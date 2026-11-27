/* eslint-disable @typescript-eslint/no-explicit-any -- Tests exercise provider payload validation with intentionally malformed snapshots. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refund: vi.fn(),
  request: vi.fn(),
  account: vi.fn(),
  accountById: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  finalize: vi.fn(),
  lifecycle: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("./client.server", async (original) => ({
  ...(await original<typeof import("./client.server")>()),
  paypalRequestForAccount: mocks.request,
  paypalRequest: mocks.request,
  getPayPalPaymentAccount: mocks.account,
  getPayPalPaymentAccountById: mocks.accountById,
}));
vi.mock("@/lib/commerce-growth.server", () => ({
  persistCommerceCheckoutGrowth: vi.fn(),
  failCommerceCheckoutSession: vi.fn(),
}));
vi.mock("@/lib/secret-crypto.server", () => ({
  encryptServerSecret: vi.fn(async () => "encrypted"),
}));
vi.mock("@/lib/commerce-fulfillment.server", () => ({
  commerceOrderMetadata: (_session: unknown, metadata: unknown) => metadata,
  finalizeCommerceFulfillment: mocks.finalize,
}));
vi.mock("@/lib/commerce-subscription-lifecycle.server", () => ({
  applyCommerceSubscriptionLifecycle: mocks.lifecycle,
}));
vi.mock("@/lib/commerce-order-lifecycle.server", () => ({
  applyCommerceRefund: mocks.refund,
  applyCommerceDispute: vi.fn(),
}));
vi.mock("@/lib/commerce-webhook-receipts.server", () => ({
  claimCommerceWebhookEvent: mocks.claim,
  completeCommerceWebhookEvent: mocks.complete,
  failCommerceWebhookEvent: mocks.fail,
}));
import { capturePayPalCommerceOrder, createPayPalCommerceCheckout } from "./checkout.server";
import { handleDirectPayPalWebhook } from "./webhook.server";

const sessionId = "58a694f8-108c-454d-b3a8-63f84ff345c6";
const connectionId = "1746d2ac-20b7-441e-985b-dfffd97dde11";
const account = {
  id: connectionId,
  creator_id: "creator",
  provider: "paypal",
  provider_account_id: "SELLER",
  charges_enabled: true,
  credential_mode: "api_key",
  webhook_endpoint_id: "WH-TEST",
};
const product = {
  id: "product",
  creator_id: "creator",
  slug: "members",
  public_slug: "members",
  creator_username: "creator",
  kind: "membership",
  title: "Members",
  description: "Membership",
  pricing_type: "subscription" as const,
  price_amount: 1900,
  currency: "usd",
  billing_interval: "month" as const,
};
const growth = {
  primaryAmount: 1900,
  recordingAddonAmount: 0,
  bumpAmount: 0,
  subtotalAmount: 1900,
  discountAmount: 0,
  grossAmount: 1900,
  discountCodeId: null,
  bumpProductId: null,
  discountCode: null,
  bumpTitle: null,
  attribution: {},
};
let session: Record<string, any>;
let inserted: Record<string, any>[];
let updates: Record<string, any>[];
let queryFilters: Record<string, unknown>;
let subscription: Record<string, any>;

function eventRequest(type: string, resource: Record<string, unknown>, id = "EV-1") {
  return new Request("https://app.test.bento.surf/api/webhooks/paypal/direct/test", {
    method: "POST",
    headers: {
      "paypal-transmission-id": "transmission",
      "paypal-transmission-time": "2026-11-26T00:00:00Z",
      "paypal-cert-url": "https://api.paypal.com/cert.pem",
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-transmission-sig": "signed",
    },
    body: JSON.stringify({ id, event_type: type, create_time: "2026-11-26T00:00:00Z", resource }),
  });
}
function sale(overrides = {}) {
  return {
    id: "SALE-1",
    state: "completed",
    billing_agreement_id: "I-SUBSCRIPTION",
    amount: { total: "19.00", currency: "USD" },
    transaction_fee: { value: "0.80", currency: "USD" },
    create_time: "2026-11-26T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BENTO_COMMERCE_PLATFORM_FEE_BPS = "0";
  session = {
    id: sessionId,
    creator_id: "creator",
    connection_id: connectionId,
    product_id: "product",
    provider: "paypal",
    provider_checkout_id: "I-SUBSCRIPTION",
    buyer_email: "buyer@example.com",
    buyer_name: "Buyer",
    gross_amount: 1900,
    platform_fee_bps: 0,
    platform_fee_amount: 0,
    currency: "usd",
    access_token_hash: "access-hash",
    status: "pending",
    expires_at: "2030-01-01T00:00:00Z",
    metadata: {
      subscription_checkout: true,
      billing_interval: "month",
      paypal_plan_id: "P-PLAN",
      paypal_product_id: "PROD-TEST",
      product_slug: "members",
      creator_username: "creator",
    },
  };
  subscription = {
    id: "I-SUBSCRIPTION",
    custom_id: sessionId,
    plan_id: "P-PLAN",
    quantity: "1",
    status: "ACTIVE",
    billing_info: {
      last_payment: { time: "2026-11-26T00:00:00Z" },
      next_billing_time: "2026-12-26T00:00:00Z",
    },
  };
  inserted = [];
  updates = [];
  queryFilters = {};
  mocks.from.mockImplementation(() => {
    const builder: Record<string, any> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn((key, value) => {
      queryFilters[key] = value;
      return builder;
    });
    builder.insert = vi.fn(async (value) => {
      inserted.push(value);
      return { error: null };
    });
    builder.update = vi.fn((value) => {
      updates.push(value);
      return builder;
    });
    builder.maybeSingle = vi.fn(async () => ({ data: session, error: null }));
    builder.then = (resolve: (value: unknown) => void) => resolve({ data: session, error: null });
    return builder;
  });
  mocks.account.mockResolvedValue(account);
  mocks.accountById.mockResolvedValue(account);
  mocks.rpc.mockResolvedValue({ data: { order_id: "order-id" }, error: null });
  mocks.lifecycle.mockReset().mockResolvedValue({ applied: true });
  mocks.claim.mockResolvedValue("claimed");
  mocks.request.mockImplementation(async (...args) => {
    if (args[1] === "/v1/notifications/webhooks/WH-TEST")
      return {
        id: "WH-TEST",
        url: `http://localhost:8080/api/webhooks/paypal/direct/${connectionId}`,
        event_types: [{ name: "*" }],
      };
    const path = args.find((arg) => typeof arg === "string");
    if (path === "/v1/notifications/verify-webhook-signature")
      return { verification_status: "SUCCESS" };
    if (path === "/v1/catalogs/products") return { id: "PROD-TEST" };
    if (path === "/v1/billing/plans") return { id: "P-PLAN" };
    if (path === "/v1/billing/subscriptions")
      return {
        id: "I-SUBSCRIPTION",
        links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/approve" }],
      };
    return subscription;
  });
});

describe("PayPal native recurring checkout", () => {
  it.each(["month", "year"] as const)(
    "creates a %s plan and an approval subscription with a pinned checkout price",
    async (interval) => {
      const result = await createPayPalCommerceCheckout({
        product: { ...product, billing_interval: interval },
        email: "buyer@example.com",
        growth,
      });
      expect(result.url).toContain("paypal.com/approve");
      expect(mocks.request).toHaveBeenCalledWith(
        account,
        "/v1/catalogs/products",
        expect.objectContaining({ method: "POST", requestId: expect.any(String) }),
      );
      expect(mocks.request).toHaveBeenCalledWith(
        account,
        "/v1/billing/plans",
        expect.objectContaining({
          body: expect.objectContaining({
            product_id: "PROD-TEST",
            billing_cycles: [
              {
                frequency: { interval_unit: interval.toUpperCase(), interval_count: 1 },
                tenure_type: "REGULAR",
                sequence: 1,
                total_cycles: 0,
                pricing_scheme: { fixed_price: { value: "19.00", currency_code: "USD" } },
              },
            ],
          }),
        }),
      );
      expect(updates.some((update) => update.metadata?.paypal_plan_id === "P-PLAN")).toBe(true);
      const subscriptionCall = mocks.request.mock.calls.find(
        (call) => call[1] === "/v1/billing/subscriptions",
      )!;
      expect(subscriptionCall[2].body.custom_id).toBe(inserted[0].id);
      expect(subscriptionCall[2].body.application_context.user_action).toBe("SUBSCRIBE_NOW");
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
  it("preserves one-time Orders checkout", async () => {
    mocks.request.mockResolvedValue({
      id: "ORDER-TEST",
      links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkout" }],
    });
    await createPayPalCommerceCheckout({
      product: { ...product, pricing_type: "one_time" },
      email: "buyer@example.com",
      growth,
    });
    expect(mocks.request).toHaveBeenCalledWith(
      account,
      "/v2/checkout/orders",
      expect.objectContaining({ body: expect.objectContaining({ intent: "CAPTURE" }) }),
    );
    expect(mocks.request).not.toHaveBeenCalledWith(
      account,
      "/v1/billing/subscriptions",
      expect.anything(),
    );
  });
  it("repairs existing direct webhook subscriptions before creating a recurring checkout", async () => {
    const implementation = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (...args) => {
      if (args[1] === "/v1/notifications/webhooks/WH-TEST" && !args[2])
        return {
          id: "WH-TEST",
          url: `http://localhost:8080/api/webhooks/paypal/direct/${connectionId}`,
          event_types: [
            { name: "PAYMENT.CAPTURE.COMPLETED" },
            { name: "CUSTOMER.DISPUTE.UPDATED" },
          ],
        };
      return implementation(...args);
    });
    await createPayPalCommerceCheckout({ product, email: "buyer@example.com", growth });
    expect(mocks.request).toHaveBeenCalledWith(
      account,
      "/v1/notifications/webhooks/WH-TEST",
      expect.objectContaining({
        method: "PATCH",
        body: expect.arrayContaining([
          expect.objectContaining({
            path: "/event_types",
            value: expect.arrayContaining([
              { name: "PAYMENT.SALE.COMPLETED" },
              { name: "CUSTOMER.DISPUTE.UPDATED" },
            ]),
          }),
        ]),
      }),
    );
  });
  it("rejects discounts and paid add-ons before creating a provider resource", async () => {
    await expect(
      createPayPalCommerceCheckout({
        product,
        email: "buyer@example.com",
        growth: { ...growth, discountAmount: 100 },
      }),
    ).rejects.toThrow(/one-time/i);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("verifies subscription approval without capturing or fulfilling a payment", async () => {
    const token = "return-token-with-enough-entropy";
    session.metadata.capture_token_hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const result = await capturePayPalCommerceOrder({
      sessionId,
      captureToken: token,
      orderId: "I-SUBSCRIPTION",
    });
    expect(result.pending).toBe(true);
    expect(result.orderId).toBe(sessionId);
    expect(mocks.request).toHaveBeenCalledWith(account, "/v1/billing/subscriptions/I-SUBSCRIPTION");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("preserves one-time capture fulfillment without a subscription ID", async () => {
    session.metadata.subscription_checkout = false;
    session.provider_checkout_id = "ORDER-TEST";
    const token = "return-token-with-enough-entropy";
    session.metadata.capture_token_hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    mocks.request.mockResolvedValue({
      status: "COMPLETED",
      purchase_units: [
        {
          payments: {
            captures: [
              {
                id: "CAPTURE-TEST",
                status: "COMPLETED",
                amount: { value: "19.00", currency_code: "USD" },
              },
            ],
          },
        },
      ],
    });
    const result = await capturePayPalCommerceOrder({
      sessionId,
      captureToken: token,
      orderId: "ORDER-TEST",
    });
    expect(result.pending).toBe(false);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "fulfill_provider_commerce_order",
      expect.objectContaining({
        p_provider_payment_id: "CAPTURE-TEST",
        p_provider_subscription_id: "",
      }),
    );
  });
  it("requires the secret return token even after a subscription has been paid", async () => {
    session.status = "paid";
    await expect(
      capturePayPalCommerceOrder({ sessionId, captureToken: "wrong", orderId: "I-SUBSCRIPTION" }),
    ).rejects.toThrow(/token/);
  });
});

describe("PayPal signed recurring payments", () => {
  it.each(["pending", "paid"])(
    "fulfills a completed sale for a %s checkout with its subscription and unique transaction IDs",
    async (status) => {
      session.status = status;
      const response = await handleDirectPayPalWebhook(
        eventRequest("PAYMENT.SALE.COMPLETED", sale()),
        connectionId,
      );
      expect(response.status).toBe(202);
      expect(mocks.rpc).toHaveBeenCalledWith(
        "fulfill_provider_commerce_order",
        expect.objectContaining({
          p_provider_subscription_id: "I-SUBSCRIPTION",
          p_provider_payment_id: "SALE-1",
          p_provider_checkout_id: "SALE-1",
          p_gross_amount: 1900,
          p_currency: "usd",
          p_provider_account_id: "SELLER",
        }),
      );
      expect(mocks.finalize).toHaveBeenCalledWith(
        expect.objectContaining({ providerCheckoutId: "I-SUBSCRIPTION" }),
      );
      expect(mocks.lifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ state: "renewed", currentPeriodEnd: "2026-12-26T00:00:00.000Z" }),
      );
      expect(queryFilters).toMatchObject({
        provider: "paypal",
        provider_checkout_id: "I-SUBSCRIPTION",
        creator_id: "creator",
      });
    },
  );
  it.each([
    { amount: { total: "18.00", currency: "USD" } },
    { amount: { total: "19.00", currency: "EUR" } },
    { state: "pending" },
  ])("rejects a completed event with invalid payment facts %j", async (override) => {
    const response = await handleDirectPayPalWebhook(
      eventRequest("PAYMENT.SALE.COMPLETED", sale(override)),
      connectionId,
    );
    expect(response.status).toBe(500);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.lifecycle).not.toHaveBeenCalled();
  });
  it("rejects another plan or another connected account", async () => {
    subscription.plan_id = "P-OTHER";
    expect(
      (
        await handleDirectPayPalWebhook(
          eventRequest("PAYMENT.SALE.COMPLETED", sale()),
          connectionId,
        )
      ).status,
    ).toBe(500);
    subscription.plan_id = "P-PLAN";
    session.connection_id = "other-connection";
    expect(
      (
        await handleDirectPayPalWebhook(
          eventRequest("PAYMENT.SALE.COMPLETED", sale()),
          connectionId,
        )
      ).status,
    ).toBe(500);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([
    ["CANCELLED", "cancel_at_period_end"],
    ["SUSPENDED", "past_due"],
    ["EXPIRED", "expired"],
  ])(
    "records the verified final paid cycle before reconciling remote %s status",
    async (status, expectedState) => {
      session.status = "paid";
      subscription.status = status;
      subscription.billing_info.next_billing_time = "2027-01-01T00:00:00Z";
      const paidBoundary = { end: "2026-12-01T00:00:00.000Z", state: "active" };
      // Model the guarded RPC rule: only a verified 'renewed' state can advance
      // an already stored paid boundary. Status changes alone cannot do so.
      mocks.lifecycle.mockImplementation(async (input) => {
        if (input.state === "renewed") paidBoundary.end = input.currentPeriodEnd;
        paidBoundary.state = input.state;
        return { applied: true };
      });
      expect(
        (
          await handleDirectPayPalWebhook(
            eventRequest("PAYMENT.SALE.COMPLETED", sale({ create_time: "2026-12-01T00:00:00Z" })),
            connectionId,
          )
        ).status,
      ).toBe(202);
      expect(mocks.lifecycle).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          state: "renewed",
          providerEventId: "EV-1:paid",
          currentPeriodEnd: "2027-01-01T00:00:00.000Z",
        }),
      );
      expect(mocks.lifecycle).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          state: expectedState,
          providerEventId: "EV-1:status",
          currentPeriodEnd: "2027-01-01T00:00:00.000Z",
        }),
      );
      expect(paidBoundary).toEqual({ end: "2027-01-01T00:00:00.000Z", state: expectedState });
    },
  );
  it("routes a subscription sale refund to the existing order/access lifecycle", async () => {
    const resource = {
      id: "REFUND-1",
      sale_id: "SALE-1",
      state: "completed",
      amount: { total: "19.00", currency: "USD" },
    };
    expect(
      (
        await handleDirectPayPalWebhook(
          eventRequest("PAYMENT.SALE.REFUNDED", resource),
          connectionId,
        )
      ).status,
    ).toBe(202);
    expect(mocks.refund).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "paypal",
        providerAccountId: "SELLER",
        providerPaymentId: "SALE-1",
        refundAmount: 1900,
        amountIsCumulative: false,
      }),
    );
  });
  it("routes a subscription sale reversal to the existing order/access lifecycle", async () => {
    expect(
      (
        await handleDirectPayPalWebhook(
          eventRequest("PAYMENT.SALE.REVERSED", sale({ state: "reversed" })),
          connectionId,
        )
      ).status,
    ).toBe(202);
    expect(mocks.refund).toHaveBeenCalledWith(
      expect.objectContaining({
        providerPaymentId: "SALE-1",
        refundAmount: 1900,
        amountIsCumulative: true,
      }),
    );
  });
  it("does not process unsigned events or already processed events", async () => {
    const unsigned = new Request("https://example.com", {
      method: "POST",
      body: JSON.stringify({ id: "EV", event_type: "PAYMENT.SALE.COMPLETED", resource: sale() }),
    });
    expect((await handleDirectPayPalWebhook(unsigned, connectionId)).status).toBe(403);
    mocks.claim.mockResolvedValue("processed");
    expect(
      (
        await handleDirectPayPalWebhook(
          eventRequest("PAYMENT.SALE.COMPLETED", sale()),
          connectionId,
        )
      ).status,
    ).toBe(202);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([
    ["BILLING.SUBSCRIPTION.CANCELLED", "CANCELLED", "cancel_at_period_end"],
    ["BILLING.SUBSCRIPTION.SUSPENDED", "SUSPENDED", "past_due"],
    ["BILLING.SUBSCRIPTION.EXPIRED", "EXPIRED", "expired"],
    ["BILLING.SUBSCRIPTION.PAYMENT.FAILED", "ACTIVE", "past_due"],
  ])(
    "applies %s through the guarded lifecycle without granting access",
    async (eventType, status, state) => {
      subscription.status = status;
      expect(
        (
          await handleDirectPayPalWebhook(
            eventRequest(eventType, { id: "I-SUBSCRIPTION" }),
            connectionId,
          )
        ).status,
      ).toBe(202);
      expect(mocks.lifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ providerSubscriptionId: "I-SUBSCRIPTION", state }),
      );
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
  it("retries a payment whose subscription session has not been persisted yet", async () => {
    session = null as unknown as typeof session;
    expect(
      (
        await handleDirectPayPalWebhook(
          eventRequest("PAYMENT.SALE.COMPLETED", sale()),
          connectionId,
        )
      ).status,
    ).toBe(500);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("uses the actual billing boundary when payment collection was delayed", async () => {
    subscription.billing_info.next_billing_time = "2026-12-24T00:00:00Z";
    await handleDirectPayPalWebhook(eventRequest("PAYMENT.SALE.COMPLETED", sale()), connectionId);
    expect(mocks.lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ currentPeriodEnd: "2026-12-24T00:00:00.000Z" }),
    );
  });
  it("keeps the provider billing anchor after a short month", async () => {
    subscription.billing_info.next_billing_time = "2027-03-31T00:00:00Z";
    await handleDirectPayPalWebhook(
      eventRequest("PAYMENT.SALE.COMPLETED", sale({ create_time: "2027-02-28T00:00:00Z" })),
      connectionId,
    );
    expect(mocks.lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ currentPeriodEnd: "2027-03-31T00:00:00.000Z" }),
    );
  });
  it("ignores stale failure events after the provider has already renewed the subscription", async () => {
    subscription.billing_info.last_payment.time = "2026-11-27T00:00:00Z";
    await handleDirectPayPalWebhook(
      eventRequest("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: "I-SUBSCRIPTION" }),
      connectionId,
    );
    expect(mocks.lifecycle).not.toHaveBeenCalled();
  });
  it("does not grant access on subscription activation", async () => {
    expect(
      (
        await handleDirectPayPalWebhook(
          eventRequest("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-SUBSCRIPTION" }),
          connectionId,
        )
      ).status,
    ).toBe(202);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.lifecycle).not.toHaveBeenCalled();
  });
});
