import { beforeEach, describe, expect, it, vi } from "vitest";

const ids = {
  auth: "11111111-1111-4111-8111-111111111111",
  original: "22222222-2222-4222-8222-222222222222",
  second: "33333333-3333-4333-8333-333333333333",
};

const mocks = vi.hoisted(() => ({
  getRequest: vi.fn(),
  getCookie: vi.fn(),
  getClaims: vi.fn(),
  verifyWorkspaceCookie: vi.fn(),
  resolveWorkspace: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({ server: (handler: unknown) => handler }),
  createServerOnlyFn: (handler: unknown) => handler,
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: mocks.getRequest,
  getCookie: mocks.getCookie,
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getClaims: mocks.getClaims } }),
}));
vi.mock("@/lib/workspace-session.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspace-session.server")>();
  return {
    ...actual,
    verifyWorkspaceCookie: mocks.verifyWorkspaceCookie,
    resolveWorkspace: mocks.resolveWorkspace,
  };
});

import { WorkspaceAccessError } from "@/lib/workspace-session.server";
import { requireSupabaseAuth } from "./auth-middleware";

const workspaceSession = (workspaceId: string) => ({
  authUserId: ids.auth,
  workspaceId,
  workspace: { id: workspaceId },
  workspaces: [{ id: workspaceId }],
  appTheme: "light",
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "publishable";
  process.env.WORKSPACE_COOKIE_SIGNING_KEY = "s".repeat(32);
  mocks.getRequest.mockReturnValue(
    new Request("https://app.example.com/_serverFn", {
      headers: { authorization: `Bearer ${"a".repeat(24)}` },
    }),
  );
  mocks.getClaims.mockResolvedValue({ data: { claims: { sub: ids.auth } }, error: null });
  mocks.getCookie.mockReturnValue("signed-workspace");
  mocks.verifyWorkspaceCookie.mockResolvedValue(ids.second);
  mocks.resolveWorkspace.mockResolvedValue(workspaceSession(ids.second));
});

async function runMiddleware() {
  const next = vi.fn(async ({ context }) => context);
  const context = await (
    requireSupabaseAuth as unknown as (input: {
      next: typeof next;
    }) => Promise<Record<string, unknown>>
  )({ next });
  return { context, next };
}

describe("workspace-aware Supabase auth middleware", () => {
  it("keeps the auth identity separate from the selected workspace", async () => {
    const { context } = await runMiddleware();

    expect(context).toMatchObject({
      authUserId: ids.auth,
      userId: ids.second,
      workspaceId: ids.second,
    });
  });

  it("falls back to the original workspace for a forged or foreign cookie", async () => {
    mocks.verifyWorkspaceCookie.mockResolvedValue(null);
    mocks.resolveWorkspace.mockResolvedValue(workspaceSession(ids.original));

    const { context } = await runMiddleware();

    expect(mocks.resolveWorkspace).toHaveBeenCalledWith(ids.auth, null);
    expect(context.userId).toBe(ids.original);
  });

  it("returns forbidden when the login has no active workspace membership", async () => {
    mocks.resolveWorkspace.mockRejectedValue(new WorkspaceAccessError());

    await expect(runMiddleware()).rejects.toMatchObject({ statusCode: 403 });
  });
});
