import { describe, expect, it } from "vitest";
import {
  billingAllows,
  lifecycleDeadlines,
  readBillingLifecycle,
  dueLifecycleNotices,
} from "./billing-lifecycle";

const start = Date.parse("2030-01-01T00:00:00Z");
const day = 86_400_000;
const episode = {
  episodeId: "episode",
  subscriptionId: "sub",
  reason: "past_due" as const,
  plan: "creator" as const,
  stoppedAt: new Date(start).toISOString(),
  ...lifecycleDeadlines("past_due", start),
  deletingAt: null,
};

describe("workspace billing lifecycle", () => {
  it("allows tools until exactly day three and public pages until exactly day seven", () => {
    expect(billingAllows(episode, "tools", start + 3 * day - 1)).toBe(true);
    expect(billingAllows(episode, "tools", start + 3 * day)).toBe(false);
    expect(billingAllows(episode, "public", start + 3 * day)).toBe(true);
    expect(billingAllows(episode, "public", start + 7 * day)).toBe(false);
    expect(episode.deleteAfter).toBe("2030-04-01T00:00:00.000Z");
  });
  it.each(["canceled", "expired"] as const)(
    "stops %s workspaces at the paid boundary",
    (reason) => {
      const canceled = { ...episode, reason, ...lifecycleDeadlines(reason, start) };
      expect(billingAllows(canceled, "tools", start - 1)).toBe(true);
      expect(billingAllows(canceled, "tools", start)).toBe(false);
      expect(billingAllows(canceled, "public", start)).toBe(false);
    },
  );
  it("does not block workspaces without an unpaid episode and fails closed on malformed state", () => {
    expect(billingAllows(null, "tools", start)).toBe(true);
    expect(billingAllows({ stoppedAt: "bad" }, "public", start)).toBe(false);
    expect(readBillingLifecycle(episode)).toEqual(episode);
  });
  it("never grants access once deletion has started", () => {
    expect(
      billingAllows({ ...episode, deletingAt: new Date(start).toISOString() }, "public", start),
    ).toBe(false);
  });
  it("schedules initial, pause and pre-deletion notices using the original episode", () => {
    expect(dueLifecycleNotices(episode, start - 1)).toEqual([]);
    expect(dueLifecycleNotices(episode, start)).toEqual(["billing_access_ending"]);
    expect(dueLifecycleNotices(episode, start + 3 * day)).toContain("billing_tools_paused");
    expect(dueLifecycleNotices(episode, start + 7 * day)).toContain("billing_page_paused");
    expect(dueLifecycleNotices(episode, start + 83 * day)).toContain("workspace_deletion_warning");
    expect(dueLifecycleNotices(episode, start + 89 * day)).toContain("workspace_deletion_final");
  });
  it("stops hosted access during a voluntary pause without scheduling deletion notices", () => {
    const paused = {
      ...episode,
      reason: "paused" as const,
      toolsStopAt: new Date(start).toISOString(),
      publicStopAt: new Date(start).toISOString(),
      deleteAfter: null,
    };
    expect(readBillingLifecycle(paused)).toEqual(paused);
    expect(billingAllows(paused, "tools", start)).toBe(false);
    expect(billingAllows(paused, "public", start)).toBe(false);
    expect(dueLifecycleNotices(paused, start + 180 * day)).toEqual([]);
  });
});
