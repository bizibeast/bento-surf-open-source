import { z } from "zod";
import { isValidTimeZone } from "./timezones";

export const weeklyRuleSchema = z.object({
  day: z.number().int().min(0).max(6),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

export const dateOverrideSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  unavailable: z.boolean().optional(),
  ranges: z
    .array(weeklyRuleSchema.pick({ start: true, end: true }))
    .max(12)
    .optional(),
});

export const availabilitySchema = z.object({
  timezone: z.string().trim().min(1).max(100).refine(isValidTimeZone, "Choose a valid timezone"),
  weeklyRules: z.array(weeklyRuleSchema).max(28),
  dateOverrides: z.array(dateOverrideSchema).max(366).default([]),
  minimumNoticeMinutes: z.number().int().min(0).max(525_600),
  maximumDaysAhead: z.number().int().min(1).max(365),
  bufferBeforeMinutes: z.number().int().min(0).max(480),
  bufferAfterMinutes: z.number().int().min(0).max(480),
  slotIntervalMinutes: z.number().int().min(5).max(240),
});

export type WeeklyRule = z.infer<typeof weeklyRuleSchema>;
export type DateOverride = z.infer<typeof dateOverrideSchema>;
export type Availability = z.infer<typeof availabilitySchema>;
export type BusyInterval = { start: string | Date; end: string | Date };
export type BookingSlot = { startsAt: string; endsAt: string };
export type BookingBlockedWindow = { blockedStartsAt: string; blockedEndsAt: string };
export type BookingReminderStage = "24h" | "1h";

export const DEFAULT_AVAILABILITY: Availability = {
  timezone: "UTC",
  weeklyRules: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })),
  dateOverrides: [],
  minimumNoticeMinutes: 120,
  maximumDaysAhead: 60,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 10,
  slotIntervalMinutes: 30,
};

type SessionAvailabilitySettings = Partial<Availability> & {
  availabilityDays?: number[];
  availabilityStart?: string;
  availabilityEnd?: string;
};

export function bookingAvailabilitySettings(availability: Availability) {
  return {
    timezone: availability.timezone,
    weeklyRules: availability.weeklyRules,
    dateOverrides: availability.dateOverrides,
    minimumNoticeMinutes: availability.minimumNoticeMinutes,
    maximumDaysAhead: availability.maximumDaysAhead,
    bufferBeforeMinutes: availability.bufferBeforeMinutes,
    bufferAfterMinutes: availability.bufferAfterMinutes,
    slotIntervalMinutes: availability.slotIntervalMinutes,
  };
}

export function bookingAvailabilityForSession(
  settings: SessionAvailabilitySettings,
  calendarAvailability: Availability = DEFAULT_AVAILABILITY,
): Availability {
  const fallback = availabilitySchema.parse(calendarAvailability);
  const hasOverride =
    Array.isArray(settings.weeklyRules) || Array.isArray(settings.availabilityDays);
  if (!hasOverride) return fallback;
  const weeklyRules = Array.isArray(settings.weeklyRules)
    ? settings.weeklyRules
    : (settings.availabilityDays ?? []).map((day) => ({
        day,
        start: settings.availabilityStart || "09:00",
        end: settings.availabilityEnd || "17:00",
      }));
  return availabilitySchema.parse({
    ...fallback,
    ...settings,
    weeklyRules,
    dateOverrides: settings.dateOverrides ?? fallback.dateOverrides,
  });
}

export function bookingBlockedWindow(input: {
  startsAt: string | Date;
  endsAt: string | Date;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
}): BookingBlockedWindow {
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  if (
    !Number.isFinite(startsAt.getTime()) ||
    !Number.isFinite(endsAt.getTime()) ||
    endsAt <= startsAt
  ) {
    throw new Error("Booking times are invalid.");
  }
  const before = Math.min(480, Math.max(0, Math.round(input.bufferBeforeMinutes)));
  const after = Math.min(480, Math.max(0, Math.round(input.bufferAfterMinutes)));
  return {
    blockedStartsAt: new Date(startsAt.getTime() - before * 60_000).toISOString(),
    blockedEndsAt: new Date(endsAt.getTime() + after * 60_000).toISOString(),
  };
}

export function bookingCanBeCanceled(
  booking: { status: string; starts_at: string },
  now = new Date(),
) {
  const startsAt = new Date(booking.starts_at).getTime();
  return (
    ["pending", "confirmed"].includes(booking.status) &&
    Number.isFinite(startsAt) &&
    startsAt > now.getTime()
  );
}

export function bookingReminderStage(
  booking: {
    starts_at: string;
    status: string;
    reminder_24h_sent_at: string | null;
    reminder_1h_sent_at: string | null;
  },
  now = new Date(),
): BookingReminderStage | null {
  if (booking.status !== "confirmed") return null;
  const untilStart = new Date(booking.starts_at).getTime() - now.getTime();
  if (!Number.isFinite(untilStart) || untilStart <= 0) return null;
  if (untilStart <= 60 * 60_000) return booking.reminder_1h_sent_at ? null : "1h";
  if (untilStart <= 24 * 60 * 60_000 && !booking.reminder_24h_sent_at) return "24h";
  return null;
}

