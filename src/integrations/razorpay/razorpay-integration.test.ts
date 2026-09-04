import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertRazorpayEnvironment,
  hmacSha256Hex,
  isRazorpayKeyId,
  RAZORPAY_WEBHOOK_EVENTS,
  razorpayCredentialFingerprint,
  razorpayEnvironment,
  razorpayRequest,
  razorpayWebhookUrl,
  verifyRazorpayPaymentSignature,
  verifyRazorpayWebhookSignature,
} from "./client.server";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Razorpay creator payments", () => {
  it("subscribes to payment, refund, and dispute lifecycle events", () => {
    expect(RAZORPAY_WEBHOOK_EVENTS).toContain("payment.dispute.created");
    expect(RAZORPAY_WEBHOOK_EVENTS).toContain("payment.dispute.won");
    expect(RAZORPAY_WEBHOOK_EVENTS).toContain("payment.dispute.lost");
  });

  it("recognizes Razorpay key modes and keeps live keys out of staging", () => {
    expect(isRazorpayKeyId("rzp_test_1234567890abcdef")).toBe(true);
    expect(isRazorpayKeyId("rzp_live_1234567890abcdef")).toBe(true);
    expect(isRazorpayKeyId("sk_live_wrong_provider")).toBe(false);
    expect(razorpayEnvironment("rzp_test_1234567890abcdef")).toBe("sandbox");
    expect(razorpayEnvironment("rzp_live_1234567890abcdef")).toBe("production");

    vi.stubEnv("APP_ENV", "staging");
    expect(() => assertRazorpayEnvironment("rzp_live_1234567890abcdef")).toThrow(
      /Live keys are blocked on staging/,
    );
    expect(assertRazorpayEnvironment("rzp_test_1234567890abcdef")).toBe("sandbox");
  });

  it("uses HTTP Basic auth and JSON without exposing the secret in the URL", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "order_example", status: "created" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await razorpayRequest({ keyId: "rzp_test_public", keySecret: "private-secret" }, "/v1/orders", {
      method: "POST",
      body: { amount: 5000, currency: "INR" },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.razorpay.com/v1/orders");
    expect(String(url)).not.toContain("private-secret");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${btoa("rzp_test_public:private-secret")}`,
    );
    expect(JSON.parse(String(init?.body))).toEqual({ amount: 5000, currency: "INR" });
  });

  it("verifies checkout and webhook HMAC signatures in constant-time form", async () => {
    const keySecret = "razorpay-key-secret-for-test";
    const orderId = "order_Example123";
    const paymentId = "pay_Example123";
    const paymentSignature = await hmacSha256Hex(keySecret, `${orderId}|${paymentId}`);
    expect(
      await verifyRazorpayPaymentSignature({
        orderId,
        paymentId,
        signature: paymentSignature,
        keySecret,
      }),
    ).toBe(true);
    expect(
      await verifyRazorpayPaymentSignature({
        orderId,
        paymentId,
        signature: "0".repeat(64),
        keySecret,
      }),
    ).toBe(false);

    const body = JSON.stringify({ entity: "event", event: "payment.captured" });
    const webhookSecret = "separate-webhook-secret";
    const webhookSignature = await hmacSha256Hex(webhookSecret, body);
    expect(await verifyRazorpayWebhookSignature(body, webhookSignature, webhookSecret)).toBe(true);
    expect(await verifyRazorpayWebhookSignature(`${body} `, webhookSignature, webhookSecret)).toBe(
      false,
    );
  });

  it("fingerprints credentials and creates an environment-specific webhook URL", async () => {
    const first = await razorpayCredentialFingerprint({
      keyId: "rzp_test_example",
      keySecret: "secret-one",
    });
    const second = await razorpayCredentialFingerprint({
      keyId: "rzp_test_example",
      keySecret: "secret-two",
    });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);

    process.env.VITE_APP_URL = "https://app.test.bento.surf";
    expect(razorpayWebhookUrl("11111111-1111-4111-8111-111111111111")).toBe(
      "https://app.test.bento.surf/api/webhooks/razorpay/direct/11111111-1111-4111-8111-111111111111",
    );
  });

  it("returns a safe actionable message for rejected credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: { description: "Authentication failed for supplied key" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      razorpayRequest(
        { keyId: "rzp_test_public", keySecret: "private-secret" },
        "/v1/payments?count=1",
      ),
    ).rejects.toThrow(/rejected these API keys/);
  });
});
