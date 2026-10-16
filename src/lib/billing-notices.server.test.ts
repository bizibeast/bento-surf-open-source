import { beforeEach, describe, expect, it, vi } from "vitest";
import { lifecycleDeadlines } from "./billing-lifecycle";
const m = vi.hoisted(() => ({
  profile: null as Record<string, unknown> | null,
  grant: null as unknown,
  refresh: vi.fn(),
  enqueue: vi.fn(),
  rpc: vi.fn(),
  existing: false,
}));
vi.mock("./plan.server", () => ({ isSelfHostedEdition: () => false }));
vi.mock("./email.server", () => ({ enqueueBentoBillingEmail: m.enqueue }));
vi.mock("@/integrations/dodo/webhook.server", () => ({ refreshWorkspaceSubscription: m.refresh }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: m.rpc,
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        gt: () => q,
        maybeSingle: async () => ({
          data:
            table === "profiles"
              ? m.profile
              : table === "complimentary_plan_grants"
                ? m.grant
                : m.existing
                  ? { id: "sent" }
                  : null,
          error: null,
        }),
      };
      return q;
    },
  },
}));
import { enqueueWorkspaceLifecycleNotices, readLifecycleNotice } from "./billing-notices.server";
beforeEach(() => {
  vi.resetAllMocks();
  m.existing = false;
  m.grant = null;
  m.rpc.mockResolvedValue({ error: null });
  m.enqueue.mockResolvedValue({ id: "queued" });
  const at = Date.now() - 4 * 86_400_000;
  m.profile = {
    display_name: "My business",
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
describe("workspace billing notices", () => {
  it("quotes the exact deadlines and workspace name", async () => {
    const notice = await readLifecycleNotice("workspace", "episode", "billing_tools_paused");
    expect(notice).toMatchObject({
      episodeId: "episode",
      workspaceName: "My business",
      reason: "past_due",
    });
    expect(notice?.deletionDate).toContain("UTC");
    expect(m.refresh).toHaveBeenCalledWith("workspace", "sub");
  });
  it("suppresses queued messages after payment recovery", async () => {
    m.refresh.mockImplementationOnce(async () => {
      m.profile = { billing_lifecycle: null };
    });
    expect(await readLifecycleNotice("workspace", "episode", "billing_tools_paused")).toBeNull();
  });
  it("does not deliver an old episode's notice", async () => {
    expect(await readLifecycleNotice("workspace", "old", "billing_tools_paused")).toBeNull();
    expect(m.refresh).not.toHaveBeenCalled();
  });
  it("defers instead of making unverified claims when Dodo is unavailable", async () => {
    m.refresh.mockRejectedValueOnce(new Error("offline"));
    await expect(
      readLifecycleNotice("workspace", "episode", "billing_tools_paused"),
    ).rejects.toThrow("offline");
  });
  it("deduplicates notices against the durable outbox", async () => {
    m.existing = true;
    expect(await enqueueWorkspaceLifecycleNotices("workspace", m.profile!.billing_lifecycle)).toBe(
      0,
    );
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it("does not warn an owner whose complimentary access is active", async () => {
    m.grant = { id: "grant" };
    expect(await readLifecycleNotice("workspace", "episode", "billing_tools_paused")).toBeNull();
  });
});
