import { describe, expect, it } from "vitest";
import { dayInTimeZone, historyStart, rangeStart } from "./analytics.functions";

describe("analytics timezone ranges", () => {
  const nearUtcMidnight = new Date("2026-08-01T22:30:00.000Z");

  it("uses the creator's local calendar day", () => {
    expect(dayInTimeZone(nearUtcMidnight, "UTC")).toBe("2026-08-01");
    expect(dayInTimeZone(nearUtcMidnight, "Asia/Kolkata")).toBe("2026-08-02");
  });

  it("includes today when calculating a rolling calendar range", () => {
    expect(rangeStart("today", "Asia/Kolkata", nearUtcMidnight)).toBe("2026-08-02");
    expect(rangeStart("3d", "Asia/Kolkata", nearUtcMidnight)).toBe("2026-07-31");
    expect(rangeStart("all", "Asia/Kolkata", nearUtcMidnight)).toBeNull();
  });

  it("enforces plan history using the selected timezone", () => {
    expect(historyStart(3, "America/Los_Angeles", nearUtcMidnight)).toBe("2026-07-30");
  });
});
