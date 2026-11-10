import { describe, expect, it } from "vitest";
import {
  buildManualCandidates,
  mentionedOnboardingPlatform,
  onboardingBriefSchema,
  onboardingPlatformIsNeutral,
  onboardingStrategyTitle,
  resolveOnboardingPlatform,
} from "./brief";
import { normalizeStrategyContent, repairStrategy } from "./strategy-format";
import { completeContentStrategy } from "../content-brain";
import { preparationSteps } from "@/components/onboarding/OnboardingScreens";
import { checkoutCustomer, checkoutProfileName } from "../billing.functions";

const brief = onboardingBriefSchema.parse({
  displayName: "Maya",
  expertise: "I teach simple weeknight vegetarian cooking for beginners.",
  audience: "Busy beginners who want to cook at home more often.",
});

describe("onboarding platform", () => {
  it("stays platform-neutral when nothing is connected or named", () => {
    expect(mentionedOnboardingPlatform(brief)).toBeNull();
    expect(onboardingPlatformIsNeutral(brief)).toBe(true);
    expect(onboardingStrategyTitle(brief)).toBe("Content Strategy");
    const starter = buildManualCandidates(brief).brain.find((item) => item.kind === "strategy")!;
    expect(starter.title).toBe("Content Strategy");
    expect(starter.content).toContain("on the platform you choose");
    expect(starter.content).not.toMatch(/linkedin/i);
    expect(completeContentStrategy(starter.content)).toBe(true);
  });
  it("uses a platform the creator named or connected", () => {
    const named = { ...brief, audience: "Home cooks who follow me on Instagram reels" };
    expect(mentionedOnboardingPlatform(named)).toBe("instagram");
    expect(resolveOnboardingPlatform(named)).toBe("instagram");
    expect(onboardingStrategyTitle({ ...named, platform: "instagram" })).toBe("Instagram Strategy");
    const connected = { ...brief, primaryConnectionId: "00000000-0000-4000-8000-000000000001" };
    expect(resolveOnboardingPlatform(connected, "twitter")).toBe("twitter");
    expect(onboardingPlatformIsNeutral(connected)).toBe(false);
    expect(resolveOnboardingPlatform(brief)).toBe("linkedin");
  });
});

describe("strategy format repair", () => {
  it("rescales weights and fills only non-pillar sections from the starter", () => {
    const starter = buildManualCandidates(brief).brain.find((item) => item.kind === "strategy")!;
    const repaired = normalizeStrategyContent(
      "## Content Pillars\n### Quick dinners - 30%\nCore message: Fast.\nWhat I share: Recipes.\nWhy it matters: Time.\n### Pantry basics - 30%\nCore Message: Stock up.\nWhat I Share: Lists.\nWhy It Matters: Fewer trips.",
      starter.content,
    );
    expect(repaired).toContain("### 50% Quick dinners");
    expect(repaired).toContain("### 50% Pantry basics");
    expect(repaired.indexOf("## Strategic Goal")).toBeLessThan(
      repaired.indexOf("## Content Pillars"),
    );
    expect(completeContentStrategy(repaired)).toBe(true);
  });
  it("never invents pillars", () => {
    expect(repairStrategy("## Strategic Goal\nGrow.\n\nJust post more.").content).toBeNull();
  });
});

describe("preparation progress", () => {
  it("follows the real job stages", () => {
    const queued = preparationSteps(null, "queued", 0, "Content Strategy");
    expect(queued.steps[0].state).toBe("active");
    const writing = preparationSteps(
      { status: "running", done: ["profile", "instruction"] },
      "running",
      0,
      "Content Strategy",
    );
    expect(writing.steps.map((step) => step.state)).toEqual([
      "done",
      "done",
      "done",
      "active",
      "waiting",
      "waiting",
    ]);
    expect(writing.steps[3].label).toBe("Writing your Content Strategy");
    const drafting = preparationSteps({ status: "ready", done: [] }, "running", 1, "X Strategy");
    expect(drafting.steps.at(-1)!.state).toBe("active");
    expect(drafting.percent).toBeGreaterThan(writing.percent);
    expect(JSON.stringify(drafting.steps)).not.toMatch(/\u2014/);
  });
});

describe("Dodo checkout customer", () => {
  it("prefills the entered name, never the email prefix", () => {
    expect(checkoutCustomer("maya@example.com", "  Maya  Rao ")).toEqual({
      email: "maya@example.com",
      name: "Maya Rao",
    });
    expect(checkoutCustomer("maya@example.com", "Maya")).toEqual({
      email: "maya@example.com",
      name: "Maya",
    });
    expect(checkoutProfileName("maya.r@example.com", "maya.r")).toBeUndefined();
    expect(checkoutProfileName("maya.r@example.com", "Maya Rao")).toBe("Maya Rao");
    expect(checkoutCustomer("maya@example.com")).toEqual({ email: "maya@example.com" });
  });
});
