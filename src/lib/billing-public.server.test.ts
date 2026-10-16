import { beforeEach, describe, expect, it, vi } from "vitest";
import { lifecycleDeadlines } from "./billing-lifecycle";
const state = vi.hoisted(() => ({
  profile: null as Record<string, unknown> | null,
  plan: "free",
  selfHosted: false,
}));
vi.mock("./plan.server", () => ({
  getPlan: vi.fn(async () => state.plan),
  isSelfHostedEdition: () => state.selfHosted,
}));
vi.mock("./username-alias.server", () => ({
  resolvePublicUsername: vi.fn(async () => ({ userId: "workspace" })),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data:
            table === "profiles"
              ? state.profile
              : table === "custom_domains"
                ? { user_id: "workspace" }
                : { creator_id: "workspace" },
          error: null,
        }),
      };
      return q;
    },
  },
}));
import { guardUnavailablePublicWorkspace } from "./billing-public.server";
beforeEach(() => {
  state.plan = "free";
  state.selfHosted = false;
  const at = Date.now() - 8 * 86_400_000;
  state.profile = {
    billing_lifecycle: {
      episodeId: "episode",
      subscriptionId: "sub",
      reason: "past_due",
      plan: "creator",
      stoppedAt: new Date(at).toISOString(),
      ...lifecycleDeadlines("past_due", at),
      deletingAt: null,
    },
  };
});
describe("public billing cutoff before caches", () => {
  it.each([
    "https://bento.surf/@creator",
    "https://bento.surf/@creator/products/course",
    "https://bento.surf/p/course",
    "https://creator.example/store",
  ])("politely hides unpaid public content at %s", async (url) => {
    const result = await guardUnavailablePublicWorkspace(
      new Request(url, { headers: { cookie: "visitor=1", accept: "text/html" } }),
    );
    expect(result?.status).toBe(503);
    expect(result?.headers.get("cache-control")).toBe("no-store");
    expect(await result!.text()).toContain("sign in to manage your workspace");
  });
  it("leaves Billing and API callbacks accessible", async () => {
    expect(
      await guardUnavailablePublicWorkspace(
        new Request("https://app.bento.surf/settings?section=plan"),
      ),
    ).toBeNull();
    expect(
      await guardUnavailablePublicWorkspace(
        new Request("https://creator.example/api/webhooks/dodo"),
      ),
    ).toBeNull();
  });
  it("keeps the store live between days three and seven", async () => {
    const at = Date.now() - 4 * 86_400_000;
    state.profile!.billing_lifecycle = {
      ...(state.profile!.billing_lifecycle as object),
      ...lifecycleDeadlines("past_due", at),
    };
    expect(
      await guardUnavailablePublicWorkspace(new Request("https://bento.surf/@creator")),
    ).toBeNull();
  });
  it("honors active complimentary and self-hosted access", async () => {
    state.plan = "store";
    expect(
      await guardUnavailablePublicWorkspace(new Request("https://bento.surf/@creator")),
    ).toBeNull();
    state.plan = "free";
    state.selfHosted = true;
    expect(
      await guardUnavailablePublicWorkspace(new Request("https://bento.surf/@creator")),
    ).toBeNull();
  });
});
