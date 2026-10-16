import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  trial: null as null | Record<string, unknown>,
  subscription: null as null | Record<string, unknown>,
  checkout: null as null | Record<string, unknown>,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "bento_trial_checkouts") {
        const q = {
          select: () => q,
          eq: () => q,
          single: async () => ({ data: state.checkout, error: null }),
        };
        return { insert: async () => ({ error: { code: "23505" } }), select: () => q };
      }
      const result = () => ({
        data:
          table === "bento_trial_owners"
            ? state.trial
            : table === "subscriptions"
              ? state.subscription
              : { billing_catalog: "2026-10", onboarded: false },
        error: null,
      });
      const q = {
        select: () => q,
        eq: () => q,
        single: async () => result(),
        maybeSingle: async () => result(),
      };
      return q;
    },
  },
}));
import { checkoutEligibility, reserveTrialCheckout } from "./billing-checkout.server";
beforeEach(() => {
  state.trial = null;
  state.subscription = null;
  state.checkout = null;
});
describe("initial-workspace trial eligibility", () => {
  it("offers one trial on the signup workspace before its first subscription", async () => {
    expect(await checkoutEligibility("owner", "owner")).toMatchObject({ trialEligible: true });
  });
  it("does not offer a trial to an additional workspace even when a legacy owner has no trial ledger", async () => {
    expect(await checkoutEligibility("legacy-owner", "additional-workspace")).toMatchObject({
      trialEligible: false,
    });
  });
  it("does not restart an owner's existing or completed trial", async () => {
    state.trial = { auth_user_id: "owner" };
    expect(await checkoutEligibility("owner", "owner")).toMatchObject({ trialEligible: false });
  });
  it("lets an already reserved seven-day checkout finish with its original terms", async () => {
    vi.stubEnv("DODO_PAYMENTS_ENVIRONMENT", "test_mode");
    state.checkout = {
      workspace_id: "owner",
      plan_id: "store",
      trial_days: 7,
      trial_verification_key: "free-card-v1:test_mode:store-product",
      checkout_url: "https://checkout.dodopayments.com/existing",
    };
    expect(
      await reserveTrialCheckout(
        "owner",
        "owner",
        "store",
        "free-card-v2:3:test_mode:store-product",
      ),
    ).toEqual({ url: "https://checkout.dodopayments.com/existing", checkoutKey: null });
    vi.unstubAllEnvs();
  });
});
