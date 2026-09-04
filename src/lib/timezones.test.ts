import { beforeEach, describe, expect, it } from "vitest";
import {
  browserTimeZone,
  detectedBrowserTimeZone,
  isValidTimeZone,
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
});
