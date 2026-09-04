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
