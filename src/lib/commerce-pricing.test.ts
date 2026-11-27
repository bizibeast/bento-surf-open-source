import { describe, expect, it } from "vitest";
import { productDraftSchema } from "./commerce.functions";
import { commerceProductPublishabilityError, commerceProductRequiresPayment } from "./commerce";

describe("commerce kind pricing", () => {
  const community = {
    kind: "paid_community" as const,
    title: "Community",
    description: "A private community.",
    pricing_type: "free" as const,
    price_amount: 0,
    currency: "usd",
    billing_interval: null,
    cta_label: "Join",
    settings: { welcomeMessage: "Welcome" },
  };

  it.each([
    { pricing_type: "free", price_amount: 0, billing_interval: null },
    { pricing_type: "one_time", price_amount: 1900, billing_interval: null },
    { pricing_type: "subscription", price_amount: 1900, billing_interval: "month" },
  ] as const)("accepts and publishes a $pricing_type community", (pricing) => {
    const product = { ...community, ...pricing };
    expect(productDraftSchema.safeParse(product).success).toBe(true);
    expect(commerceProductPublishabilityError(product)).toBeNull();
  });

  it.each([
    { pricing_type: "free", price_amount: 100, billing_interval: null },
    { pricing_type: "free", price_amount: 0, billing_interval: "month" },
    { pricing_type: "one_time", price_amount: 0, billing_interval: null },
    { pricing_type: "subscription", price_amount: 1900, billing_interval: null },
  ] as const)("rejects inconsistent community pricing: %j", (pricing) => {
    expect(productDraftSchema.safeParse({ ...community, ...pricing }).success).toBe(false);
  });

  it("requires a welcome message even for free communities", () => {
    expect(commerceProductPublishabilityError({ ...community, settings: {} })).toBe(
      "Add a community welcome message before publishing.",
    );
  });

  it.each([
    { pricing_type: "free", kind: "paid_community", settings: {}, requiresPayment: false },
    { pricing_type: "one_time", kind: "paid_community", settings: {}, requiresPayment: true },
    { pricing_type: "subscription", kind: "membership", settings: {}, requiresPayment: true },
    {
      pricing_type: "free",
      kind: "coaching_call",
      settings: { recordingAddonEnabled: true, recordingAddonPrice: 500 },
      requiresPayment: true,
    },
    {
      pricing_type: "free",
      kind: "coaching_call",
      settings: { recordingAddonEnabled: false, recordingAddonPrice: 500 },
      requiresPayment: false,
    },
  ] as const)(
    "identifies whether the offer needs payments: %j",
    ({ requiresPayment, ...product }) => {
      expect(commerceProductRequiresPayment(product)).toBe(requiresPayment);
    },
  );
});
