import { describe, expect, it } from "vitest";
import {
  isoToLocalDateTimeInput,
  isoToZonedDateTimeInput,
  localDateTimeInputToIso,
  zonedDateTimeInputToIso,
} from "./local-datetime";

describe("local datetime conversion", () => {
  it("round-trips an instant through the browser-local input without changing the minute", () => {
    const original = "2026-07-29T08:32:00.000Z";
    expect(localDateTimeInputToIso(isoToLocalDateTimeInput(original))).toBe(original);
  });

  it("rejects invalid values", () => {
    expect(isoToLocalDateTimeInput("not-a-date")).toBe("");
    expect(localDateTimeInputToIso("not-a-date")).toBeNull();
    expect(isoToZonedDateTimeInput("not-a-date", "Asia/Kolkata")).toBe("");
    expect(zonedDateTimeInputToIso("not-a-date", "Asia/Kolkata")).toBeNull();
    expect(zonedDateTimeInputToIso("2026-07-29T14:02", "Not/A_Timezone")).toBeNull();
  });

  it("round-trips a webinar through the selected creator timezone", () => {
    const original = "2026-07-29T08:32:00.000Z";
    const input = isoToZonedDateTimeInput(original, "Asia/Kolkata");
    expect(input).toBe("2026-07-29T14:02");
    expect(zonedDateTimeInputToIso(input, "Asia/Kolkata")).toBe(original);
  });

  it("rejects a wall-clock time that does not exist at the DST boundary", () => {
    expect(zonedDateTimeInputToIso("2026-03-08T02:30", "America/New_York")).toBeNull();
  });
});
