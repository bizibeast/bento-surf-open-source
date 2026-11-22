import { expect, it } from "vitest";
import {
  answeredFields,
  createOnboardingFunnel,
  markOnboardingNavigationIntent,
} from "./funnel-tracking";
it("records changes, deduplicates exits, and distinguishes intentional redirects", () => {
  const funnel = createOnboardingFunnel(1000);
  expect(funnel.view(2, "displayName", true, 2000)).toEqual({
    step: 2,
    step_name: "questions",
    question: "displayName",
    revision_resumed: true,
  });
  expect(funnel.view(2, "displayName", true, 3000)).toBeNull();
  expect(funnel.leave({}, 5000)).toEqual({
    seconds_on_step: 3,
    seconds_since_start: 4,
    reason: "closed_or_hidden",
  });
  expect(funnel.leave({}, 6000)).toBeNull();
  expect(funnel.view(2, "expertise", false, 6000)).not.toBeNull();
  markOnboardingNavigationIntent("connect_redirect");
  expect(funnel.leave({}, 7000)?.reason).toBe("connect_redirect");
  funnel.view(5, "audience", false, 8000);
  markOnboardingNavigationIntent("checkout_redirect");
  expect(funnel.leave({}, 9000)?.reason).toBe("checkout_redirect");
});
it("counts only nonempty answers", () => {
  expect(answeredFields({ displayName: "Ada", expertise: " ", audience: "creators" })).toBe(2);
});
