import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ from: vi.fn(), request: vi.fn() }));
vi.mock("@/lib/secret-crypto.server", () => ({
  encryptServerSecret: vi.fn().mockResolvedValue("encrypted-token"),
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("@/lib/commerce-growth.server", () => ({
  persistCommerceCheckoutGrowth: vi.fn(),
  failCommerceCheckoutSession: vi.fn(),
}));
vi.mock("./client.server", () => ({
  getCreemPaymentAccount: vi.fn().mockResolvedValue({
    id: "connection",
    provider_account_id: "account",
    charges_enabled: true,
    webhook_secret_ciphertext: "secret",
  }),
  creemApiKeyForAccount: vi.fn().mockResolvedValue("api-key"),
  creemEnvironmentForAccount: () => "test",
  creemRequest: mocks.request,
}));
import { createCreemCommerceCheckout } from "./checkout.server";
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
  mocks.request
    .mockResolvedValueOnce({ id: "remote-product" })
    .mockResolvedValueOnce({ id: "checkout", checkout_url: "https://checkout.example" });
});
it("creates weekly subscriptions using Creem's documented custom cadence", async () => {
  await createCreemCommerceCheckout({
    product: {
      id: "product",
      creator_id: "creator",
      slug: "offer",
      public_slug: "offer",
      creator_username: "creator",
      kind: "digital_product",
      title: "Guide",
      description: "Digital guide",
      pricing_type: "subscription",
      price_amount: 1900,
      currency: "usd",
      billing_interval: "week",
    },
    email: "buyer@example.com",
    growth: {} as never,
  });
  expect(mocks.request.mock.calls[0][2]).toBe("/v1/products");
  expect(mocks.request.mock.calls[0][3].body).toMatchObject({
    billing_type: "recurring",
    billing_period: "custom",
    recurring_interval: "week",
    recurring_interval_count: 1,
  });
});
