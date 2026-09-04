import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPayPalEnvironment,
  paypalApiBaseUrl,
  paypalCredentialFingerprint,
  PAYPAL_WEBHOOK_EVENTS,
} from "./client.server";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("creator-owned PayPal credentials", () => {
  it("subscribes to customer dispute openings and resolutions", () => {
    expect(PAYPAL_WEBHOOK_EVENTS).toContain("CUSTOMER.DISPUTE.CREATED");
    expect(PAYPAL_WEBHOOK_EVENTS).toContain("CUSTOMER.DISPUTE.RESOLVED");
  });

  it("keeps sandbox and production API hosts separate", () => {
    expect(paypalApiBaseUrl("sandbox")).toBe("https://api-m.sandbox.paypal.com");
    expect(paypalApiBaseUrl("production")).toBe("https://api-m.paypal.com");
  });

  it("blocks sandbox credentials on production and live credentials on staging", () => {
    vi.stubEnv("APP_ENV", "production");
    expect(() => assertPayPalEnvironment("sandbox")).toThrow("Sandbox credentials");
    expect(assertPayPalEnvironment("production")).toBe("production");

    vi.stubEnv("APP_ENV", "staging");
    expect(() => assertPayPalEnvironment("production")).toThrow("Live credentials");
    expect(assertPayPalEnvironment("sandbox")).toBe("sandbox");
  });

  it.each(["development", "preview", "staging"])(
    "blocks live credentials outside production in %s",
    (appEnv) => {
      vi.stubEnv("APP_ENV", appEnv);
      expect(() => assertPayPalEnvironment("production")).toThrow(
        "Live credentials are blocked outside production",
      );
      expect(assertPayPalEnvironment("sandbox")).toBe("sandbox");
    },
  );

  it("fingerprints the full credential pair without storing either raw value", async () => {
    const first = await paypalCredentialFingerprint({
      clientId: "creator-paypal-client-id",
      clientSecret: "creator-paypal-client-secret",
    });
    const second = await paypalCredentialFingerprint({
      clientId: "creator-paypal-client-id",
      clientSecret: "rotated-paypal-client-secret",
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain("creator-paypal");
  });
});
