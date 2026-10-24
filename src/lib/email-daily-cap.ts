/**
 * Resend Free is 100 emails per UTC day and 3,000 per month for the whole
 * account, shared with Supabase Auth SMTP. The enforced cap lives in the
 * email_send_budget_policy row (see reserve_email_send); these defaults match it.
 */
export const RESEND_DAILY_EMAIL_LIMIT = 100;
/** Kept free for Supabase Auth mail the worker cannot see before it is sent. */
export const DEFAULT_AUTH_EMAIL_RESERVE = 10;
/** Marketing stops once the shared day total (all categories) reaches this. */
export const DEFAULT_MARKETING_EMAIL_DAILY_CEILING = 60;
/** Weekly digests enqueued per UTC day, so onboarding mail keeps room under the ceiling. */
export const DEFAULT_WEEKLY_DIGEST_DAILY_CAP = 45;
/** 10 requests/second. */
export const DEFAULT_RESEND_MIN_INTERVAL_MS = 100;

function boundedInteger(raw: string | undefined, fallback: number, max: number) {
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return fallback;
  return Math.min(value, max);
}

/** Digests enqueued per day. Never above the marketing ceiling. */
export function weeklyDigestDailyCap(
  raw = process.env.EMAIL_WEEKLY_DIGEST_SEND_CAP,
  marketingCeiling = DEFAULT_MARKETING_EMAIL_DAILY_CEILING,
) {
  return boundedInteger(
    raw,
    Math.min(DEFAULT_WEEKLY_DIGEST_DAILY_CAP, marketingCeiling),
    marketingCeiling,
  );
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
