export const ONBOARDING_STEP_NAMES = [
  "username",
  "socials",
  "questions",
  "brain",
  "showcase",
  "trial",
  "ready",
] as const;
export type Question = "displayName" | "expertise" | "audience";
type Properties = Record<string, string | number | boolean | null>;
let navigationIntent: "connect_redirect" | "checkout_redirect" | null = null;
let currentStep = 0;
export function markOnboardingNavigationIntent(reason: NonNullable<typeof navigationIntent>) {
  navigationIntent = reason;
}
export function onboardingStepProperties(step: number) {
  return { step, step_name: ONBOARDING_STEP_NAMES[step] ?? "unknown" };
}
export function currentOnboardingStep() {
  return onboardingStepProperties(currentStep);
}
export function answeredFields(brief: Record<Question, string>) {
  return (["displayName", "expertise", "audience"] as const).filter((key) => brief[key].trim())
    .length;
}
export function createOnboardingFunnel(startedAt: number) {
  let viewKey = "";
  let viewedAt = startedAt;
  let left = false;
  navigationIntent = null;
  return {
    view(
      step: number,
      question: Question,
      revisionResumed: boolean,
      now: number,
    ): Properties | null {
      const key = `${step}:${step === 2 ? question : ""}`;
      if (key === viewKey) return null;
      currentStep = step;
      viewKey = key;
      viewedAt = now;
      left = false;
      navigationIntent = null;
      return {
        ...onboardingStepProperties(step),
        ...(step === 2 ? { question } : {}),
        revision_resumed: revisionResumed,
      };
    },
    leave(properties: Properties, now: number): Properties | null {
      if (left || !viewKey) return null;
      left = true;
      return {
        ...properties,
        seconds_on_step: Math.max(0, Math.round((now - viewedAt) / 1000)),
        seconds_since_start: Math.max(0, Math.round((now - startedAt) / 1000)),
        reason: navigationIntent ?? "closed_or_hidden",
      };
    },
  };
}
