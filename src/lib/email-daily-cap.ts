/** Resend's free plan is 100 emails/day, shared with Supabase Auth SMTP. */
export const DEFAULT_MARKETING_EMAIL_DAILY_CAP = 70;
export const DEFAULT_TRANSACTIONAL_EMAIL_DAILY_CAP = 100;
export const DEFAULT_WEEKLY_DIGEST_SEND_CAP = 20;
/** 10 requests/second. */
export const DEFAULT_RESEND_MIN_INTERVAL_MS = 100;

const MAX_EMAIL_DAILY_CAP = 10_000;

function boundedInteger(raw: string | undefined, fallback: number, max: number) {
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return fallback;
  return Math.min(value, max);
}

export function emailDailyCap(
  category: "marketing" | "transactional",
  raw = process.env[
    category === "marketing" ? "EMAIL_MARKETING_DAILY_CAP" : "EMAIL_TRANSACTIONAL_DAILY_CAP"
  ],
) {
  return boundedInteger(
    raw,
    category === "marketing"
      ? DEFAULT_MARKETING_EMAIL_DAILY_CAP
      : DEFAULT_TRANSACTIONAL_EMAIL_DAILY_CAP,
    MAX_EMAIL_DAILY_CAP,
  );
}

/** One Monday run must leave the rest of the marketing day for onboarding mail. */
export function weeklyDigestSendCap(
  raw = process.env.EMAIL_WEEKLY_DIGEST_SEND_CAP,
  marketingDailyCap = emailDailyCap("marketing"),
) {
  return boundedInteger(raw, Math.min(DEFAULT_WEEKLY_DIGEST_SEND_CAP, marketingDailyCap), marketingDailyCap);
}

export function resendMinIntervalMs(raw = process.env.RESEND_MIN_INTERVAL_MS) {
  return boundedInteger(raw, DEFAULT_RESEND_MIN_INTERVAL_MS, 60_000);
}

export function compareEmailDeliveryPriority(
  left: { category: string },
  right: { category: string },
) {
  return Number(left.category !== "transactional") - Number(right.category !== "transactional");
}

type CapRow = { resource: string; daily_limit: number | string };
type CapDb = {
  from(table: string): {
    select(columns: string): {
      in(
        column: string,
        values: string[],
      ): PromiseLike<{ data: CapRow[] | null; error: { message: string } | null }>;
    };
    update(values: { daily_limit: number }): {
      eq(column: string, value: string): PromiseLike<{ error: { message: string } | null }>;
    };
  };
};

const EMAIL_CAP_RESOURCES = [
  ["marketing_emails", "marketing"],
  ["transactional_emails", "transactional"],
] as const;

/** Env wins over the stored policy so a deploy can lower the cap before the next migration. */
export async function syncEmailDailyCaps(db: CapDb) {
  const desired = EMAIL_CAP_RESOURCES.map(([resource, category]) => [resource, emailDailyCap(category)] as const);
  const { data, error } = await db
    .from("provider_budget_policies")
    .select("resource,daily_limit")
    .in(
      "resource",
      desired.map(([resource]) => resource),
    );
  if (error) throw new Error(error.message);
  const current = new Map((data ?? []).map((row) => [row.resource, Number(row.daily_limit)]));
  for (const [resource, dailyLimit] of desired) {
    if (current.get(resource) === dailyLimit) continue;
    const { error: updateError } = await db
      .from("provider_budget_policies")
      .update({ daily_limit: dailyLimit })
      .eq("resource", resource);
    if (updateError) throw new Error(updateError.message);
  }
}
