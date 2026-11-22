import type { PaidPlanId } from "../plans";

/**
 * Plan pre-selected on the onboarding trial step. Store and Creator stay one tap away.
 * Changing this is a pricing decision for Yash; it matches production as of 24 Oct 2026.
 */
export const ONBOARDING_DEFAULT_TRIAL_PLAN: PaidPlanId = "creator_plus";

/**
 * What a creator keeps from onboarding on each plan. Brain chapters and starter drafts are
 * always saved and downloadable; Creator+ can open them in Brain and Agent.
 */
export function onboardingPlanAftercare(plan: PaidPlanId) {
  if (plan === "creator_plus")
    return "Your Brain chapters and starter draft open in Brain and Agent as soon as your trial starts.";
  if (plan === "creator")
    return "Use Benny and your saved creator memory with your own AI API key. Creator+ includes Bento-managed AI and scheduled routines within usage limits. Your chapters and starter draft stay saved and downloadable.";
  return "Benny and creator tools are available on Creator with your own AI, or on Creator+ with managed AI. Your chapters and starter draft stay saved and downloadable.";
}
