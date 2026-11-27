import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  apply: vi.fn(),
  finalize: vi.fn(),
  request: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("@/lib/commerce-fulfillment.server", () => ({
  commerceOrderMetadata: (_session: unknown, metadata: unknown) => metadata,
  finalizeCommerceFulfillment: mocks.finalize,
}));
vi.mock("@/lib/commerce-subscription-lifecycle.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/commerce-subscription-lifecycle.server")>()),
  applyCommerceSubscriptionLifecycle: mocks.apply,
}));
vi.mock("./client.server", () => ({ stripeRequestForPaymentAccount: mocks.request }));
import { fulfillCheckoutSession } from "./webhook.server";
const session = {
  id: "local-session",
  connection_id: "connection",
  product_id: "product",
  buyer_email: "buyer@example.com",
  gross_amount: 1900,
  currency: "usd",
  platform_fee_bps: 0,
  platform_fee_amount: 0,
  access_token_hash: "access",
  metadata: { billing_interval: "month" },
};
const checkout = {
  id: "checkout",
  created: Date.parse("2026-11-01T00:00:00Z") / 1000,
  metadata: { bento_session_id: session.id },
  payment_status: "paid",
  amount_total: 1900,
  currency: "usd",
  subscription: {
    id: "subscription",
    current_period_start: Date.parse("2026-12-01T00:00:00Z") / 1000,
    current_period_end: Date.parse("2027-01-01T00:00:00Z") / 1000,
  },
  invoice: { id: "initial-invoice" },
};
const context = {
  accountId: "account",
  connectionId: "connection",
  paymentAccount: { id: "connection", provider_account_id: "account" } as never,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.from.mockImplementation(() => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data: session }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    return query;
  });
  mocks.rpc.mockResolvedValue({ data: { order_id: "order" } });
});
it("binds a delayed paid checkout to its original period rather than the subscription's later cycle", async () => {
  await fulfillCheckoutSession({ id: "event", data: { object: checkout } }, context);
  expect(mocks.rpc).toHaveBeenCalledWith(
    "fulfill_provider_commerce_order_with_period",
    expect.objectContaining({
      p_provider_subscription_id: "subscription",
      p_provider_payment_id: "initial-invoice",
    }),
  );
  expect(mocks.apply).toHaveBeenCalledWith(
    expect.objectContaining({
      state: "renewed",
      fundingOrderId: "order",
      currentPeriodStart: "2026-11-01T00:00:00.000Z",
      currentPeriodEnd: "2026-12-01T00:00:00.000Z",
    }),
  );
  expect(mocks.request).not.toHaveBeenCalled();
});
it("does not fulfill a pending subscription checkout", async () => {
  await fulfillCheckoutSession(
    { id: "event", data: { object: { ...checkout, payment_status: "unpaid" } } },
    context,
  );
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.apply).not.toHaveBeenCalled();
});

it("does not grant access when a paid subscription's immutable period is missing", async () => {
  mocks.from.mockImplementation(() => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { ...session, metadata: {} } }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    return query;
  });
  await expect(
    fulfillCheckoutSession({ id: "event", data: { object: checkout } }, context),
  ).rejects.toThrow("period");
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.apply).not.toHaveBeenCalled();
});

it("recovers an older session's immutable cadence from its original checkout price", async () => {
  mocks.from.mockImplementation(() => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { ...session, metadata: {} } }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    return query;
  });
  mocks.request.mockResolvedValue({
    data: [
      {
        quantity: 1,
        amount_subtotal: 1900,
        currency: "usd",
        price: { recurring: { interval: "month", interval_count: 1 } },
      },
    ],
  });
  await fulfillCheckoutSession({ id: "event", data: { object: checkout } }, context);
  expect(mocks.request).toHaveBeenCalledWith(
    context.paymentAccount,
    "/v1/checkout/sessions/checkout/line_items?limit=2",
  );
  expect(mocks.apply).toHaveBeenCalledWith(
    expect.objectContaining({ currentPeriodEnd: "2026-12-01T00:00:00.000Z" }),
  );
});
