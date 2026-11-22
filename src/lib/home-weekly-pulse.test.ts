import { describe, expect, it } from "vitest";
import { parseHomeWeeklyPulse, weeklyChange } from "./home-weekly-pulse";

describe("weekly pulse", () => {
  it("keeps genuine empty periods distinct from missing or malformed data", () => {
    const value = {
      startedAt: "2026-11-11T12:00:00+00:00",
      endedAt: "2026-11-18T12:00:00+00:00",
      followers: { current: 0, previous: 0 },
      leads: { current: 0, previous: 0 },
      revenue: [],
    };
    expect(parseHomeWeeklyPulse(value)).toEqual(value);
    expect(parseHomeWeeklyPulse(null)).toBeNull();
    expect(parseHomeWeeklyPulse({ ...value, followers: { current: -1, previous: 0 } })).toBeNull();
    expect(
      parseHomeWeeklyPulse({
        ...value,
        leads: { current: Number.MAX_SAFE_INTEGER + 1, previous: 0 },
      }),
    ).toBeNull();
  });
  it("does not invent a percentage when the previous period is zero", () => {
    expect(weeklyChange(null)).toMatchObject({ text: "Not available", direction: "neutral" });
    expect(weeklyChange({ current: 0, previous: 0 })).toMatchObject({
      text: "No change vs last week",
      direction: "neutral",
    });
    expect(weeklyChange({ current: 3, previous: 0 })).toMatchObject({
      text: "New this week",
      direction: "up",
    });
    expect(weeklyChange({ current: 0, previous: 10 })).toMatchObject({
      text: "-100% vs last week",
      direction: "down",
    });
    expect(weeklyChange({ current: 15, previous: 10 })).toMatchObject({
      text: "+50% vs last week",
      direction: "up",
    });
  });
});
