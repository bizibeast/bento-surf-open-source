import { afterEach, describe, expect, it } from "vitest";
import { stripeAccountFields, stripeAuthorizeUrl, stripeOnboardingStatus } from "./client.server";

const originalClientId = process.env.STRIPE_CONNECT_CLIENT_ID;
const originalAppUrl = process.env.VITE_APP_URL;

afterEach(() => {
  if (originalClientId === undefined)
    Reflect.deleteProperty(process.env, "STRIPE_CONNECT_CLIENT_ID");
  else process.env.STRIPE_CONNECT_CLIENT_ID = originalClientId;
  if (originalAppUrl === undefined) Reflect.deleteProperty(process.env, "VITE_APP_URL");
  else process.env.VITE_APP_URL = originalAppUrl;
});

describe("Stripe Connect", () => {
  it("builds a state-bound OAuth URL with safe creator prefill", () => {
    process.env.STRIPE_CONNECT_CLIENT_ID = "ca_test_bento";
    process.env.VITE_APP_URL = "https://app.test.bento.surf/";

    const url = new URL(
      stripeAuthorizeUrl("state-token", {
        email: "creator@example.com",
        businessName: "Creator Studio",
        url: "https://test.bento.surf/@creator",
      }),
    );

    expect(url.origin).toBe("https://connect.stripe.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("ca_test_bento");
    expect(url.searchParams.get("scope")).toBe("read_write");
    expect(url.searchParams.get("state")).toBe("state-token");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.test.bento.surf/integrations/stripe/callback",
    );
    expect(url.searchParams.get("stripe_user[email]")).toBe("creator@example.com");
    expect(url.searchParams.get("stripe_user[business_name]")).toBe("Creator Studio");
  });

  it("only considers an account complete when charges and payouts are enabled", () => {
    expect(
      stripeOnboardingStatus({
        id: "acct_ready",
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: true,
      }),
    ).toBe("complete");
    expect(
      stripeOnboardingStatus({
        id: "acct_restricted",
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: false,
      }),
    ).toBe("restricted");
    expect(stripeOnboardingStatus({ id: "acct_pending" })).toBe("pending");
  });

  it("normalizes Stripe account details before persistence", () => {
    expect(
      stripeAccountFields({
        id: "acct_123",
        country: "US",
        default_currency: "USD",
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: true,
        business_profile: { name: "Creator Studio", url: "https://example.com" },
        email: "creator@example.com",
        requirements: { currently_due: [] },
      }),
    ).toMatchObject({
      provider_account_id: "acct_123",
      onboarding_status: "complete",
      country: "us",
      default_currency: "usd",
      provider_metadata: {
        business_name: "Creator Studio",
        email: "creator@example.com",
      },
    });
  });
});
