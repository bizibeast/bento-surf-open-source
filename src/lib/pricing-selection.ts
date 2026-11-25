import { newPlanBillingPeriod, type PaidPlanId, type BillingPeriod } from "./plans";

export function pricingSelection(
  plan: unknown,
  period: unknown,
): { plan: PaidPlanId; period: BillingPeriod } | null {
  if (plan !== "store" && plan !== "creator" && plan !== "creator_plus") return null;
  return { plan, period: newPlanBillingPeriod(plan, period === "yearly" ? "yearly" : "monthly") };
}

export function pricingCheckoutDestination(plan: unknown, period: unknown) {
  const selection = pricingSelection(plan, period);
  return selection
    ? `/settings?section=plan&checkoutPlan=${selection.plan}&checkoutPeriod=${selection.period}`
    : "/link";
}

export function pricingOnboardingDestination(plan: unknown, period: unknown) {
  const selection = pricingSelection(plan, period);
  return selection
    ? `/onboarding?plan=${selection.plan}&period=${selection.period}`
    : "/onboarding";
}
