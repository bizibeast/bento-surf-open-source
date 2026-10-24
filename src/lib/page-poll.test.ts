import { describe, expect, it } from "vitest";
import {
  IDLE_POLL_MS,
  LIVE_PUBLISH_POLL_MS,
  SCHEDULER_POLL_MS,
  WAITING_PUBLISH_POLL_MS,
  pagePollInterval,
  schedulerPollInterval,
} from "./page-poll";

const now = Date.parse("2026-10-23T03:30:00.000Z");
const active = { visibility: "visible" as const, idle: false };
const idle = { visibility: "visible" as const, idle: true };
const hidden = { visibility: "hidden" as const, idle: true };

describe("page polling", () => {
  it("stops while the tab is hidden and slows down while the user is idle", () => {
    expect(pagePollInterval(60_000, active)).toBe(60_000);
    expect(pagePollInterval(60_000, idle)).toBe(IDLE_POLL_MS);
    expect(pagePollInterval(60_000, hidden)).toBe(false);
    expect(pagePollInterval(3_000, hidden)).toBe(false);
  });

  it("fast-polls only a publish that is actually in flight", () => {
    expect(
      schedulerPollInterval(
        [{ status: "publishing", targets: [{ status: "publishing" }] }],
        active,
        now,
      ),
    ).toBe(LIVE_PUBLISH_POLL_MS);
    expect(
      schedulerPollInterval(
        [{ status: "publishing", targets: [{ status: "queued" }, { status: "outcome_unknown" }] }],
        active,
        now,
      ),
    ).toBe(LIVE_PUBLISH_POLL_MS);
    expect(schedulerPollInterval([{ status: "scheduled", targets: [] }], active, now)).toBe(
      SCHEDULER_POLL_MS,
    );
  });

  it("does not treat a future retry as a live publish", () => {
    const later = new Date(now + 30 * 60_000).toISOString();
    expect(
      schedulerPollInterval(
        [{ status: "publishing", targets: [{ status: "retrying", nextAttemptAt: later }] }],
        active,
        now,
      ),
    ).toBe(SCHEDULER_POLL_MS);
    const soon = new Date(now + 20_000).toISOString();
    expect(
      schedulerPollInterval(
        [{ status: "publishing", targets: [{ status: "pending", nextAttemptAt: soon }] }],
        active,
        now,
      ),
    ).toBe(WAITING_PUBLISH_POLL_MS);
    expect(
      schedulerPollInterval(
        [{ status: "publishing", targets: [{ status: "retrying", nextAttemptAt: null }] }],
        active,
        now,
      ),
    ).toBe(WAITING_PUBLISH_POLL_MS);
  });

  it("backs off a visible idle scheduler and stops a hidden one", () => {
    const publishing = [{ status: "publishing", targets: [{ status: "processing" }] }];
    expect(schedulerPollInterval(publishing, idle, now)).toBe(SCHEDULER_POLL_MS);
    expect(schedulerPollInterval(publishing, hidden, now)).toBe(false);
    expect(schedulerPollInterval([{ status: "published", targets: [] }], idle, now)).toBe(
      IDLE_POLL_MS,
    );
    expect(schedulerPollInterval([{ status: "published", targets: [] }], hidden, now)).toBe(false);
  });
});
