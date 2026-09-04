import { describe, expect, it } from "vitest";
import { publicBookingCalendarCacheKey } from "./public-booking-calendar-cache.server";

describe("public booking calendar cache", () => {
  it("normalizes usernames into a stable, isolated cache key", () => {
    expect(publicBookingCalendarCacheKey("BiziBeast")).toBe(
      "https://booking-calendar-cache.bento.internal/v1/bizibeast",
    );
  });

  it("encodes unexpected characters without changing the cache namespace", () => {
    expect(publicBookingCalendarCacheKey("name/with space")).toBe(
      "https://booking-calendar-cache.bento.internal/v1/name%2Fwith%20space",
    );
  });
});
