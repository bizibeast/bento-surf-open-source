import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  originalStatus: "paid",
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
  mocks.from.mockImplementation((table: string) => {
    const filters: Record<string, unknown[]> = {};
    const read = () => ({
      data:
        table === "commerce_payment_sessions"
          ? session
          : table === "commerce_products"
            ? { id: "product", creator_id: "creator", currency: "usd" }
            : filters.status?.includes(mocks.originalStatus)
              ? { id: "original-order" }
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
      contains: () => query,
      limit: () => query,
      maybeSingle: async () => read(),
      single: async () => read(),
    };
    return query;
  });
  mocks.rpc.mockResolvedValue({ data: { order_id: "renewal-order" }, error: null });
});

describe("Polar subscription renewal financial binding", () => {
  it.each(["paid", "partially_refunded"])(
    "records a new paid order after a %s original subscription charge",
    async (status) => {
      mocks.originalStatus = status;
      await processOrderPaid(event as never, account, "event-renewal");
      expect(mocks.rpc).toHaveBeenCalledWith(
        "fulfill_provider_commerce_order",
        expect.objectContaining({
          p_provider_payment_id: "renewal-order",
          p_provider_subscription_id: "subscription",
          p_provider_checkout_id: "initial-checkout",
          p_access_token_hash: "original-access",
        }),
      );
      expect(mocks.lifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ state: "renewed", providerSubscriptionId: "subscription" }),
      );
    },
  );
  it.each(["refunded", "disputed", "failed"])(
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
