import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const fallbackId = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  getCookie: vi.fn(),
  setCookie: vi.fn(),
  resolveWorkspace: vi.fn(),
  signWorkspaceCookie: vi.fn(),
  verifyWorkspaceCookie: vi.fn(),
  contextSession: null as unknown,
  preferenceUpdate: vi.fn(),
  preferenceOwner: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (handler: unknown) => handler,
  createServerFn: () => {
    let validate = (value: unknown) => value;
    const builder: Record<string, unknown> = {};
    builder.middleware = () => builder;
    builder.validator = (validator: (value: unknown) => unknown) => {
      validate = validator;
      return builder;
    };
    builder.handler =
      (
        handler: (input: {
          context: { authUserId: string; claims: { sub: string }; workspaceSession: unknown };
          data: unknown;
        }) => unknown,
      ) =>
      (input?: { data?: unknown }) =>
        handler({
          context: {
            authUserId: "auth-user",
            claims: { sub: "auth-user" },
            workspaceSession: mocks.contextSession,
          },
          data: validate(input?.data),
        });
    return builder;
  },
}));
vi.mock("@tanstack/react-start/server", () => ({
  getCookie: mocks.getCookie,
  setCookie: mocks.setCookie,
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const query: Record<string, unknown> = {};
      query.update = vi.fn((value: unknown) => {
        mocks.preferenceUpdate(value);
        return query;
      });
      query.eq = vi.fn((_column: string, value: string) => {
        mocks.preferenceOwner(value);
        return query;
      });
      query.select = vi.fn(() => query);
      query.single = vi.fn(async () => ({ data: { app_theme: "dark" }, error: null }));
      return query;
    },
  },
}));
vi.mock("./workspace-session.server", () => ({
  WORKSPACE_COOKIE: "bento_workspace",
  resolveWorkspace: mocks.resolveWorkspace,
  signWorkspaceCookie: mocks.signWorkspaceCookie,
  verifyWorkspaceCookie: mocks.verifyWorkspaceCookie,
  workspaceCookieSigningKey: () => "s".repeat(32),
}));

import {
  getWorkspaceSession,
  switchWorkspace,
  updateAccountPreference,
} from "./workspace.functions";

const session = (id: string) => ({
  authUserId: "auth-user",
  workspaceId: id,
  workspace: { id },
  workspaces: [{ id }],
  appTheme: "light",
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WORKSPACE_COOKIE_SIGNING_KEY = "s".repeat(32);
  mocks.signWorkspaceCookie.mockResolvedValue("v1.signed.value");
  mocks.verifyWorkspaceCookie.mockResolvedValue(workspaceId);
  mocks.resolveWorkspace.mockResolvedValue(session(workspaceId));
  mocks.contextSession = session(workspaceId);
});

describe("workspace server functions", () => {
  it("returns the workspace session already resolved by auth middleware", async () => {
    await expect(getWorkspaceSession()).resolves.toEqual(session(workspaceId));
    expect(mocks.resolveWorkspace).not.toHaveBeenCalled();
  });

  it("sets a secure HTTP-only cookie only for an accessible active workspace", async () => {
    await switchWorkspace({ data: { workspaceId } });

    expect(mocks.setCookie).toHaveBeenCalledWith("bento_workspace", "v1.signed.value", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 31_536_000,
    });
  });

  it("rejects an inaccessible workspace without changing the cookie", async () => {
    mocks.resolveWorkspace.mockResolvedValue(session(fallbackId));

    await expect(switchWorkspace({ data: { workspaceId } })).rejects.toThrow(
      "Workspace is unavailable",
    );
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });

  it("stores app theme against the login identity", async () => {
    await expect(updateAccountPreference({ data: { appTheme: "dark" } })).resolves.toEqual({
      appTheme: "dark",
    });
    expect(mocks.preferenceUpdate).toHaveBeenCalledWith({ app_theme: "dark" });
    expect(mocks.preferenceOwner).toHaveBeenCalledWith("auth-user");
  });
});
