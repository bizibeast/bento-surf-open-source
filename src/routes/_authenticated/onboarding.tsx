import { createFileRoute } from "@tanstack/react-router";
import { OnboardingExperience } from "@/components/onboarding/OnboardingExperience";

export const Route = createFileRoute("/_authenticated/onboarding")({
  head: () => ({ meta: [{ title: "Build your Bento | bento.surf" }] }),
  component: OnboardingExperience,
});
