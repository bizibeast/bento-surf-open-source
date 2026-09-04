import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { readResponseText } from "./request-security.server";

export type SocialPreviewPlatform =
  | "instagram"
  | "twitter"
  | "tiktok"
  | "linkedin"
  | "youtube"
  | "github"
  | "gitlab"
  | "reddit"
  | "bluesky"
  | "mastodon";

export type SocialPreviewOutcome =
  "success" | "unavailable" | "timeout" | "rate_limited" | "blocked" | "parse_error" | "error";

type ReliabilityEnv = {
  APP_ENV?: string;
  BROWSER?: BrowserRun;
};

type SourceResult<T> = { value: T; browserMs?: number };

const BROWSER_DAILY_BUDGET_MS = 4 * 60 * 1_000;
const BROWSER_RESERVATION_MS = 15_000;
const MAX_RENDERED_HTML_BYTES = 2 * 1024 * 1024;

export class SocialPreviewSourceError extends Error {
  constructor(
    message: string,
    readonly outcome: Exclude<SocialPreviewOutcome, "success"> = "error",
    readonly browserMs?: number,
  ) {
    super(message);
    this.name = "SocialPreviewSourceError";
  }
}

function utcPeriodStart(kind: "day" | "month") {
  const now = new Date();
  return kind === "day" ? now.toISOString().slice(0, 10) : `${now.toISOString().slice(0, 7)}-01`;
}

async function claimBudget(
  provider: "browser_run" | "bright_data",
  periodStart: string,
  units: number,
  limit: number,
) {
  const { data, error } = await supabaseAdmin.rpc("claim_social_preview_budget", {
    p_provider: provider,
    p_period_start: periodStart,
    p_units: units,
    p_limit: limit,
  });
  return !error && data === true;
}

async function reconcileBrowserBudget(actualMs: number | undefined) {
  if (actualMs === undefined) return;
  await supabaseAdmin.rpc("adjust_social_preview_budget", {
    p_provider: "browser_run",
    p_period_start: utcPeriodStart("day"),
    p_delta: Math.round(actualMs) - BROWSER_RESERVATION_MS,
  });
}

function classifyError(error: unknown): Exclude<SocialPreviewOutcome, "success"> {
  if (error instanceof SocialPreviewSourceError) return error.outcome;
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("429") || message.includes("rate limit")) return "rate_limited";
  if (message.includes("403") || message.includes("captcha") || message.includes("login wall")) {
    return "blocked";
  }
  if (message.includes("parse") || message.includes("follower count")) return "parse_error";
  return "error";
}

async function recordAttempt(input: {
  platform: SocialPreviewPlatform;
  source: string;
  attemptNumber: number;
  outcome: SocialPreviewOutcome;
  durationMs: number;
  browserMs?: number;
  usedBright?: boolean;
}) {
  if (process.env.NODE_ENV === "test") return;
  const { error } = await supabaseAdmin.from("social_preview_attempts").insert({
    platform: input.platform,
    source: input.source,
    attempt_number: input.attemptNumber,
    outcome: input.outcome,
    duration_ms: Math.min(300_000, Math.max(0, Math.round(input.durationMs))),
    browser_ms:
      input.browserMs === undefined
        ? null
        : Math.min(300_000, Math.max(0, Math.round(input.browserMs))),
    used_bright: input.usedBright ?? false,
  });
  if (error) console.warn("Could not record social-preview attempt", { source: input.source });
}

export async function runSocialPreviewSource<T>(
  platform: SocialPreviewPlatform,
  source: string,
  attemptNumber: number,
  operation: () => Promise<SourceResult<T>>,
  usedBright = false,
  outcomeForValue: (value: T) => "success" | "unavailable" = () => "success",
) {
  const startedAt = Date.now();
  try {
    const result = await operation();
    await recordAttempt({
      platform,
      source,
      attemptNumber,
      outcome: outcomeForValue(result.value),
      durationMs: Date.now() - startedAt,
      browserMs: result.browserMs,
      usedBright,
    });
    return result.value;
  } catch (error) {
    await recordAttempt({
      platform,
      source,
      attemptNumber,
      outcome: classifyError(error),
      durationMs: Date.now() - startedAt,
      browserMs: error instanceof SocialPreviewSourceError ? error.browserMs : undefined,
      usedBright,
    });
    throw error;
  }
}

export async function fetchRenderedSocialHtml(url: string) {
  const env = globalThis.__env__ as ReliabilityEnv | undefined;
  if (!env?.BROWSER) {
    throw new SocialPreviewSourceError("Browser Run is not configured", "blocked");
  }
  if (
    !(await claimBudget(
      "browser_run",
      utcPeriodStart("day"),
      BROWSER_RESERVATION_MS,
      BROWSER_DAILY_BUDGET_MS,
    ))
  ) {
    throw new SocialPreviewSourceError("Browser Run daily budget exhausted", "blocked");
  }

  const response = await env.BROWSER.quickAction("content", {
    url,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    gotoOptions: { waitUntil: "domcontentloaded", timeout: 12_000 },
    actionTimeout: 12_000,
    bestAttempt: true,
    cacheTTL: 0,
    rejectResourceTypes: ["image", "media", "font"],
  });
  const rawBrowserMs = Number(response.headers.get("x-browser-ms-used"));
  const browserMs = Number.isFinite(rawBrowserMs) && rawBrowserMs >= 0 ? rawBrowserMs : undefined;
  await reconcileBrowserBudget(browserMs);
  if (!response.ok) {
    throw new SocialPreviewSourceError(
      `Browser Run returned ${response.status}`,
      response.status === 429 ? "rate_limited" : response.status === 403 ? "blocked" : "error",
      browserMs,
    );
  }
  let payload: { success?: unknown; result?: unknown };
  try {
    payload = JSON.parse(await readResponseText(response, MAX_RENDERED_HTML_BYTES));
  } catch {
    throw new SocialPreviewSourceError(
      "Browser Run returned invalid JSON",
      "parse_error",
      browserMs,
    );
  }
  if (payload.success !== true || typeof payload.result !== "string") {
    throw new SocialPreviewSourceError(
      "Browser Run returned invalid HTML",
      "parse_error",
      browserMs,
    );
  }
  return {
    value: payload.result,
    browserMs,
  };
}

export async function claimBrightDataAttempt() {
  const environment = (globalThis.__env__ as ReliabilityEnv | undefined)?.APP_ENV;
  const limit = environment === "production" ? 3_500 : 500;
  return claimBudget("bright_data", utcPeriodStart("month"), 1, limit);
}
