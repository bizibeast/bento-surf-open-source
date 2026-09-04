import { describe, expect, it } from "vitest";
import {
  availabilitySchema,
  bookingAvailabilityForSession,
  bookingCanBeCanceled,
  bookingBlockedWindow,
  bookingReminderStage,
  calendarSetupReadiness,
  DEFAULT_AVAILABILITY,
  generateBookingSlots,
  shouldAutoAddCalendarPage,
  zonedDateTimeToUtc,
} from "./booking";

describe("booking availability", () => {
  it("inherits global availability until a session saves its own override", () => {
    const globalAvailability = {
      ...DEFAULT_AVAILABILITY,
      timezone: "Asia/Kolkata",
      weeklyRules: [{ day: 2, start: "11:00", end: "16:00" }],
      minimumNoticeMinutes: 240,
    };
    expect(bookingAvailabilityForSession({}, globalAvailability)).toEqual(globalAvailability);
    expect(
      bookingAvailabilityForSession(
        {
          timezone: "America/New_York",
          weeklyRules: [{ day: 4, start: "13:00", end: "18:00" }],
          slotIntervalMinutes: 60,
        },
        globalAvailability,
      ),
    ).toMatchObject({
      timezone: "America/New_York",
      weeklyRules: [{ day: 4, start: "13:00", end: "18:00" }],
      slotIntervalMinutes: 60,
      minimumNoticeMinutes: 240,
    });
  });

  it("accepts IANA timezones and rejects made-up values", () => {
    expect(
      availabilitySchema.safeParse({ ...DEFAULT_AVAILABILITY, timezone: "Asia/Kolkata" }).success,
    ).toBe(true);
    expect(
      availabilitySchema.safeParse({ ...DEFAULT_AVAILABILITY, timezone: "Bento/Nowhere" }).success,
    ).toBe(false);
  });

  it("auto-adds Calendar exactly once after Bookings setup completes", () => {
    const setup = {
      locked: false,
      availabilityConfigured: true,
      hasActiveGoogleCalendar: true,
      sessionCount: 1,
    };
    expect(shouldAutoAddCalendarPage({ ...setup, bookingOnboardedAt: null })).toBe(true);
    expect(
      shouldAutoAddCalendarPage({
        ...setup,
        bookingOnboardedAt: "2026-07-23T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("advances Calendar onboarding only when each real prerequisite is complete", () => {
    expect(
      calendarSetupReadiness({
        locked: false,
        availabilityConfigured: false,
        hasActiveGoogleCalendar: false,
        sessionCount: 0,
      }).currentStep,
    ).toBe("google");
    expect(
      calendarSetupReadiness({
        locked: false,
        availabilityConfigured: false,
        hasActiveGoogleCalendar: true,
        sessionCount: 0,
      }).currentStep,
    ).toBe("availability");
    expect(
      calendarSetupReadiness({
        locked: false,
        availabilityConfigured: true,
        hasActiveGoogleCalendar: true,
        sessionCount: 0,
      }).currentStep,
    ).toBe("sessions");
    expect(
      calendarSetupReadiness({
        locked: false,
        availabilityConfigured: true,
        hasActiveGoogleCalendar: true,
        sessionCount: 1,
      }),
    ).toMatchObject({ complete: true, currentStep: "complete" });
  });

  it("converts creator-local times through DST", () => {
    expect(zonedDateTimeToUtc("2026-07-20", "09:00", "America/New_York")?.toISOString()).toBe(
      "2026-07-20T13:00:00.000Z",
    );
    expect(zonedDateTimeToUtc("2026-01-20", "09:00", "America/New_York")?.toISOString()).toBe(
      "2026-01-20T14:00:00.000Z",
    );
  });

  it("filters busy periods and booking buffers", () => {
    const slots = generateBookingSlots({
      availability: {
        ...DEFAULT_AVAILABILITY,
        timezone: "UTC",
        weeklyRules: [{ day: 1, start: "09:00", end: "12:00" }],
        minimumNoticeMinutes: 0,
        maximumDaysAhead: 1,
        bufferBeforeMinutes: 15,
        bufferAfterMinutes: 15,
        slotIntervalMinutes: 30,
      },
      durationMinutes: 30,
      now: new Date("2026-07-19T00:00:00.000Z"),
      busy: [{ start: "2026-07-20T10:00:00.000Z", end: "2026-07-20T10:30:00.000Z" }],
    });
    expect(slots.map((slot) => slot.startsAt)).toEqual([
      "2026-07-20T09:00:00.000Z",
      "2026-07-20T11:00:00.000Z",
      "2026-07-20T11:30:00.000Z",
    ]);
  });

  it("persists the full blocked window used to protect booking buffers", () => {
    expect(
      bookingBlockedWindow({
        startsAt: "2026-07-20T10:00:00.000Z",
        endsAt: "2026-07-20T11:00:00.000Z",
        bufferBeforeMinutes: 15,
        bufferAfterMinutes: 30,
      }),
    ).toEqual({
      blockedStartsAt: "2026-07-20T09:45:00.000Z",
      blockedEndsAt: "2026-07-20T11:30:00.000Z",
    });
  });

  it("rejects invalid blocked windows", () => {
    expect(() =>
      bookingBlockedWindow({
        startsAt: "2026-07-20T11:00:00.000Z",
        endsAt: "2026-07-20T10:00:00.000Z",
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
      }),
    ).toThrow("Booking times are invalid.");
  });

  it("only allows customers to cancel future active bookings", () => {
    const now = new Date("2026-07-20T10:00:00.000Z");
    expect(
      bookingCanBeCanceled({ status: "confirmed", starts_at: "2026-07-20T11:00:00.000Z" }, now),
    ).toBe(true);
    expect(
      bookingCanBeCanceled({ status: "completed", starts_at: "2026-07-20T11:00:00.000Z" }, now),
    ).toBe(false);
    expect(
      bookingCanBeCanceled({ status: "confirmed", starts_at: "2026-07-20T09:00:00.000Z" }, now),
    ).toBe(false);
  });

  it("queues each booking reminder once and never after the call starts", () => {
    const base = {
      starts_at: "2026-07-21T10:00:00.000Z",
      status: "confirmed",
      reminder_24h_sent_at: null,
      reminder_1h_sent_at: null,
    };
    expect(bookingReminderStage(base, new Date("2026-07-20T10:00:00.000Z"))).toBe("24h");
    expect(
      bookingReminderStage(
        { ...base, reminder_24h_sent_at: "2026-07-20T10:00:00.000Z" },
        new Date("2026-07-21T09:00:00.000Z"),
      ),
    ).toBe("1h");
    expect(
      bookingReminderStage(
        { ...base, reminder_1h_sent_at: "2026-07-21T09:00:00.000Z" },
        new Date("2026-07-21T09:30:00.000Z"),
      ),
    ).toBeNull();
    expect(bookingReminderStage(base, new Date("2026-07-21T10:00:00.000Z"))).toBeNull();
    expect(
      bookingReminderStage({ ...base, status: "canceled" }, new Date("2026-07-20T10:00:00.000Z")),
    ).toBeNull();
  });

  it("honours date overrides", () => {
    const slots = generateBookingSlots({
      availability: {
        ...DEFAULT_AVAILABILITY,
        timezone: "UTC",
        weeklyRules: [],
        dateOverrides: [{ date: "2026-07-20", ranges: [{ start: "15:00", end: "16:00" }] }],
        minimumNoticeMinutes: 0,
        maximumDaysAhead: 1,
        slotIntervalMinutes: 30,
      },
      durationMinutes: 30,
      now: new Date("2026-07-19T00:00:00.000Z"),
    });
    expect(slots).toHaveLength(2);
    expect(slots[0].startsAt).toBe("2026-07-20T15:00:00.000Z");
  });
});
