import { beforeEach, describe, expect, it, vi } from "vitest";

const captureProductEvent = vi.hoisted(() => vi.fn());
const setCheckoutReplayForced = vi.hoisted(() => vi.fn());
vi.mock("./posthog", () => ({ captureProductEvent, setCheckoutReplayForced }));

import {
  CHECKOUT_PENDING_MAX_AGE_MS,
  CHECKOUT_VISIBILITY_TIMEOUT_MS,
  PENDING_CHECKOUT_KEY,
  beginCheckoutTracking,
  checkPendingCheckout,
  readPendingCheckout,
  rememberCheckoutStarted,
  resolvePendingCheckout,
  watchCheckoutExit,
} from "./checkout-tracking";

const T0 = 1_800_000_000_000;
const started = { plan: "creator_plus", trial: true, surface: "onboarding_trial_step" };

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  window.sessionStorage.clear();
  captureProductEvent.mockClear();
  setCheckoutReplayForced.mockClear();
});

describe("resolvePendingCheckout", () => {
  it("does nothing without a started checkout", () => {
    expect(resolvePendingCheckout("reload_or_return", { search: "", now: T0 })).toEqual({
      kind: "none",
    });
  });

  it("reports a reload or return without a marker with plan, trial and elapsed seconds", () => {
    rememberCheckoutStarted(started, T0);
    const result = resolvePendingCheckout("reload_or_return", { search: "", now: T0 + 12_400 });
    expect(result).toEqual({
      kind: "left",
      properties: {
        plan: "creator_plus",
        trial: true,
        elapsed_seconds: 12,
        surface: "onboarding_trial_step",
        reason: "reload_or_return",
      },
    });
  });

  it("does not report when Dodo's return marker is present, and clears the record", () => {
    rememberCheckoutStarted(started, T0);
    expect(
      resolvePendingCheckout("reload_or_return", {
        search: "?checkout=return&trial=1&status=failed",
        now: T0 + 5_000,
      }),
    ).toEqual({ kind: "returned" });
    expect(readPendingCheckout()).toBeNull();
    expect(resolvePendingCheckout("back_navigation", { search: "", now: T0 + 6_000 })).toEqual({
      kind: "none",
    });
  });

  it("treats the dashboard upgraded marker as a return too", () => {
    rememberCheckoutStarted({ ...started, surface: "upgrade_dialog" }, T0);
    expect(
      resolvePendingCheckout("reload_or_return", { search: "?upgraded=1", now: T0 + 1 }),
    ).toEqual({ kind: "returned" });
  });

  it("waits on a visibility return before the timeout, then reports once after it", () => {
    rememberCheckoutStarted(started, T0);
    expect(
      resolvePendingCheckout("visibility_timeout", {
        search: "",
        now: T0 + CHECKOUT_VISIBILITY_TIMEOUT_MS - 1,
      }),
    ).toEqual({ kind: "waiting" });
    expect(readPendingCheckout()).not.toBeNull();
    const after = resolvePendingCheckout("visibility_timeout", {
      search: "",
      now: T0 + CHECKOUT_VISIBILITY_TIMEOUT_MS + 4_000,
    });
    expect(after).toMatchObject({
      kind: "left",
      properties: { elapsed_seconds: 64, reason: "visibility_timeout" },
    });
  });

  it("never fires twice for the same checkout", () => {
    rememberCheckoutStarted(started, T0);
    expect(resolvePendingCheckout("back_navigation", { search: "", now: T0 + 3_000 }).kind).toBe(
      "left",
    );
    expect(resolvePendingCheckout("reload_or_return", { search: "", now: T0 + 4_000 }).kind).toBe(
      "none",
    );
    expect(
      resolvePendingCheckout("visibility_timeout", { search: "", now: T0 + 120_000 }).kind,
    ).toBe("none");
  });

  it("drops stale records instead of reporting them", () => {
    rememberCheckoutStarted(started, T0);
    expect(
      resolvePendingCheckout("reload_or_return", {
        search: "",
        now: T0 + CHECKOUT_PENDING_MAX_AGE_MS + 1,
      }),
    ).toEqual({ kind: "none" });
    expect(readPendingCheckout()).toBeNull();
  });

  it("ignores corrupt storage", () => {
    window.sessionStorage.setItem(PENDING_CHECKOUT_KEY, "{nope");
    expect(resolvePendingCheckout("reload_or_return", { search: "", now: T0 }).kind).toBe("none");
  });
});

describe("checkPendingCheckout", () => {
  it("captures one checkout_page_left event and only one on repeated checks", async () => {
    rememberCheckoutStarted(started, Date.now() - 8_000);
    checkPendingCheckout("reload_or_return", { search: "" });
    checkPendingCheckout("back_navigation", { search: "" });
    await flush();
    expect(captureProductEvent).toHaveBeenCalledTimes(1);
    expect(captureProductEvent).toHaveBeenCalledWith(
      "checkout_page_left",
      expect.objectContaining({
        plan: "creator_plus",
        trial: true,
        reason: "reload_or_return",
        elapsed_seconds: expect.any(Number),
      }),
    );
  });

  it("captures nothing when the buyer returned with Dodo's marker", async () => {
    rememberCheckoutStarted(started, Date.now() - 20_000);
    checkPendingCheckout("reload_or_return", { search: "?checkout=return&trial=1" });
    await flush();
    expect(captureProductEvent).not.toHaveBeenCalled();
  });
});

describe("watchCheckoutExit", () => {
  it("reports a back/forward cache restore once and ignores ordinary page shows", async () => {
    const stop = watchCheckoutExit();
    rememberCheckoutStarted(started, Date.now() - 30_000);
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
    await flush();
    expect(captureProductEvent).not.toHaveBeenCalled();
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    await flush();
    expect(captureProductEvent).toHaveBeenCalledTimes(1);
    expect(captureProductEvent.mock.calls[0]?.[1]).toMatchObject({ reason: "back_navigation" });
    stop();
  });

  it("reports a visibility return after the timeout only", async () => {
    const stop = watchCheckoutExit();
    rememberCheckoutStarted(started, Date.now() - 5_000);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(captureProductEvent).not.toHaveBeenCalled();
    window.sessionStorage.setItem(
      PENDING_CHECKOUT_KEY,
      JSON.stringify({ ...started, startedAt: Date.now() - 90_000 }),
    );
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(captureProductEvent).toHaveBeenCalledTimes(1);
    expect(captureProductEvent.mock.calls[0]?.[1]).toMatchObject({
      reason: "visibility_timeout",
      plan: "creator_plus",
    });
    stop();
  });

  it("stops listening after cleanup", async () => {
    const stop = watchCheckoutExit();
    stop();
    rememberCheckoutStarted(started, Date.now() - 30_000);
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    await flush();
    expect(captureProductEvent).not.toHaveBeenCalled();
  });
});

describe("beginCheckoutTracking", () => {
  it("remembers the checkout and forces session replay", async () => {
    beginCheckoutTracking(started);
    await flush();
    expect(readPendingCheckout()).toMatchObject(started);
    expect(setCheckoutReplayForced).toHaveBeenCalledTimes(1);
  });
});
