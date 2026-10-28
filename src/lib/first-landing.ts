import { redactSensitivePathname } from "./safe-url";

/**
 * First landing record for signup attribution.
 *
 * The PostHog SDK only starts on product routes, so a visitor who first lands on a
 * marketing page (pricing, features, blog, compare...) would otherwise have no first
 * touch. This tiny recorder runs on those pages without loading the SDK and without
 * sending anything anywhere: it writes one first-party cookie, scoped to the shared
 * parent domain so app.bento.surf (and the OAuth return) can read it at signup.
 */
export const FIRST_LANDING_COOKIE = "bento_first_landing";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

export type FirstLanding = {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  /** Referring host only, or "$direct". */
  referrer: string;
  /** Pathname only; no query string or hash. */
  path: string;
};

const MARKETING_PREFIXES = [
  "/pricing",
  "/features",
  "/blog",
  "/compare",
  "/alternatives",
  "/use-cases",
  "/tools",
  "/about",
  "/resources",
  "/changelog",
  "/explore",
  "/contact",
  "/security",
];

/** Marketing and product entry routes where a first landing may be recorded. */
export function isFirstLandingPath(pathname: string): boolean {
  if (["/", "/signup", "/login"].includes(pathname)) return true;
  return MARKETING_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim().slice(0, 120);
  return trimmed || null;
}

/** Shared parent domain: app.bento.surf -> .bento.surf, app.test.bento.surf -> .test.bento.surf. */
export function firstLandingCookieDomain(hostname: string): string | null {
  const host = hostname.toLowerCase();
  if (!host.endsWith("bento.surf")) return null;
  return `.${host.replace(/^(app|www)\./, "")}`;
}

export function buildFirstLanding(input: { href: string; referrer: string }): FirstLanding | null {
  let url: URL;
  try {
    url = new URL(input.href);
  } catch {
    return null;
  }
  let referrer = "$direct";
  try {
    if (input.referrer) {
      const ref = new URL(input.referrer);
      if (ref.hostname !== url.hostname)
        referrer = ref.hostname.replace(/^www\./, "").toLowerCase();
    }
  } catch {
    // Invalid referrers count as direct.
  }
  return {
    utm_source: clean(url.searchParams.get("utm_source")),
    utm_medium: clean(url.searchParams.get("utm_medium")),
    utm_campaign: clean(url.searchParams.get("utm_campaign")),
    referrer,
    path: redactSensitivePathname(url.pathname || "/").slice(0, 200),
  };
}

export function parseFirstLanding(cookieHeader: string): FirstLanding | null {
  const match = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${FIRST_LANDING_COOKIE}=`));
  if (!match) return null;
  try {
    const value = JSON.parse(decodeURIComponent(match.slice(FIRST_LANDING_COOKIE.length + 1)));
    if (!value || typeof value !== "object" || typeof value.path !== "string") return null;
    return value as FirstLanding;
  } catch {
    return null;
  }
}

export function hasPostHogCookie(cookieHeader: string): boolean {
  return /(?:^|;\s*)ph_[^=;]+_posthog=/.test(cookieHeader);
}

/** Records the first landing once per browser. Safe to call on every navigation. */
export function recordFirstLanding(pathname: string): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  if (!isFirstLandingPath(pathname)) return;
  try {
    if (parseFirstLanding(document.cookie)) return;
    // A browser that already has a PostHog cookie landed before this recorder existed;
    // posthog-js already holds its first touch, so a later visit must not overwrite it.
    if (hasPostHogCookie(document.cookie)) return;
    const landing = buildFirstLanding({ href: window.location.href, referrer: document.referrer });
    if (!landing) return;
    const domain = firstLandingCookieDomain(window.location.hostname);
    document.cookie = [
      `${FIRST_LANDING_COOKIE}=${encodeURIComponent(JSON.stringify(landing))}`,
      "path=/",
      `max-age=${MAX_AGE_SECONDS}`,
      "samesite=lax",
      ...(window.location.protocol === "https:" ? ["secure"] : []),
      ...(domain ? [`domain=${domain}`] : []),
    ].join("; ");
  } catch {
    // Cookies disabled: posthog-js and localStorage first touch remain as fallbacks.
  }
}

export function readFirstLanding(): FirstLanding | null {
  if (typeof document === "undefined") return null;
  try {
    return parseFirstLanding(document.cookie);
  } catch {
    return null;
  }
}
