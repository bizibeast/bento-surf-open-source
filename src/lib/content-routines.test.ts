import { describe, expect, it } from "vitest";
import { missingPostingSlots, nextContentRoutineRun, routineRunKey } from "./content-routines";
import type { PostingSchedule, SchedulerPost } from "./social-scheduler";

const schedule: PostingSchedule = {
  timezone: "UTC",
  naturalOffset: false,
  slots: [
    { day: 1, time: "09:00" },
    { day: 3, time: "09:00" },
  ],
};

function post(status: SchedulerPost["status"], scheduledAt: string): SchedulerPost {
  return {
    id: crypto.randomUUID(),
    body: "Post",
    title: "",
    scheduledAt,
    timezone: "UTC",
    media: [],
    status,
    createdAt: scheduledAt,
    targets: [],
  };
}

describe("content routines", () => {
  it("generates only for unfilled configured slots", () => {
    const result = missingPostingSlots(
      schedule,
      [
        post("scheduled", "2026-09-21T09:00:00.000Z"),
        post("cancelled", "2026-09-23T09:00:00.000Z"),
      ],
      {
        from: new Date("2026-09-20T00:00:00.000Z"),
        until: new Date("2026-09-26T23:59:59.000Z"),
      },
    );
    expect(result).toEqual([
      expect.objectContaining({ day: 3, time: "09:00", scheduledAt: "2026-09-23T09:00:00.000Z" }),
    ]);
  });

  it("does not count failed or cancelled posts as filled", () => {
    const result = missingPostingSlots(
      schedule,
      [post("failed", "2026-09-21T09:00:00.000Z"), post("cancelled", "2026-09-23T09:00:00.000Z")],
      {
        from: new Date("2026-09-20T00:00:00.000Z"),
        until: new Date("2026-09-26T23:59:59.000Z"),
      },
    );
    expect(result).toHaveLength(2);
  });

  it("returns the same run key for a retry of one scheduled occurrence", () => {
    const scheduledFor = new Date("2026-09-18T20:30:00.000Z");
    expect(routineRunKey("routine", scheduledFor)).toBe("routine:2026-09-18T20:30:00.000Z");
  });

  it("calculates the next local daily run without exposing cron", () => {
    expect(
      nextContentRoutineRun(
        { intervalMinutes: 1_440, time: "03:00" },
        "Asia/Kolkata",
        new Date("2026-09-18T22:00:00.000Z"),
      ).toISOString(),
    ).toBe("2026-09-19T21:30:00.000Z");
  });
});
