export function isValidTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

const ACCOUNT_TIME_ZONE_KEY = "bento.account-timezone";

export function detectedBrowserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function browserTimeZone() {
  try {
    const override = window.localStorage.getItem(ACCOUNT_TIME_ZONE_KEY) || "";
    if (isValidTimeZone(override)) return override;
  } catch {
    // Browser storage is optional; native timezone detection remains the fallback.
  }
  return detectedBrowserTimeZone();
}

export function setBrowserTimeZoneOverride(timeZone: string | null) {
  try {
    if (timeZone && isValidTimeZone(timeZone)) {
      window.localStorage.setItem(ACCOUNT_TIME_ZONE_KEY, timeZone);
    } else {
      window.localStorage.removeItem(ACCOUNT_TIME_ZONE_KEY);
    }
  } catch {
    // Private browsing can disable storage without disabling timezone support.
  }
}

export function supportedTimeZones() {
  try {
    return Array.from(new Set(["UTC", ...Intl.supportedValuesOf("timeZone")])).sort();
  } catch {
    return ["UTC"];
  }
}

export function nextLocalRefreshAt(timeZone: string, after: Date, hour = 2) {
  if (!isValidTimeZone(timeZone) || !Number.isFinite(after.getTime())) {
    throw new Error("Choose a valid timezone and refresh time.");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(after);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const start = Date.UTC(value("year"), value("month") - 1, value("day"));
  const pad = (input: number) => String(input).padStart(2, "0");

  for (let offset = 0; offset < 370; offset += 1) {
    const day = new Date(start);
    day.setUTCDate(day.getUTCDate() + offset);
    const local = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}T${pad(hour)}:00`;
    const candidate = zonedDateTimeInputToIso(local, timeZone);
    if (candidate && Date.parse(candidate) > after.getTime()) return candidate;
  }
  throw new Error("Could not calculate the next refresh time.");
}
import { zonedDateTimeInputToIso } from "@/lib/local-datetime";
