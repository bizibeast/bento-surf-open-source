import { z } from "zod";

export const cancellationReasonSchema = z.enum([
  "budget",
  "break",
  "missing_capability",
  "product_problem",
  "moving_elsewhere",
]);
export type CancellationReason = z.infer<typeof cancellationReasonSchema>;

export function firstOfferAvailable(input: {
  ownerHasAttempt: boolean;
  customerHasAttempt: boolean;
  legacyOfferRedeemed: boolean;
}) {
  return !input.ownerHasAttempt && !input.customerHasAttempt && !input.legacyOfferRedeemed;
}

export function selectCancellationOffer(input: {
  reason: CancellationReason | null;
  subscription: {
    status: string;
    plan_id: string;
    billing_interval: string | null;
    pending_plan_id: string | null;
  };
  signals: { activeIntegrations: number; hasSocial: boolean; activeUsage: boolean };
  discountConfigured: boolean;
}) {
  const { reason, subscription, signals, discountConfigured } = input;
  if (!reason || reason === "moving_elsewhere") return null;
  if (subscription.status === "trialing") {
    return signals.activeIntegrations >= 3 && signals.hasSocial && signals.activeUsage
      ? ("trial_extension" as const)
      : null;
  }
  if (!["store", "creator", "creator_plus"].includes(subscription.plan_id)) return null;
  if (reason === "break" && !subscription.pending_plan_id) return "pause" as const;
  if (reason === "budget") {
    if (["creator", "creator_plus"].includes(subscription.plan_id) && !subscription.pending_plan_id)
      return "downgrade" as const;
    if (
      ["month", "monthly"].includes(subscription.billing_interval?.toLowerCase() ?? "") &&
      discountConfigured
    )
      return "discount" as const;
  }
  if (reason === "missing_capability" || reason === "product_problem") return "support" as const;
  return null;
}
