import { beforeEach, expect, it, vi } from "vitest";
import { lifecycleDeadlines } from "./billing-lifecycle";
const m = vi.hoisted(() => ({
  subscriptions: [] as any[],
  profiles: [] as any[],
  refresh: vi.fn(),
  notices: vi.fn(),
  retention: vi.fn(),
}));
vi.mock("./plan.server", () => ({ isSelfHostedEdition: () => false }));
vi.mock("./billing-notices.server", () => ({ enqueueWorkspaceLifecycleNotices: m.notices }));
vi.mock("./workspace-retention.server", () => ({ processWorkspaceRetention: m.retention }));
vi.mock("@/integrations/dodo/webhook.server", () => ({ refreshWorkspaceSubscription: m.refresh }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      let after = "";
      const q = {
        select: () => q,
        in: () => q,
        lte: () => q,
        not: () => q,
        order: () => q,
        limit: () => q,
        gt: (_column: string, value: string) => {
          after = value;
          return q;
        },
        then: (resolve: (value: unknown) => void) =>
          resolve({
            error: null,
            data: (table === "subscriptions" ? m.subscriptions : m.profiles)
              .filter((row) => (row.user_id ?? row.id) > after)
              .slice(0, 100),
          }),
      };
      return q;
    },
  },
}));
import { processWorkspaceBillingLifecycle } from "./billing-maintenance.server";
beforeEach(() => {
  vi.resetAllMocks();
  m.subscriptions = [];
  m.profiles = [];
  m.notices.mockResolvedValue(0);
  m.retention.mockResolvedValue(false);
});
it("reconciles overdue subscriptions beyond the first hundred without starving later workspaces", async () => {
  m.subscriptions = Array.from({ length: 101 }, (_, i) => ({
    user_id: String(i).padStart(3, "0"),
    dodo_subscription_id: `sub-${i}`,
  }));
  expect(await processWorkspaceBillingLifecycle()).toMatchObject({ checked: 101 });
  expect(m.refresh).toHaveBeenLastCalledWith("100", "sub-100");
});
it("does not skip the next page when earlier workspaces are deleted", async () => {
  const at = Date.now() - 91 * 86_400_000;
  m.profiles = Array.from({ length: 101 }, (_, i) => ({
    id: String(i).padStart(3, "0"),
    billing_lifecycle: {
      episodeId: "episode",
      subscriptionId: "sub",
      reason: "canceled",
      plan: "creator",
      stoppedAt: new Date(at).toISOString(),
      ...lifecycleDeadlines("canceled", at),
      deletingAt: null,
    },
  }));
  m.retention.mockImplementation(async (id: string) => {
    m.profiles = m.profiles.filter((row) => row.id !== id);
    return true;
  });
  expect(await processWorkspaceBillingLifecycle()).toMatchObject({ deleted: 101 });
  expect(m.retention).toHaveBeenLastCalledWith("100");
});
