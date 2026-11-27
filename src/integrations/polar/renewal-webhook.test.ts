import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  originalStatus: "paid",
  originalPaidAt: "2026-11-01T00:00:00Z" as string | null,
  originalProduct: "product",
  originalBuyer: "buyer@example.test",
  originalSession: "aa111111-1111-4111-8111-111111111111",
  from: vi.fn(),
  rpc: vi.fn(),
  finalize: vi.fn(),
  lifecycle: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("@/lib/commerce-fulfillment.server", () => ({
  commerceOrderMetadata: (_session: unknown, metadata: unknown) => metadata,
  finalizeCommerceFulfillment: mocks.finalize,
}));
vi.mock("@/lib/commerce-subscription-lifecycle.server", () => ({
  applyCommerceSubscriptionLifecycle: mocks.lifecycle,
  polarSubscriptionState: vi.fn(),
}));
import { processOrderPaid } from "./webhook.server";

const session = {
  id: "aa111111-1111-4111-8111-111111111111",
  product_id: "product",
  creator_id: "creator",
  connection_id: "connection",
  provider_checkout_id: "initial-checkout",
  gross_amount: 1900,
  currency: "usd",
  status: "paid",
  buyer_email: "buyer@example.test",
  metadata: { provider_product_id: "polar-product" },
  access_token_hash: "original-access",
};
const account = { id: "connection", creator_id: "creator", provider_account_id: "account" };
const event = {
  type: "order.paid",
  data: {
    id: "renewal-order",
    metadata: { bento_session_id: session.id },
    checkoutId: null,
    subscriptionId: "subscription",
    netAmount: 1900,
    currency: "usd",
    platformFeeAmount: 0,
    productId: "polar-product",
    customer: { name: "Buyer" },
    taxAmount: 0,
    subscription: {
      currentPeriodStart: new Date("2026-11-01"),
      currentPeriodEnd: new Date("2026-12-01"),
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.originalStatus = "paid";
  mocks.originalPaidAt = "2026-11-01T00:00:00Z";
  mocks.originalProduct = "product";
  mocks.originalBuyer = "buyer@example.test";
  mocks.originalSession = session.id;
  mocks.from.mockImplementation((table: string) => {
    const filters: Record<string, unknown[]> = {};
    let paidHistoryProofRequired = false;
    let sessionBinding = "";
    const originalOrder = () => ({
      id: "original-order",
      provider: "polar",
      provider_account_id: "account",
      provider_subscription_id: "subscription",
      creator_id: "creator",
      product_id: mocks.originalProduct,
      buyer_email: mocks.originalBuyer,
      status: mocks.originalStatus,
      paid_at: mocks.originalPaidAt,
    });
    const read = () => ({
      data:
        table === "commerce_payment_sessions"
          ? session
          : table === "commerce_products"
            ? { id: "product", creator_id: "creator", currency: "usd" }
            : Object.entries(filters).every(([column, values]) =>
                  values.includes(
                    originalOrder()[column as keyof ReturnType<typeof originalOrder>],
                  ),
                ) &&
                (!paidHistoryProofRequired ||
                  ["paid", "partially_refunded"].includes(mocks.originalStatus) ||
                  mocks.originalPaidAt !== null) &&
                sessionBinding === mocks.originalSession
              ? originalOrder()
              : null,
      error: null,
    });
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        filters[column] = [value];
        return query;
      },
      in: (column: string, values: unknown[]) => {
        filters[column] = values;
        return query;
      },
      or: (expression: string) => {
        paidHistoryProofRequired = expression.includes("paid_at.not.is.null");
        return query;
      },
      contains: (_column: string, value: { bento_session_id: string }) => {
        sessionBinding = value.bento_session_id;
        return query;
      },
      limit: () => query,
      maybeSingle: async () => read(),
      single: async () => read(),
    };
    return query;
  });
  mocks.rpc.mockResolvedValue({ data: { order_id: "renewal-order" }, error: null });
});

