import { describe, expect, it } from "vitest";
import { founderInvoiceEndDayExclusive, founderPeriod } from "./founder-period";

describe("founder report dates", () => {
  it("includes today and exactly seven UTC calendar dates", () => {
    const range = founderPeriod(7, 0, new Date("2026-10-22T14:00:00Z"));
    expect(range.start).toBe("2026-10-16T00:00:00.000Z");
    expect(range.end).toBe("2026-10-22T14:00:00.000Z");
    expect(range.dates).toEqual([
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
    ]);
  });
  it("uses non-overlapping complete days for previous periods across a month boundary", () => {
    const range = founderPeriod(7, 7, new Date("2026-11-02T23:00:00-05:00"));
    expect(range.start).toBe("2026-10-21T00:00:00.000Z");
    expect(range.end).toBe("2026-10-28T00:00:00.000Z");
    expect(range.dates.at(-1)).toBe("2026-10-27");
  });
  it("includes today's date-only invoices while excluding a previous period's end day", () => {
    const now = new Date("2026-11-02T15:00:00Z");
    expect(founderInvoiceEndDayExclusive(founderPeriod(7, 0, now).end)).toBe("2026-11-03");
    expect(founderInvoiceEndDayExclusive(founderPeriod(7, 7, now).end)).toBe("2026-10-27");
    expect(founderInvoiceEndDayExclusive("2026-11-03T00:00:00Z")).toBe("2026-11-03");
  });
});
