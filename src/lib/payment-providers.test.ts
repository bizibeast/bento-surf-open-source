import { describe, expect, it } from "vitest";
import {
  CREATOR_PAYMENT_PROVIDERS,
  CREATOR_PAYMENT_PROVIDER_DEFINITIONS,
  creatorPaymentCompatibility,
  creatorPaymentSupportsCheckoutAdjustments,
  formatFeeBps,
  providerCanCollectBentoCommission,
  recommendedCreatorPaymentProvider,
} from "./payment-providers";

describe("creator payment provider capabilities", () => {
  it("only enables providers with an atomic platform-fee primitive", () => {
    // Direct Stripe keys charge the creator account itself. Bento deliberately
    // has no application-fee capability in this connection mode.
    expect(providerCanCollectBentoCommission("stripe")).toBe(false);
    expect(providerCanCollectBentoCommission("paypal")).toBe(false);
    expect(providerCanCollectBentoCommission("razorpay")).toBe(false);
    expect(providerCanCollectBentoCommission("polar")).toBe(false);
    expect(providerCanCollectBentoCommission("dodo")).toBe(false);
    expect(providerCanCollectBentoCommission("creem")).toBe(false);
    expect(providerCanCollectBentoCommission("unknown")).toBe(false);
  });

  it("limits checkout-specific promotions to adapters with arbitrary signed totals", () => {
    expect(creatorPaymentSupportsCheckoutAdjustments("stripe")).toBe(true);
    expect(creatorPaymentSupportsCheckoutAdjustments("paypal")).toBe(true);
    expect(creatorPaymentSupportsCheckoutAdjustments("razorpay")).toBe(true);
    expect(creatorPaymentSupportsCheckoutAdjustments("mock")).toBe(true);
    expect(creatorPaymentSupportsCheckoutAdjustments("polar")).toBe(false);
    expect(creatorPaymentSupportsCheckoutAdjustments("dodo")).toBe(false);
    expect(creatorPaymentSupportsCheckoutAdjustments("creem")).toBe(false);
  });

  it("keeps recurring support explicit instead of silently downgrading checkout", () => {
    const support = Object.fromEntries(
      CREATOR_PAYMENT_PROVIDER_DEFINITIONS.map((provider) => [
        provider.id,
        provider.supportsSubscriptions,
      ]),
    );
    expect(support).toEqual({
      stripe: true,
      paypal: true,
      razorpay: true,
      polar: true,
      dodo: true,
      creem: true,
    });
  });

  it("documents an exact and honest setup path for every provider", () => {
    for (const provider of CREATOR_PAYMENT_PROVIDER_DEFINITIONS) {
      expect(provider.docsUrl).toMatch(/^https:\/\//);
      expect(provider.setupNote.length).toBeGreaterThan(20);
      expect(provider.creatorSetupSteps).toHaveLength(3);
    }
    expect(
      Object.fromEntries(
        CREATOR_PAYMENT_PROVIDER_DEFINITIONS.map((provider) => [
          provider.id,
          provider.directConnect,
        ]),
      ),
    ).toEqual({
      stripe: true,
      paypal: true,
      razorpay: true,
      polar: true,
      dodo: true,
      creem: true,
    });
  });

  it("formats basis points as a creator-facing percentage", () => {
    expect(formatFeeBps(800)).toBe("8%");
    expect(formatFeeBps(425)).toBe("4.25%");
    expect(formatFeeBps(0)).toBe("0%");
  });

  it("recommends Dodo in India and Polar everywhere else", () => {
    expect(recommendedCreatorPaymentProvider("IN")).toBe("dodo");
    expect(recommendedCreatorPaymentProvider("in")).toBe("dodo");
    expect(recommendedCreatorPaymentProvider("US")).toBe("polar");
    expect(recommendedCreatorPaymentProvider(null)).toBe("polar");
  });

  it("enforces one canonical offer compatibility policy", () => {
    expect(creatorPaymentCompatibility("stripe", "coaching_call", "one_time")).toEqual({
      supported: true,
      reason: null,
    });
    expect(creatorPaymentCompatibility("dodo", "digital_product", "one_time").supported).toBe(true);
    expect(creatorPaymentCompatibility("dodo", "coaching_call", "one_time")).toMatchObject({
      supported: false,
    });
    expect(creatorPaymentCompatibility("polar", "paid_community", "subscription")).toMatchObject({
      supported: false,
    });
    expect(creatorPaymentCompatibility("razorpay", "membership", "subscription")).toMatchObject({
      supported: true,
    });
    expect(creatorPaymentCompatibility("paypal", "course", "subscription")).toMatchObject({
      supported: true,
    });
    expect(creatorPaymentCompatibility("stripe", "priority_dm", "one_time").supported).toBe(true);
    expect(creatorPaymentCompatibility("paypal", "bundle", "one_time").supported).toBe(true);
    expect(creatorPaymentCompatibility("razorpay", "bundle", "one_time").supported).toBe(true);
    expect(creatorPaymentCompatibility("unknown", "digital_product", "one_time")).toMatchObject({
      supported: false,
    });
    expect(creatorPaymentCompatibility("unknown", "course", "free")).toEqual({
      supported: true,
      reason: null,
    });
  });

  it.each(CREATOR_PAYMENT_PROVIDERS)(
    "allows a paid newsletter through %s while retaining actual currency and cadence checks",
    (provider) => {
      for (const billingInterval of ["month", "year"]) {
        expect(
          creatorPaymentCompatibility(provider, "newsletter", "subscription", {
            billingInterval,
            currency: "usd",
          }),
        ).toEqual({ supported: true, reason: null });
      }
    },
  );

  it.each(["dodo", "creem"])(
    "allows hosted digital communities and memberships through %s",
    (provider) => {
      for (const kind of ["paid_community", "membership"] as const) {
        for (const pricing of ["one_time", "subscription"] as const) {
          expect(
            creatorPaymentCompatibility(provider, kind, pricing, {
              billingInterval: "month",
              currency: "usd",
            }),
          ).toEqual({ supported: true, reason: null });
        }
      }
    },
  );

  it("keeps Polar's community-access policy consistent for hosted memberships", () => {
    for (const kind of ["paid_community", "membership"] as const) {
      expect(creatorPaymentCompatibility("polar", kind, "subscription").supported).toBe(false);
    }
  });

  it.each(["dodo", "polar", "creem"])(
    "does not treat human services or unclassified fulfillment as approved digital goods on %s",
    (provider) => {
      for (const kind of ["coaching_call", "priority_dm", "webinar", "custom_product"] as const) {
        expect(creatorPaymentCompatibility(provider, kind, "one_time").supported).toBe(false);
      }
    },
  );

  it.each(["dodo", "polar", "creem"])(
    "allows digital bundles on %s only after validating any supplied fulfillment context",
    (provider) => {
      // Omitting context answers only whether the adapter has bundle checkout capability.
      // Server publication, quote, and checkout must supply the actual loaded children.
      expect(creatorPaymentCompatibility(provider, "bundle", "one_time").supported).toBe(true);
      expect(
        creatorPaymentCompatibility(provider, "bundle", "one_time", {
          bundledProducts: [{ kind: "digital_product" }, { kind: "course" }],
        }),
      ).toEqual({ supported: true, reason: null });
      for (const kind of [
        "custom_product",
        "coaching_call",
        "priority_dm",
        "webinar",
        "bundle",
      ] as const) {
        expect(
          creatorPaymentCompatibility(provider, "bundle", "one_time", {
            bundledProducts: [{ kind: "digital_product" }, { kind }],
          }),
        ).toMatchObject({ supported: false, reason: expect.stringContaining("bundle") });
      }
      for (const bundledProducts of [
        [],
        [{ kind: "course" as const }],
        Array.from({ length: 21 }, () => ({ kind: "course" as const })),
      ]) {
        expect(
          creatorPaymentCompatibility(provider, "bundle", "one_time", { bundledProducts })
            .supported,
        ).toBe(false);
      }
    },
  );

  it("keeps newsletter currency and interval restrictions at the provider boundary", () => {
    expect(
      creatorPaymentCompatibility("paypal", "newsletter", "subscription", {
        billingInterval: "month",
        currency: "inr",
      }),
    ).toMatchObject({ supported: false, reason: expect.stringContaining("INR") });
    expect(
      creatorPaymentCompatibility("razorpay", "newsletter", "subscription", {
        billingInterval: "day",
        currency: "usd",
      }),
    ).toMatchObject({ supported: false, reason: expect.stringContaining("billing interval") });
  });

  it("checks the actual recurring interval before a Razorpay product is published", () => {
    expect(
      creatorPaymentCompatibility("razorpay", "paid_community", "subscription", {
        billingInterval: "day",
        currency: "usd",
      }).supported,
    ).toBe(false);
    for (const billingInterval of ["week", "month", "year"]) {
      expect(
        creatorPaymentCompatibility("razorpay", "paid_community", "subscription", {
          billingInterval,
          currency: "usd",
        }).supported,
      ).toBe(true);
    }
    expect(
      creatorPaymentCompatibility("razorpay", "paid_community", "free", {
        billingInterval: null,
        currency: "usd",
      }).supported,
    ).toBe(true);
  });

  it("rejects unsupported PayPal currencies before publication but keeps free offers available", () => {
    expect(
      creatorPaymentCompatibility("paypal", "paid_community", "subscription", {
        billingInterval: "month",
        currency: "inr",
      }).supported,
    ).toBe(false);
    expect(
      creatorPaymentCompatibility("paypal", "paid_community", "subscription", {
        billingInterval: "month",
        currency: "usd",
      }).supported,
    ).toBe(true);
    expect(
      creatorPaymentCompatibility("paypal", "paid_community", "free", { currency: "inr" })
        .supported,
    ).toBe(true);
  });

  it("matches PayPal publication intervals to the checkout adapter", () => {
    for (const billingInterval of ["hour", "quarter"]) {
      expect(
        creatorPaymentCompatibility("paypal", "course", "subscription", {
          billingInterval,
          currency: "usd",
        }),
      ).toMatchObject({ supported: false, reason: expect.stringContaining("billing interval") });
    }
    for (const billingInterval of ["day", "week", "month", "year"]) {
      expect(
        creatorPaymentCompatibility("paypal", "course", "subscription", {
          billingInterval,
          currency: "usd",
        }).supported,
      ).toBe(true);
    }
    expect(
      creatorPaymentCompatibility("paypal", "course", "free", {
        billingInterval: "week",
        currency: "usd",
      }).supported,
    ).toBe(true);
  });
});
