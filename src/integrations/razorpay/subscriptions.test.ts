/* eslint-disable @typescript-eslint/no-explicit-any -- Provider fixtures and an in-memory DB boundary. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  request: vi.fn(),
  account: {} as any,
  sessions: [] as any[],
  orders: [] as any[],
  finalize: vi.fn(),
  lifecycle: vi.fn(),
  failSession: vi.fn(),
  growth: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  failEvent: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const chain: any = { validator: () => chain, handler: (fn: any) => fn };
    return chain;
  },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("@/lib/request-security.server", () => ({
  enforceRequestRateLimit: vi.fn(),
  readRequestText: (request: Request) => request.text(),
  RequestBodyTooLargeError: class extends Error {},
}));
vi.mock("@/lib/secret-crypto.server", () => ({
  encryptServerSecret: async (v: string) => v,
  decryptServerSecret: async (v: string) => v,
}));
vi.mock("@/lib/commerce-fulfillment.server", () => ({
  commerceOrderMetadata: (_session: unknown, metadata: unknown) => metadata,
  finalizeCommerceFulfillment: mocks.finalize,
}));
vi.mock("@/lib/commerce-growth.server", () => ({
  commerceCheckoutGrowthMetadata: () => ({}),
  persistCommerceCheckoutGrowth: mocks.growth,
  failCommerceCheckoutSession: mocks.failSession,
}));
vi.mock("@/lib/commerce-subscription-lifecycle.server", () => ({
  applyCommerceSubscriptionLifecycle: mocks.lifecycle,
}));
vi.mock("@/lib/commerce-order-lifecycle.server", () => ({
  applyCommerceDispute: vi.fn(),
  applyCommerceRefund: vi.fn(),
}));
vi.mock("@/lib/commerce-webhook-receipts.server", () => ({
  claimCommerceWebhookEvent: mocks.claim,
  completeCommerceWebhookEvent: mocks.complete,
  failCommerceWebhookEvent: mocks.failEvent,
}));
vi.mock("./client.server", async (original) => ({
  ...(await original<typeof import("./client.server")>()),
  getRazorpayPaymentAccount: async () => mocks.account,
  getRazorpayPaymentAccountById: async () => mocks.account,
  razorpayCredentialsForAccount: async () => ({ keyId: "rzp_test_example", keySecret: "secret" }),
  razorpayRequest: mocks.request,
}));

import {
  createRazorpayCommerceCheckout,
  finalizeRazorpayPayment,
  getRazorpayCheckout,
  verifyRazorpayCheckout,
} from "./checkout.functions";
import { handleRazorpayWebhook } from "./webhook.server";
import { hmacSha256Hex } from "./client.server";

const connectionId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const product = {
  id: "product",
  creator_id: "creator",
  kind: "paid_community",
  title: "Community",
  description: "Membership",
  slug: "community",
  public_slug: "community",
  creator_username: "creator",
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
const subscription = () => ({
  id: "sub_example",
  plan_id: "plan_example",
  quantity: 1,
  status: "active",
  paid_count: 1,
  current_start: 1795651200,
  current_end: 1798243200,
  notes: {
    bento_session_id: sessionId,
    bento_product_id: product.id,
    bento_creator_id: product.creator_id,
  },
});
const payment = () => ({
  id: "pay_example",
  order_id: "order_invoice",
  invoice_id: "inv_example",
  amount: 1900,
  currency: "USD",
  captured: true,
  status: "captured",
  fee: 50,
});
const invoice = () => ({
  id: "inv_example",
  subscription_id: "sub_example",
  payment_id: "pay_example",
  order_id: "order_invoice",
  status: "paid",
  amount: 1900,
  amount_paid: 1900,
  amount_due: 0,
  currency: "USD",
  billing_start: 1795651200,
  billing_end: 1798243200,
  line_items: [{ type: "plan", amount: 1900, quantity: 1 }],
});
const session = () => ({
  id: sessionId,
  product_id: product.id,
  creator_id: product.creator_id,
  provider: "razorpay",
  connection_id: connectionId,
  provider_checkout_id: "sub_example",
  gross_amount: 1900,
  currency: "usd",
  buyer_email: "buyer@example.com",
  status: "pending",
  expires_at: new Date(Date.now() + 7200000).toISOString(),
  metadata: {
    pricing_type: "subscription",
    razorpay_plan_id: "plan_example",
    billing_interval: "month",
    razorpay_total_count: 120,
    access_token_ciphertext: "access",
    product_public_slug: "community",
    creator_username: "creator",
  },
});

function dbQuery(table: string) {
  const filters: Array<[string, unknown]> = [];
  let operation = "select";
  let value: any;
  const execute = () => {
    const rows =
      table === "commerce_payment_sessions"
        ? mocks.sessions
        : table === "commerce_orders"
          ? mocks.orders
          : [];
    const matching = rows.filter((row) => filters.every(([key, v]) => row[key] === v));
    if (operation === "insert") {
      rows.push({ status: "pending", ...value });
      return { data: value, error: null };
    }
    if (operation === "update") matching.forEach((row) => Object.assign(row, value));
    if (table === "commerce_products") return { data: product, error: null };
    if (table === "profiles")
      return { data: { username: "creator", display_name: "Creator" }, error: null };
    return { data: matching[0] || null, error: null };
  };
  const q: any = {
    select: () => q,
    eq: (key: string, v: unknown) => {
      filters.push([key, v]);
      return q;
    },
    insert: (v: any) => {
      operation = "insert";
      value = v;
      return q;
    },
    update: (v: any) => {
      operation = "update";
      value = v;
      return q;
    },
    maybeSingle: async () => execute(),
    single: async () => execute(),
    then: (resolve: any) => Promise.resolve(execute()).then(resolve),
  };
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessions.length = 0;
  mocks.orders.length = 0;
  mocks.account = {
    id: connectionId,
    creator_id: "creator",
    provider: "razorpay",
    provider_account_id: "rzp_test_example",
    charges_enabled: true,
    payouts_enabled: true,
    webhook_secret_ciphertext: "webhook-secret",
  };
  mocks.from.mockImplementation(dbQuery);
  mocks.rpc.mockImplementation(async (_name, params) => {
    const existing = mocks.orders.find(
      (order) => order.provider_payment_id === params.p_provider_payment_id,
    );
    const orderId = existing?.id || `order-${mocks.orders.length + 1}`;
    if (!existing)
      mocks.orders.push({
        id: orderId,
        provider: "razorpay",
        provider_account_id: mocks.account.provider_account_id,
        provider_subscription_id: params.p_provider_subscription_id,
        provider_payment_id: params.p_provider_payment_id,
      });
    return { data: { order_id: orderId, already_processed: Boolean(existing) }, error: null };
  });
  mocks.request.mockImplementation(async (_credentials, path, init) => {
    if (path === "/v1/plans")
      return {
        id: "plan_example",
        period: "monthly",
        interval: 1,
        item: { amount: 1900, currency: "USD" },
      };
    if (path === "/v1/subscriptions")
      return {
        id: "sub_example",
        status: "created",
        plan_id: "plan_example",
        quantity: 1,
        total_count: init.body.total_count,
      };
    if (path.startsWith("/v1/subscriptions/")) return subscription();
    if (path.startsWith("/v1/payments/")) return payment();
    if (path.startsWith("/v1/invoices/")) return invoice();
    if (path === "/v1/orders") return { id: "order_example", status: "created" };
    throw new Error(`Unexpected API path: ${path}`);
  });
  mocks.claim.mockResolvedValue("claimed");
  mocks.lifecycle.mockResolvedValue({ applied: true });
  mocks.finalize.mockImplementation(async ({ session: s }) => {
    s.status = "paid";
  });
});

async function webhook(eventType: string, sub = subscription(), pay: any = undefined) {
  const body = JSON.stringify({
    entity: "event",
    event: eventType,
    created_at: 1795651201,
    payload: { subscription: { entity: sub }, ...(pay ? { payment: { entity: pay } } : {}) },
  });
  return handleRazorpayWebhook(
    new Request("https://example.com/webhook", {
      method: "POST",
      body,
      headers: {
        "x-razorpay-signature": await hmacSha256Hex("webhook-secret", body),
        "x-razorpay-event-id": `event-${eventType}`,
      },
    }),
    connectionId,
  );
}

describe("native Razorpay subscriptions", () => {
  it("creates a frozen USD plan and subscription instead of a one-time Order", async () => {
    const result = await createRazorpayCommerceCheckout({
      product,
      email: "buyer@example.com",
      growth,
    });
    expect(result.url).toContain("/payments/razorpay/");
    const plan = mocks.request.mock.calls.find((call) => call[1] === "/v1/plans")?.[2]?.body;
    expect(plan).toMatchObject({
      period: "monthly",
      interval: 1,
      item: { amount: 1900, currency: "USD" },
    });
    const recurring = mocks.request.mock.calls.find((call) => call[1] === "/v1/subscriptions")?.[2]
      ?.body;
    expect(recurring).toMatchObject({
      plan_id: "plan_example",
      quantity: 1,
      total_count: 120,
      customer_notify: true,
    });
    expect(recurring).not.toHaveProperty("start_at");
    expect(mocks.sessions[0]).toMatchObject({
      provider_checkout_id: "sub_example",
      gross_amount: 1900,
      metadata: {
        pricing_type: "subscription",
        razorpay_plan_id: "plan_example",
        billing_interval: "month",
        razorpay_total_count: 120,
      },
    });
    expect(mocks.request.mock.calls.some((call) => call[1] === "/v1/orders")).toBe(false);
  });

  it("rejects unsupported daily frequency and adjusted recurring totals before creating resources", async () => {
    await expect(
      createRazorpayCommerceCheckout({
        product: { ...product, billing_interval: "day" },
        email: "buyer@example.com",
        growth,
      }),
    ).rejects.toThrow(/week|daily/i);
    await expect(
      createRazorpayCommerceCheckout({
        product,
        email: "buyer@example.com",
        growth: { ...growth, discountAmount: 100, grossAmount: 1800 },
      }),
    ).rejects.toThrow(/one-time|adjust/i);
    expect(mocks.sessions).toHaveLength(0);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("uses the shared offer compatibility policy before creating checkout", async () => {
    await expect(
      createRazorpayCommerceCheckout({
        product: { ...product, kind: "unsupported" },
        email: "buyer@example.com",
        growth,
      }),
    ).rejects.toThrow(/offer type|compatible/i);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.sessions).toHaveLength(0);
  });

  it("keeps Orders for one-time checkout", async () => {
    await createRazorpayCommerceCheckout({
      product: { ...product, pricing_type: "one_time", billing_interval: null },
      email: "buyer@example.com",
      growth,
    });
    expect(mocks.sessions[0].provider_checkout_id).toBe("order_example");
    expect(mocks.request.mock.calls.map((call) => call[1])).toEqual(["/v1/orders"]);
  });

  it("exposes subscription checkout and the maximum recurring term to the buyer", async () => {
    mocks.sessions.push(session());
    const checkout = await (getRazorpayCheckout as any)({ data: { sessionId } });
    expect(checkout).toMatchObject({
      orderId: null,
      subscriptionId: "sub_example",
      billingInterval: "month",
      totalBillingCycles: 120,
    });
    expect(checkout.subscriptionTerms).toMatch(/120|10 years/);
    expect(checkout.subscriptionTerms).toContain("$19 every month");
    expect(checkout.cancelUrl).toContain("/@creator/products/community");
  });

  it("fulfills only captured billed subscription payments using the per-invoice Order ID", async () => {
    const s = session();
    await finalizeRazorpayPayment({
      account: mocks.account,
      session: s,
      payment: payment(),
      subscription: subscription(),
      invoice: invoice(),
    } as any);
    expect(mocks.orders).toHaveLength(1);
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({
      p_provider_checkout_id: "order_invoice",
      p_provider_payment_id: "pay_example",
      p_provider_subscription_id: "sub_example",
      p_gross_amount: 1900,
    });
    expect(mocks.finalize.mock.calls[0][0]).toMatchObject({ providerCheckoutId: "sub_example" });
    expect(mocks.lifecycle.mock.calls[0][0]).toMatchObject({
      providerSubscriptionId: "sub_example",
      state: "renewed",
      currentPeriodEnd: "2026-12-26T00:00:00.000Z",
    });
  });

  it.each([
    ["completed", "cancel_at_period_end"],
    ["cancelled", "revoked"],
    ["pending", "past_due"],
  ])(
    "records a verified final paid period before applying current %s state",
    async (status, terminalState) => {
      const finalInvoice = {
        ...invoice(),
        billing_start: Date.parse("2026-12-01T00:00:00Z") / 1000,
        billing_end: Date.parse("2027-01-01T00:00:00Z") / 1000,
      };
      await finalizeRazorpayPayment({
        account: mocks.account,
        session: session(),
        payment: payment(),
        subscription: { ...subscription(), status },
        invoice: finalInvoice,
      });
      const transitions = mocks.lifecycle.mock.calls.map((call) => call[0]);
      expect(transitions.map((transition) => transition.state)).toEqual(["renewed", terminalState]);
      expect(transitions[0].currentPeriodEnd).toBe("2027-01-01T00:00:00.000Z");
      expect(transitions[1].currentPeriodEnd).toBe("2027-01-01T00:00:00.000Z");
      expect(transitions[0].providerEventId).not.toBe(transitions[1].providerEventId);
    },
  );

  it.each([
    ["authentication-only", { paid_count: 0, status: "authenticated" }, {}, {}],
    ["uncaptured", {}, { captured: false, status: "authorized" }, {}],
    ["wrong amount", {}, { amount: 100 }, {}],
    ["wrong subscription", { id: "sub_other" }, {}, {}],
    ["wrong plan", { plan_id: "plan_other" }, {}, {}],
    ["unrelated payment", {}, {}, { payment_id: "pay_other" }],
    ["unrelated invoice", {}, {}, { subscription_id: "sub_other" }],
    ["authorization invoice", {}, {}, { line_items: [{ type: "addon", amount: 1900 }] }],
    ["missing period", {}, {}, { billing_start: null, billing_end: null }],
  ])("refuses %s without granting access", async (_name, subPatch, payPatch, invoicePatch) => {
    await expect(
      finalizeRazorpayPayment({
        account: mocks.account,
        session: session(),
        payment: { ...payment(), ...payPatch },
        subscription: { ...subscription(), ...subPatch },
        invoice: { ...invoice(), ...invoicePatch },
      } as any),
    ).rejects.toThrow();
    expect(mocks.orders).toHaveLength(0);
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.lifecycle).not.toHaveBeenCalled();
  });

  it("verifies callback identifiers and retrieves payment, subscription and invoice server-side", async () => {
    mocks.sessions.push(session());
    const result = await (verifyRazorpayCheckout as any)({
      data: {
        sessionId,
        razorpayPaymentId: "pay_example",
        razorpaySubscriptionId: "sub_example",
        razorpaySignature: await hmacSha256Hex("secret", "pay_example|sub_example"),
      },
    });
    expect(result.url).toContain("order=order-1");
    expect(mocks.request.mock.calls.map((call) => call[1])).toContain("/v1/invoices/inv_example");
    expect(mocks.orders).toHaveLength(1);
  });

  it("shows mandate authorization as pending until a billed payment is captured", async () => {
    mocks.sessions.push(session());
    mocks.request.mockImplementation(async (_credentials, path) =>
      path.includes("/payments/")
        ? { ...payment(), invoice_id: null, amount: 100 }
        : { ...subscription(), paid_count: 0, status: "authenticated" },
    );
    const result = await (verifyRazorpayCheckout as any)({
      data: {
        sessionId,
        razorpayPaymentId: "pay_example",
        razorpaySubscriptionId: "sub_example",
        razorpaySignature: await hmacSha256Hex("secret", "pay_example|sub_example"),
      },
    });
    expect(result).toMatchObject({ pending: true, url: null });
    expect(result.message).toMatch(/first subscription payment|first charge/i);
    expect(mocks.orders).toHaveLength(0);
    expect(mocks.lifecycle).not.toHaveBeenCalled();
  });

  it("processes captured initial and renewal invoices idempotently after checkout expiry", async () => {
    mocks.sessions.push({ ...session(), status: "paid", expires_at: "2020-01-01T00:00:00Z" });
    expect((await webhook("subscription.charged", subscription(), payment())).status).toBe(202);
    expect((await webhook("subscription.charged", subscription(), payment())).status).toBe(202);
    const secondPay = {
      ...payment(),
      id: "pay_second",
      order_id: "order_second",
      invoice_id: "inv_second",
    };
    mocks.request.mockImplementation(async (_credentials, path) =>
      path.includes("/payments/")
        ? secondPay
        : path.includes("/invoices/")
          ? { ...invoice(), id: "inv_second", payment_id: "pay_second", order_id: "order_second" }
          : { ...subscription(), paid_count: 2 },
    );
    expect(
      (await webhook("subscription.charged", { ...subscription(), paid_count: 2 }, secondPay))
        .status,
    ).toBe(202);
    expect(mocks.orders.map((order) => order.provider_payment_id)).toEqual([
      "pay_example",
      "pay_second",
    ]);
    expect(mocks.sessions[0].provider_checkout_id).toBe("sub_example");
  });

  it("acknowledges authentication-only events without paid access", async () => {
    mocks.sessions.push(session());
    expect(
      (
        await webhook("subscription.authenticated", {
          ...subscription(),
          status: "authenticated",
          paid_count: 0,
        })
      ).status,
    ).toBe(202);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.lifecycle).not.toHaveBeenCalled();
  });

  it("does not create provider resources when checkout persistence fails", async () => {
    mocks.growth.mockRejectedValueOnce(new Error("checkout persistence failed"));
    await expect(
      createRazorpayCommerceCheckout({ product, email: "buyer@example.com", growth }),
    ).rejects.toThrow("checkout persistence failed");
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.failSession).toHaveBeenCalledOnce();
  });

  it("acknowledges captured mandate authentication without a subscription invoice", async () => {
    mocks.sessions.push(session());
    mocks.request.mockResolvedValueOnce({ ...payment(), invoice_id: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      (await webhook("payment.captured", subscription(), { ...payment(), invoice_id: null }))
        .status,
    ).toBe(202);
    expect(mocks.orders).toHaveLength(0);
    expect(mocks.lifecycle).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it.each([
    ["subscription.pending", "pending", "past_due"],
    ["subscription.halted", "halted", "past_due"],
    ["subscription.paused", "paused", "past_due"],
    ["subscription.cancelled", "cancelled", "revoked"],
    ["subscription.completed", "completed", "cancel_at_period_end"],
  ])("applies %s to account-bound subscription access", async (event, status, state) => {
    mocks.sessions.push({ ...session(), status: "paid" });
    mocks.request.mockResolvedValue({ ...subscription(), status });
    expect((await webhook(event, { ...subscription(), status })).status).toBe(202);
    expect(mocks.lifecycle.mock.calls.at(-1)?.[0]).toMatchObject({
      provider: "razorpay",
      providerAccountId: "rzp_test_example",
      providerSubscriptionId: "sub_example",
      state,
    });
  });

  it("rejects signed events whose fetched subscription belongs to a different checkout", async () => {
    mocks.sessions.push(session());
    mocks.request.mockResolvedValue({
      ...subscription(),
      notes: { bento_session_id: "different" },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      (await webhook("subscription.cancelled", { ...subscription(), status: "cancelled" })).status,
    ).toBe(500);
    expect(mocks.lifecycle).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
