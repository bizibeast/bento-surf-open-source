/**
 * One shared Resend budget for every email the worker sends.
 * The SQL side (reserve_email_send) holds the real cap under a row lock.
 */
export type EmailSendCategory = "marketing" | "transactional";

type BudgetClient = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

/** A send that must wait for budget. The row goes back to pending, not failed. */
export class EmailBudgetDeferred extends Error {
  constructor(
    readonly category: EmailSendCategory,
    readonly reason: string,
    readonly retryAt: string,
  ) {
    super(`Email ${category} budget ${reason}: held until ${retryAt}.`);
    this.name = "EmailBudgetDeferred";
  }
}

/** Resend's free daily quota resets at 00:00 UTC. */
export function nextUtcDayStart(now = new Date()) {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
}

export function nextUtcMonthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** Retry soon when the budget itself could not be read; never send unguarded. */
const BUDGET_UNAVAILABLE_RETRY_MS = 5 * 60_000;

async function defaultClient(): Promise<BudgetClient> {
  return (await import("@/integrations/supabase/client.server")).supabaseAdmin as BudgetClient;
}

export async function reserveEmailSend(
  category: EmailSendCategory,
  options: { client?: BudgetClient; now?: Date } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  let data: unknown;
  try {
    const client = options.client ?? (await defaultClient());
    const result = await client.rpc("reserve_email_send", { p_category: category });
    if (result.error) throw result.error;
    data = result.data;
  } catch {
    throw new EmailBudgetDeferred(
      category,
      "unavailable",
      new Date(now.getTime() + BUDGET_UNAVAILABLE_RETRY_MS).toISOString(),
    );
  }
  const decision = (data && typeof data === "object" ? data : {}) as {
    allowed?: unknown;
    reason?: unknown;
    retry_at?: unknown;
  };
  if (decision.allowed === true) return;
  const reason = typeof decision.reason === "string" ? decision.reason : "unavailable";
  const retryAt =
    typeof decision.retry_at === "string" && Number.isFinite(Date.parse(decision.retry_at))
      ? new Date(decision.retry_at).toISOString()
      : reason === "monthly"
        ? nextUtcMonthStart(now)
        : reason === "daily"
          ? nextUtcDayStart(now)
          : new Date(now.getTime() + BUDGET_UNAVAILABLE_RETRY_MS).toISOString();
  throw new EmailBudgetDeferred(category, reason, retryAt);
}

function quotaHeader(headers: Headers, name: string) {
  const raw = headers.get(name);
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Resend sends its account usage on every response. Null means "not reported". */
export function resendQuotaFromHeaders(headers: Headers) {
  return {
    daily: quotaHeader(headers, "x-resend-daily-quota"),
    monthly: quotaHeader(headers, "x-resend-monthly-quota"),
  };
}

export const RESEND_FREE_DAILY_LIMIT = 100;
export const RESEND_FREE_MONTHLY_LIMIT = 3000;

/** Resend 429 quota errors mean the account is full until the reset, not a failed email. */
export function resendQuotaExceeded(
  status: number,
  body: { name?: unknown; message?: unknown; error?: { name?: unknown; message?: unknown } },
) {
  if (status !== 429) return null;
  const text = [body.name, body.message, body.error?.name, body.error?.message]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();
  if (text.includes("monthly_quota") || text.includes("monthly quota")) return "monthly" as const;
  if (text.includes("daily_quota") || text.includes("daily quota")) return "daily" as const;
  return null;
}

/** Best effort: a missed record only means the next reservation is a little less exact. */
export async function recordResendQuota(
  usage: { daily: number | null; monthly: number | null },
  options: { client?: BudgetClient } = {},
) {
  if (usage.daily == null && usage.monthly == null) return false;
  try {
    const client = options.client ?? (await defaultClient());
    const { error } = await client.rpc("record_resend_quota", {
      p_daily_used: usage.daily,
      p_monthly_used: usage.monthly,
    });
    return !error;
  } catch {
    return false;
  }
}
