import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc } }));
import {
  applyCommerceSubscriptionLifecycle,
  commercePaidServicePeriod,
  creemSubscriptionState,
  dodoSubscriptionState,
  polarSubscriptionState,
} from "./commerce-subscription-lifecycle.server";

describe("provider subscription lifecycle normalization", () => {
  it("preserves Polar end-of-period cancellation and revokes terminal states", () => {
    expect(
      polarSubscriptionState({
        eventType: "subscription.canceled",
        status: "active",
        cancelAtPeriodEnd: true,
      }),
    ).toBe("cancel_at_period_end");
    expect(
      polarSubscriptionState({
        eventType: "subscription.updated",
        status: "canceled",
        cancelAtPeriodEnd: true,
      }),
    ).toBe("revoked");
    expect(polarSubscriptionState({ eventType: "subscription.past_due" })).toBe("past_due");
    expect(polarSubscriptionState({ eventType: "subscription.uncanceled" })).toBe("active");
  });

  it("treats Dodo cancellation as effective and a scheduled update as pending", () => {
    expect(dodoSubscriptionState({ eventType: "subscription.cancelled" })).toBe("revoked");
    expect(
      dodoSubscriptionState({
        eventType: "subscription.updated",
        cancelAtPeriodEnd: true,
      }),
    ).toBe("cancel_at_period_end");
    expect(dodoSubscriptionState({ eventType: "subscription.on_hold" })).toBe("past_due");
    expect(dodoSubscriptionState({ eventType: "subscription.renewed" })).toBe("renewed");
  });

  it("keeps Creem retry events in grace and expires terminal subscriptions", () => {
    expect(creemSubscriptionState({ eventType: "subscription.expired" })).toBe("expired");
    expect(creemSubscriptionState({ eventType: "subscription.paused" })).toBe("past_due");
    expect(creemSubscriptionState({ eventType: "subscription.scheduled_cancel" })).toBe(
      "cancel_at_period_end",
    );
    expect(creemSubscriptionState({ eventType: "subscription.canceled" })).toBe("revoked");
    expect(creemSubscriptionState({ eventType: "subscription.paid" })).toBe("renewed");
  });
});

describe("subscription lifecycle payment boundaries", () => {
  beforeEach(() => rpc.mockReset());

  it.each(["incomplete", "incomplete_expired", "trialing", "unknown"])(
    "does not activate Polar %s updates",
    (status) => {
      expect(polarSubscriptionState({ eventType: "subscription.updated", status })).toBeNull();
    },
  );

  it("does not call a Polar status update a paid renewal", () => {
    expect(polarSubscriptionState({ eventType: "subscription.updated", status: "active" })).toBe(
      "active",
    );
    expect(polarSubscriptionState({ eventType: "subscription.updated" })).toBeNull();
  });

  it.each(["pending", "trialing", "unknown"])("ignores Dodo %s updates", (status) => {
    expect(dodoSubscriptionState({ eventType: "subscription.updated", status })).toBeNull();
  });

  it.each([
    ["paused", "past_due"],
    ["past_due", "past_due"],
    ["expired", "expired"],
    ["cancelled", "revoked"],
    ["canceled", "revoked"],
  ])("maps Dodo status %s to %s even on generic updates", (status, state) => {
    expect(dodoSubscriptionState({ eventType: "subscription.updated", status })).toBe(state);
  });

  it.each(["trialing", "trial", "unknown"])("ignores Creem %s snapshots", (status) => {
    expect(creemSubscriptionState({ eventType: "subscription.active", status })).toBeNull();
  });

  it("ignores a Creem trial event with no status", () => {
    expect(creemSubscriptionState({ eventType: "subscription.trialing" })).toBeNull();
  });

  it.each([polarSubscriptionState, dodoSubscriptionState, creemSubscriptionState])(
    "ignores unknown events without a positive payment status",
    (normalize) => expect(normalize({ eventType: "subscription.unknown" })).toBeNull(),
  );

  it("does not write ignored subscription states to the database", async () => {
    await expect(
      applyCommerceSubscriptionLifecycle({
        provider: "polar",
        providerSubscriptionId: "sub-revoked",
        state: null,
        providerEventId: "pending-event",
      }),
    ).resolves.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("retains the guarded RPC and normalized dates for a paid renewal", async () => {
    rpc.mockResolvedValue({ data: { applied: true, status: "active" }, error: null });
    await applyCommerceSubscriptionLifecycle({
      provider: "creem",
      providerAccountId: "merchant",
      providerSubscriptionId: "sub-paid",
      state: "renewed",
      providerEventId: "paid-event",
      currentPeriodEnd: "2026-12-01T00:00:00Z",
    });
    expect(rpc).toHaveBeenCalledWith(
      "apply_commerce_subscription_lifecycle_guarded",
      expect.objectContaining({
        p_state: "renewed",
        p_provider_account_id: "merchant",
        p_current_period_end: "2026-12-01T00:00:00.000Z",
      }),
    );
  });
});

describe("paid service period boundaries", () => {
  it.each([
    ["2026-01-31T12:34:56Z", "MONTH", 1, "2026-02-28T12:34:56.000Z"],
    ["2024-02-29T00:00:00Z", "year", 1, "2025-02-28T00:00:00.000Z"],
    ["2026-11-26T00:00:00Z", "day", 3, "2026-11-29T00:00:00.000Z"],
    ["2026-11-26T00:00:00Z", "week", 2, "2026-12-10T00:00:00.000Z"],
    ["2026-11-26T00:00:00Z", "month", 3, "2027-02-26T00:00:00.000Z"],
  ])("bounds %s to %s times %s", (paidAt, interval, intervalCount, end) => {
    expect(commercePaidServicePeriod({ paidAt, interval, intervalCount })).toEqual({
      start: new Date(paidAt).toISOString(),
      end,
    });
  });

  it("accepts millisecond timestamps and dates, defaulting to one interval", () => {
    const paidAt = new Date("2026-11-26T00:00:00Z");
    const expected = { start: paidAt.toISOString(), end: "2026-12-26T00:00:00.000Z" };
    expect(commercePaidServicePeriod({ paidAt, interval: "month" })).toEqual(expected);
    expect(commercePaidServicePeriod({ paidAt: paidAt.getTime(), interval: "month" })).toEqual(
      expected,
    );
    expect(paidAt.toISOString()).toBe(expected.start);
  });

  it.each([
    { paidAt: "invalid", interval: "month" },
    { paidAt: null, interval: "month" },
    { paidAt: "2026-11-26", interval: "unknown" },
    { paidAt: "2026-11-26", interval: "month", intervalCount: 0 },
    { paidAt: "2026-11-26", interval: "month", intervalCount: 1.5 },
    { paidAt: "2026-11-26", interval: "month", intervalCount: Number.MAX_SAFE_INTEGER },
  ])("rejects invalid payment dates and cadence %j", (input) => {
    expect(commercePaidServicePeriod(input)).toEqual({ start: null, end: null });
  });
});
