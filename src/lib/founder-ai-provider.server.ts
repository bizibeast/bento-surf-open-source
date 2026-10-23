import { selectedAiModel, type AiProviderEnv } from "./ai-json.server";

const KEY_ENDPOINT = "https://openrouter.ai/api/v1/key";
const CACHE_MS = 60_000;
const MAX_RESPONSE_BYTES = 16_384;

export type OpenRouterKeyDiagnostic = {
  status: "unconfigured" | "ready" | "auth_failed" | "unavailable";
  checkedAt: string;
  failureReason: "timeout" | "network" | "invalid_response" | "http" | null;
  httpStatus: number | null;
  usageUsd: number | null;
  dailyUsageUsd: number | null;
  monthlyUsageUsd: number | null;
  limitUsd: number | null;
  remainingUsd: number | null;
  unlimited: boolean;
  limitReset: "daily" | "weekly" | "monthly" | null;
};

function emptyStatus(
  status: OpenRouterKeyDiagnostic["status"],
  checkedAt: string,
): OpenRouterKeyDiagnostic {
  return {
    status,
    checkedAt,
    failureReason: null,
    httpStatus: null,
    usageUsd: null,
    dailyUsageUsd: null,
    monthlyUsageUsd: null,
    limitUsd: null,
    remainingUsd: null,
    unlimited: false,
    limitReset: null,
  };
}

function amount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

class InvalidKeyReportError extends Error {}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES || !response.body)
    throw new InvalidKeyReportError("Invalid key report");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new InvalidKeyReportError("Key report too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Free metadata read only: never requests inference or changes provider billing. */
export function createOpenRouterKeyDiagnostic({
  fetcher = globalThis.fetch.bind(globalThis),
  now = Date.now,
}: { fetcher?: typeof fetch; now?: () => number } = {}) {
  // Keep only one cached credential's allowlisted result per Worker isolate.
  let cache: {
    credential: string;
    expiresAt: number;
    value: Promise<OpenRouterKeyDiagnostic>;
  } | null = null;
  return async (apiKey: string | undefined): Promise<OpenRouterKeyDiagnostic> => {
    const credential = apiKey?.trim();
    const checkedAt = new Date(now()).toISOString();
    if (!credential) return emptyStatus("unconfigured", checkedAt);
    if (cache?.credential === credential && cache.expiresAt > now()) return cache.value;
    const value = (async (): Promise<OpenRouterKeyDiagnostic> => {
      let httpStatus: number | null = null;
      try {
        const response = await fetcher(KEY_ENDPOINT, {
          method: "GET",
          headers: { authorization: `Bearer ${credential}`, accept: "application/json" },
          // Workers implements manual/follow, but not Fetch-standard error mode.
          // Never forward the bearer credential to a redirected endpoint.
          redirect: "manual",
          signal: AbortSignal.timeout(4_000),
        });
        httpStatus = response.status >= 100 && response.status <= 599 ? response.status : null;
        // All redirect responses are rejected here; Location is never followed.
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          return {
            ...emptyStatus(
              response.status === 401 || response.status === 403 ? "auth_failed" : "unavailable",
              checkedAt,
            ),
            failureReason: "http",
            httpStatus,
          };
        }
        const payload = (await readBoundedJson(response)) as { data?: unknown } | null;
        if (!payload?.data || typeof payload.data !== "object" || Array.isArray(payload.data))
          return {
            ...emptyStatus("unavailable", checkedAt),
            failureReason: "invalid_response",
            httpStatus,
          };
        const data = payload.data as Record<string, unknown>;
        return {
          ...emptyStatus("ready", checkedAt),
          httpStatus,
          usageUsd: amount(data.usage),
          dailyUsageUsd: amount(data.usage_daily),
          monthlyUsageUsd: amount(data.usage_monthly),
          limitUsd: amount(data.limit),
          remainingUsd: amount(data.limit_remaining),
          unlimited: data.limit === null,
          limitReset:
            data.limit_reset === "daily" ||
            data.limit_reset === "weekly" ||
            data.limit_reset === "monthly"
              ? data.limit_reset
              : null,
        };
      } catch (error) {
        // Fixed categories only: never return provider bodies, error messages,
        // credential labels, URLs, or other private response metadata.
        const name = error && typeof error === "object" && "name" in error ? error.name : null;
        const failureReason =
          name === "TimeoutError" || name === "AbortError"
            ? "timeout"
            : error instanceof InvalidKeyReportError || error instanceof SyntaxError
              ? "invalid_response"
              : "network";
        return { ...emptyStatus("unavailable", checkedAt), failureReason, httpStatus };
      }
    })();
    cache = { credential, expiresAt: now() + CACHE_MS, value };
    return value;
  };
}

const checkOpenRouterKey = createOpenRouterKeyDiagnostic();

export async function getFounderAiProviderDiagnostic(
  env = ((globalThis as { __env__?: AiProviderEnv }).__env__ ?? {}) as AiProviderEnv,
) {
  let models: {
    primary: ReturnType<typeof selectedAiModel>;
    lightweight: ReturnType<typeof selectedAiModel>;
  } | null = null;
  try {
    models = {
      primary: selectedAiModel(env, { modelTier: "balanced" }),
      lightweight: selectedAiModel(env, { modelTier: "fast" }),
    };
  } catch {
    // Missing configured provider stays explicit while key status is checked independently.
  }
  const openrouter = await checkOpenRouterKey(
    env.OPENROUTER_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim(),
  );
  return { models, openrouter };
}
