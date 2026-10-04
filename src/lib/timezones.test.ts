import { beforeEach, describe, expect, it } from "vitest";
import {
  browserTimeZone,
  detectedBrowserTimeZone,
  isValidTimeZone,
  nextLocalRefreshAt,
  setBrowserTimeZoneOverride,
  supportedTimeZones,
} from "./timezones";

describe("account timezone", () => {
  beforeEach(() => window.localStorage.clear());

  it("uses a valid account override and returns to automatic detection", () => {
    setBrowserTimeZoneOverride("Asia/Kolkata");
    expect(browserTimeZone()).toBe("Asia/Kolkata");

    setBrowserTimeZoneOverride(null);
    expect(browserTimeZone()).toBe(detectedBrowserTimeZone());
    expect(isValidTimeZone(browserTimeZone())).toBe(true);
  });

  it("offers UTC and the browser's complete IANA timezone list", () => {
    const timeZones = supportedTimeZones();

    expect(timeZones).toContain("UTC");
    expect(timeZones).toEqual(expect.arrayContaining(Intl.supportedValuesOf("timeZone")));
  });

  it("finds the next local 2 AM by calendar date", () => {
    expect(nextLocalRefreshAt("Asia/Kolkata", new Date("2026-09-20T18:00:00Z"))).toBe(
      "2026-09-20T20:30:00.000Z",
    );
    expect(nextLocalRefreshAt("Asia/Kolkata", new Date("2026-09-20T19:00:00Z"))).toBe(
      "2026-09-20T20:30:00.000Z",
    );
    expect(nextLocalRefreshAt("Asia/Kolkata", new Date("2026-09-20T21:00:00Z"))).toBe(
      "2026-09-21T20:30:00.000Z",
    );
  });

  it("skips a nonexistent DST hour and remains stable after fall-back", () => {
    expect(nextLocalRefreshAt("America/New_York", new Date("2026-03-08T00:00:00Z"))).toBe(
      "2026-03-09T06:00:00.000Z",
    );
    expect(nextLocalRefreshAt("America/New_York", new Date("2026-11-01T08:00:00Z"))).toBe(
      "2026-11-02T07:00:00.000Z",
    );
  });
});
