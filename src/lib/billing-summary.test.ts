import { describe, expect, it } from "vitest";
import { billingSummary } from "./billing-summary";
import { lifecycleDeadlines } from "./billing-lifecycle";

const now = Date.parse("2026-10-23T00:00:00Z");
const trialEnd = "2026-10-25T20:51:30.186Z";
const base = {
  plan: "store" as const,
  status: "trialing" as const,
  cancelAtPeriodEnd: false,
  currentPeriodEnd: trialEnd,
  hasSubscription: true,
  billingLifecycle: null,
};

describe("Billing header", () => {
  it("names the subscribed Store plan during a trial and promises no extra tools", () => {
    const summary = billingSummary(base, "store", now);
    expect(summary.plan).toBe("store");
    expect(summary.badge).toBe("Store trial");
    expect(summary.note).toBeNull();
    expect(summary.date).toEqual({ kind: "trial_ends", at: trialEnd });
  });
  it("never shows Access until for a trial", () => {
    const summary = billingSummary({ ...base, cancelAtPeriodEnd: true }, "store", now);
    expect(summary.badge).toBe("Store trial, canceled");
    expect(summary.date).toEqual({ kind: "trial_ends", at: trialEnd });
  });
  it("keeps Access until for a cancelled paid plan", () => {
    const summary = billingSummary(
      { ...base, status: "active", cancelAtPeriodEnd: true },
      "store",
      now,
    );
    expect(summary.badge).toBe("Store ends soon");
    expect(summary.date).toEqual({ kind: "access_ends", at: trialEnd });
  });
  it("shows Access ended right after a trial is cancelled", () => {
    const summary = billingSummary(
      {
        ...base,
        status: "canceled",
        billingLifecycle: {
          episodeId: "e",
          subscriptionId: "sub",
          reason: "canceled",
          plan: "store",
          stoppedAt: new Date(now).toISOString(),
          ...lifecycleDeadlines("canceled", now),
          deletingAt: null,
        },
      },
      "free",
      now,
    );
    expect(summary.date).toEqual({ kind: "access_ended", at: new Date(now).toISOString() });
  });
  it("never shows Legacy or Renews for an ended subscription", () => {
    const stopped = Date.parse("2026-10-22T20:52:51.163Z");
    const summary = billingSummary(
      {
        ...base,
        status: "canceled",
        billingLifecycle: {
          episodeId: "e",
          subscriptionId: "sub",
          reason: "canceled",
          plan: "store",
          stoppedAt: new Date(stopped).toISOString(),
          ...lifecycleDeadlines("canceled", stopped),
          deletingAt: null,
        },
      },
      "free",
      now,
    );
    expect(summary.badge).toBe("Store canceled");
    expect(summary.description).not.toContain("Legacy");
    expect(summary.date?.kind).toBe("access_ended");
  });
  it("keeps renewal wording for an active paid plan", () => {
    const summary = billingSummary({ ...base, status: "active" }, "store", now);
    expect(summary.badge).toBe("Store is active");
    expect(summary.date?.kind).toBe("renews");
    expect(summary.note).toBeNull();
  });
  it("shows a processing renewal, not an ended plan, while a late debit settles", () => {
    const due = "2026-10-22T00:00:00.000Z";
    const summary = billingSummary(
      { ...base, status: "active", currentPeriodEnd: due },
      "store",
      now,
    );
    expect(summary.badge).toBe("Store is active");
    expect(summary.date).toEqual({ kind: "renewal_processing", at: due });
  });
  it("uses the effective plan when there is no subscription", () => {
    expect(billingSummary(null, "free", now).badge).toBe("Choose your Bento plan");
    expect(billingSummary({ ...base, hasSubscription: false }, "creator", now).badge).toBe(
      "Creator is active",
    );
  });
  it("uses no dashes in visible copy", () => {
    for (const summary of [
      billingSummary(base, "store", now),
      billingSummary({ ...base, cancelAtPeriodEnd: true }, "store", now),
    ])
      expect(`${summary.badge} ${summary.note}`).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("Billing header after a trial cancel", () => {
  it("says the trial ended instead of a paid cancellation", () => {
    const summary = billingSummary({ ...base, status: "canceled", trialEnded: true }, "free", now);
    expect(summary.badge).toBe("Store trial ended");
    expect(
      billingSummary({ ...base, status: "canceled", trialEnded: false }, "free", now).badge,
    ).toBe("Store canceled");
  });
});
