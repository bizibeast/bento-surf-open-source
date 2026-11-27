import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), selected: false, connectionReady: true }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("./plan.server", () => ({
  hasPlanEntitlement: async () => true,
  requireCreatorPaymentConnect: vi.fn(),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("https://app.test.self.invalid/"),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const fn = {
      middleware: () => fn,
      validator: () => fn,
      handler: (handler: (input: unknown) => unknown) => () =>
        handler({ context: { userId: "workspace" } }),
    };
    return fn;
  },
}));
import { getCreatorPaymentSettings } from "./payment-connections.functions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selected = false;
  mocks.connectionReady = true;
  mocks.from.mockImplementation((table: string) => {
    const read = () => ({
      data:
        table === "profiles"
          ? { plan_id: "creator", commerce_payment_provider: mocks.selected ? "stripe" : null }
          : mocks.selected && mocks.connectionReady
            ? [
                {
                  id: "account",
                  provider: "stripe",
                  onboarding_status: "complete",
                  charges_enabled: true,
                  payouts_enabled: true,
                  webhook_endpoint_id: "endpoint",
                  webhook_secret_ciphertext: "encrypted",
                },
              ]
            : [],
      error: null,
    });
    const query = {
      select: () => query,
      eq: () => query,
      single: async () => read(),
      then: (resolve: (value: ReturnType<typeof read>) => unknown) =>
        Promise.resolve(read()).then(resolve),
    };
    return query;
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("authoritative staging mock payment availability", () => {
  it.each([
    ["staging", "mock", true],
    ["production", "mock", false],
    ["development", "mock", false],
    ["staging", "disabled", false],
  ])("exposes mock availability for %s/%s as %s", async (environment, provider, expected) => {
    vi.stubEnv("APP_ENV", environment);
    vi.stubEnv("COMMERCE_PAYMENT_PROVIDER", provider);
    expect(await getCreatorPaymentSettings()).toMatchObject({
      selectedProvider: null,
      stagingMockAvailable: expected,
    });
  });
  it("keeps a selected ready provider authoritative even on mock-enabled staging", async () => {
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("COMMERCE_PAYMENT_PROVIDER", "mock");
    mocks.selected = true;
    expect(await getCreatorPaymentSettings()).toMatchObject({
      selectedProvider: "stripe",
      stagingMockAvailable: false,
    });
  });
  it("does not replace an explicitly selected incomplete provider with test checkout", async () => {
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("COMMERCE_PAYMENT_PROVIDER", "mock");
    mocks.selected = true;
    mocks.connectionReady = false;
    expect(await getCreatorPaymentSettings()).toMatchObject({
      selectedProvider: null,
      stagingMockAvailable: false,
    });
  });
});
