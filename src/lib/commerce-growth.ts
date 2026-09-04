export type CommerceDiscountInput = {
  id: string;
  type: "percent" | "fixed";
  /** Basis points for percent discounts; minor currency units for fixed discounts. */
  value: number;
};

export type CommerceCheckoutQuote = {
  primaryAmount: number;
  recordingAddonAmount: number;
  bumpAmount: number;
  subtotalAmount: number;
  discountAmount: number;
  grossAmount: number;
  discountCodeId: string | null;
  bumpProductId: string | null;
};

export function normalizeCommerceDiscountCode(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

export function commerceCheckoutRequestsAdjustedPrice(input: {
  discountCode?: string | null;
  bumpProductId?: string | null;
  recordingAddonAmount?: number | null;
}) {
  return Boolean(
    normalizeCommerceDiscountCode(input.discountCode || "") ||
    input.bumpProductId ||
    Math.max(0, Math.round(input.recordingAddonAmount || 0)) > 0,
  );
}

export function calculateCommerceDiscount(
  eligibleAmount: number,
  discount?: CommerceDiscountInput | null,
) {
  const boundedEligible = Math.max(0, Math.round(eligibleAmount));
  if (!discount || boundedEligible === 0) return 0;
  const value = Math.max(0, Math.round(discount.value));
  if (discount.type === "fixed") return Math.min(boundedEligible, value);
  return Math.min(
    boundedEligible,
    Math.floor((boundedEligible * Math.min(10_000, value)) / 10_000),
  );
}

/**
 * Discounts intentionally apply only to the primary offer. Recording add-ons
 * and order bumps keep their explicitly displayed price.
 */
export function calculateCommerceCheckoutQuote(input: {
  primaryAmount: number;
  recordingAddonAmount?: number;
  bumpAmount?: number;
  bumpProductId?: string | null;
  discount?: CommerceDiscountInput | null;
}): CommerceCheckoutQuote {
  const primaryAmount = Math.max(0, Math.round(input.primaryAmount));
  const recordingAddonAmount = Math.max(0, Math.round(input.recordingAddonAmount || 0));
  const bumpAmount = Math.max(0, Math.round(input.bumpAmount || 0));
  const subtotalAmount = primaryAmount + recordingAddonAmount + bumpAmount;
  const discountAmount = calculateCommerceDiscount(primaryAmount, input.discount);
  return {
    primaryAmount,
    recordingAddonAmount,
    bumpAmount,
    subtotalAmount,
    discountAmount,
    grossAmount: Math.max(0, subtotalAmount - discountAmount),
    discountCodeId: input.discount?.id || null,
    bumpProductId: bumpAmount > 0 ? input.bumpProductId || null : null,
  };
}
