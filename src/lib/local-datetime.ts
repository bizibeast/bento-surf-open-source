/**
 * Converts an absolute instant into the value expected by a `datetime-local` input.
 * The input intentionally shows the creator's browser-local wall-clock time.
 */
export function isoToLocalDateTimeInput(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const part = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(
    date.getHours(),
  )}:${part(date.getMinutes())}`;
}

/**
 * Converts a `datetime-local` wall-clock value into an unambiguous UTC instant.
 */
export function localDateTimeInputToIso(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function datePartsInZone(date: Date, timeZone: string) {
  try {
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
  } catch {
    return null;
  }
}

/** Render an absolute instant as a wall-clock value in the creator's selected timezone. */
export function isoToZonedDateTimeInput(value: string, timeZone: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = datePartsInZone(date, timeZone);
  if (!parts) return "";
  const part = (number: number) => String(number).padStart(2, "0");
  return `${parts.year}-${part(parts.month)}-${part(parts.day)}T${part(parts.hour)}:${part(
    parts.minute,
  )}`;
}

/**
 * Resolve a timezone-specific wall-clock value to UTC.
 *
 * Returning null for non-existent DST wall-clock times prevents silently
 * scheduling a webinar at a different hour than the creator selected.
 */
export function zonedDateTimeInputToIso(value: string, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  const [, yearValue, monthValue, dayValue, hourValue, minuteValue] = match;
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = desired;

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const actual = datePartsInZone(new Date(guess), timeZone);
    if (!actual) return null;
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
    !actual ||
    actual.year !== year ||
    actual.month !== month ||
    actual.day !== day ||
    actual.hour !== hour ||
    actual.minute !== minute
  ) {
    return null;
  }
  return candidate.toISOString();
}
