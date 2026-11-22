import { expect, it } from "vitest";
import { PAID_PLAN_IDS } from "../plans";
import { plansIncluding } from "./showcase";
import { ONBOARDING_DEFAULT_TRIAL_PLAN, onboardingPlanAftercare } from "./trial-plan";

it("keeps the production default trial plan until Yash changes it", () => {
  expect(ONBOARDING_DEFAULT_TRIAL_PLAN).toBe("creator_plus");
  expect(PAID_PLAN_IDS).toContain(ONBOARDING_DEFAULT_TRIAL_PLAN);
});

it("distinguishes Creator BYOK from Creator+ managed AI without losing saved work", () => {
  expect(plansIncluding("brain")).toEqual(["creator_plus"]);
  expect(plansIncluding("contentAgent")).toEqual(["creator_plus"]);
  for (const plan of ["store", "creator"] as const) {
    const copy = onboardingPlanAftercare(plan);
    expect(copy).toContain("Creator+");
    expect(copy).toContain("downloadable");
    expect(copy).not.toMatch(/\u2014|keep access/i);
  }
  expect(onboardingPlanAftercare("creator")).toContain("own AI API key");
  expect(onboardingPlanAftercare("creator_plus")).toContain("open in Brain and Agent");
});
