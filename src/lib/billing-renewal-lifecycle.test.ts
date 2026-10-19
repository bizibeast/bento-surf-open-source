import { beforeEach, expect, it, vi } from "vitest";
import { lifecycleDeadlines } from "./billing-lifecycle";
const m = vi.hoisted(() => ({
  subscription: {} as Record<string, unknown>,
  lifecycle: null as unknown,
  update: vi.fn(),
  refresh: vi.fn(),
  sync: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: table === "profiles" ? { billing_lifecycle: m.lifecycle } : m.subscription,
          error: null,
        }),
      };
      return q;
    },
  },
}));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (handler: unknown) => handler,
  createServerFn: () => {
    let validate = (v: unknown) => v;
    const q = {
      middleware: () => q,
      validator: (fn: typeof validate) => {
        validate = fn;
        return q;
      },
      handler:
        (
          fn: (input: {
            data: unknown;
            context: { userId: string; authUserId: string; supabase: unknown };
          }) => unknown,
        ) =>
        async (input?: { data?: unknown }) => {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          return fn({
            data: validate(input?.data),
            context: { userId: "workspace", authUserId: "owner", supabase: supabaseAdmin },
          });
        },
    };
    return q;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/dodo/client.server", () => ({
  dodo: { subscriptions: { update: m.update } },
}));
vi.mock("@/integrations/dodo/webhook.server", () => ({ refreshWorkspaceSubscription: m.refresh }));
vi.mock("./billing-sync.server", () => ({ withWorkspaceBillingSync: m.sync }));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: vi.fn() }));
import { cancelMyRenewal, resumeMyRenewal } from "./billing.functions";
beforeEach(() => {
  vi.resetAllMocks();
  m.lifecycle = null;
  m.subscription = {
    plan_id: "creator",
    status: "active",
    dodo_subscription_id: "sub",
    current_period_end: "2026-11-01T00:00:00.000Z",
    cancel_at_period_end: false,
  };
  m.sync.mockImplementation((_id, action) => action("lease"));
});
it("returns the verified cancellation deadline without ending the paid period immediately", async () => {
  const verifiedEnd = "2026-11-05T00:00:00.000Z";
  m.refresh.mockImplementation(async () => {
    m.subscription = {
      ...m.subscription,
      cancel_at_period_end: true,
      current_period_end: verifiedEnd,
    };
    m.lifecycle = {
      episodeId: "episode",
      subscriptionId: "sub",
      reason: "canceled",
      plan: "creator",
      stoppedAt: verifiedEnd,
      ...lifecycleDeadlines("canceled", Date.parse(verifiedEnd)),
      deletingAt: null,
    };
  });
  const result = await cancelMyRenewal({ data: { reason: "other", details: "Taking a break" } });
  expect(m.update).toHaveBeenCalledWith(
    "sub",
    expect.objectContaining({ cancel_at_next_billing_date: true }),
  );
  expect(m.refresh).toHaveBeenCalledWith("workspace", "sub", "lease");
  expect(result).toMatchObject({
    status: "active",
    currentPeriodEnd: verifiedEnd,
    cancelAtPeriodEnd: true,
    billingLifecycle: { toolsStopAt: verifiedEnd, publicStopAt: verifiedEnd },
  });
});
it("clears the scheduled stop only after renewal is verified under the same lease", async () => {
  m.subscription.cancel_at_period_end = true;
  m.refresh.mockImplementation(async () => {
    m.subscription.cancel_at_period_end = false;
    m.lifecycle = null;
  });
  expect(await resumeMyRenewal()).toMatchObject({
    status: "active",
    cancelAtPeriodEnd: false,
    billingLifecycle: null,
  });
  expect(m.update).toHaveBeenCalledWith("sub", { cancel_at_next_billing_date: false });
  expect(m.refresh).toHaveBeenCalledWith("workspace", "sub", "lease");
});
it("ends a verified trial immediately and reconciles access before returning", async () => {
  m.subscription.status = "trialing";
  m.refresh.mockImplementation(async () => {
    if (m.update.mock.calls.length) {
      m.subscription.status = "canceled";
      m.subscription.plan_id = "free";
      m.subscription.cancel_at_period_end = false;
    }
  });
  expect(await cancelMyRenewal({ data: {} })).toMatchObject({
    status: "canceled",
    plan: "free",
    cancelAtPeriodEnd: false,
  });
  expect(m.update).toHaveBeenCalledWith(
    "sub",
    expect.objectContaining({ status: "cancelled", cancel_at_next_billing_date: false }),
  );
  expect(m.refresh).toHaveBeenCalledTimes(2);
});
it("preserves the paid period if a stale trial has already converted", async () => {
  m.subscription.status = "trialing";
  m.refresh.mockImplementation(async () => {
    m.subscription.status = "active";
  });
  await cancelMyRenewal({ data: {} });
  expect(m.update).toHaveBeenCalledWith(
    "sub",
    expect.objectContaining({ cancel_at_next_billing_date: true }),
  );
  expect(m.update.mock.calls[0][1]).not.toHaveProperty("status");
});
it("does not claim a trial ended if provider reconciliation is still active", async () => {
  m.subscription.status = "trialing";
  await expect(cancelMyRenewal({ data: {} })).rejects.toThrow("being verified");
});
