import { describe, expect, it } from "vitest";
import {
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
