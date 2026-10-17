/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  refresh: vi.fn(),
  changes: [] as any[],
  filters: [] as any[],
  saved: true,
}));
vi.mock("./social-token-refresh.server", () => ({ withSocialTokenRefresh: state.refresh }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: { admin: { getUserById: async () => ({ data: null }) } },
    from() {
      let values: any;
      const chain: any = {
        select: () => chain,
        update: (v: any) => {
          values = v;
          state.changes.push(v);
          return chain;
        },
        eq: (...args: any[]) => {
          state.filters.push(args);
          return chain;
        },
        neq: () => chain,
        in: () => chain,
        or: () => chain,
        order: () => chain,
        limit: async () => ({
          data: [
            {
              id: "connection",
              user_id: "owner",
              provider: "twitter",
              access_token: "saved-token",
              refresh_token: "refresh",
              status: "active",
            },
          ],
          error: null,
        }),
        maybeSingle: async () => ({ data: state.saved ? { id: "connection" } : null, error: null }),
        then: (resolve: any) => Promise.resolve({ data: values, error: null }).then(resolve),
      };
      return chain;
    },
  },
}));
import { auditSocialConnections, providerJson, ProviderError } from "./social-publisher.server";
beforeEach(() => {
  state.refresh.mockReset();
  state.changes = [];
  state.filters = [];
  state.saved = true;
});
afterEach(() => vi.unstubAllGlobals());
describe("connection health recovery", () => {
  it.each([
    new Error("network unavailable"),
    new ProviderError("busy", "429", true, 429),
    new ProviderError("outage", "503", true, 503),
    new ProviderError("configuration", "invalid_client", false, 401),
  ])("does not disconnect on %s", async (error) => {
    state.refresh.mockRejectedValue(error);
    expect((await auditSocialConnections()).expired).toBe(0);
    expect(state.changes.some((change) => change.status === "expired")).toBe(false);
  });
  it("marks revoked refresh grants as requiring reconnect, conditional on the original token", async () => {
    state.refresh.mockRejectedValue(new ProviderError("revoked", "invalid_grant", false, 400));
    expect((await auditSocialConnections()).expired).toBe(1);
    expect(state.changes).toContainEqual(
      expect.objectContaining({
        reauth_required: true,
        status: "expired",
        provider_error_code: "invalid_grant",
      }),
    );
    expect(state.filters).toContainEqual(["access_token", "saved-token"]);
    state.saved = false;
    expect((await auditSocialConnections()).expired).toBe(0);
  });
  it("preserves OAuth string errors so revocation can be distinguished from outages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "invalid_grant", error_description: "expired" }), {
            status: 400,
          }),
      ),
    );
    await expect(
      providerJson("https://api.x.com/2/oauth2/token", { method: "POST" }, "twitter"),
    ).rejects.toMatchObject({ code: "invalid_grant", status: 400, retryable: false });
  });
});
