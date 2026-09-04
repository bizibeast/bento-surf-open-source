import { describe, expect, it } from "vitest";
import {
  calculateCommerceCheckoutQuote,
  calculateCommerceDiscount,
  commerceCheckoutRequestsAdjustedPrice,
  normalizeCommerceDiscountCode,
} from "./commerce-growth";

describe("commerce growth pricing", () => {
  it("normalizes creator codes consistently", () => {
    expect(normalizeCommerceDiscountCode(" summer 25 ")).toBe("SUMMER25");
  });

  it("calculates percent discounts in integer minor units", () => {
    expect(calculateCommerceDiscount(1_999, { id: "code", type: "percent", value: 2_500 })).toBe(
      499,
    );
  });

  it("caps fixed discounts at the eligible primary amount", () => {
    expect(calculateCommerceDiscount(500, { id: "code", type: "fixed", value: 900 })).toBe(500);
  });

  it("does not discount recording add-ons or order bumps", () => {
    expect(
      calculateCommerceCheckoutQuote({
        primaryAmount: 2_000,
        recordingAddonAmount: 500,
        bumpAmount: 750,
        bumpProductId: "bump",
        discount: { id: "discount", type: "percent", value: 5_000 },
      }),
    ).toEqual({
      primaryAmount: 2_000,
      recordingAddonAmount: 500,
      bumpAmount: 750,
      subtotalAmount: 3_250,
      discountAmount: 1_000,
      grossAmount: 2_250,
      discountCodeId: "discount",
      bumpProductId: "bump",
    });
  });

  it("treats every checkout-specific price change as an adjustment", () => {
    expect(commerceCheckoutRequestsAdjustedPrice({ discountCode: "SAVE10" })).toBe(true);
    expect(commerceCheckoutRequestsAdjustedPrice({ bumpProductId: "bump" })).toBe(true);
    expect(commerceCheckoutRequestsAdjustedPrice({ recordingAddonAmount: 500 })).toBe(true);
    expect(
      commerceCheckoutRequestsAdjustedPrice({
        discountCode: " ",
        bumpProductId: null,
        recordingAddonAmount: 0,
      }),
    ).toBe(false);
  });
});
