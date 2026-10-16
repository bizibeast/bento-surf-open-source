import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), verify: vi.fn(), getClaims: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getClaims: mocks.getClaims } }),
}));
vi.mock("./workspace-session.server", () => ({
  WORKSPACE_COOKIE: "bento_workspace",
  workspaceCookieSigningKey: () => "secret",
  verifyWorkspaceCookie: mocks.verify,
  resolveWorkspace: mocks.resolve,
}));
import { authenticateUpload } from "./r2-storage.server";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SUPABASE_URL", "https://example.test");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "key");
  mocks.getClaims.mockResolvedValue({ data: { claims: { sub: "auth-user" } } });
  mocks.verify.mockResolvedValue("second");
  mocks.resolve.mockResolvedValue({ workspaceId: "second" });
});
it("uploads under the selected owned second workspace, never the auth user", async () => {
  const request = new Request("https://bento.surf/api/storage/upload", {
    headers: { authorization: "Bearer token", cookie: "bento_workspace=signed" },
  });
  expect(await authenticateUpload(request, {} as Parameters<typeof authenticateUpload>[1])).toBe(
    "second",
  );
  expect(mocks.verify).toHaveBeenCalledWith("signed", "secret");
  expect(mocks.resolve).toHaveBeenCalledWith("auth-user", "second");
});
it("does not trust a client workspace ID or unsigned cookie", async () => {
  mocks.verify.mockResolvedValue(null);
  mocks.resolve.mockResolvedValue({ workspaceId: "owned-default" });
  const request = new Request("https://bento.surf/api/storage/upload?workspaceId=foreign", {
    headers: {
      authorization: "Bearer token",
      cookie: "bento_workspace=forged",
      "x-workspace-id": "foreign",
    },
  });
  expect(await authenticateUpload(request, {} as Parameters<typeof authenticateUpload>[1])).toBe(
    "owned-default",
  );
  expect(mocks.resolve).toHaveBeenCalledWith("auth-user", null);
});
