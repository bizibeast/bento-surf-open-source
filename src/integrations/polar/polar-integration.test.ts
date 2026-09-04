import { afterEach, describe, expect, it } from "vitest";
import { decryptServerSecret, encryptServerSecret } from "@/lib/secret-crypto.server";
import { polarOrganizationReadiness } from "./client.server";
import { polarSupportsCommerceKind } from "./checkout.server";
import { assertPolarOrderSession } from "./webhook.server";

const originalKey = process.env.PAYMENT_CONNECTION_ENCRYPTION_KEY;

afterEach(() => {
  if (originalKey === undefined) delete process.env.PAYMENT_CONNECTION_ENCRYPTION_KEY;
  else process.env.PAYMENT_CONNECTION_ENCRYPTION_KEY = originalKey;
});

describe("payment connection secret encryption", () => {
  it("round-trips OAuth and webhook secrets without storing plaintext", async () => {
    process.env.PAYMENT_CONNECTION_ENCRYPTION_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const plaintext = "polar_oauth_token_that_must_stay_private";
    const encrypted = await encryptServerSecret(plaintext);

    expect(encrypted).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encrypted).not.toContain(plaintext);
    await expect(decryptServerSecret(encrypted)).resolves.toBe(plaintext);
  });

  it("rejects missing and incorrectly sized encryption keys", async () => {
    delete process.env.PAYMENT_CONNECTION_ENCRYPTION_KEY;
    await expect(encryptServerSecret("secret")).rejects.toThrow("not configured");

    process.env.PAYMENT_CONNECTION_ENCRYPTION_KEY = "dG9vLXNob3J0";
    await expect(encryptServerSecret("secret")).rejects.toThrow("32-byte key");
  });

  it("supports 32-byte hexadecimal keys without changing the encrypted payload format", async () => {
    process.env.PAYMENT_CONNECTION_ENCRYPTION_KEY = "ab".repeat(32);
    const encrypted = await encryptServerSecret("secret");

    expect(encrypted).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    await expect(decryptServerSecret(encrypted)).resolves.toBe("secret");
  });
});

describe("Polar creator payment policy", () => {
  it("only marks an active, verified organization with checkout and payouts as ready", () => {
    expect(
      polarOrganizationReadiness({
        capabilities: { checkoutPayments: true, payouts: true },
        detailsSubmittedAt: new Date("2026-07-21T00:00:00Z"),
        status: "active",
      }),
    ).toEqual({
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      onboardingStatus: "complete",
    });

    expect(
      polarOrganizationReadiness({
        capabilities: { checkoutPayments: true, payouts: false },
        detailsSubmittedAt: new Date("2026-07-21T00:00:00Z"),
        status: "active",
      }).onboardingStatus,
    ).toBe("pending");
  });

  it("allows Polar only for immediately fulfilled digital goods and access", () => {
    expect(polarSupportsCommerceKind("digital_product")).toBe(true);
    expect(polarSupportsCommerceKind("course")).toBe(true);
    expect(polarSupportsCommerceKind("paid_community")).toBe(false);
    expect(polarSupportsCommerceKind("membership")).toBe(false);
    expect(polarSupportsCommerceKind("coaching_call")).toBe(false);
    expect(polarSupportsCommerceKind("custom_product")).toBe(false);
  });

  it("binds paid orders to the exact creator checkout, amount, currency, and zero Bento fee", () => {
    const valid = {
      session: {
        id: "77d33b90-1b6d-4a46-9a76-846d60c20170",
        product_id: "dc14e4e1-278e-4f8e-9d0e-a46a05283abc",
        creator_id: "creator-1",
        connection_id: "connection-1",
        provider_checkout_id: "checkout-1",
        gross_amount: 1900,
        currency: "usd",
        status: "pending",
      },
      connection: { id: "connection-1", creator_id: "creator-1" },
      order: {
        checkoutId: "checkout-1",
        netAmount: 1900,
        currency: "USD",
        platformFeeAmount: 0,
      },
    };
    expect(assertPolarOrderSession(valid)).toBe(valid.session.product_id);
    expect(() =>
      assertPolarOrderSession({
        ...valid,
        order: { ...valid.order, netAmount: 1800 },
      }),
    ).toThrow("amount");
    expect(() =>
      assertPolarOrderSession({
        ...valid,
        order: { ...valid.order, platformFeeAmount: 100 },
      }),
    ).toThrow("platform fee");
  });
});
