import { describe, expect, it } from "vitest";

import {
  CONTACT_TIER_OPTIONS,
  CONTACT_TIER_PRICING,
  PAID_CONTACT_TIER_OPTIONS,
  PLAN_HIGHLIGHTS,
  PLAN_FEATURES,
  PLAN_PRICING,
  PAID_PLAN_IDS,
  NEW_BILLING_PERIODS,
  minimumPlanForEntitlement,
  normalizePlan,
  CONNECTED_PAYMENTS_REQUIRED_MESSAGE,
  creatorPaymentsUnlocked,
  planHasEntitlement,
  planLimits,
  storageAddonPrice,
  TRIAL_DAYS,
  usesAdvancedAutoDm,
} from "./plans";

describe("creator plans", () => {

  it("prices yearly plans at ten monthly payments", () => {
    expect(PLAN_PRICING.store.monthly.amount).toBe(19);
    expect(PLAN_PRICING.store.yearly.amount).toBe(190);
    expect(PLAN_PRICING.creator.monthly.amount).toBe(39);
    expect(PLAN_PRICING.creator.yearly.amount).toBe(390);
    expect(TRIAL_DAYS).toBe(3);
    expect(PLAN_PRICING.creator_plus.monthly.amount).toBe(49);
    expect(PLAN_PRICING.creator_plus.yearly.amount).toBe(490);
    expect(PAID_PLAN_IDS).toEqual(["store", "creator", "creator_plus"]);
    expect(NEW_BILLING_PERIODS).toEqual(["monthly", "yearly"]);
  });

  it("advertises Bento's zero sales fee on the Store plan", () => {
    expect(PLAN_HIGHLIGHTS.store).toContain("0% Bento platform fee on sales");
  });

  it("keeps Free unlimited for ordinary blocks but limited elsewhere", () => {
    const free = planLimits("free");
    expect(free.maxPages).toBe(5);
    expect(free.maxLinksAndBlocks).toBeNull();
    expect(free.storageMb).toBe(1024);
    expect(free.analyticsHistoryDays).toBe(7);
    expect(planHasEntitlement("free", "allThemes")).toBe(true);
    expect(planHasEntitlement("free", "customFonts")).toBe(true);
    expect(planHasEntitlement("free", "instagramAutoDM")).toBe(true);
    expect(planHasEntitlement("free", "advancedAutoDM")).toBe(false);
    expect(planHasEntitlement("free", "storeCards")).toBe(false);
    expect(planHasEntitlement("free", "oneTapCheckout")).toBe(false);
    expect(creatorPaymentsUnlocked({ plan: "free" })).toBe(false);
    expect(
      creatorPaymentsUnlocked({
        plan: "free",
        subscriptionStatus: "trialing",
        subscriptionPlan: "store",
      }),
    ).toBe(true);
    expect(
      creatorPaymentsUnlocked({
        plan: "free",
        subscriptionStatus: "trialing",
        subscriptionPlan: "creator_plus",
      }),
    ).toBe(true);
    expect(
      creatorPaymentsUnlocked({
        plan: "free",
        subscriptionStatus: "active",
        subscriptionPlan: "store",
      }),
    ).toBe(false);
    expect(
      creatorPaymentsUnlocked({
        plan: "free",
        subscriptionStatus: "trialing",
        subscriptionPlan: "free",
      }),
    ).toBe(false);
    expect(creatorPaymentsUnlocked({ plan: "store" })).toBe(true);
    expect(CONNECTED_PAYMENTS_REQUIRED_MESSAGE).toContain("3-day");
    expect(CONNECTED_PAYMENTS_REQUIRED_MESSAGE).not.toMatch(/7-day|7 day|\u2014|\u2013/);
    expect(planHasEntitlement("free", "customDomain")).toBe(false);
    expect(planHasEntitlement("free", "liveSocialPreviews")).toBe(false);
  });

  it("gives paid plans their included storage allowances", () => {
    expect(planLimits("store").maxPages).toBeNull();
    expect(planLimits("creator").maxPages).toBeNull();
    expect(planLimits("store").storageMb).toBe(10 * 1024);
    expect(planLimits("creator").storageMb).toBe(50 * 1024);
    expect(planLimits("creator_plus").storageMb).toBe(100 * 1024);
    expect(PLAN_FEATURES.find((row) => row.label === "Storage")).toMatchObject({
      store: "10 GB",
      creator: "50 GB",
      creator_plus: "100 GB",
    });
    expect(PLAN_HIGHLIGHTS.store).toContain("Unlimited pages and blocks");
  });

  it("separates Store monetization and automation from Creator growth", () => {
    expect(planHasEntitlement("store", "advancedAutoDM")).toBe(false);
    expect(planHasEntitlement("store", "storeCards")).toBe(true);
    expect(planHasEntitlement("store", "courses")).toBe(true);
    expect(planHasEntitlement("store", "postScheduler")).toBe(false);
    expect(planHasEntitlement("store", "socialAnalytics")).toBe(false);
    expect(planHasEntitlement("store", "liveSocialPreviews")).toBe(true);
    expect(planHasEntitlement("creator", "postScheduler")).toBe(true);
    expect(planHasEntitlement("creator", "socialAnalytics")).toBe(true);
    expect(minimumPlanForEntitlement("customDomain")).toBe("creator");
    expect(minimumPlanForEntitlement("liveSocialPreviews")).toBe("store");
    expect(minimumPlanForEntitlement("discountCodes")).toBe("store");
  });

  it("defines the Email Marketing contact and storage add-on contract", () => {
    expect(planHasEntitlement("store", "emailCollection")).toBe(true);
    expect(planHasEntitlement("store", "emailListBuilder")).toBe(false);
    expect(planHasEntitlement("store", "emailMarketing")).toBe(false);
    expect(minimumPlanForEntitlement("emailMarketing")).toBe("creator");
    expect(CONTACT_TIER_OPTIONS).toEqual([500, 5_000, 10_000, 25_000, 50_000, 100_000, 150_000]);
    expect(PAID_CONTACT_TIER_OPTIONS).toEqual([5_000, 10_000, 25_000, 50_000, 100_000, 150_000]);
    expect(CONTACT_TIER_PRICING[25_000]).toEqual({ monthly: 200, yearly: 2_000 });
    expect(storageAddonPrice("monthly", 37)).toBe(37);
    expect(storageAddonPrice("yearly", 37)).toBe(370);
    expect(PLAN_FEATURES.find((row) => row.label === "Newsletter")).toMatchObject({
      store: "Capture up to 500",
      creator: "500 contacts, unlimited sends; larger tiers available",
    });
  });

  it("detects advanced Auto DM mechanics independently of provider", () => {
    expect(usesAdvancedAutoDm({})).toBe(false);
    expect(usesAdvancedAutoDm({ excludedKeywords: ["spam"] })).toBe(true);
    expect(usesAdvancedAutoDm({ emailCaptureEnabled: true })).toBe(true);
    expect(usesAdvancedAutoDm({ followGateEnabled: true })).toBe(true);
  });

  it("normalizes legacy database and billing values safely", () => {
    expect(normalizePlan("creator_plus")).toBe("creator_plus");
    expect(normalizePlan("max")).toBe("creator");
    expect(normalizePlan("pro")).toBe("store");
    expect(normalizePlan("link")).toBe("store");
    expect(normalizePlan("store")).toBe("store");
    expect(normalizePlan("lifetime")).toBe("free");
    expect(normalizePlan(null, true)).toBe("store");
  });

  it("keeps Creator distribution separate from the Plus Brain and routine features", () => {
    for (const feature of [
      "discover",
      "postScheduler",
      "emailMarketing",
      "mcpSocialAutomation",
    ] as const) {
      expect(planHasEntitlement("creator", feature)).toBe(true);
      expect(planHasEntitlement("store", feature)).toBe(false);
    }
    for (const feature of [
      "brain",
      "contentAgent",
      "contentRoutines",
      "weeklyStrategyReview",
    ] as const) {
      expect(planHasEntitlement("creator", feature)).toBe(false);
      expect(planHasEntitlement("creator_plus", feature)).toBe(true);
      expect(minimumPlanForEntitlement(feature)).toBe("creator_plus");
      expect(planHasEntitlement("unknown", feature)).toBe(false);
    }
  });

  it("preserves the purchased feature bundle of existing paid contracts", () => {
    expect(planHasEntitlement("store", "advancedAutoDM", "legacy")).toBe(true);
    expect(planHasEntitlement("store", "postScheduler", "legacy")).toBe(false);
    expect(planHasEntitlement("creator", "brain", "legacy")).toBe(true);
    expect(planHasEntitlement("creator", "brain", "2026-10")).toBe(false);
  });
});
