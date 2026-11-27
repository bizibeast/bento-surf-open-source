import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  finalize: vi.fn(),
  status: "paid",
  paidAt: "2026-11-01T00:00:00Z" as string | null,
  previousSession: "session",
  previousCreator: "creator",
  previousProduct: "product",
  previousBuyer: "buyer@example.test",
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("@/lib/commerce-fulfillment.server", () => ({
  commerceOrderMetadata: (_session: unknown, metadata: unknown) => metadata,
  finalizeCommerceFulfillment: mocks.finalize,
}));
import { processStripeInvoicePaid } from "./webhook.server";

const session = {
  id: "session",
  provider: "stripe",
  connection_id: "connection",
  creator_id: "creator",
  product_id: "product",
  buyer_email: "buyer@example.test",
  provider_checkout_id: "checkout",
  gross_amount: 1900,
  currency: "usd",
  platform_fee_bps: 0,
  platform_fee_amount: 0,
  access_token_hash: "original-token",
  metadata: {},
};
const context = {
  accountId: "account",
  connectionId: "connection",
  paymentAccount: { provider_account_id: "account", creator_id: "creator" },
} as Parameters<typeof processStripeInvoicePaid>[1];
const event = {
  data: {
    object: {
      id: "invoice-new",
      subscription: "subscription",
      status: "paid",
      billing_reason: "subscription_cycle",
      total: 1900,
      currency: "usd",
      tax: 0,
      lines: {
        data: [
          {
            type: "subscription",
            subscription: "subscription",
            period: { start: 1793491200, end: 1796083200 },
          },
        ],
      },
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks, {
    status: "paid",
    paidAt: "2026-11-01T00:00:00Z",
    previousSession: "session",
    previousCreator: "creator",
    previousProduct: "product",
    previousBuyer: "buyer@example.test",
  });
  mocks.from.mockImplementation((table: string) => {
    const filters: Record<string, unknown[]> = {};
    let paidHistoryProofRequired = false;
    const previous = () => ({
      id: "order-old",
      provider: "stripe",
      provider_account_id: "account",
      provider_subscription_id: "subscription",
      creator_id: mocks.previousCreator,
      product_id: mocks.previousProduct,
      buyer_email: mocks.previousBuyer,
      status: mocks.status,
      paid_at: mocks.paidAt,
      metadata: { bento_session_id: mocks.previousSession },
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
      order: () => query,
      limit: () => query,
      maybeSingle: async () => ({
        data:
          table === "commerce_payment_sessions"
            ? filters.id?.includes(session.id)
              ? session
              : null
            : Object.entries(filters).every(([column, values]) =>
                  values.includes(previous()[column as keyof ReturnType<typeof previous>]),
                ) &&
                (!paidHistoryProofRequired ||
                  ["paid", "partially_refunded"].includes(mocks.status) ||
                  mocks.paidAt !== null)
              ? previous()
              : null,
        error: null,
      }),
    };
    return query;
  });
  mocks.rpc.mockResolvedValue({ data: { order_id: "order-new" }, error: null });
});

describe("Stripe renewal historical purchase identity", () => {
  it.each(["paid", "partially_refunded"])(
    "preserves supported legacy %s history without paid_at",
    async (status) => {
      mocks.status = status;
      mocks.paidAt = null;
      await expect(processStripeInvoicePaid(event, context)).resolves.toBe("order-new");
    },
  );
  it.each(["account", "subscription"])("does not cross a historical %s identity", async (field) => {
    const incoming =
      field === "subscription"
        ? {
            data: {
              object: {
                ...event.data.object,
                subscription: "foreign-subscription",
                lines: {
                  data: [
                    { ...event.data.object.lines.data[0], subscription: "foreign-subscription" },
                  ],
                },
              },
            },
          }
        : event;
    const accountContext =
      field === "account" ? { ...context, accountId: "foreign-account" } : context;
    await expect(processStripeInvoicePaid(incoming, accountContext)).resolves.toBeUndefined();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not replace the immutable checkout session from historical metadata", async () => {
    mocks.previousSession = "foreign-session";
    await expect(processStripeInvoicePaid(event, context)).rejects.toThrow("session was not found");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(["paid", "partially_refunded", "refunded", "disputed"])(
    "records the new paid invoice after a previously paid %s order",
    async (status) => {
      mocks.status = status;
      await expect(processStripeInvoicePaid(event, context)).resolves.toBe("order-new");
      expect(mocks.rpc).toHaveBeenCalledWith(
        "fulfill_provider_commerce_order_with_period",
        expect.objectContaining({
          p_provider_payment_id: "invoice-new",
          p_provider_subscription_id: "subscription",
          p_provider_checkout_id: "checkout",
          p_access_token_hash: "original-token",
          p_subscription_period_start: "2026-11-01T00:00:00.000Z",
          p_subscription_period_end: "2026-12-01T00:00:00.000Z",
          p_metadata: expect.objectContaining({ bento_session_id: session.id }),
        }),
      );
    },
  );
  it.each(["refunded", "disputed"])("does not use never-paid %s history", async (status) => {
    mocks.status = status;
    mocks.paidAt = null;
    await expect(processStripeInvoicePaid(event, context)).resolves.toBeUndefined();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["pending", "failed"])("does not use %s history", async (status) => {
    mocks.status = status;
    await expect(processStripeInvoicePaid(event, context)).resolves.toBeUndefined();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["creator", "product", "buyer"])(
    "rejects foreign historical %s identity",
    async (field) => {
      if (field === "creator") mocks.previousCreator = "foreign-creator";
      if (field === "product") mocks.previousProduct = "foreign-product";
      if (field === "buyer") mocks.previousBuyer = "foreign@example.test";
      await expect(processStripeInvoicePaid(event, context)).rejects.toThrow("original paid order");
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
  it("never fulfills an unpaid incoming invoice even with valid previous payment history", async () => {
    await expect(
      processStripeInvoicePaid(
        { data: { object: { ...event.data.object, status: "open" } } },
        context,
      ),
    ).resolves.toBeUndefined();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
