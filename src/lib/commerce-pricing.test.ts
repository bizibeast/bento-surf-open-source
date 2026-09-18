import { describe, expect, it } from "vitest";
import { productDraftSchema } from "./commerce.functions";
import { commerceProductPublishabilityError } from "./commerce";

describe("commerce kind pricing", () => {
  it("never publishes a free paid community", () => {
    const product = {
      kind: "paid_community" as const,
      title: "Community",
      description: "A private community.",
      pricing_type: "free" as const,
      price_amount: 0,
      currency: "usd",
      cta_label: "Join",
      settings: { welcomeMessage: "Welcome" },
    };

    expect(productDraftSchema.safeParse(product).success).toBe(false);
    expect(commerceProductPublishabilityError(product)).toBe(
      "Paid communities require paid pricing.",
    );
  });
});
