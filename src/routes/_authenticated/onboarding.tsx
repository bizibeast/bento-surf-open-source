import { OnboardingErrorScreen } from "@/components/onboarding/OnboardingErrorScreen";
import { createFileRoute } from "@tanstack/react-router";
import { OnboardingExperience } from "@/components/onboarding/OnboardingExperience";

export const Route = createFileRoute("/_authenticated/onboarding")({
  head: () => ({
    meta: [{ name: "google", content: "notranslate" }, { title: "Build your Bento | bento.surf" }],
  }),
  errorComponent: OnboardingErrorScreen,
  component: OnboardingExperience,
});
