import { reserveProviderUsage } from "./provider-budget.server";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
const disambiguateSerpQuery = (query: string) => query;
import { readResponseText, RequestBodyTooLargeError } from "./request-security.server";

const BRIGHT_DATA_ENDPOINT = "https://api.brightdata.com/request";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MONTHLY_LIMIT = 3_000;

export type BrightDataSeoEnv = {
  APP_ENV?: string;
  BRIGHT_DATA_API_KEY?: string;
  BRIGHT_DATA_SERP_ZONE?: string;
  SEO_BRIGHT_DATA_MONTHLY_REQUEST_LIMIT?: string;
};

export type SeoSerpResult = {
  organic: Array<{
    rank: number;
    title: string;
    url: string;
    domain: string;
    description: string;
  }>;
  questions: string[];
  relatedSearches: string[];
  requestsUsed: number;
};

type UsageClient = {
  from(table: "seo_runs"): {
    select(columns: "provider_usage"): {
      gte(
        column: "created_at",
        value: string,
      ): {
        lt(
          column: "created_at",
          value: string,
        ): Promise<{
          data: Array<{ provider_usage: unknown }> | null;
          error: { message?: string } | null;
        }>;
      };
    };
  };
};

export type SeoSerpDependencies = {
  fetcher?: typeof fetch;
  reserve?: (month: string, limit: number) => Promise<boolean>;
  usage?: (month: string) => Promise<number>;
  recordUsage?: (requests: number) => Promise<void>;
  now?: () => Date;
  delay?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  timeoutMs?: number;
  dataFormat?: "parsed" | "parsed_light";
  onReserved?: () => Promise<void> | void;
};

const RETRYABLE_STATUSES = new Set([408, 500, 502, 503, 504]);

type ReservationClient = {
  rpc(
    name: "reserve_seo_bright_data_request",
    args: { p_environment: string; p_month: string; p_limit: number },
  ): Promise<{ data: boolean | null; error: { message?: string } | null }>;
};

type RelatedSearchRow = {
  text?: string | null;
  items?: RelatedSearchRow[];
};

const relatedSchema: z.ZodType<RelatedSearchRow> = z.lazy(() =>
  z.object({
    text: z.string().trim().max(300).nullish(),
    items: z.array(relatedSchema).max(20).optional(),
  }),
);

export class SeoProviderBudgetError extends Error {
  constructor() {
    super("Bright Data SEO monthly limit reached");
    this.name = "SeoProviderBudgetError";
  }
}

export class SeoSerpTransportError extends Error {
  readonly causeName: string;
  readonly durationMs: number;

  constructor(causeName: string, durationMs: number) {
    super(`Bright Data SEO transport failed after retries (${causeName}, ${durationMs}ms).`);
    this.name = "SeoSerpTransportError";
    this.causeName = causeName;
    this.durationMs = durationMs;
  }
}

export class SeoSerpParseError extends Error {
  readonly reason: string;

  constructor(message: string, reason = "malformed") {
    super(message);
    this.name = "SeoSerpParseError";
    this.reason = reason;
  }
}

export function isSeoSerpTimeout(error: unknown): error is SeoSerpTransportError {
  return error instanceof SeoSerpTransportError && error.causeName === "TimeoutError";
}

export function isSeoSerpRecoverable(error: unknown) {
  if (error instanceof SeoSerpTransportError || error instanceof SeoSerpParseError) return true;
  return (
    error instanceof Error &&
    /Bright Data SEO request failed \((?:408|500|502|503|504)\)/.test(error.message)
  );
}

function transportErrorName(error: unknown) {
  if (error instanceof Error && error.name === "TimeoutError") return "TimeoutError";
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.code === 23) {
    return "TimeoutError";
  }
  return error instanceof Error && error.name ? error.name : "Error";
}