export function shouldAutoAddCalendarPage(input: {
  locked: boolean;
  availabilityConfigured: boolean;
  hasActiveGoogleCalendar: boolean;
  sessionCount: number;
  bookingOnboardedAt: string | null;
}) {
  return calendarSetupReadiness(input).complete && !input.bookingOnboardedAt;
}

export type CalendarSetupStep = "google" | "availability" | "sessions" | "complete";

/**
 * One source of truth for Calendar activation. UI affordances and server-side
 * block creation both use these same prerequisites so setup cannot be skipped
 * by navigating directly to another screen.
 */
export function calendarSetupReadiness(input: {
  locked: boolean;
  availabilityConfigured: boolean;
  hasActiveGoogleCalendar: boolean;
  sessionCount: number;
}) {
  const googleConnected = !input.locked && input.hasActiveGoogleCalendar;
  const availabilityConfigured = !input.locked && input.availabilityConfigured;
  const hasSession = !input.locked && input.sessionCount > 0;
  const currentStep: CalendarSetupStep = input.locked
    ? "google"
    : !googleConnected
      ? "google"
      : !availabilityConfigured
        ? "availability"
        : !hasSession
          ? "sessions"
          : "complete";

  return {
    complete: currentStep === "complete",
    currentStep,
    googleConnected,
    availabilityConfigured,
    hasSession,
  };
}

function timeMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function datePartsInZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

/** Convert a creator-local wall-clock value to UTC without a timezone library. */
export function zonedDateTimeToUtc(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = desired;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const actual = datePartsInZone(new Date(guess), timeZone);
    const rendered = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const correction = desired - rendered;
    if (correction === 0) break;
    guess += correction;
  }
  const candidate = new Date(guess);
  const actual = datePartsInZone(candidate, timeZone);
  if (
    actual.year !== year ||
    actual.month !== month ||
    actual.day !== day ||
    actual.hour !== hour ||
    actual.minute !== minute
  ) {
    return null;
  }
  return candidate;
}

function localDateString(date: Date, timeZone: string) {
  const parts = datePartsInZone(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addCalendarDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days, 12));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

function weekday(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

function overlaps(
  start: number,
  end: number,
  busy: Array<{ start: number; end: number }>,
  beforeMs: number,
  afterMs: number,
) {
  return busy.some((item) => start - beforeMs < item.end && end + afterMs > item.start);
}

export function generateBookingSlots(input: {
  availability: Availability;
  durationMinutes: number;
  busy?: BusyInterval[];
  now?: Date;
}) {
  const availability = availabilitySchema.parse(input.availability);
  // Throws early for unknown IANA zones instead of silently generating bad slots.
  new Intl.DateTimeFormat("en", { timeZone: availability.timezone }).format(new Date());
  const durationMinutes = Math.min(480, Math.max(10, Math.round(input.durationMinutes)));
  const now = input.now ?? new Date();
  const earliest = now.getTime() + availability.minimumNoticeMinutes * 60_000;
  const busy = (input.busy ?? [])
    .map((item) => ({ start: new Date(item.start).getTime(), end: new Date(item.end).getTime() }))
    .filter(
      (item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start,
    );
  const overrides = new Map(
    availability.dateOverrides.map((override) => [override.date, override]),
  );
  const slots: BookingSlot[] = [];
  const firstDate = localDateString(now, availability.timezone);
  const beforeMs = availability.bufferBeforeMinutes * 60_000;
  const afterMs = availability.bufferAfterMinutes * 60_000;

  for (let dayOffset = 0; dayOffset <= availability.maximumDaysAhead; dayOffset += 1) {
    const date = addCalendarDays(firstDate, dayOffset);
    const override = overrides.get(date);
    const ranges = override?.unavailable
      ? []
      : (override?.ranges ??
        availability.weeklyRules
          .filter((rule) => rule.day === weekday(date))
          .map(({ start, end }) => ({ start, end })));
    for (const range of ranges) {
      const rangeStart = timeMinutes(range.start);
      const rangeEnd = timeMinutes(range.end);
      if (rangeEnd <= rangeStart) continue;
      for (
        let minute = rangeStart;
        minute + durationMinutes <= rangeEnd;
        minute += availability.slotIntervalMinutes
      ) {
        const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
        const start = zonedDateTimeToUtc(date, time, availability.timezone);
        if (!start) continue;
        const startMs = start.getTime();
        const endMs = startMs + durationMinutes * 60_000;
        if (startMs < earliest) continue;
        if (overlaps(startMs, endMs, busy, beforeMs, afterMs)) continue;
        slots.push({
          startsAt: start.toISOString(),
          endsAt: new Date(endMs).toISOString(),
        });
      }
    }
  }
  return slots;
}

export function availabilityFromRow(row: Record<string, unknown> | null | undefined): Availability {
  if (!row) return DEFAULT_AVAILABILITY;
  return availabilitySchema.parse({
    timezone: row.timezone,
    weeklyRules: row.weekly_rules,
    dateOverrides: row.date_overrides,
    minimumNoticeMinutes: row.minimum_notice_minutes,
    maximumDaysAhead: row.maximum_days_ahead,
    bufferBeforeMinutes: row.buffer_before_minutes,
    bufferAfterMinutes: row.buffer_after_minutes,
    slotIntervalMinutes: row.slot_interval_minutes,
  });
}
