import { zonedDateTimeInputToIso } from "./local-datetime";
import { isValidTimeZone } from "./timezones";
import type { PostingSchedule, SchedulerPost } from "./social-scheduler";

export type ContentRoutineSchedule = {
  intervalMinutes: number;
  time: string;
  name?: string;
  instructions?: string;
  catalogKey?: string;
};

export type ContentRoutineTemplate =
  | "nightly_niche_brief"
  | "fill_schedule"
  | "morning_ready_email"
  | "weekly_performance_review"
  | `custom:${string}`;

function localDateKey(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function addLocalDays(dateKey: string, days: number) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function requiredZonedIso(value: string, timezone: string) {
  const iso = zonedDateTimeInputToIso(value, timezone);
  if (!iso) throw new Error("Routine time could not be resolved in this timezone.");
  return iso;
}

export function nextContentRoutineRun(
  schedule: ContentRoutineSchedule,
  timezone: string,
  now = new Date(),
) {
  if (!isValidTimeZone(timezone)) throw new Error("Choose a valid routine timezone.");
  if (![1_440, 10_080].includes(schedule.intervalMinutes))
    throw new Error("Choose a daily or weekly routine.");
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
    throw new Error("Choose a valid routine time.");
  }
  const intervalDays = Math.max(1, Math.round(schedule.intervalMinutes / 1_440));
  let dateKey = localDateKey(now, timezone);
  let candidate = new Date(requiredZonedIso(`${dateKey}T${schedule.time}`, timezone));
  if (candidate.getTime() <= now.getTime()) {
    dateKey = addLocalDays(dateKey, intervalDays);
    candidate = new Date(requiredZonedIso(`${dateKey}T${schedule.time}`, timezone));
  }
  return candidate;
}

export function routineRunKey(routineId: string, scheduledFor: Date) {
  return `${routineId}:${scheduledFor.toISOString()}`;
}

export function missingPostingSlots(
  schedule: PostingSchedule,
  posts: SchedulerPost[],
  horizon: { from: Date; until: Date },
) {
  if (!isValidTimeZone(schedule.timezone) || horizon.until < horizon.from) return [];
  const occupied = new Set(
    posts
      .filter((post) => post.scheduledAt && !["cancelled", "failed", "draft"].includes(post.status))
      .map((post) => new Date(post.scheduledAt as string).toISOString()),
  );
  const firstDate = localDateKey(horizon.from, schedule.timezone);
  const lastDate = localDateKey(horizon.until, schedule.timezone);
  const result: Array<{ day: number; time: string; scheduledAt: string }> = [];
  for (let offset = 0; offset < 15; offset += 1) {
    const date = addLocalDays(firstDate, offset);
    if (date > lastDate) break;
    const weekday = new Date(`${date}T12:00:00.000Z`).getUTCDay();
    for (const slot of schedule.slots.filter((candidate) => candidate.day === weekday)) {
      const scheduledAt = new Date(requiredZonedIso(`${date}T${slot.time}`, schedule.timezone));
      const iso = scheduledAt.toISOString();
      if (scheduledAt >= horizon.from && scheduledAt <= horizon.until && !occupied.has(iso)) {
        result.push({ day: slot.day, time: slot.time, scheduledAt: iso });
      }
    }
  }
  return result;
}
