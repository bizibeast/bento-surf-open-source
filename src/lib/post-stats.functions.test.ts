import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  connections: vi.fn(),
  read: vi.fn(),
  header: vi.fn(),
  rate: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (value: unknown) => value;
    const builder = {
      middleware: (_value: unknown) => builder,
      validator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler: (fn: (args: unknown) => unknown) => (input?: { data?: unknown }) =>
        fn({
          data: validate(input?.data),
          context: {
            authUserId: "signed-in-user",
            workspaceId: "11111111-1111-4111-8111-111111111111",
            workspaceSession: {
              workspaces: [
                {
                  id: "11111111-1111-4111-8111-111111111111",
                  displayName: "My workspace",
                  status: "active",
                },
              ],
            },
          },
        }),
    };
    return builder;
  },
}));
vi.mock("@tanstack/react-start/server", () => ({ setResponseHeader: mocks.header }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("./workspace-session.server", () => ({ resolveWorkspace: mocks.resolve }));
vi.mock("./post-stats-connected.server", () => ({
  loadPostStatsConnections: mocks.connections,
  readWorkspacePostStats: mocks.read,
}));
vi.mock("./request-security.server", () => ({
  enforceRequestRateLimit: mocks.rate,
  RequestHttpError: class extends Error {
    constructor(
      readonly statusCode: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
import { getPostStatsAccess, getWorkspacePostStats } from "./post-stats.functions";
describe("connected stats server function boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("rejects a selected workspace that the signed-in user cannot access", async () => {
    const foreign = "22222222-2222-4222-8222-222222222222";
    mocks.resolve.mockResolvedValue({ workspaceId: "different", workspace: { status: "active" } });
    await expect(
      getWorkspacePostStats({
        data: { url: "https://instagram.com/reel/exact", workspaceId: foreign },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.resolve).toHaveBeenCalledWith("signed-in-user", foreign);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("marks readiness private and never returns encrypted tokens", async () => {
    mocks.connections.mockResolvedValue([
      {
        provider: "instagram",
        provider_handle: "creator",
        scopes: ["instagram_business_manage_insights"],
        access_token: "secret-must-not-escape",
      },
    ]);
    const result = await getPostStatsAccess();
    expect(JSON.stringify(result)).not.toContain("secret-must-not-escape");
    expect(result.accounts).toEqual([
      { provider: "instagram", handle: "creator", analyticsReady: true },
    ]);
    expect(mocks.header).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });
});
