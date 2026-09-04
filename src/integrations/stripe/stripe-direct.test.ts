import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertStripeKeyMatchesEnvironment,
  isStripeRestrictedKey,
  stripeDirectRequest,
  STRIPE_DIRECT_ENABLED_EVENTS,
  stripeDirectWebhookUrl,
  stripeRestrictedKeyEnvironment,
  verifyStripeDirectRestrictedKey,
} from "./client.server";
import { verifyStripeSignature } from "./webhook.server";

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(process.env, "VITE_APP_URL");
  Reflect.deleteProperty(process.env, "APP_ENV");
});

describe("creator-owned Stripe credentials", () => {
  const restrictedLiveKey = ["rk", "live", "example1234567890"].join("_");
  const secretLiveKey = ["sk", "live", "example1234567890"].join("_");

  it("subscribes to dispute openings and authoritative closures", () => {
    expect(STRIPE_DIRECT_ENABLED_EVENTS).toContain("charge.dispute.created");
    expect(STRIPE_DIRECT_ENABLED_EVENTS).toContain("charge.dispute.closed");
  });

  it("accepts restricted keys and rejects unrestricted secret keys", () => {
    expect(isStripeRestrictedKey("rk_test_example1234567890")).toBe(true);
    expect(isStripeRestrictedKey(restrictedLiveKey)).toBe(true);
    expect(isStripeRestrictedKey("sk_test_example1234567890")).toBe(false);
    expect(isStripeRestrictedKey(secretLiveKey)).toBe(false);
    expect(stripeRestrictedKeyEnvironment(restrictedLiveKey)).toBe("production");
    expect(stripeRestrictedKeyEnvironment("rk_test_example1234567890")).toBe("sandbox");
  });

  it("calls Stripe directly without a connected-account header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "acct_creator" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      stripeDirectRequest<{ id: string }>("rk_test_example1234567890", "/v1/account"),
    ).resolves.toEqual({ id: "acct_creator" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer rk_test_example1234567890");
    expect(headers.has("Stripe-Account")).toBe(false);
  });

  it("verifies only the permissions Bento needs without requiring account access", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await verifyStripeDirectRestrictedKey("rk_test_example1234567890");

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual(
      expect.arrayContaining([
        "https://api.stripe.com/v1/charges?limit=1",
        "https://api.stripe.com/v1/payment_intents?limit=1",
        "https://api.stripe.com/v1/subscriptions?limit=1",
        "https://api.stripe.com/v1/checkout/sessions?limit=1",
        "https://api.stripe.com/v1/webhook_endpoints?limit=1",
      ]),
    );
    expect(urls).not.toContain("https://api.stripe.com/v1/account");
  });

  it("builds an environment-specific, per-connection webhook URL", () => {
    process.env.VITE_APP_URL = "https://staging.example/";
    expect(stripeDirectWebhookUrl("11111111-1111-4111-8111-111111111111")).toBe(
      "https://staging.example/api/webhooks/stripe/direct/11111111-1111-4111-8111-111111111111",
    );
  });

  it("prevents test keys in production and live keys in staging", () => {
    process.env.APP_ENV = "production";
    expect(() => assertStripeKeyMatchesEnvironment("rk_test_example1234567890")).toThrow(
      /rk_live_/,
    );
    process.env.APP_ENV = "staging";
    expect(() => assertStripeKeyMatchesEnvironment(restrictedLiveKey)).toThrow(/rk_test_/);
  });

  it("verifies Stripe signatures and rejects a changed payload", async () => {
    const secret = ["whsec", "test", "signing", "secret"].join("_");
    const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${body}`),
    );
    const signature = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const header = `t=${timestamp},v1=${signature}`;

    await expect(verifyStripeSignature(body, header, secret)).resolves.toBe(true);
    await expect(verifyStripeSignature(`${body} `, header, secret)).resolves.toBe(false);
  });
});
