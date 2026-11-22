import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BENNY_EDITING_MODELS } from "./benny-models";
import { FULLY_MANAGED_BILLING_CATALOG } from "./plans";
const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  brain: vi.fn(),
  byok: vi.fn(),
  spend: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    const fn = {
      middleware: () => fn,
      validator: () => fn,
      handler: (handler: (input: unknown) => unknown) => () =>
        handler({ context: { workspaceId: "trusted-workspace", authUserId: "trusted-owner" } }),
    };
    return fn;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("./plan.server", () => ({
  getBillingCatalog: mocks.catalog,
  hasPlanEntitlement: mocks.brain,
}));
vi.mock("./provider-budget.server", async (original) => ({
  ...(await original<typeof import("./provider-budget.server")>()),
  getManagedSpendStatus: mocks.spend,
}));
vi.mock("./benny-byok.server", () => ({
  canUseBennyByok: mocks.byok,
  loadBennyProviderPreferences: async () => ({ providers: [], defaultProviderId: null }),
}));
vi.mock("./benny-web-search.server", () => ({ hasBennySearchKey: async () => false }));
import { getBennyAiSettings } from "./benny-byok.functions";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENROUTER_API_KEY", "fixture-key");
  vi.stubEnv("AI_TEXT_PROVIDER", "openrouter");
  vi.stubGlobal("__env__", {});
  mocks.catalog.mockResolvedValue(FULLY_MANAGED_BILLING_CATALOG);
  mocks.brain.mockResolvedValue(true);
  mocks.byok.mockResolvedValue(true);
  mocks.spend.mockResolvedValue({
    eligible: true,
    weekly: { remainingMicrousd: 1 },
    monthly: { remainingMicrousd: 1 },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("lists the named routes with their verified availability only after server-side paid eligibility", async () => {
  expect((await getBennyAiSettings())?.bentoModels).toEqual(
    BENNY_EDITING_MODELS.map(({ id, name, available }) => ({
      id,
      name,
      ...(!available ? { available: false } : {}),
    })),
  );
  expect(mocks.spend).toHaveBeenCalledWith("trusted-workspace", { authUserId: "trusted-owner" });
});
it.each(["ineligible", "unavailable"])(
  "hides managed models when the paid meter is %s",
  async (reason) => {
    mocks.spend.mockResolvedValue({ eligible: false, reason });
    expect((await getBennyAiSettings())?.bentoModels).toEqual([]);
  },
);
it("hides premium models without the company connection", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "");
  expect((await getBennyAiSettings())?.bentoModels).toEqual([]);
});
it("preserves actual legacy model naming without granting premium models", async () => {
  mocks.catalog.mockResolvedValue("legacy");
  expect((await getBennyAiSettings())?.bentoModels).toEqual([
    { id: "bento", name: "GLM 5.3 Flash" },
  ]);
  expect(mocks.spend).not.toHaveBeenCalled();
});
it("leaves Creator on saved own-key models and Store without AI access", async () => {
  mocks.catalog.mockResolvedValue("2026-10");
  mocks.brain.mockResolvedValue(false);
  expect((await getBennyAiSettings())?.bentoModels).toEqual([]);
  mocks.byok.mockResolvedValue(false);
  expect(await getBennyAiSettings()).toBeNull();
});
