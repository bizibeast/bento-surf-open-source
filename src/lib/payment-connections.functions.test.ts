import { describe, expect, it } from "vitest";
import { paymentAccountReady } from "./payment-connections.functions";

const readyAccount = {
  provider: "stripe",
  credential_mode: "api_key",
  onboarding_status: "complete",
  charges_enabled: true,
  payouts_enabled: true,
  webhook_endpoint_id: "we_123",
  webhook_secret_ciphertext: "encrypted_secret",
};

describe("paymentAccountReady", () => {
  it("requires payment, payout, onboarding, and webhook readiness", () => {
    expect(paymentAccountReady(readyAccount)).toBe(true);
    expect(paymentAccountReady({ ...readyAccount, charges_enabled: false })).toBe(false);
    expect(paymentAccountReady({ ...readyAccount, payouts_enabled: false })).toBe(false);
    expect(paymentAccountReady({ ...readyAccount, onboarding_status: "pending" })).toBe(false);
    expect(paymentAccountReady({ ...readyAccount, webhook_endpoint_id: null })).toBe(false);
    expect(paymentAccountReady({ ...readyAccount, webhook_secret_ciphertext: null })).toBe(false);
  });

  it("accepts PayPal API-key accounts whose webhook endpoint is provider-verifiable", () => {
    expect(
      paymentAccountReady({
        ...readyAccount,
        provider: "paypal",
        webhook_secret_ciphertext: null,
      }),
    ).toBe(true);
  });

  it("does not treat missing accounts as ready", () => {
    expect(paymentAccountReady(null)).toBe(false);
  });
});