describe("Polar subscription renewal financial binding", () => {
  it.each([
    ["missing subscription expansion", null],
    ["missing start", { currentPeriodEnd: new Date("2026-12-01") }],
    ["missing end", { currentPeriodStart: new Date("2026-11-01") }],
    [
      "nonfinite start",
      { currentPeriodStart: new Date(NaN), currentPeriodEnd: new Date("2026-12-01") },
    ],
    [
      "nonfinite end",
      { currentPeriodStart: new Date("2026-11-01"), currentPeriodEnd: new Date(NaN) },
    ],
    [
      "reversed period",
      { currentPeriodStart: new Date("2026-12-01"), currentPeriodEnd: new Date("2026-11-01") },
    ],
    [
      "zero-length period",
      { currentPeriodStart: new Date("2026-11-01"), currentPeriodEnd: new Date("2026-11-01") },
    ],
  ])("rejects %s before creating or finalizing a paid order", async (_name, subscription) => {
    const initial = {
      ...event,
      data: { ...event.data, checkoutId: "initial-checkout", subscription },
    };
    await expect(processOrderPaid(initial as never, account, "event-initial")).rejects.toThrow(
      "paid service period",
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.lifecycle).not.toHaveBeenCalled();
  });

  it.each(["paid", "partially_refunded"])(
    "preserves supported legacy %s identity without paid_at",
    async (status) => {
      mocks.originalStatus = status;
      mocks.originalPaidAt = null;
      await processOrderPaid(event as never, account, "event-renewal");
      expect(mocks.rpc).toHaveBeenCalledWith(
        "fulfill_provider_commerce_order_with_period",
        expect.objectContaining({ p_provider_payment_id: "renewal-order" }),
      );
    },
  );
  it.each(["account", "subscription"])("does not cross a historical %s identity", async (field) => {
    const incoming =
      field === "subscription"
        ? { ...event, data: { ...event.data, subscriptionId: "foreign-subscription" } }
        : event;
    const connection =
      field === "account" ? { ...account, provider_account_id: "foreign-account" } : account;
    await expect(processOrderPaid(incoming as never, connection, "event-renewal")).rejects.toThrow(
      "checkout",
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(["refunded", "disputed"])(
    "rejects %s history that never established a real paid timestamp",
    async (status) => {
      mocks.originalStatus = status;
      mocks.originalPaidAt = null;
      await expect(processOrderPaid(event as never, account, "event-renewal")).rejects.toThrow(
        "checkout",
      );
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
  it.each(["product", "buyer", "session"])(
    "rejects historically paid financial history with a foreign %s identity",
    async (field) => {
      mocks.originalStatus = "refunded";
      if (field === "product") mocks.originalProduct = "foreign-product";
      if (field === "buyer") mocks.originalBuyer = "foreign@example.test";
      if (field === "session") mocks.originalSession = "foreign-session";
      await expect(processOrderPaid(event as never, account, "event-renewal")).rejects.toThrow(
        "checkout",
      );
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it.each(["paid", "partially_refunded", "refunded", "disputed"])(
    "records a new paid order after a %s original subscription charge",
    async (status) => {
      mocks.originalStatus = status;
      await processOrderPaid(event as never, account, "event-renewal");
      expect(mocks.rpc).toHaveBeenCalledWith(
        "fulfill_provider_commerce_order_with_period",
        expect.objectContaining({
          p_provider_payment_id: "renewal-order",
          p_provider_subscription_id: "subscription",
          p_provider_checkout_id: "initial-checkout",
          p_access_token_hash: "original-access",
          p_subscription_period_start: "2026-11-01T00:00:00.000Z",
          p_subscription_period_end: "2026-12-01T00:00:00.000Z",
        }),
      );
      expect(mocks.lifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ state: "renewed", providerSubscriptionId: "subscription" }),
      );
    },
  );
  it.each(["pending", "failed"])(
    "rejects a renewal backed only by a %s original charge",
    async (status) => {
      mocks.originalStatus = status;
      await expect(processOrderPaid(event as never, account, "event-renewal")).rejects.toThrow(
        "checkout",
      );
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.lifecycle).not.toHaveBeenCalled();
    },
  );
});
