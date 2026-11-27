import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  finalize: vi.fn(),
  account: vi.fn(),
  originalStatus: "paid",
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("@/lib/commerce-fulfillment.server", () => ({
  commerceOrderMetadata: (_session: unknown, metadata: unknown) => metadata,
  finalizeCommerceFulfillment: mocks.finalize,
}));
vi.mock("./client.server", () => ({ getStripePaymentAccountById: mocks.account }));
import { processStripeInvoicePaid } from "./webhook.server";
const session = {
  id: "session",
  product_id: "product",
  creator_id: "creator",
  connection_id: "connection",
  provider_checkout_id: "original-checkout",
  status: "paid",
  buyer_email: "buyer@example.com",
  gross_amount: 1900,
  currency: "usd",
  platform_fee_bps: 0,
  platform_fee_amount: 0,
  access_token_hash: "original-access",
};
const invoice = {
  id: "evt-renewal",
  type: "invoice.paid",
  data: {
    object: {
      id: "invoice-renewal",
      status: "paid",
      billing_reason: "subscription_cycle",
      parent: { subscription_details: { subscription: "subscription" } },
      total: 1900,
      currency: "usd",
    },
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.originalStatus = "paid";
  mocks.from.mockImplementation((table: string) => {
    const filters: Record<string, unknown[]> = {};
    const result = () =>
      table === "commerce_orders"
        ? {
            data: filters.status?.includes(mocks.originalStatus)
              ? {
                  id: "original-order",
                  metadata: { bento_session_id: "session" },
                  product_id: "product",
                  buyer_email: session.buyer_email,
                }
              : null,
          }
        : { data: session };
    const query = {
      select: vi.fn(),
      eq: (column: string, value: unknown) => {
        filters[column] = [value];
        return query;
      },
      in: (column: string, values: unknown[]) => {
        filters[column] = values;
        return query;
      },
      order: vi.fn(),
      limit: vi.fn(),
      maybeSingle: async () => result(),
    };
    for (const key of ["select", "order", "limit"] as const) query[key].mockReturnValue(query);
    return query;
  });
  mocks.account.mockResolvedValue({
    id: "connection",
    creator_id: "creator",
    provider_account_id: "account",
  });
  mocks.rpc.mockResolvedValue({ data: { order_id: "renewal-order" } });
});
it("records a paid renewal against the original session price and leaves its checkout reference intact", async () => {
  await processStripeInvoicePaid(invoice, { accountId: "account" });
  expect(mocks.rpc).toHaveBeenCalledWith(
    "fulfill_provider_commerce_order",
    expect.objectContaining({
      p_provider_payment_id: "invoice-renewal",
      p_provider_subscription_id: "subscription",
      p_provider_checkout_id: "original-checkout",
      p_gross_amount: 1900,
      p_access_token_hash: "original-access",
      p_metadata: expect.objectContaining({ bento_session_id: "session" }),
    }),
  );
  expect(mocks.finalize).toHaveBeenCalledWith(
    expect.objectContaining({ providerCheckoutId: "original-checkout" }),
  );
});
it("records renewals after the original subscription payment was partially refunded", async () => {
  mocks.originalStatus = "partially_refunded";
  await processStripeInvoicePaid(invoice, { accountId: "account" });
  expect(mocks.rpc).toHaveBeenCalledWith(
    "fulfill_provider_commerce_order",
    expect.objectContaining({ p_provider_payment_id: "invoice-renewal" }),
  );
  expect(mocks.finalize).toHaveBeenCalled();
});
it.each(["refunded", "disputed", "failed"])(
  "does not use a %s original payment to bind a renewal",
  async (status) => {
    mocks.originalStatus = status;
    await processStripeInvoicePaid(invoice, { accountId: "account" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  },
);
it("rejects a changed recurring amount before recording the renewal", async () => {
  await expect(
    processStripeInvoicePaid(
      { ...invoice, data: { object: { ...invoice.data.object, total: 1800 } } },
      { accountId: "account" },
    ),
  ).rejects.toThrow("amount");
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("rejects a different connected account before recording the renewal", async () => {
  await expect(processStripeInvoicePaid(invoice, { accountId: "another-account" })).rejects.toThrow(
    "account",
  );
  expect(mocks.rpc).not.toHaveBeenCalled();
});
