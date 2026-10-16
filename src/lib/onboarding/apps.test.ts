import { describe, expect, it } from "vitest";
import { APP_GUIDES, appGuideForLocation } from "./apps";
describe("contextual app setup", () => {
  it("covers every sidebar app and independent messaging providers", () => {
    expect(APP_GUIDES).toHaveLength(20);
    expect(new Set(APP_GUIDES.map((app) => app.id)).size).toBe(20);
    for (const app of APP_GUIDES) {
      expect(app.steps).toHaveLength(3);
      expect(app.steps.every((step) => step.title && step.instruction && step.proof)).toBe(true);
    }
  });
  it("resolves content subapps without mixing their progress", () => {
    expect(appGuideForLocation("/content", { tab: "agent", routines: true })?.id).toBe("routines");
    expect(appGuideForLocation("/content", { tab: "brain" })?.id).toBe("brain");
    expect(appGuideForLocation("/content", {})?.id).toBe("discover");
    expect(appGuideForLocation("/onboarding", {})).toBeUndefined();
    expect(appGuideForLocation("/email-marketing/posts/123", {})?.id).toBe("newsletter");
  });
});
