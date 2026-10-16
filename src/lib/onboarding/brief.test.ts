import { continueWithoutOnboardingDrafts, onboardingCandidatesSchema } from "./brief";
import { describe, expect, it } from "vitest";
import { completeContentStrategy } from "../content-brain";
import {
  onboardingBriefSchema,
  buildManualCandidates,
  preparationReady,
  recommendedPlan,
} from "./brief";

describe("onboarding preparation", () => {
  const brief = {
    displayName: "Ari",
    username: "ari",
    expertise: "Photography",
    audience: "New photographers",
    goal: "sell" as const,
    voice: "Warm and practical",
    platform: "instagram" as const,
  };
  it("builds honest usable core context without social accounts, offers or invented stories", () => {
    const parsed = onboardingBriefSchema.parse(brief);
    const candidates = buildManualCandidates(parsed);
    expect(candidates.brain.map((item) => item.kind)).toEqual([
      "profile",
      "instruction",
      "strategy",
    ]);
    expect(completeContentStrategy(candidates.brain[2].content)).toBe(true);
    expect(candidates.brain[0].content).toContain("New photographers");
    expect(candidates.drafts).toEqual([]);
    expect(preparationReady(parsed, candidates)).toBe(true);
  });
  it("rejects unsafe destinations and incomplete core context", () => {
    expect(
      onboardingBriefSchema.safeParse({
        ...brief,
        links: [{ title: "Offer", url: "javascript:alert(1)" }],
      }).success,
    ).toBe(false);
    const empty = onboardingBriefSchema.parse({});
    expect(preparationReady(empty, buildManualCandidates(empty))).toBe(false);
  });
  it("recommends a plan from intent without changing the user's choice", () => {
    expect(recommendedPlan("sell")).toBe("store");
    expect(recommendedPlan("grow")).toBe("creator");
    expect(recommendedPlan("publish")).toBe("creator_plus");
  });
});

it("retains legacy copy separately when explicitly continuing without starter drafts", () => {
  const candidates = {
    ...buildManualCandidates(onboardingBriefSchema.parse({ platform: "instagram" })),
    drafts: [{ title: "Old draft", body: "Creator's saved script" }],
  };
  const continued = continueWithoutOnboardingDrafts(candidates);
  expect(continued.drafts).toEqual([]);
  expect(continued.deferredDrafts).toEqual(candidates.drafts);
  expect(onboardingCandidatesSchema.parse(continued).deferredDrafts).toEqual(candidates.drafts);
  expect(continueWithoutOnboardingDrafts(continued).deferredDrafts).toEqual(candidates.drafts);
});
