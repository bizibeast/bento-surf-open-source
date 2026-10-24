import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureServerEvent: vi.fn(),
  captureServerException: vi.fn(),
  enqueueBentoBillingEmail: vi.fn(),
  retrieve: vi.fn(),
  lifecycle: vi.fn(),
  lastSubscription: null as Record<string, unknown> | null,
  from: vi.fn(),
  rpc: vi.fn(),
  subscriptionUpsert: vi.fn(),
  profileUpdates: [] as Array<{ id: string; value: Record<string, unknown> }>,
  intentInserts: [] as Array<Record<string, unknown>>,
  currentSubscription: null as null | {
    user_id?: string;
    dodo_subscription_id: string;
    status: string;
    billing_catalog?: string;
    plan_id?: string;
    current_period_end?: string;
  },
  billingUpdates: [] as Array<Record<string, unknown>>,
  trialTerms: { days: 7, approvedExtensionEnd: null as string | null },
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("./client.server", () => ({ dodo: { subscriptions: { retrieve: mocks.retrieve } } }));
vi.mock("@/lib/billing-sync.server", () => ({
  withWorkspaceBillingSync: (_id: string, action: (lease: string) => unknown) => action("lease"),
  applyWorkspaceBillingSnapshot: async (
    userId: string,
    _lease: string,
    snapshot: Record<string, unknown>,
    lifecycle: Record<string, unknown>,
  ) => {
    const saved = await mocks.lifecycle({
      workspaceId: userId,
      subscriptionId: snapshot.dodo_subscription_id,
      ...lifecycle,
    });
    mocks.profileUpdates.push({
      id: userId,
      value: {
        plan_id: snapshot.plan_id,
        billing_catalog: snapshot.billing_catalog,
        workspace_status:
          ["active", "trialing"].includes(String(snapshot.status)) ||
          (saved && Date.parse(saved.toolsStopAt) > Date.now())
            ? "active"
            : "locked",
      },
    });
    await mocks.subscriptionUpsert(snapshot, { onConflict: "user_id" });
  },
}));
vi.mock("@/lib/billing-lifecycle.server", () => ({
  syncWorkspaceBillingLifecycle: mocks.lifecycle,
}));
vi.mock("@/lib/billing-trial-terms.server", () => ({
  readTrialTerms: vi.fn(async () => mocks.trialTerms),
}));
vi.mock("@/lib/email.server", () => ({ enqueueBentoBillingEmail: mocks.enqueueBentoBillingEmail }));
vi.mock("@/lib/posthog.server", () => ({
  captureServerEvent: mocks.captureServerEvent,
  captureServerException: mocks.captureServerException,
}));

import { verifiedDodoAddonState } from "@/lib/billing-addons";
import { processVerifiedDodoEvent, type DodoEvent } from "./webhook.server";

const env = {
  DODO_CONTACT_TIER_5000_MONTHLY_ADDON_ID: "contact-5000-monthly",
  DODO_CONTACT_TIER_10000_MONTHLY_ADDON_ID: "contact-10000-monthly",
  DODO_CONTACT_TIER_25000_MONTHLY_ADDON_ID: "contact-25000-monthly",
  DODO_CONTACT_TIER_50000_MONTHLY_ADDON_ID: "contact-50000-monthly",
  DODO_CONTACT_TIER_100000_MONTHLY_ADDON_ID: "contact-100000-monthly",
  DODO_CONTACT_TIER_150000_MONTHLY_ADDON_ID: "contact-150000-monthly",
  DODO_CONTACT_TIER_5000_YEARLY_ADDON_ID: "contact-5000-yearly",
  DODO_CONTACT_TIER_10000_YEARLY_ADDON_ID: "contact-10000-yearly",
  DODO_CONTACT_TIER_25000_YEARLY_ADDON_ID: "contact-25000-yearly",
  DODO_CONTACT_TIER_50000_YEARLY_ADDON_ID: "contact-50000-yearly",
  DODO_CONTACT_TIER_100000_YEARLY_ADDON_ID: "contact-100000-yearly",
  DODO_CONTACT_TIER_150000_YEARLY_ADDON_ID: "contact-150000-yearly",
  DODO_STORAGE_10GB_MONTHLY_ADDON_ID: "storage-10gb-monthly",
  DODO_STORAGE_10GB_YEARLY_ADDON_ID: "storage-10gb-yearly",
};

