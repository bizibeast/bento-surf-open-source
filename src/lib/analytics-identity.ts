/**
 * Analytics helpers shared by the browser and the Worker. Nothing here sends a raw email
 * address anywhere: callers only forward the boolean result of `isTestEmail`.
 */

/** Exact internal addresses whose traffic is never a real customer. */
const INTERNAL_TEST_EMAILS = new Set(["owner@qa.example.test"]);

/** Disposable inbox domains used for QA signups. */
const TEST_EMAIL_DOMAINS = ["qa.example.test", "disposable.example"];

const TEST_LOCAL_PART_PREFIXES = ["owner+", "stgfix"];

/** True for agent, QA, and staging-fixture accounts that analytics must exclude. */
export function isTestEmail(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) return false;
  if (INTERNAL_TEST_EMAILS.has(normalized)) return true;
  const at = normalized.lastIndexOf("@");
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (TEST_EMAIL_DOMAINS.some((test) => domain === test || domain.endsWith(`.${test}`)))
    return true;
  return TEST_LOCAL_PART_PREFIXES.some((prefix) => local.startsWith(prefix));
}

export const OAUTH_SIGNUP_WINDOW_MS = 10 * 60 * 1000;

/**
 * An OAuth account is treated as a fresh signup when it was created moments ago. Email
 * signups are already captured on the signup form, so they are excluded here.
 */
export function isFreshOAuthSignup(input: {
  provider: string | null | undefined;
  createdAt: string | null | undefined;
  now?: number;
}): boolean {
  const provider = input.provider?.trim().toLowerCase();
  if (!provider || provider === "email" || provider === "phone") return false;
  const created = input.createdAt ? Date.parse(input.createdAt) : Number.NaN;
  if (!Number.isFinite(created)) return false;
  const age = (input.now ?? Date.now()) - created;
  return age >= -60_000 && age < OAUTH_SIGNUP_WINDOW_MS;
}

/** Shape of the bento_first_landing cookie (see first-landing.ts). */
export type FirstLandingRecord = {
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  referrer?: string | null;
  path?: string | null;
};

export type FirstTouch = {
  first_utm_source: string | null;
  first_utm_medium: string | null;
  first_utm_campaign: string | null;
  /** Referring host only (or "$direct"); never a full URL with its query string. */
  first_referrer: string | null;
  /** Landing pathname only; the query string and hash are never kept. */
  first_landing_path: string | null;
  /** utm_source, else "organic search", "referral" or "direct". */
  first_channel: string | null;
};

const EMPTY_FIRST_TOUCH: FirstTouch = {
  first_utm_source: null,
  first_utm_medium: null,
  first_utm_campaign: null,
  first_referrer: null,
  first_landing_path: null,
  first_channel: null,
};

const SEARCH_ENGINE_HOSTS = [
  /^google\./,
  /\.google\./,
  /(^|\.)bing\.com$/,
  /(^|\.)duckduckgo\.com$/,
  /(^|\.)yahoo\./,
  /(^|\.)ecosia\.org$/,
];

/** True for google.*, bing.com, duckduckgo.com, yahoo.* and ecosia.org hosts (any subdomain). */
export function isSearchEngineHost(host: string | null | undefined): boolean {
  const value = host
    ?.trim()
    .toLowerCase()
    .replace(/^www\./, "");
  if (!value) return false;
  return SEARCH_ENGINE_HOSTS.some((pattern) => pattern.test(value));
}

/**
 * Derived first-touch channel: the UTM source when present; otherwise "organic search"
 * for search engine referrers, "referral" for any other referrer host, else "direct".
 * The referring host itself stays in first_referrer.
 */
export function deriveFirstChannel(input: {
  utmSource: string | null | undefined;
  referrerHost: string | null | undefined;
}): string {
  const utm = input.utmSource?.trim();
  if (utm) return utm;
  const host = input.referrerHost?.trim().toLowerCase();
  if (!host || host === "$direct") return "direct";
  return isSearchEngineHost(host) ? "organic search" : "referral";
}

function landingPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || !(raw.startsWith("/") || /^https?:\/\//i.test(raw))) return null;
  try {
    const path = new URL(raw, "https://bento.surf").pathname;
    return (path || "/").slice(0, 200);
  } catch {
    return null;
  }
}

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 120);
  return trimmed || null;
}

function referrerHost(value: unknown): string | null {
  const raw = clean(value);
  if (!raw) return null;
  if (raw === "$direct") return "$direct";
  try {
    return new URL(raw).hostname.replace(/^www\./, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * First-touch attribution for a signup.
 *
 * posthog-js stores `$initial_person_info` ({ r: referrer, u: landing URL }) in its
 * cross-subdomain cookie the first time it loads, so it survives the bento.surf to
 * app.bento.surf hop and the OAuth redirect. Bento's own `bento:first-touch:v1`
 * localStorage record is per-origin and is only used as a fallback.
 */
export function resolveFirstTouch(
  initialPersonInfo: unknown,
  localFallback: Record<string, string | undefined> = {},
  firstLanding: FirstLandingRecord | null = null,
): FirstTouch {
  const info =
    initialPersonInfo && typeof initialPersonInfo === "object"
      ? (initialPersonInfo as Record<string, unknown>)
      : null;
  let fromPostHog: FirstTouch | null = null;
  if (info && (typeof info.u === "string" || typeof info.r === "string")) {
    let params: URLSearchParams | null = null;
    try {
      params = typeof info.u === "string" ? new URL(info.u).searchParams : null;
    } catch {
      params = null;
    }
    fromPostHog = {
      first_utm_source: clean(params?.get("utm_source")),
      first_utm_medium: clean(params?.get("utm_medium")),
      first_utm_campaign: clean(params?.get("utm_campaign")),
      first_referrer: referrerHost(info.r),
      first_landing_path: landingPath(info.u),
      first_channel: null,
    };
  }
  const fallback: FirstTouch = {
    first_utm_source: clean(localFallback.initial_utm_source),
    first_utm_medium: clean(localFallback.initial_utm_medium),
    first_utm_campaign: clean(localFallback.initial_utm_campaign),
    first_referrer:
      localFallback.initial_referring_domain === "Direct"
        ? "$direct"
        : (clean(localFallback.initial_referring_domain)?.replace(/^www\./, "") ?? null),
    first_landing_path: landingPath(localFallback.initial_landing_path),
    first_channel: null,
  };
  if (firstLanding && typeof firstLanding.path === "string") {
    // Recorded on the very first page, including marketing pages where PostHog is off.
    fromPostHog = {
      first_utm_source: clean(firstLanding.utm_source),
      first_utm_medium: clean(firstLanding.utm_medium),
      first_utm_campaign: clean(firstLanding.utm_campaign),
      first_referrer: referrerHost(firstLanding.referrer) ?? clean(firstLanding.referrer),
      first_landing_path: landingPath(firstLanding.path),
      first_channel: null,
    };
  }
  const merged: FirstTouch = !fromPostHog
    ? { ...EMPTY_FIRST_TOUCH, ...fallback }
    : {
        first_utm_source: fromPostHog.first_utm_source ?? fallback.first_utm_source,
        first_utm_medium: fromPostHog.first_utm_medium ?? fallback.first_utm_medium,
        first_utm_campaign: fromPostHog.first_utm_campaign ?? fallback.first_utm_campaign,
        first_referrer: fromPostHog.first_referrer ?? fallback.first_referrer,
        first_landing_path: fromPostHog.first_landing_path ?? fallback.first_landing_path,
        first_channel: null,
      };
  merged.first_channel = deriveFirstChannel({
    utmSource: merged.first_utm_source,
    referrerHost: merged.first_referrer,
  });
  return merged;
}
