import { reserveProviderUsage } from "./provider-budget.server";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
const disambiguateSerpQuery = (query: string) => query;
import { readResponseText } from "./request-security.server";

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
  onReserved?: () => Promise<void> | void;
};

const RETRYABLE_STATUSES = new Set([408, 500, 502, 503, 504]);

type ReservationClient = {
  rpc(
    name: "reserve_seo_bright_data_request",
    args: { p_environment: string; p_month: string; p_limit: number },
  ): Promise<{ data: boolean | null; error: { message?: string } | null }>;
};

const organicSchema = z.object({
  global_rank: z.number().int().positive(),
  title: z.string().trim().min(1).max(500),
  link: z.string().url(),
  description: z.string().trim().max(2_000).nullish(),
});

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

const brightDataPayloadSchema = z.object({
  organic: z.array(organicSchema).max(100).default([]),
  people_also_ask: z
    .array(z.object({ question: z.string().trim().min(1).max(300) }))
    .max(30)
    .default([]),
  related: z.array(relatedSchema).max(30).default([]),
});

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

export function isSeoSerpTimeout(error: unknown): error is SeoSerpTransportError {
  return error instanceof SeoSerpTransportError && error.causeName === "TimeoutError";
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

  const target = new URL("https://www.google.com/search");
  target.searchParams.set("q", disambiguateSerpQuery(keyword));
  target.searchParams.set("gl", "us");
  target.searchParams.set("hl", "en");
  target.searchParams.set("num", "10");

  const fetcher = dependencies.fetcher ?? globalThis.fetch.bind(globalThis);
  const delay =
    dependencies.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = dependencies.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new Error("Invalid SEO request attempt limit.");
  }
  const timeoutMs = dependencies.timeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 20_000) {
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
          format: "json",
          data_format: "parsed",
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

    try {
      payload = JSON.parse(await readResponseText(response, MAX_RESPONSE_BYTES));
    } catch {
      throw new Error("Bright Data SEO returned invalid JSON.");
    }
    if (payload && typeof payload === "object" && "status_code" in payload) {
      const envelope = z
        .object({ status_code: z.number().int(), body: z.string() })
        .safeParse(payload);
      if (!envelope.success)
        throw new Error("Bright Data SEO returned an invalid response envelope.");
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
        payload = JSON.parse(envelope.data.body);
      } catch {
        throw new Error("Bright Data SEO returned invalid parsed JSON.");
      }
    }
    break;
  }
  const parsed = brightDataPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Bright Data SEO returned an invalid result shape.");

  const organic = parsed.data.organic.flatMap((row) => {
    try {
      const url = new URL(row.link);
      if (url.protocol !== "https:") return [];
      return [
        {
          rank: row.global_rank,
          title: row.title,
          url: url.toString(),
          domain: url.hostname.toLowerCase().replace(/^www\./, ""),
          description: row.description ?? "",
        },
      ];
    } catch {
      return [];
    }
  });

  if (dependencies.usage) await dependencies.recordUsage?.(requestsUsed);
  return {
    organic,
    questions: uniqueStrings(
      parsed.data.people_also_ask.map((item) => item.question),
      20,
    ),
    relatedSearches: uniqueStrings(flattenRelated(parsed.data.related), 20),
    requestsUsed,
  };
}
