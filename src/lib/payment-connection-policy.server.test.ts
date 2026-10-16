import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ provider: null as string | null }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        single: async () => ({ data: { commerce_payment_provider: state.provider }, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return query;
    },
  },
}));
import { creatorStorePaymentSetup } from "./payment-connection-policy.server";
afterEach(() => {
  vi.unstubAllEnvs();
  state.provider = null;
});
describe("store payment setup isolation", () => {
  it("allows the staging mock checkout to create products without real payment credentials", async () => {
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("COMMERCE_PAYMENT_PROVIDER", "mock");
    await expect(creatorStorePaymentSetup("creator")).resolves.toEqual({
      ready: true,
      selectedProvider: null,
    });
  });
  it("never bypasses production payment readiness or a selected real provider", async () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("COMMERCE_PAYMENT_PROVIDER", "mock");
    expect((await creatorStorePaymentSetup("creator")).ready).toBe(false);
    vi.stubEnv("APP_ENV", "staging");
    state.provider = "stripe";
    expect((await creatorStorePaymentSetup("creator")).ready).toBe(false);
  });
});
