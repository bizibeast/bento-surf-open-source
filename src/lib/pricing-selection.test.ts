import { describe, expect, it } from "vitest";
import {
  pricingCheckoutDestination,
  pricingOnboardingDestination,
  pricingSelection,
} from "./pricing-selection";
import { authenticatedEntryDestination } from "./auth-entry";

describe("pricing selection handoff", () => {
  it("sends a signed-in visitor to the selected checkout", () => {
    const target = pricingCheckoutDestination("creator_plus", "yearly");
    expect(target).toBe("/settings?section=plan&checkoutPlan=creator_plus&checkoutPeriod=monthly");
    expect(authenticatedEntryDestination(true, target)).toBe(target);
  });
  it("preserves the selection through onboarding", () => {
    const target = pricingCheckoutDestination("creator", "yearly");
    expect(authenticatedEntryDestination(false, target)).toBe(
      "/onboarding?plan=creator&period=yearly",
    );
    expect(pricingOnboardingDestination("store", "monthly")).toBe(
      "/onboarding?plan=store&period=monthly",
    );
    expect(pricingSelection("invalid", "yearly")).toBeNull();
  });
});
