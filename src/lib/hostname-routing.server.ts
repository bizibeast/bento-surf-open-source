import { configuredAppOrigin, configuredPublicOrigin } from "./application-urls";

const MARKETING_PATH_SEGMENTS = new Set([
  "",
  "about",
  "alternatives",
  "blog",
  "changelog",
  "compare",
  "contact",
  "explore",
  "features",
  "llms.txt",
  "pricing",
  "privacy",
  "resources",
  "security",
  "sitemap.xml",
  "sitemaps",
  "terms",
  "tools",
  "use-cases",
]);

const APPLICATION_PATH_SEGMENTS = new Set([
  "_server",
  "access",
  "admin",
  "analytics",
  "auto-dms",
  "automations",
  "bookings",
  "calendar",
  "community",
  "dashboard",
  "data-deletion",
  "earn",
  "home",
  "integrations",
  "library",
  "link",
  "login",
  "mcp",
  "onboarding",
  "p",
  "payments",
  "products",
  "post-scheduler",
  "reset-password",
  "review",
  "scheduler",
  "settings",
  "signup",
  "social-insights",
  "store",
]);

const PASSTHROUGH_PATH_SEGMENTS = new Set([
  "api",
  "assets",
  "branding",
  "cdn",
  "favicon.ico",
  "manifest.webmanifest",
  "robots.txt",
  "sitemap.xml",
]);

const LEGACY_APPLICATION_PATHS = new Map([
  ["/dashboard", "/link"],
  ["/products", "/store"],
  ["/bookings", "/calendar"],
  ["/scheduler", "/post-scheduler"],
  ["/automations", "/auto-dms"],
]);

function firstPathSegment(pathname: string) {
  return pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
}

function redirectTo(origin: string, source: URL, status: 307 | 308 = 308) {
  const destination = new URL(`${source.pathname}${source.search}`, origin);
  return Response.redirect(destination.toString(), status);
}

function canonicalApplicationPath(pathname: string) {
  for (const [legacy, canonical] of LEGACY_APPLICATION_PATHS) {
    if (pathname === legacy || pathname.startsWith(`${legacy}/`)) {
      return `${canonical}${pathname.slice(legacy.length)}`;
    }
  }
  return null;
}

function looksLikeLegacyPublicProfile(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 1 || segments.length > 2) return false;
  const [username, pageSlug] = segments;
  return /^[a-z0-9_]{3,24}$/i.test(username) && (!pageSlug || /^[a-z0-9-]{1,40}$/i.test(pageSlug));
}

function canonicalPublicProfilePath(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  return `/@${segments.map(encodeURIComponent).join("/")}`;
}

function isPublicProductPath(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  return segments.length === 2 && segments[0]?.toLowerCase() === "p";
}

function isCreatorProductSuccessPath(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  return (
    segments.length === 4 &&
    segments[0]?.startsWith("@") &&
    segments[1]?.toLowerCase() === "products" &&
    segments[3]?.toLowerCase() === "success"
  );
}

/**
 * Keep marketing, account, and creator URLs on deliberate hostnames.
 *
 * The configured public origin serves marketing and collision-free /@username creator pages.
 * The configured app origin serves authentication, editor, settings, integrations, and checkout.
 * - existing /username links: permanent redirect to /@username
 *
 * API, webhook, CDN, and preview-image requests remain valid on both origins so
 * previously registered providers and already-sent media URLs do not break.
 */
export function routeCanonicalHostname(
  request: Request,
  environment: { VITE_APP_URL?: unknown; VITE_PUBLIC_URL?: unknown } | undefined,
) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const url = new URL(request.url);
  const appOrigin = configuredAppOrigin(
    typeof environment?.VITE_APP_URL === "string" ? environment.VITE_APP_URL : undefined,
  );
  const publicOrigin = configuredPublicOrigin(
    typeof environment?.VITE_PUBLIC_URL === "string" ? environment.VITE_PUBLIC_URL : undefined,
  );
  const appHost = new URL(appOrigin).hostname;
  const publicHost = new URL(publicOrigin).hostname;
  const hostname = url.hostname.toLowerCase();
  const segment = firstPathSegment(url.pathname);

  if (hostname === `www.${publicHost}`) return redirectTo(publicOrigin, url);

  if (appOrigin === publicOrigin && hostname === appHost) {
    const canonicalPath = canonicalApplicationPath(url.pathname);
    if (canonicalPath) {
      const destination = new URL(canonicalPath, appOrigin);
      destination.search = url.search;
      return Response.redirect(destination.toString(), 308);
    }
    return url.origin === appOrigin ? null : redirectTo(appOrigin, url);
  }

  if (hostname === appHost) {
    const canonicalPath = canonicalApplicationPath(url.pathname);
    if (canonicalPath) {
      const destination = new URL(canonicalPath, appOrigin);
      destination.search = url.search;
      return Response.redirect(destination.toString(), 308);
    }
    if (url.pathname === "/") {
      const destination = new URL("/link", appOrigin);
      destination.search = url.search;
      return Response.redirect(destination.toString(), 307);
    }
    if (isCreatorProductSuccessPath(url.pathname)) {
      return url.protocol === "https:" ? null : redirectTo(appOrigin, url);
    }
    if (isPublicProductPath(url.pathname)) return redirectTo(publicOrigin, url);
    if (MARKETING_PATH_SEGMENTS.has(segment) || segment.startsWith("@")) {
      return redirectTo(publicOrigin, url);
    }
    if (url.protocol !== "https:") return redirectTo(appOrigin, url);
    return null;
  }

  if (hostname !== publicHost) return null;
  const canonicalPath = canonicalApplicationPath(url.pathname);
  if (canonicalPath) {
    const destination = new URL(canonicalPath, appOrigin);
    destination.search = url.search;
    return Response.redirect(destination.toString(), 308);
  }
  if (isCreatorProductSuccessPath(url.pathname)) return redirectTo(appOrigin, url);
  if (PASSTHROUGH_PATH_SEGMENTS.has(segment)) {
    return url.protocol === "https:" ? null : redirectTo(publicOrigin, url);
  }
  if (isPublicProductPath(url.pathname)) {
    return url.protocol === "https:" ? null : redirectTo(publicOrigin, url);
  }
  if (APPLICATION_PATH_SEGMENTS.has(segment)) return redirectTo(appOrigin, url);
  if (MARKETING_PATH_SEGMENTS.has(segment) || segment.startsWith("@")) {
    return url.protocol === "https:" ? null : redirectTo(publicOrigin, url);
  }

  if (looksLikeLegacyPublicProfile(url.pathname)) {
    const destination = new URL(canonicalPublicProfilePath(url.pathname), publicOrigin);
    destination.search = url.search;
    return Response.redirect(destination.toString(), 308);
  }

  return url.protocol === "https:" ? null : redirectTo(publicOrigin, url);
}
