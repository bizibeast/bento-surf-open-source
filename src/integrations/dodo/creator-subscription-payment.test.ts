import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  retrieve: vi.fn(),
  apply: vi.fn(),
  finalize: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("./creator-client.server", () => ({
  dodoClientForCreatorAccount: vi
    .fn()
    .mockResolvedValue({ subscriptions: { retrieve: mocks.retrieve } }),
}));
vi.mock("@/lib/commerce-subscription-lifecycle.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/commerce-subscription-lifecycle.server")>()),
  applyCommerceSubscriptionLifecycle: mocks.apply,
}));
vi.mock("@/lib/commerce-fulfillment.server", () => ({
  commerceOrderMetadata: (_session: unknown, data: unknown) => data,
  finalizeCommerceFulfillment: mocks.finalize,
}));
import { processPaymentSucceeded } from "./creator-webhook.server";
const session = {
  id: "11111111-1111-4111-8111-111111111111",
  product_id: "product",
  buyer_email: "buyer@example.com",
  provider_checkout_id: "checkout",
  gross_amount: 1900,
  currency: "usd",
  status: "pending",
  metadata: { provider_product_id: "remote-product", billing_interval: "month" },
};
const event = {
  business_id: "business",
  data: {
    status: "succeeded",
    created_at: "2026-11-01T00:00:00Z",
    metadata: { bento_session_id: session.id },
    subscription_id: "subscription",
    payment_id: "payment",
    currency: "USD",
    total_amount: 1900,
    tax: 0,
    settlement_amount: 1900,
    settlement_currency: "USD",
    customer: { name: "Buyer" },
    product_cart: null,
  },
};
const account = { id: "connection", creator_id: "creator", provider_account_id: "business" };
beforeEach(() => {
  vi.clearAllMocks();
  const results = [{ data: session }, { data: { id: "product" } }];
  mocks.from.mockImplementation(() => {
    const result = results.shift();
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue(result),
      single: vi.fn().mockResolvedValue(result),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    return query;
  });
  mocks.retrieve.mockResolvedValue({
    subscription_id: "subscription",
    product_id: "remote-product",
    previous_billing_date: "2026-11-01T00:00:00Z",
    next_billing_date: "2026-12-01T00:00:00Z",
  });
  mocks.rpc.mockResolvedValue({ data: { order_id: "order" } });
});
it("validates recurring payments via the subscription when Dodo omits its one-time-only product cart", async () => {
  await processPaymentSucceeded(event as never, account as never, "event");
  expect(mocks.retrieve).toHaveBeenCalledWith("subscription");
  expect(mocks.rpc).toHaveBeenCalledWith(
    "fulfill_provider_commerce_order_with_period",
    expect.objectContaining({ p_provider_subscription_id: "subscription", p_gross_amount: 1900 }),
  );
  expect(mocks.apply).toHaveBeenCalledWith(
    expect.objectContaining({ currentPeriodEnd: "2026-12-01T00:00:00.000Z" }),
  );
});
it("rejects a subscription belonging to a different provider product", async () => {
  mocks.retrieve.mockResolvedValue({
    subscription_id: "subscription",
    product_id: "another-product",
  });
  await expect(processPaymentSucceeded(event as never, account as never, "event")).rejects.toThrow(
    "product",
  );
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it("does not give a delayed payment access to the subscription's later unpaid cycle", async () => {
  mocks.retrieve.mockResolvedValue({
    subscription_id: "subscription",
    product_id: "remote-product",
    previous_billing_date: "2026-12-01T00:00:00Z",
    next_billing_date: "2027-01-01T00:00:00Z",
  });
  await processPaymentSucceeded(event as never, account as never, "delayed-event");
  expect(mocks.apply).toHaveBeenCalledWith(
    expect.objectContaining({ currentPeriodEnd: "2026-12-01T00:00:00.000Z" }),
  );
});
