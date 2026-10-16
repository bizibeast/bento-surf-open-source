import { describe, expect, it } from "vitest";
import { resolveBillingProduct, trialExtensionEnd, verifiedTrialEnd } from "./billing-catalog";

describe("versioned billing catalog", () => {
  const env = {
    DODO_STORE_MONTHLY_PRODUCT_ID: "old-store",
    DODO_STORE_19_MONTHLY_PRODUCT_ID: "new-store",
    DODO_CREATOR_PLUS_MONTHLY_PRODUCT_ID: "plus",
    DODO_STORE_190_YEARLY_PRODUCT_ID: "new-store-yearly",
    DODO_CREATOR_390_YEARLY_PRODUCT_ID: "new-creator-yearly",
    DODO_CREATOR_PLUS_490_YEARLY_PRODUCT_ID: "new-plus-yearly",
  };
  it("keeps existing product contracts separate from new monthly prices", () => {
    expect(resolveBillingProduct("old-store", env)).toEqual({
      plan: "store",
      period: "monthly",
      catalog: "legacy",
    });
    expect(resolveBillingProduct("new-store", env)).toEqual({
      plan: "store",
      period: "monthly",
      catalog: "2026-10",
    });
    expect(resolveBillingProduct("plus", env)?.plan).toBe("creator_plus");
    expect(resolveBillingProduct("new-store-yearly", env)).toEqual({
      plan: "store",
      period: "yearly",
      catalog: "2026-10",
    });
    expect(resolveBillingProduct("new-creator-yearly", env)).toEqual({
      plan: "creator",
      period: "yearly",
      catalog: "2026-10",
    });
    expect(resolveBillingProduct("new-plus-yearly", env)).toEqual({
      plan: "creator_plus",
      period: "yearly",
      catalog: "2026-10",
    });
    expect(resolveBillingProduct("unknown", env)).toBeNull();
  });
  it("rejects product IDs reused between contract catalogs", () => {
    expect(
      resolveBillingProduct("old-store", { ...env, DODO_STORE_19_MONTHLY_PRODUCT_ID: "old-store" }),
    ).toBeNull();
  });
  it("uses the provider's full three-day trial and never starts from receipt time", () => {
    const subscription = {
      created_at: "2026-10-07T12:00:00Z",
      next_billing_date: "2026-10-10T12:00:00Z",
      trial_period_days: 3,
      status: "active",
    };
    expect(verifiedTrialEnd(subscription, Date.parse("2026-10-08T12:00:00Z"))).toBe(
      "2026-10-10T12:00:00.000Z",
    );
    expect(verifiedTrialEnd(subscription, Date.parse("2026-10-10T12:00:00Z"))).toBeNull();
    expect(verifiedTrialEnd({ ...subscription, status: "pending" })).toBeNull();
    expect(verifiedTrialEnd({ ...subscription, created_at: undefined })).toBeNull();
    expect(
      verifiedTrialEnd(
        { ...subscription, next_billing_date: "2026-10-11T12:00:00Z" },
        Date.parse("2026-10-08T12:00:00Z"),
      ),
    ).toBeNull();
  });
  it("allows a bounded Dodo card-authorization delay without treating renewals as trials", () => {
    const subscription = {
      created_at: "2026-10-07T12:00:00Z",
      next_billing_date: "2026-10-10T12:03:00Z",
      trial_period_days: 3,
      status: "active",
    };
    const now = Date.parse("2026-10-08T12:00:00Z");
    expect(verifiedTrialEnd(subscription, now)).toBe("2026-10-10T12:03:00.000Z");
    expect(verifiedTrialEnd(subscription, Date.parse("2026-10-10T12:01:00Z"))).toBe(
      "2026-10-10T12:03:00.000Z",
    );
    expect(
      verifiedTrialEnd({ ...subscription, next_billing_date: "2026-10-10T12:31:00Z" }, now),
    ).toBeNull();
    expect(
      verifiedTrialEnd({ ...subscription, next_billing_date: "2026-10-10T11:58:00Z" }, now),
    ).toBeNull();
  });
  it("extends to seven full days from the verified initial end and retries idempotently", () => {
    const initialEnd = "2026-10-10T12:03:00Z";
    const extendedEnd = "2026-10-14T12:03:00.000Z";
    expect(trialExtensionEnd(initialEnd, null, null)).toBe(extendedEnd);
    expect(trialExtensionEnd(extendedEnd, extendedEnd, "2026-10-08T12:00:00Z")).toBe(extendedEnd);
    expect(trialExtensionEnd("invalid", null, null)).toBeNull();
  });
  it("honors an existing seven-day trial and only a server-approved extension", () => {
    const started = "2026-10-07T12:00:00Z";
    const sevenDayEnd = "2026-10-14T12:00:00Z";
    const legacy = {
      created_at: started,
      next_billing_date: sevenDayEnd,
      trial_period_days: 7,
      status: "active",
    };
    expect(verifiedTrialEnd(legacy, Date.parse(started), 7)).toBe("2026-10-14T12:00:00.000Z");
    const extended = { ...legacy, trial_period_days: 3 };
    expect(verifiedTrialEnd(extended, Date.parse(started), 3)).toBeNull();
    expect(verifiedTrialEnd(extended, Date.parse(started), 3, sevenDayEnd)).toBe(
      "2026-10-14T12:00:00.000Z",
    );
  });
});
