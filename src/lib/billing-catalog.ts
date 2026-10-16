import {
  CURRENT_DODO_PRODUCT_ENV,
  DODO_PRODUCT_ENV,
  EXTENDED_TRIAL_DAYS,
  PAID_PLAN_IDS,
  TRIAL_DAYS,
  type BillingCatalog,
  type BillingPeriod,
  type PaidPlanId,
} from "./plans";

export function resolveBillingProduct(
  productId: string | null | undefined,
  env: Record<string, string | undefined>,
) {
  if (!productId) return null;
  const matches: Array<{ plan: PaidPlanId; period: BillingPeriod; catalog: BillingCatalog }> = [];
  for (const plan of PAID_PLAN_IDS) {
    for (const period of ["monthly", "yearly"] as const) {
      if (env[CURRENT_DODO_PRODUCT_ENV[plan][period]]?.trim() === productId) {
        matches.push({ plan, period, catalog: "2026-10" });
      }
    }
  }
  for (const plan of ["store", "creator"] as const) {
    for (const period of ["monthly", "yearly"] as const) {
      if (env[DODO_PRODUCT_ENV[plan][period]]?.trim() === productId) {
        matches.push({ plan, period, catalog: "legacy" });
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/** Accept only a verified provider subscription; browser input must never call this path. */
export function verifiedTrialEnd(
  subscription: Record<string, unknown>,
  now = Date.now(),
  expectedDays = TRIAL_DAYS,
  approvedExtensionEnd: string | null = null,
): string | null {
  if (!["active", "trialing"].includes(String(subscription.status))) return null;
  if (subscription.trial_period_days !== expectedDays) return null;
  const startedAt = Date.parse(String(subscription.created_at ?? ""));
  const chargeAt = Date.parse(String(subscription.next_billing_date ?? ""));
  const expectedEnd = startedAt + expectedDays * 86_400_000;
  if (!Number.isFinite(startedAt) || !Number.isFinite(chargeAt) || chargeAt <= now) return null;
  // A renewal may still include trial_period_days. It must never create another trial.
  const approvedEnd = Date.parse(approvedExtensionEnd ?? "");
  // Dodo starts the trial clock when the card is authorized, after creating the subscription.
  // Bound that checkout delay so a later renewal cannot masquerade as an initial trial.
  const initialTrial = chargeAt >= expectedEnd - 60_000 && chargeAt <= expectedEnd + 30 * 60_000;
  const approvedExtension =
    Number.isFinite(approvedEnd) &&
    Math.abs(chargeAt - approvedEnd) <= 60_000 &&
    approvedEnd > expectedEnd;
  if (!initialTrial && !approvedExtension) return null;
  return new Date(chargeAt).toISOString();
}

/** Add the remaining days to the verified initial end, not to Dodo's earlier creation time. */
export function trialExtensionEnd(
  initialEnd: string,
  approvedEnd: string | null,
  redeemedAt: string | null,
): string | null {
  const base = Date.parse(redeemedAt ? (approvedEnd ?? "") : initialEnd);
  if (!Number.isFinite(base)) return null;
  return new Date(
    base + (redeemedAt ? 0 : EXTENDED_TRIAL_DAYS - TRIAL_DAYS) * 86_400_000,
  ).toISOString();
}
