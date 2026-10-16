import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  select: vi.fn(),
  eq: vi.fn(),
  requirePlan: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder: any = {};
    builder.middleware = builder.validator = () => builder;
    builder.handler = (handler: any) => () => handler({ context: { userId: "owner" } });
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const query: any = {};
      query.select = (...args: unknown[]) => {
        mocks.select(...args);
        return query;
      };
      query.eq = (...args: unknown[]) => {
        mocks.eq(...args);
        return query;
      };
      query.order = () => query;
      query.limit = async () => ({ data: mocks.rows, error: null });
      return query;
    },
  },
}));
vi.mock("./plan.server", () => ({ requirePlanEntitlement: mocks.requirePlan }));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: vi.fn() }));
vi.mock("./ai-json.server", () => ({ runAiJson: vi.fn() }));
vi.mock("./r2-storage.server", () => ({
  getMediaBucket: vi.fn(),
  mediaObjectUrl: vi.fn(),
  validateMediaObjectKey: vi.fn(),
}));
vi.mock("./content-agent-media.server", () => ({
  registerAgentMedia: vi.fn(),
  resolveOwnedAgentMedia: vi.fn(),
}));
vi.mock("./content-agent-images.server", () => ({
  reserveImageGeneration: vi.fn(),
  getImageWorkspaceState: vi.fn(),
  processImageJob: vi.fn(),
  imageProviderAvailable: vi.fn(),
}));
vi.mock("./content-agent-identity.server", () => ({
  getContentAgentPreferencesForWorkspace: vi.fn(),
}));
vi.mock("./scheduler-stock.server", () => ({
  searchStockPhotos: vi.fn(),
  importStockPhoto: vi.fn(),
  availableStockProviders: vi.fn(),
}));

import { getAgentPreviewAccounts } from "./scheduler-assist.functions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [];
});

it("lets the real Agent approve active accounts while preserving missing-permission and reconnect blockers", async () => {
  mocks.rows = [
    { id: "linkedin", provider: "linkedin", status: "active", scopes: [], reauth_required: false },
    {
      id: "instagram",
      provider: "instagram",
      status: "active",
      scopes: ["instagram_business_content_publish"],
      reauth_required: false,
    },
    { id: "no-scope", provider: "instagram", status: "active", scopes: [], reauth_required: false },
    { id: "reconnect", provider: "threads", status: "active", scopes: [], reauth_required: true },
  ];
  const result = await getAgentPreviewAccounts();
  expect(result.map((account) => account.canPublish)).toEqual([true, true, false, false]);
  expect(result[2].publishBlockReason).toMatch(/approve publishing access/);
  expect(result[3].publishBlockReason).toMatch(/Reconnect/);
  expect(mocks.eq).toHaveBeenCalledWith("user_id", "owner");
  expect(mocks.eq).toHaveBeenCalledWith("status", "active");
  expect(mocks.select).toHaveBeenCalledWith(expect.stringContaining("scopes,reauth_required"));
  expect(mocks.requirePlan).toHaveBeenCalledWith("owner", "brain", expect.any(String));
});
