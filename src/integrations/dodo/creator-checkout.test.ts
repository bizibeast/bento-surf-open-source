import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  createProduct: vi.fn(),
  createCheckout: vi.fn(),
}));
vi.mock("@/lib/secret-crypto.server", () => ({
  encryptServerSecret: vi.fn().mockResolvedValue("encrypted-token"),
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("@/lib/commerce-growth.server", () => ({
  persistCommerceCheckoutGrowth: vi.fn(),
  failCommerceCheckoutSession: vi.fn(),
}));
vi.mock("./creator-client.server", () => ({
  getDodoCreatorPaymentAccount: vi.fn().mockResolvedValue({
    id: "connection",
    provider_account_id: "business",
    charges_enabled: true,
    webhook_secret_ciphertext: "secret",
  }),
  dodoEnvironmentForAccount: () => "test_mode",
  dodoClientForCreatorAccount: vi.fn().mockResolvedValue({
    products: { create: mocks.createProduct },
    checkoutSessions: { create: mocks.createCheckout },
  }),
}));
import { createDodoCommerceCheckout } from "./checkout.server";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.from.mockImplementation(() => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null }),
      insert: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
      update: vi.fn(),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.update.mockReturnValue(query);
    return query;
  });
  mocks.createProduct.mockResolvedValue({ product_id: "remote-product" });
  mocks.createCheckout.mockResolvedValue({
    session_id: "remote-checkout",
    checkout_url: "https://checkout.example",
  });
});

describe("Dodo recurring checkout contract", () => {
  it.each([
    ["day", "Day"],
    ["week", "Week"],
    ["month", "Month"],
    ["year", "Year"],
  ] as const)(
    "sends a valid %s cadence and renews beyond the first payment",
    async (interval, remoteInterval) => {
      await createDodoCommerceCheckout({
        product: {
          id: "product",
          creator_id: "creator",
          slug: "offer",
          public_slug: "offer",
          creator_username: "creator",
          kind: "digital_product",
          title: "Digital guide",
          description: "Guide",
          pricing_type: "subscription",
          price_amount: 1900,
          currency: "usd",
          billing_interval: interval,
        },
        email: "buyer@example.com",
        growth: {} as never,
      });
      expect(mocks.createProduct.mock.calls[0][0].price).toMatchObject({
        payment_frequency_count: 1,
        payment_frequency_interval: remoteInterval,
        subscription_period_count: 20,
        subscription_period_interval: "Year",
      });
    },
  );
});
