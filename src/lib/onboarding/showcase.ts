import {
  minimumPlanForEntitlement,
  PAID_PLAN_IDS,
  planName,
  type EntitlementKey,
  type PaidPlanId,
} from "../plans";

export type ShowcaseItem = {
  id: "brain" | "sell" | "post" | "ideas" | "ai";
  title: string;
  body: string;
  /** Entitlement that gates the capability, so the plan label follows src/lib/plans.ts. */
  entitlement: EntitlementKey;
};

/** Plans that include an entitlement, lowest first. */
export function plansIncluding(entitlement: EntitlementKey): PaidPlanId[] {
  const minimum = minimumPlanForEntitlement(entitlement) as PaidPlanId;
  return PAID_PLAN_IDS.slice(PAID_PLAN_IDS.indexOf(minimum));
}

/** "Creator Plus only" or "Included with Creator and Creator Plus". Never implies a lower plan. */
export function planAvailabilityLabel(entitlement: EntitlementKey) {
  const plans = plansIncluding(entitlement).map(planName);
  if (plans.length === 1) return `Included with ${plans[0]} only`;
  return `Included with ${plans.slice(0, -1).join(", ")} and ${plans[plans.length - 1]}`;
}

/** Names only what the plans already list. No numbers, no outcome claims. */
export function showcaseItems(brainChapters: number): ShowcaseItem[] {
  return [
    {
      id: "brain",
      title: "Your Brain",
      body:
        brainChapters > 0
          ? `The chapters you just reviewed: your voice, audience and strategy, in one place you control.`
          : "Your voice, audience and strategy, in one place you control.",
      entitlement: "brain",
    },
    {
      id: "ai",
      title: "AI that creates with you",
      body: "An Agent and routines that draft posts from your Brain and real sources. You review everything before it goes out.",
      entitlement: "contentAgent",
    },
    {
      id: "sell",
      title: "Sell products",
      body: "A creator store with one-tap checkout for digital products, bookings, courses and memberships.",
      entitlement: "storeCards",
    },
    {
      id: "post",
      title: "Schedule and post",
      body: "Plan posts for your socials in one scheduler and publish when you approve them.",
      entitlement: "postScheduler",
    },
    {
      id: "ideas",
      title: "Content ideas",
      body: "Discover ideas for your next post from your space, with links to the originals.",
      entitlement: "discover",
    },
  ];
}