function subscriptionEvent(
  plan: "store" | "creator",
  type:
    | "subscription.active"
    | "subscription.cancelled"
    | "subscription.expired" = "subscription.active",
  addons?: Array<{ addon_id: string; quantity: number }>,
): DodoEvent {
  const event = {
    type,
    timestamp: "2026-09-01T00:00:00.000Z",
    data: {
      subscription_id: "sub_123",
      product_id: `${plan}-monthly`,
      status: type.split(".").at(-1),
      payment_frequency_interval: "monthly",
      metadata: { user_id: "user_123" },
      ...(addons === undefined ? {} : { addons }),
    },
  };
  mocks.lastSubscription = event.data;
  return event;
}

function workspaceSubscriptionEvent(
  workspaceId: string,
  authUserId: string,
  type: "subscription.active" | "subscription.cancelled",
  subscriptionId = "sub_workspace",
): DodoEvent {
  const event = subscriptionEvent("creator", type);
  event.data.subscription_id = subscriptionId;
  event.data.metadata = {
    user_id: workspaceId,
    workspace_id: workspaceId,
    auth_user_id: authUserId,
  };
  return event;
}

beforeEach(() => {
  mocks.lifecycle.mockResolvedValue(null);
  mocks.retrieve.mockImplementation(async () => mocks.lastSubscription);
  mocks.captureServerEvent.mockResolvedValue(undefined);
  mocks.captureServerException.mockResolvedValue(undefined);
  mocks.enqueueBentoBillingEmail.mockResolvedValue(undefined);
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  mocks.subscriptionUpsert.mockResolvedValue({ error: null });
  mocks.profileUpdates.length = 0;
  mocks.intentInserts.length = 0;
  mocks.currentSubscription = null;
  mocks.billingUpdates.length = 0;
  mocks.trialTerms.days = 7;
  mocks.trialTerms.approvedExtensionEnd = null;
  mocks.from.mockImplementation((table: string) => {
    if (table === "complimentary_plan_grants") {
      const query = {
        eq: () => query,
        gt: () => query,
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return { select: () => query };
    }
    if (table === "workspace_memberships") {
      const query = {
        eq: () => query,
        maybeSingle: async () => ({ data: { workspace_id: "owned" }, error: null }),
      };
      return { select: () => query };
    }
    if (table === "profiles") {
      return {
        update: (value: Record<string, unknown>) => ({
          eq: async (_column: string, id: string) => {
            mocks.profileUpdates.push({ id, value });
            return { error: null };
          },
        }),
      };
    }
    if (table === "subscriptions") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: mocks.currentSubscription, error: null }),
          }),
        }),
        upsert: mocks.subscriptionUpsert,
      };
    }
    if (table === "billing_events") {
      return {
        update: (value: Record<string, unknown>) => ({
          eq: async () => {
            mocks.billingUpdates.push(value);
            return { error: null };
          },
        }),
      };
    }
    if (table === "cancellation_intents") {
      const query = {
        select: () => query,
        eq: () => query,
        is: () => query,
        order: () => query,
        maybeSingle: async () => ({ data: null, error: null }),
        limit: () =>
          Object.assign(Promise.resolve({ data: [], error: null }), {
            maybeSingle: async () => ({ data: null, error: null }),
          }),
      };
      return {
        select: () => query,
        insert: async (row: Record<string, unknown>) => {
          mocks.intentInserts.push(row);
          return { error: null };
        },
      };
    }
    throw new Error(`unexpected table: ${table}`);
  });
  vi.stubEnv("DODO_CREATOR_MONTHLY_PRODUCT_ID", "creator-monthly");
  vi.stubEnv("DODO_STORE_MONTHLY_PRODUCT_ID", "store-monthly");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("verified Dodo add-on state", () => {
  it("treats a voluntary provider pause as paused access, not failed payment", async () => {
    mocks.currentSubscription = {
      dodo_subscription_id: "sub_123",
      status: "active",
      plan_id: "creator",
    };
    const event = subscriptionEvent("creator");
    event.type = "subscription.paused";
    event.data.status = "paused";
    await processVerifiedDodoEvent(event, "voluntary-pause");
    expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paused" }),
      { onConflict: "user_id" },
    );
    expect(mocks.lifecycle).toHaveBeenCalledWith(expect.objectContaining({ reason: "paused" }));
    expect(mocks.profileUpdates).toContainEqual({
      id: "user_123",
      value: expect.objectContaining({ workspace_status: "locked" }),
    });
  });
  it("starts grace from the missed due date and preserves the workspace during tool grace", async () => {
    const due = new Date(Date.now() - 60_000).toISOString();
    mocks.currentSubscription = {
      dodo_subscription_id: "sub_123",
      status: "active",
      plan_id: "creator",
      current_period_end: due,
    };
    const event = subscriptionEvent("creator");
    event.data.status = "on_hold";
    mocks.lifecycle.mockResolvedValueOnce({
      toolsStopAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });
    await processVerifiedDodoEvent(event, "missed-due");
    expect(mocks.lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "past_due", stoppedAt: due, plan: "creator" }),
    );
    expect(mocks.profileUpdates).toContainEqual({
      id: "user_123",
      value: expect.objectContaining({ workspace_status: "active" }),
    });
  });
  it("uses provider state to ignore a delayed failure after payment recovery", async () => {
    const event = subscriptionEvent("creator");
    mocks.retrieve.mockResolvedValueOnce({ ...event.data, status: "active" });
    event.type = "subscription.failed";
    event.data.status = "failed";
    await processVerifiedDodoEvent(event, "stale-failure");
    expect(mocks.lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ reason: null, plan: "creator" }),
    );
  });
  it("activates only the workspace named by purchaser-verified metadata", async () => {
    const workspaceId = "33333333-3333-4333-8333-333333333333";
    const authUserId = "11111111-1111-4111-8111-111111111111";

    await processVerifiedDodoEvent(
      workspaceSubscriptionEvent(workspaceId, authUserId, "subscription.active"),
      "webhook-workspace-active",
    );

    expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: workspaceId, dodo_subscription_id: "sub_workspace" }),
      { onConflict: "user_id" },
    );
    expect(mocks.profileUpdates).toContainEqual({
      id: workspaceId,
      value: expect.objectContaining({ workspace_status: "active" }),
    });
    expect(mocks.profileUpdates.some((update) => update.id === authUserId)).toBe(false);
  });

  it("locks only the workspace whose current subscription was cancelled", async () => {
    const workspaceId = "33333333-3333-4333-8333-333333333333";
    mocks.currentSubscription = { dodo_subscription_id: "sub_workspace", status: "active" };

    await processVerifiedDodoEvent(
      workspaceSubscriptionEvent(
        workspaceId,
        "11111111-1111-4111-8111-111111111111",
        "subscription.cancelled",
      ),
      "webhook-workspace-cancelled",
    );

    expect(mocks.profileUpdates).toContainEqual({
      id: workspaceId,
      value: expect.objectContaining({ workspace_status: "locked" }),
    });
    expect(mocks.intentInserts).toContainEqual(
      expect.objectContaining({
        workspace_id: workspaceId,
        first_attempt: true,
        cancellation_confirmed_at: expect.any(String),
      }),
    );
  });

  it("ignores a stale cancellation for a replaced workspace subscription", async () => {
    mocks.currentSubscription = { dodo_subscription_id: "sub_new", status: "active" };

    await processVerifiedDodoEvent(
      workspaceSubscriptionEvent(
        "33333333-3333-4333-8333-333333333333",
        "11111111-1111-4111-8111-111111111111",
        "subscription.cancelled",
        "sub_old",
      ),
      "webhook-workspace-stale",
    );

    expect(mocks.subscriptionUpsert).not.toHaveBeenCalled();
    expect(mocks.profileUpdates).toEqual([]);
  });

  it("does not let a stale active subscription replace the current subscription", async () => {
    mocks.currentSubscription = {
      dodo_subscription_id: "sub_new",
      status: "active",
      billing_catalog: "2026-10",
    };
    await processVerifiedDodoEvent(subscriptionEvent("creator"), "stale-active");
    expect(mocks.profileUpdates).toEqual([]);
    expect(mocks.subscriptionUpsert).not.toHaveBeenCalled();
  });
  it("retains the current catalog on a product-less cancellation after provider verification", async () => {
    vi.stubEnv("DODO_CREATOR_39_MONTHLY_PRODUCT_ID", "current-creator");
    mocks.currentSubscription = {
      dodo_subscription_id: "sub_123",
      status: "active",
      billing_catalog: "2026-10",
    };
    mocks.retrieve.mockResolvedValue({
      subscription_id: "sub_123",
      status: "cancelled",
      product_id: "current-creator",
      metadata: { workspace_id: "user_123", auth_user_id: "owner", billing_catalog: "2026-10" },
    });
    const event = subscriptionEvent("creator", "subscription.cancelled");
    delete event.data.product_id;
    await processVerifiedDodoEvent(event, "no-product-cancel");
    expect(mocks.retrieve).toHaveBeenCalledWith("sub_123");
    expect(mocks.profileUpdates).toContainEqual({
      id: "user_123",
      value: expect.objectContaining({ plan_id: "free", billing_catalog: "2026-10" }),
    });
  });
  it("verifies trial checkout authorization before granting trial access", async () => {
    vi.stubEnv("DODO_CREATOR_39_MONTHLY_PRODUCT_ID", "current-creator");
    const remote = {
      subscription_id: "sub_123",
      status: "active",
      product_id: "current-creator",
      created_at: "2030-01-01T00:00:00Z",
      next_billing_date: "2030-01-08T00:00:00Z",
      trial_period_days: 7,
      has_payment_method: true,
      trial_amount: null,
      metadata: {
        workspace_id: "user_123",
        auth_user_id: "owner",
        billing_catalog: "2026-10",
        trial_checkout_key: "secret-checkout-nonce",
      },
    };
    mocks.retrieve.mockResolvedValue(remote);
    mocks.rpc.mockImplementation(async (name: string) => ({
      data: name === "claim_bento_trial" ? remote.next_billing_date : true,
      error: null,
    }));
    await processVerifiedDodoEvent({ type: "subscription.active", data: remote }, "verified-trial");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "claim_bento_trial",
      expect.objectContaining({
        p_checkout_key: "secret-checkout-nonce",
        p_auth_user_id: "owner",
        p_workspace_id: "user_123",
      }),
    );
    expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "trialing",
        plan_id: "creator",
        billing_catalog: "2026-10",
        trial_ends_at: remote.next_billing_date,
      }),
      { onConflict: "user_id" },
    );
  });

  it("grants the new three-day trial only against recorded checkout terms", async () => {
    vi.stubEnv("DODO_CREATOR_39_MONTHLY_PRODUCT_ID", "current-creator");
    mocks.trialTerms.days = 3;
    const remote = {
      subscription_id: "sub_123",
      status: "active",
      product_id: "current-creator",
      created_at: "2030-01-01T00:00:00Z",
      next_billing_date: "2030-01-04T00:03:00Z",
      trial_period_days: 3,
      has_payment_method: true,
      trial_amount: null,
      metadata: {
        workspace_id: "user_123",
        auth_user_id: "owner",
        billing_catalog: "2026-10",
        trial_checkout_key: "three-day-checkout",
      },
    };
    mocks.retrieve.mockResolvedValue(remote);
    mocks.rpc.mockImplementation(async (name: string) => ({
      data: name === "claim_bento_trial" ? remote.next_billing_date : true,
      error: null,
    }));
    await processVerifiedDodoEvent(
      { type: "subscription.active", data: remote },
      "three-day-trial",
    );
    expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ status: "trialing", trial_ends_at: remote.next_billing_date }),
      { onConflict: "user_id" },
    );
  });

  it.each([
    { cancel: false, label: "an active trial" },
    { cancel: true, label: "a trial cancelled for its end date" },
  ])("keeps the Store product as the plan and trial access for $label", async ({ cancel }) => {
    vi.stubEnv("DODO_STORE_19_MONTHLY_PRODUCT_ID", "current-store");
    mocks.trialTerms.days = 3;
    const remote = {
      subscription_id: "sub_123",
      status: "active",
      product_id: "current-store",
      created_at: "2030-01-01T00:00:00Z",
      next_billing_date: "2030-01-04T00:03:00Z",
      trial_period_days: 3,
      has_payment_method: true,
      trial_amount: null,
      cancel_at_next_billing_date: cancel,
      // UI-selected metadata never decides the plan; the product does.
      metadata: {
        workspace_id: "user_123",
        auth_user_id: "owner",
        billing_catalog: "2026-10",
        plan: "creator_plus",
        trial_checkout_key: "three-day-checkout",
      },
    };
    mocks.retrieve.mockResolvedValue(remote);
    mocks.rpc.mockImplementation(async (name: string) => ({
      data: name === "claim_bento_trial" ? remote.next_billing_date : true,
      error: null,
    }));
    await processVerifiedDodoEvent(
      { type: "subscription.updated", data: remote },
      `store-trial-${cancel}`,
    );
    expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        plan_id: "store",
        status: "trialing",
        trial_ends_at: remote.next_billing_date,
        current_period_end: remote.next_billing_date,
        cancel_at_period_end: cancel,
      }),
      { onConflict: "user_id" },
    );
    expect(mocks.profileUpdates.at(-1)?.value).toMatchObject({
      plan_id: "store",
      workspace_status: "active",
    });
    if (cancel)
      expect(mocks.lifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "canceled",
          stoppedAt: remote.next_billing_date,
          plan: "store",
        }),
      );
  });

  it("revokes plan access right away when a trial is cancelled immediately", async () => {
    vi.stubEnv("DODO_STORE_19_MONTHLY_PRODUCT_ID", "current-store");
    const trialEnd = new Date(Date.now() + 2 * 86_400_000).toISOString();
    mocks.currentSubscription = {
      user_id: "user_123",
      dodo_subscription_id: "sub_123",
      status: "trialing",
      billing_catalog: "2026-10",
      plan_id: "store",
      current_period_end: trialEnd,
    };
    const remote = {
      subscription_id: "sub_123",
      status: "cancelled",
      product_id: "current-store",
      created_at: new Date(Date.now() - 86_400_000).toISOString(),
      next_billing_date: trialEnd,
      trial_period_days: 3,
      has_payment_method: true,
      trial_amount: null,
      cancel_at_next_billing_date: false,
      metadata: {
        workspace_id: "user_123",
        auth_user_id: "owner",
        billing_catalog: "2026-10",
        trial_checkout_key: "three-day-checkout",
      },
    };
    mocks.retrieve.mockResolvedValue(remote);
    const before = Date.now();
    await processVerifiedDodoEvent(
      { type: "subscription.cancelled", timestamp: new Date().toISOString(), data: remote },
      "trial-cancel-now",
    );
    expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ plan_id: "free", status: "canceled", trial_ends_at: null }),
      { onConflict: "user_id" },
    );
    const lifecycle = mocks.lifecycle.mock.calls.at(-1)?.[0] as {
      stoppedAt: string;
      reason: string;
    };
    expect(lifecycle.reason).toBe("canceled");
    // Access stops now, not at the (never charged) trial end date.
    expect(Date.parse(lifecycle.stoppedAt)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(lifecycle.stoppedAt)).toBeGreaterThanOrEqual(before - 60_000);
    expect(mocks.profileUpdates.at(-1)?.value).toMatchObject({ plan_id: "free" });
    expect(mocks.rpc).not.toHaveBeenCalledWith("claim_bento_trial", expect.anything());
  });

  it.each([
    { has_payment_method: false },
    { has_payment_method: undefined },
    { has_payment_method: true, trial_amount: 500 },
    { has_payment_method: false, trial_period_days: 14 },
    { has_payment_method: false, next_billing_date: null },
    { has_payment_method: true, trial_period_days: 14 },
    { has_payment_method: true, trial_period_days: 0 },
    { has_payment_method: true, next_billing_date: null },
    { has_payment_method: true, next_billing_date: "2030-01-08T00:31:00Z" },
  ])("does not grant access for an unverified free card trial: %j", async (trial) => {
    vi.stubEnv("DODO_CREATOR_39_MONTHLY_PRODUCT_ID", "current-creator");
    const remote = {
      subscription_id: "sub_123",
      status: "active",
      product_id: "current-creator",
      created_at: "2030-01-01T00:00:00Z",
      next_billing_date: "2030-01-08T00:00:00Z",
      trial_period_days: 7,
      metadata: {
        workspace_id: "user_123",
        auth_user_id: "owner",
        billing_catalog: "2026-10",
        trial_checkout_key: "secret-checkout-nonce",
      },
      ...trial,
    };
    mocks.retrieve.mockResolvedValue(remote);
    await expect(
      processVerifiedDodoEvent({ type: "subscription.active", data: remote }, "unsafe-trial"),
    ).rejects.toThrow("Trial payment requirements");
    expect(mocks.subscriptionUpsert).not.toHaveBeenCalled();
    expect(mocks.profileUpdates).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalledWith("claim_bento_trial", expect.anything());
  });

  it("records renewal before trial end without granting access", async () => {
    vi.stubEnv("DODO_CREATOR_39_MONTHLY_PRODUCT_ID", "current-creator");
    const remote = {
      subscription_id: "sub_123",
      status: "active",
      product_id: "current-creator",
      created_at: "2030-01-01T00:00:00Z",
      next_billing_date: "2030-02-08T00:00:00Z",
      previous_billing_date: "2030-01-01T00:00:00Z",
      trial_period_days: 7,
      has_payment_method: true,
      metadata: {
        workspace_id: "user_123",
        auth_user_id: "owner",
        billing_catalog: "2026-10",
        trial_checkout_key: "secret-checkout-nonce",
      },
    };
    mocks.retrieve.mockResolvedValue(remote);
    await expect(
      processVerifiedDodoEvent({ type: "subscription.active", data: remote }, "early-renewal"),
    ).rejects.toThrow("renewal before trial end");
    expect(mocks.subscriptionUpsert).not.toHaveBeenCalled();
    expect(mocks.billingUpdates).toContainEqual(
      expect.objectContaining({ status: "failed", error_message: "renewal before trial end" }),
    );
  });

  it("resolves a subscription event with no user id from the stored dodo subscription", async () => {
    mocks.currentSubscription = {
      user_id: "user_123",
      dodo_subscription_id: "sub_123",
      status: "active",
      plan_id: "creator",
    };
    const event = subscriptionEvent("creator");
    event.data.metadata = {};
    mocks.lastSubscription = event.data;
    await processVerifiedDodoEvent(event, "resolved-sub");
    expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "user_123", dodo_subscription_id: "sub_123" }),
      { onConflict: "user_id" },
    );
    expect(mocks.captureServerException).not.toHaveBeenCalled();
  });

  it("acks an unmatched subscription event so the provider stops retrying", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const event = subscriptionEvent("creator");
    event.data.metadata = {};
    mocks.lastSubscription = event.data;
    await expect(processVerifiedDodoEvent(event, "orphan-sub")).resolves.toEqual({
      duplicate: false,
      ignored: true,
    });
    expect(mocks.subscriptionUpsert).not.toHaveBeenCalled();
    expect(mocks.captureServerException).not.toHaveBeenCalled();
    expect(mocks.billingUpdates).toContainEqual(
      expect.objectContaining({
        status: "processed",
        user_id: null,
        error_message: "ignored: no workspace for dodo subscription",
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      "[dodo] ignoring subscription event with no matching workspace",
      expect.objectContaining({
        eventType: "subscription.active",
        subscriptionId: "sub_123",
        webhookId: "orphan-sub",
      }),
    );
    warn.mockRestore();
  });

  it("does not attach a stored subscription to a different remote owner", async () => {
    mocks.currentSubscription = {
      user_id: "user_123",
      dodo_subscription_id: "sub_123",
      status: "active",
      plan_id: "creator",
    };
    const event = subscriptionEvent("creator");
    event.data.metadata = {};
    mocks.lastSubscription = {
      ...event.data,
      metadata: { user_id: "someone_else" },
    };
    await expect(processVerifiedDodoEvent(event, "foreign-owner")).rejects.toThrow(
      "Subscription owner does not match",
    );
    expect(mocks.subscriptionUpsert).not.toHaveBeenCalled();
  });

  it.each([false, true])("accepts a verified paid period (renewed trial: %s)", async (renewal) => {
    vi.stubEnv("DODO_CREATOR_39_MONTHLY_PRODUCT_ID", "current-creator");
    const now = Date.now();
    const day = 86_400_000;
    const remote = {
      subscription_id: "sub_123",
      status: "active",
      product_id: "current-creator",
      has_payment_method: true,
      trial_amount: null,
      trial_period_days: renewal ? 7 : 0,
      created_at: new Date(now - 40 * day).toISOString(),
      previous_billing_date: new Date(now - 3 * day).toISOString(),
      next_billing_date: new Date(now + 27 * day).toISOString(),
      metadata: {
        workspace_id: "user_123",
        auth_user_id: "owner",
        billing_catalog: "2026-10",
        ...(renewal ? { trial_checkout_key: "secret-checkout-nonce" } : {}),
      },
    };
    mocks.retrieve.mockResolvedValue(remote);
    await processVerifiedDodoEvent({ type: "subscription.active", data: remote }, "paid-period");
    expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active", plan_id: "creator", trial_ends_at: null }),
      { onConflict: "user_id" },
    );
    expect(mocks.rpc).not.toHaveBeenCalledWith("claim_bento_trial", expect.anything());
  });

  it("maps only configured IDs from an explicit webhook cart", () => {
    const explicitKnownCart = [
      { addon_id: "contact-10000-monthly", quantity: 1 },
      { addon_id: "storage-10gb-monthly", quantity: 4 },
    ];

    expect(verifiedDodoAddonState(explicitKnownCart, "monthly", env)).toEqual({
      contactTierContacts: 10_000,
      storageAddonUnits: 4,
    });
  });

  it("preserves local state when Dodo omits the add-on cart", () => {
    expect(verifiedDodoAddonState(undefined, "monthly", env)).toBeNull();
  });

  it("does not grant capacity for unknown add-ons", () => {
    expect(verifiedDodoAddonState([{ addon_id: "unknown", quantity: 99 }], "monthly", env)).toEqual(
      {
        contactTierContacts: 500,
        storageAddonUnits: 0,
      },
    );
  });

  it("persists top-level Dodo add-ons and emits the confirmed state", async () => {
    await processVerifiedDodoEvent(
      subscriptionEvent("creator", "subscription.active", [
        { addon_id: "contact-10000-monthly", quantity: 1 },
        { addon_id: "storage-10gb-monthly", quantity: 4 },
      ]),
      "webhook-creator",
    );

    expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ contact_tier_contacts: 10_000, storage_addon_units: 4 }),
      { onConflict: "user_id" },
    );
    expect(mocks.captureServerEvent).toHaveBeenCalledWith("user_123", "dodo_addons_verified", {
      plan: "creator",
      billing_period: "monthly",
      contact_tier: 10_000,
      storage_units: 4,
    });
  });

  it("preserves add-on columns when the provider omits top-level add-ons", async () => {
    await processVerifiedDodoEvent(subscriptionEvent("creator"), "webhook-omitted");

    expect(mocks.subscriptionUpsert.mock.calls[0][0]).not.toHaveProperty("contact_tier_contacts");
    expect(mocks.subscriptionUpsert.mock.calls[0][0]).not.toHaveProperty("storage_addon_units");
    expect(mocks.captureServerEvent).not.toHaveBeenCalledWith(
      "user_123",
      "dodo_addons_verified",
      expect.anything(),
    );
  });

  it("resets add-on columns for an explicit empty top-level add-on cart", async () => {
    await processVerifiedDodoEvent(
      subscriptionEvent("creator", "subscription.active", []),
      "webhook-empty",
    );

    expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ contact_tier_contacts: 500, storage_addon_units: 0 }),
      { onConflict: "user_id" },
    );
  });

  it("clamps Store contact add-ons while preserving verified storage", async () => {
    await processVerifiedDodoEvent(
      subscriptionEvent("store", "subscription.active", [
        { addon_id: "contact-10000-monthly", quantity: 1 },
        { addon_id: "storage-10gb-monthly", quantity: 4 },
      ]),
      "webhook-store",
    );

    expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ contact_tier_contacts: 500, storage_addon_units: 4 }),
      { onConflict: "user_id" },
    );
  });

  it.each(["subscription.cancelled", "subscription.expired"] as const)(
    "clears add-on capacity for %s",
    async (type) => {
      await processVerifiedDodoEvent(
        subscriptionEvent("creator", type, [
          { addon_id: "contact-10000-monthly", quantity: 1 },
          { addon_id: "storage-10gb-monthly", quantity: 4 },
        ]),
        `webhook-${type}`,
      );

      expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          plan_id: "free",
          contact_tier_contacts: 500,
          storage_addon_units: 0,
        }),
        { onConflict: "user_id" },
      );
    },
  );
});
