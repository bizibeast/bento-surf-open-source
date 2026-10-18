/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  provider: "linkedin",
  redirect: "",
  writes: [] as any[],
  existing: [] as any[],
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const chain: any = {
      middleware: () => chain,
      validator: () => chain,
      handler: (fn: any) => (data: any) => fn({ data, context: { userId: "owner" } }),
    };
    return chain;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      let write = false;
      const result = () => ({
        data:
          table === "social_oauth_states"
            ? {
                user_id: "owner",
                redirect_uri: state.redirect,
                expires_at: new Date(Date.now() + 600000).toISOString(),
              }
            : write
              ? [{ id: "connection" }]
              : state.existing,
        error: null,
      });
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        delete: () => chain,
        upsert: (rows: any[]) => {
          write = true;
          state.writes.push(...rows);
          return chain;
        },
        maybeSingle: async () => result(),
        then: (resolve: any) => Promise.resolve(result()).then(resolve),
      };
      return chain;
    },
  },
}));
vi.mock("./secret-crypto.server", () => ({
  encryptServerSecret: async (value: string) => `encrypted:${value}`,
  isServerSecretEncryptionKeyValid: () => true,
}));
vi.mock("./request-security.server", () => ({
  enforceRequestRateLimit: vi.fn(),
  readResponseText: (response: Response) => response.text(),
}));
vi.mock("./plan.server", () => ({
  hasPlanEntitlement: async () => true,
  requirePlanEntitlement: vi.fn(),
}));
vi.mock("./social-avatar.server", () => ({ durableSocialAvatarUrl: async () => null }));
vi.mock("./social-analytics.functions", () => ({
  queueInitialSocialInsightsImport: vi.fn(async () => {}),
}));
import { completeSocialConnection, socialProviderRedirectUri } from "./social-oauth.functions";

beforeEach(() => {
  state.writes = [];
  state.existing = [];
  vi.stubEnv("VITE_APP_URL", "https://app.bento.surf");
  for (const key of [
    "LINKEDIN_CLIENT_ID",
    "LINKEDIN_CLIENT_SECRET",
    "TIKTOK_CLIENT_KEY",
    "TIKTOK_CLIENT_SECRET",
    "GOOGLE_YOUTUBE_CLIENT_ID",
    "GOOGLE_YOUTUBE_CLIENT_SECRET",
  ])
    vi.stubEnv(key, "configured");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("OAuth reconnection persistence", () => {
  it.each(["linkedin", "tiktok", "youtube"] as const)(
    "clears stale authentication errors and leases after %s consent",
    async (provider) => {
      state.redirect = socialProviderRedirectUri(provider);
      state.existing = [
        {
          provider_user_id: provider === "linkedin" ? "urn:li:person:member" : "member",
          refresh_token: "encrypted:old-refresh",
        },
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async (url: string) =>
            new Response(
              JSON.stringify(
                /token|accessToken/.test(url)
                  ? { access_token: "new-access", refresh_token: "new-refresh", expires_in: 86400 }
                  : provider === "linkedin"
                    ? { sub: "member", name: "Creator" }
                    : provider === "tiktok"
                      ? {
                          data: { user: { open_id: "member", display_name: "Creator" } },
                          error: { code: "ok" },
                        }
                      : { items: [{ id: "member", snippet: { title: "Creator" } }] },
              ),
              { status: 200 },
            ),
        ),
      );
      await (completeSocialConnection as any)({
        provider,
        state: crypto.randomUUID(),
        code: "new-code",
      });
      expect(state.writes).toHaveLength(1);
      expect(state.writes[0]).toMatchObject({
        status: "active",
        reauth_required: false,
        last_error: null,
        provider_error_code: null,
        connection_health: "healthy",
        token_refresh_lease_id: null,
        token_refresh_lease_until: null,
        access_token: "encrypted:new-access",
        refresh_token: "encrypted:new-refresh",
      });
    },
  );
  it("retains the same YouTube account's refresh token when repeat consent omits it", async () => {
    state.redirect = socialProviderRedirectUri("youtube");
    state.existing = [
      { provider_user_id: "member", refresh_token: "encrypted:retained" },
      { provider_user_id: "other", refresh_token: "encrypted:wrong" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.includes("token")
                ? { access_token: "new-access", expires_in: 3600 }
                : { items: [{ id: "member", snippet: { title: "Creator" } }] },
            ),
            { status: 200 },
          ),
      ),
    );
    await (completeSocialConnection as any)({
      provider: "youtube",
      state: crypto.randomUUID(),
      code: "new-code",
    });
    expect(state.writes[0].refresh_token).toBe("encrypted:retained");
  });
  it("does not change a connection when the provider rejects OAuth", async () => {
    state.redirect = socialProviderRedirectUri("tiktok");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
    );
    await expect(
      (completeSocialConnection as any)({
        provider: "tiktok",
        state: crypto.randomUUID(),
        code: "bad-code",
      }),
    ).rejects.toThrow();
    expect(state.writes).toEqual([]);
  });
});
