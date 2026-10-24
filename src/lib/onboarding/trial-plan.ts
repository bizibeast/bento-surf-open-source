import type { PaidPlanId } from "../plans";

/**
 * Plan pre-selected on the onboarding trial step. Store and Creator stay one tap away.
 * Changing this is a pricing decision for Yash; it matches production as of 24 Oct 2026.
 */
export const ONBOARDING_DEFAULT_TRIAL_PLAN: PaidPlanId = "creator_plus";

/**
 * What a creator keeps from onboarding on each plan. Brain chapters and starter drafts are
 * always saved and downloadable; only Creator Plus can open them in Brain and Agent.
 */
export function onboardingPlanAftercare(plan: PaidPlanId) {
  if (plan === "creator_plus")
    return "Your Brain chapters and starter draft open in Brain and Agent as soon as your trial starts.";
  return "Brain and Agent are included with Creator Plus only. On this plan, your Brain chapters and starter draft stay saved and you can download them anytime. They open in Brain and Agent if you move to Creator Plus.";
}
