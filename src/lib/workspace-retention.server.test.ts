import { beforeEach, describe, expect, it, vi } from "vitest";
import { lifecycleDeadlines } from "./billing-lifecycle";
const m = vi.hoisted(() => ({
  profile: null as Record<string, unknown> | null,
  grant: null as unknown,
  warning: null as unknown,
  checkouts: [] as Array<Record<string, unknown>>,
  readError: null as unknown,
  refresh: vi.fn(),
  retrieve: vi.fn(),
  checkout: vi.fn(),
  payment: vi.fn(),
  update: vi.fn(),
  rpc: vi.fn(),
  media: vi.fn(),
  domain: vi.fn(),
}));
vi.mock("./plan.server", () => ({ isSelfHostedEdition: () => false }));
vi.mock("@/integrations/dodo/webhook.server", () => ({ refreshWorkspaceSubscription: m.refresh }));
vi.mock("@/integrations/dodo/client.server", () => ({
  dodo: {
    subscriptions: { retrieve: m.retrieve, update: m.update },
    checkoutSessions: { retrieve: m.checkout },
    payments: { retrieve: m.payment },
  },
}));
vi.mock("./workspace-media-cleanup.server", () => ({ deleteWorkspaceMedia: m.media }));
vi.mock("./cloudflare-custom-hostnames.server", () => ({ deleteCloudflareHostname: m.domain }));
vi.mock("./billing-notices.server", () => ({
  lifecycleNoticeKey: (w: string, e: string, t: string) => `workspace-lifecycle:${w}:${e}:${t}`,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: m.rpc,
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        gt: () => q,
        gte: async () => ({ data: m.checkouts, error: m.readError }),
        maybeSingle: async () => ({
          data:
            table === "profiles"
              ? m.profile
              : table === "complimentary_plan_grants"
                ? m.grant
                : table === "email_outbox"
                  ? m.warning
                  : { cloudflare_hostname_id: "hostname" },
          error: m.readError,
        }),
      };
      return q;
    },
  },
}));
import { processWorkspaceRetention } from "./workspace-retention.server";
beforeEach(() => {
  vi.resetAllMocks();
  m.grant = null;
  m.readError = null;
  m.checkouts = [];
  const at = Date.now() - 91 * 86_400_000;
  m.profile = {
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
  m.warning = { status: "sent", delivered_at: new Date(Date.now() - 8 * 86_400_000).toISOString() };
  m.retrieve.mockResolvedValue({
    status: "cancelled",
    next_billing_date: new Date(at).toISOString(),
  });
  m.rpc.mockImplementation(async (name: string) => ({
    data: name === "claim_workspace_retention" ? { leaseKey: "lease" } : true,
    error: null,
  }));
});
describe("90-day workspace retention", () => {
  it("lets a recovery card form expire before claiming deletion", async () => {
    m.checkouts = [
      {
        session_id: "checkout",
        created_at: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
      },
    ];
    expect(await processWorkspaceRetention("workspace")).toBe(false);
    expect(m.media).not.toHaveBeenCalled();
  });
  it("recovers a successful checkout even when its subscription webhook was lost", async () => {
    const created_at = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    m.checkouts = [{ session_id: "checkout", created_at }];
    m.checkout.mockResolvedValue({
      id: "checkout",
      created_at,
      payment_status: "succeeded",
      payment_id: "paid",
    });
    m.payment.mockResolvedValue({
      subscription_id: "recovered",
      metadata: { workspace_id: "workspace" },
    });
    expect(await processWorkspaceRetention("workspace")).toBe(false);
    expect(m.refresh).toHaveBeenCalledWith("workspace", "recovered");
    expect(m.media).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { status: "queued", delivered_at: null },
    {
      status: "sent",
      sent_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
      delivered_at: null,
    },
    {
      status: "sent",
      delivered_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
      bounced_at: new Date().toISOString(),
    },
    { status: "failed", delivered_at: new Date(Date.now() - 8 * 86_400_000).toISOString() },

    { status: "sent", delivered_at: "invalid" },
    { status: "sent", delivered_at: new Date(Date.now() - 86_400_000).toISOString() },
  ])("requires a delivered warning at least seven days old: %j", async (warning) => {
    m.warning = warning;
    expect(await processWorkspaceRetention("workspace")).toBe(false);
    expect(m.media).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("never deletes before the retention deadline", async () => {
    (m.profile!.billing_lifecycle as Record<string, unknown>).deleteAfter = new Date(
      Date.now() + 86_400_000,
    ).toISOString();
    expect(await processWorkspaceRetention("workspace")).toBe(false);
    expect(m.refresh).not.toHaveBeenCalled();
  });
  it("defers cleanup if the provider cannot be reached", async () => {
    m.refresh.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(processWorkspaceRetention("workspace")).rejects.toThrow("provider unavailable");
    expect(m.media).not.toHaveBeenCalled();
  });
  it("stops if verified recovery clears the episode", async () => {
    m.refresh.mockImplementationOnce(async () => {
      m.profile = { billing_lifecycle: null };
    });
    expect(await processWorkspaceRetention("workspace")).toBe(false);
    expect(m.media).not.toHaveBeenCalled();
  });
  it("preserves complimentary access", async () => {
    m.grant = { id: "grant" };
    expect(await processWorkspaceRetention("workspace")).toBe(false);
    expect(m.media).not.toHaveBeenCalled();
  });
  it("does not cancel an active paid period", async () => {
    m.retrieve.mockResolvedValue({
      status: "active",
      next_billing_date: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(await processWorkspaceRetention("workspace")).toBe(false);
    expect(m.update).not.toHaveBeenCalled();
    expect(m.media).not.toHaveBeenCalled();
  });
  it("removes external data only after a claim, then uses the guarded database cleanup", async () => {
    expect(await processWorkspaceRetention("workspace")).toBe(true);
    expect(m.domain).toHaveBeenCalledWith("hostname");
    expect(m.media).toHaveBeenCalledWith("workspace");
    expect(m.rpc).toHaveBeenLastCalledWith("finish_workspace_retention", {
      p_episode_id: "episode",
      p_lease_key: "lease",
    });
  });
  it("retains database data if external cleanup fails so a later lease can retry", async () => {
    m.media.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(processWorkspaceRetention("workspace")).rejects.toThrow("storage unavailable");
    expect(m.rpc).not.toHaveBeenCalledWith("finish_workspace_retention", expect.anything());
  });
});
