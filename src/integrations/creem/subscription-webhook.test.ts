import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  finalize: vi.fn(),
  apply: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("@/lib/secret-crypto.server", () => ({
  decryptServerSecret: async () => "local-test-secret",
}));
vi.mock("@/lib/commerce-fulfillment.server", () => ({
  commerceOrderMetadata: (_session: unknown, metadata: unknown) => metadata,
  finalizeCommerceFulfillment: mocks.finalize,
}));
vi.mock("@/lib/commerce-webhook-receipts.server", () => ({
  claimCommerceWebhookEvent: mocks.claim,
  completeCommerceWebhookEvent: mocks.complete,
  failCommerceWebhookEvent: mocks.fail,
}));
vi.mock("@/lib/commerce-subscription-lifecycle.server", () => ({
  applyCommerceSubscriptionLifecycle: mocks.apply,
  creemSubscriptionState: vi.fn(),
}));
vi.mock("./client.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.server")>()),
  getCreemPaymentAccountById: async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    creator_id: "creator",
    provider_account_id: "account",
    webhook_secret_ciphertext: "encrypted",
    environment: "test",
  }),
}));
import { handleCreemWebhook } from "./webhook.server";

const session = {
  id: "22222222-2222-4222-8222-222222222222",
  product_id: "product",
  creator_id: "creator",
  provider_checkout_id: "checkout",
  gross_amount: 1900,
  currency: "usd",
  status: "pending",
  buyer_email: "buyer@example.test",
  metadata: { provider_product_id: "creem-product" },
  access_token_hash: "original-token",
};
const subscription = {
  id: "subscription",
  last_transaction_id: "payment",
  mode: "test",
  metadata: { bento_session_id: session.id },
  product: { id: "creem-product", price: 1900, currency: "usd" },
  customer: { email: "buyer@example.test", name: "Buyer" },
  current_period_start_date: "2026-11-01T00:00:00Z",
  current_period_end_date: "2026-12-01T00:00:00Z",
};
async function deliver(period: Record<string, unknown>) {
  const body = JSON.stringify({
    id: "event-paid",
    eventType: "subscription.paid",
    object: { ...subscription, ...period },
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("local-test-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Array.from(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return handleCreemWebhook(
    new Request("https://local.test/webhook", {
      method: "POST",
      headers: { "creem-signature": signature },
      body,
    }),
    "11111111-1111-4111-8111-111111111111",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.claim.mockResolvedValue("claimed");
  mocks.rpc.mockResolvedValue({ data: { order_id: "order" }, error: null });
  mocks.from.mockImplementation((table: string) => {
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: session, error: null }),
      single: async () => ({
        data: table === "commerce_products" ? { id: "product", creator_id: "creator" } : session,
        error: null,
      }),
    };
    return query;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("Creem paid subscription period validation", () => {
  it.each([
    ["missing start", { current_period_start_date: undefined }],
    ["missing end", { current_period_end_date: undefined }],
    ["null start", { current_period_start_date: null }],
    ["nonfinite start", { current_period_start_date: "not-a-date" }],
    ["nonfinite end", { current_period_end_date: "not-a-date" }],
    ["reversed period", { current_period_start_date: "2027-01-01T00:00:00Z" }],
    ["zero-length period", { current_period_end_date: subscription.current_period_start_date }],
  ])("rejects a signed paid event with %s before any financial mutation", async (_name, period) => {
    const result = await deliver(period as Record<string, unknown>);
    expect(result.status).toBe(500);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("records a signed payment with a finite ordered service period", async () => {
    const result = await deliver({});
    expect(result.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "fulfill_provider_commerce_order_with_period",
      expect.objectContaining({
        p_provider_subscription_id: "subscription",
        p_provider_payment_id: "payment",
        p_subscription_period_start: "2026-11-01T00:00:00.000Z",
        p_subscription_period_end: "2026-12-01T00:00:00.000Z",
      }),
    );
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        fundingOrderId: "order",
        currentPeriodStart: subscription.current_period_start_date,
        currentPeriodEnd: subscription.current_period_end_date,
      }),
    );
  });
});
