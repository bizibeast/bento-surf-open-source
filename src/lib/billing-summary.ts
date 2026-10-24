import { PLAN_CONFIG, planName, type PlanId } from "./plans";
import type { BillingLifecycle } from "./billing-lifecycle";

type SummaryBilling = {
  plan: PlanId;
  status: "active" | "trialing" | "past_due" | "paused" | "canceled" | "incomplete" | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  hasSubscription: boolean;
  billingLifecycle?: BillingLifecycle | null;
  trialEnded?: boolean;
};

export type BillingSummary = {
  /** The plan the subscription is for (Dodo product), not temporary trial tools. */
  plan: PlanId;
  badge: string;
  description: string;
  /** Extra line, e.g. trial tools that go beyond the subscribed plan. */
  note: string | null;
  date: { kind: "renews" | "trial_ends" | "access_ends" | "access_ended"; at: string } | null;
};

/**
 * One source for the Billing header. The subscribed plan comes from the
 * verified subscription (billing.plan). A trial grants exactly that plan; a
 * higher effective plan can only come from a complimentary grant.
 */
export function billingSummary(
  billing: SummaryBilling | null | undefined,
  effectivePlan: PlanId,
  now = Date.now(),
): BillingSummary {
  const subscribed = billing?.hasSubscription ? billing.plan : effectivePlan;
  const name = planName(subscribed);
  const description = PLAN_CONFIG[subscribed].description;
  const lifecycle = billing?.billingLifecycle ?? null;
  if (!billing?.hasSubscription)
    return {
      plan: subscribed,
      badge: subscribed === "free" ? "Choose your Bento plan" : `${name} is active`,
      description,
      note: null,
      date: null,
    };
  if (billing.status === "paused")
    return { plan: subscribed, badge: "Subscription paused", description, note: null, date: null };
  if (billing.status === "canceled" || billing.status === "incomplete") {
    const stop = lifecycle?.toolsStopAt ?? null;
    return {
      plan: subscribed,
      badge: billing.trialEnded ? `${name} trial ended` : `${name} canceled`,
      description,
      note: null,
      date: stop
        ? { kind: Date.parse(stop) > now ? "access_ends" : "access_ended", at: stop }
        : null,
    };
  }
  const end = billing.currentPeriodEnd;
  const trialing = billing.status === "trialing";
  return {
    plan: subscribed,
    badge: trialing
      ? billing.cancelAtPeriodEnd
        ? `${name} trial, canceled`
        : `${name} trial`
      : billing.cancelAtPeriodEnd
        ? `${name} ends soon`
        : `${name} is active`,
    description,
    note: null,
    date: end
      ? {
          // "Access until" is only for paid cancels. Cancelling a trial in Bento ends it
          // immediately; a trial still scheduled to stop (set outside Bento) shows its end.
          kind: trialing ? "trial_ends" : billing.cancelAtPeriodEnd ? "access_ends" : "renews",
          at: end,
        }
      : null,
  };
}