function monthRange(month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Invalid SEO usage month.");
  const start = new Date(`${month}-01T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 7) !== month) {
    throw new Error("Invalid SEO usage month.");
  }
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

function requestCount(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const count = (value as Record<string, unknown>).brightDataRequests;
  return typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 0;
}

export async function brightDataSeoUsage(
  month: string,
  client: UsageClient = supabaseAdmin as unknown as UsageClient,
) {
  const range = monthRange(month);
  const { data, error } = await client
    .from("seo_runs")
    .select("provider_usage")
    .gte("created_at", range.start)
    .lt("created_at", range.end);
  if (error) throw new Error("Bright Data SEO usage is unavailable.");
  return (data ?? []).reduce((total, row) => total + requestCount(row.provider_usage), 0);
}

function publicPrefix(value: string) {
  return value
    .replace(/bearer\s+\S+/gi, "bearer [redacted]")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function responseContentType(response: Response) {
  return (response.headers.get("content-type") ?? "").split(";")[0]?.trim().slice(0, 80) ?? "";
}

function rejectSerpBody(response: Response, body: string, reason: string) {
  const contentType = responseContentType(response);
  const prefix = publicPrefix(body);
  const declared = Number(response.headers.get("content-length"));
  console.error("Bright Data SEO response rejected", {
    reason,
    status: response.status,
    contentType: contentType || "missing",
    bytes: body.length || (Number.isFinite(declared) ? declared : 0),
    prefix,
  });
  const detail = [
    reason,
    `status ${response.status}`,
    contentType || "no content-type",
    `${body.length || (Number.isFinite(declared) ? declared : 0)} bytes`,
    prefix,
  ]
    .filter(Boolean)
    .join(", ");
  return new SeoSerpParseError(
    `Bright Data SEO returned invalid JSON (${detail}).`.slice(0, 500),
    reason,
  );
}

function parseJsonBody(response: Response, body: string) {
  const trimmed = body.replace(/^\uFEFF/, "").trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1]) as unknown;
      } catch {
        // Fall through to the same diagnostic as a raw non-JSON body.
      }
    }
    throw rejectSerpBody(response, body, "malformed");
  }
}

function organicRank(value: unknown) {
  const rank =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isInteger(rank) && rank >= 1 && rank <= 100 ? rank : null;
}

function serpOrganic(
  payload: unknown,
): { ok: true; rows: ReturnType<typeof normalizeOrganic> } | { ok: false; reason: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "unrecognized" };
  }
  if (!Object.prototype.hasOwnProperty.call(payload, "organic")) {
    return { ok: false, reason: "unrecognized" };
  }
  const organic = (payload as { organic?: unknown }).organic;
  if (!Array.isArray(organic)) return { ok: false, reason: "unrecognized" };
  const rows = normalizeOrganic(organic);
  // An empty organic array is a real SERP. A nonempty array with no usable rows is not.
  if (organic.length > 0 && rows.length === 0) return { ok: false, reason: "invalid_rows" };
  return { ok: true, rows };
}

function normalizeOrganic(value: unknown[]) {
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const rank = organicRank(row.global_rank ?? row.rank);
    const title = typeof row.title === "string" ? row.title.trim() : "";
    const link = typeof row.link === "string" ? row.link.trim() : "";
    const description = typeof row.description === "string" ? row.description.trim() : "";
    if (!rank || !title || title.length > 500 || !link) return [];
    try {
      const url = new URL(link);
      if (url.protocol !== "https:") return [];
      return [
        {
          rank,
          title,
          url: url.toString(),
          domain: url.hostname.toLowerCase().replace(/^www\./, ""),
          description: description.slice(0, 2_000),
        },
      ];
    } catch {
      return [];
    }
  });
}

function questionList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const question = (item as { question?: unknown }).question;
    if (typeof question !== "string") return [];
    const text = question.trim();
    return text && text.length <= 300 ? [text] : [];
  });
}

function uniqueStrings(values: string[], limit: number) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function flattenRelated(items: z.infer<typeof relatedSchema>[], depth = 0): string[] {
  if (depth > 2) return [];
  return items.flatMap((item) => [
    ...(item.text ? [item.text] : []),
    ...flattenRelated(item.items ?? [], depth + 1),
  ]);
}

function monthlyLimit(env: BrightDataSeoEnv) {
  const value = Number(env.SEO_BRIGHT_DATA_MONTHLY_REQUEST_LIMIT ?? DEFAULT_MONTHLY_LIMIT);
  if (!Number.isSafeInteger(value) || value < 0 || value > DEFAULT_MONTHLY_LIMIT) {
    throw new Error("Invalid Bright Data SEO monthly limit.");
  }
  return value;
}

export async function reserveBrightDataSeoRequest(
  env: BrightDataSeoEnv,
  month: string,
  client: ReservationClient = supabaseAdmin as unknown as ReservationClient,
) {
  const target = env.APP_ENV === "production" || env.APP_ENV === "staging" ? env.APP_ENV : "local";
  const { data, error } = await client.rpc("reserve_seo_bright_data_request", {
    p_environment: target,
    p_month: month,
    p_limit: monthlyLimit(env),
  });
  if (error) throw new Error("Bright Data SEO usage unavailable.");
  return data === true;
}

export async function fetchSeoSerp(
  input: { keyword: string; country: string; language: string },
  env: BrightDataSeoEnv,
  dependencies: SeoSerpDependencies = {},
): Promise<SeoSerpResult> {
  const keyword = input.keyword.trim();
  if (!keyword || keyword.length > 160) throw new Error("Invalid SEO keyword.");
  if (input.country.toLowerCase() !== "us" || input.language.toLowerCase() !== "en") {
    throw new Error("SEO research supports US English only.");
  }
  const apiKey = env.BRIGHT_DATA_API_KEY?.trim();
  const zone = env.BRIGHT_DATA_SERP_ZONE?.trim();
  if (!apiKey || !zone) throw new Error("Bright Data SEO is not configured.");

  const now = dependencies.now?.() ?? new Date();
  const month = now.toISOString().slice(0, 7);
  const limit = monthlyLimit(env);

  const dataFormat = dependencies.dataFormat ?? "parsed";
  if (dataFormat !== "parsed" && dataFormat !== "parsed_light") {
    throw new Error("Invalid SEO SERP format.");
  }
  const target = new URL("https://www.google.com/search");
  target.searchParams.set("q", disambiguateSerpQuery(keyword));
  target.searchParams.set("gl", "us");
  target.searchParams.set("hl", "en");
  target.searchParams.set("num", "10");
  // brd_json is the documented SERP parser switch. data_format "parsed" is not a
  // SERP value and comes back as HTML or plain text, which JSON.parse rejects.
  target.searchParams.set("brd_json", dataFormat === "parsed_light" ? "parsed_light" : "1");

  const fetcher = dependencies.fetcher ?? globalThis.fetch.bind(globalThis);
  const delay =
    dependencies.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = dependencies.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new Error("Invalid SEO request attempt limit.");
  }
  const timeoutMs = dependencies.timeoutMs ?? 20_000;
  // parsed stays at the 20s caller cap. parsed_light may use the cloud pair budget.
  const timeoutCap = dataFormat === "parsed_light" ? 45_000 : 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > timeoutCap) {
    throw new Error("Invalid SEO request timeout.");
  }
  let payload: unknown;
  let requestsUsed = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const reserved = dependencies.reserve
      ? await dependencies.reserve(month, limit)
      : dependencies.usage
        ? (await dependencies.usage(month)) < limit
        : await reserveBrightDataSeoRequest(env, month);
    if (!reserved) throw new SeoProviderBudgetError();
    requestsUsed += 1;
    await dependencies.onReserved?.();

    await reserveProviderUsage("bright_data_requests");
    let response: Response;
    const started = Date.now();
    try {
      response = await fetcher(BRIGHT_DATA_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          zone,
          url: target.toString(),
          // parsed_light is the faster organic-only parser. Bright Data expects format raw for it.
          // Full JSON omits data_format: "parsed" is not a documented SERP value.
          format: dataFormat === "parsed_light" ? "raw" : "json",
          ...(dataFormat === "parsed_light" ? { data_format: "parsed_light" } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const durationMs = Date.now() - started;
      const name = transportErrorName(error);
      console.error("Bright Data SEO transport failed", { name, durationMs, attempt });
      if (attempt === maxAttempts - 1) throw new SeoSerpTransportError(name, durationMs);
      await delay((attempt + 1) * 1_000);
      continue;
    }
    if (response.status === 429) throw new Error("Bright Data SEO request failed (429).");
    if (!response.ok) {
      if (attempt < maxAttempts - 1 && RETRYABLE_STATUSES.has(response.status)) {
        await delay((attempt + 1) * 1_000);
        continue;
      }
      throw new Error(`Bright Data SEO request failed (${response.status}).`);
    }

    let text = "";
    try {
      text = await readResponseText(response, MAX_RESPONSE_BYTES);
      payload = parseJsonBody(response, text);
    } catch (error) {
      const parseError =
        error instanceof SeoSerpParseError
          ? error
          : error instanceof RequestBodyTooLargeError
            ? rejectSerpBody(response, "", "too_large")
            : null;
      if (!parseError) throw error;
      if (attempt === maxAttempts - 1) throw parseError;
      await delay((attempt + 1) * 1_000);
      continue;
    }
    // format json may wrap {status_code, body}. parsed_light is the object itself.
    // A top-level organic array wins so a light body is not read as an envelope.
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>;
      if (!Array.isArray(record.organic) && typeof record.body === "string") {
        const envelope = z
          .object({ status_code: z.number().int(), body: z.string() })
          .safeParse(payload);
        if (!envelope.success) {
          const parseError = rejectSerpBody(response, text, "envelope");
          if (attempt === maxAttempts - 1) throw parseError;
          await delay((attempt + 1) * 1_000);
          continue;
        }
        if (envelope.data.status_code !== 200) {
          if (envelope.data.status_code === 429) {
            throw new Error("Bright Data SEO request failed (429).");
          }
          if (attempt < maxAttempts - 1 && RETRYABLE_STATUSES.has(envelope.data.status_code)) {
            await delay((attempt + 1) * 1_000);
            continue;
          }
          throw new Error(`Bright Data SEO request failed (${envelope.data.status_code}).`);
        }
        try {
          payload = parseJsonBody(response, envelope.data.body);
        } catch (error) {
          const parseError =
            error instanceof SeoSerpParseError
              ? error
              : rejectSerpBody(response, envelope.data.body, "parsed_body");
          if (attempt === maxAttempts - 1) throw parseError;
          await delay((attempt + 1) * 1_000);
          continue;
        }
      }
    }
    const organic = serpOrganic(payload);
    if (!organic.ok) {
      const parseError = rejectSerpBody(response, text, organic.reason);
      if (attempt === maxAttempts - 1) throw parseError;
      await delay((attempt + 1) * 1_000);
      continue;
    }
    const record =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { people_also_ask?: unknown; related?: unknown })
        : {};
    const related = z
      .array(relatedSchema)
      .max(30)
      .safeParse(record.related ?? []);
    if (dependencies.usage) await dependencies.recordUsage?.(requestsUsed);
    return {
      organic: organic.rows,
      questions: uniqueStrings(questionList(record.people_also_ask), 20),
      relatedSearches: uniqueStrings(related.success ? flattenRelated(related.data) : [], 20),
      requestsUsed,
    };
  }
  throw new SeoSerpParseError("Bright Data SEO returned invalid JSON.");
}
