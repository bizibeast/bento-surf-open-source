import { afterEach, describe, expect, it, vi } from "vitest";
import { dodoSupportsCommerceKind } from "./checkout.server";
import {
  DODO_CREATOR_WEBHOOK_EVENTS,
  assertDodoEnvironmentAllowed,
  dodoApiKeyFingerprint,
  dodoCreatorWebhookUrl,
} from "./creator-client.server";
import { assertDodoCreatorBusiness, assertDodoPaymentAmount } from "./creator-webhook-validation";

describe("Dodo creator payments", () => {
  it("requires every creator webhook resource to match the connected business", () => {
    expect(() => assertDodoCreatorBusiness("biz_1", "biz_1", "refund")).not.toThrow();
    expect(() => assertDodoCreatorBusiness("biz_2", "biz_1", "refund")).toThrow(
      "Dodo refund belongs to a different business.",
    );
    expect(() => assertDodoCreatorBusiness(undefined, "biz_1", "refund")).toThrow(
      "Dodo refund belongs to a different business.",
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("supports only Dodo-compatible digital and hosted products", () => {
    expect(dodoSupportsCommerceKind("digital_product")).toBe(true);
    expect(dodoSupportsCommerceKind("course")).toBe(true);
    expect(dodoSupportsCommerceKind("webinar")).toBe(false);
    expect(dodoSupportsCommerceKind("paid_community")).toBe(false);
    expect(dodoSupportsCommerceKind("membership")).toBe(false);
    expect(dodoSupportsCommerceKind("coaching_call")).toBe(false);
    expect(dodoSupportsCommerceKind("custom_product")).toBe(false);
  });

  it("subscribes to the payment lifecycle needed for reliable fulfillment", () => {
    expect(DODO_CREATOR_WEBHOOK_EVENTS).toEqual([
      "payment.succeeded",
      "payment.failed",
      "payment.cancelled",
      "refund.succeeded",
      "dispute.opened",
      "dispute.challenged",
      "dispute.won",
      "dispute.lost",
      "dispute.cancelled",
      "dispute.accepted",
      "dispute.expired",
      "subscription.active",
      "subscription.renewed",
      "subscription.updated",
      "subscription.cancelled",
      "subscription.failed",
      "subscription.on_hold",
      "subscription.expired",
    ]);
  });

  it("uses stable, non-secret credential fingerprints", async () => {
    const fingerprint = await dodoApiKeyFingerprint("dodo-private-key-for-test-only");
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain("private-key");
  });

  it("creates an isolated per-connection webhook path", () => {
    vi.stubEnv("VITE_APP_URL", "https://staging.example/");
    expect(dodoCreatorWebhookUrl("connection-id")).toBe(
      "https://staging.example/api/webhooks/dodo/direct/connection-id",
    );
  });

  it.each(["development", "preview", "staging"])(
    "keeps live credentials out of non-production %s",
    (appEnv) => {
      vi.stubEnv("APP_ENV", appEnv);
      expect(() => assertDodoEnvironmentAllowed("live_mode")).toThrow(
        /Live keys are blocked outside production/,
      );
      expect(assertDodoEnvironmentAllowed("test_mode")).toBe("test_mode");
    },
  );

  it("keeps explicit production in live mode", () => {
    vi.stubEnv("APP_ENV", "production");
    expect(assertDodoEnvironmentAllowed("live_mode")).toBe("live_mode");
    expect(() => assertDodoEnvironmentAllowed("test_mode")).toThrow(/Use a live Dodo API key/);
  });

  it("accepts the exact Bento checkout amount plus provider-collected tax", () => {
    expect(() =>
      assertDodoPaymentAmount(
        { currency: "USD", total_amount: 2_100, tax: 200 },
        { currency: "usd", gross_amount: 1_900 },
      ),
    ).not.toThrow();
  });

  it("rejects mismatched Dodo amounts and currencies before fulfillment", () => {
    expect(() =>
      assertDodoPaymentAmount(
        { currency: "usd", total_amount: 1_899, tax: 0 },
        { currency: "usd", gross_amount: 1_900 },
      ),
    ).toThrow("amount does not match");
    expect(() =>
      assertDodoPaymentAmount(
        { currency: "eur", total_amount: 1_900, tax: 0 },
        { currency: "usd", gross_amount: 1_900 },
      ),
    ).toThrow("currency does not match");
  });
});
