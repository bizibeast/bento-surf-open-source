const PUBLIC_PAGE_CACHE_VERSION = "v1";
const DEFAULT_PUBLIC_PAGE_TTL_SECONDS = 30;

const RESERVED_APPLICATION_SEGMENTS = new Set([
  "_server",
  "access",
  "admin",
  "analytics",
  "api",
  "assets",
  "auto-dms",
  "automations",
  "bookings",
  "calendar",
  "community",
  "dashboard",
  "earn",
  "favicon.ico",
  "home",
  "integrations",
  "link",
  "login",
  "library",
  "manifest.webmanifest",
  "mcp",
  "onboarding",
  "payments",
  "post-scheduler",
  "products",
  "reset-password",
  "review",
  "robots.txt",
  "settings",
  "signup",
  "sitemap.xml",
  "social-insights",
  "store",
]);

type CacheContext = {
  waitUntil?: (promise: Promise<unknown>) => void;
};

type CacheEnvironment =
  | { VITE_APP_URL?: unknown; VITE_PUBLIC_URL?: unknown; PUBLIC_PAGE_CACHE_TTL_SECONDS?: unknown }
  | undefined;

function isApplicationOrigin(url: URL, env: CacheEnvironment) {
  const appOrigin = configuredAppOrigin(
    typeof env?.VITE_APP_URL === "string" ? env.VITE_APP_URL : undefined,
  );
  const publicOrigin = configuredPublicOrigin(
    typeof env?.VITE_PUBLIC_URL === "string" ? env.VITE_PUBLIC_URL : undefined,
  );
  const hostname = url.hostname.toLowerCase();
  return (
    url.origin === appOrigin ||
    url.origin === publicOrigin ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.endsWith(".workers.dev") ||
    hostname.endsWith(".pages.dev")
  );
}

function pathSegments(pathname: string) {
  return pathname.split("/").filter(Boolean);
}

function looksLikePublicSegment(segment: string) {
  return segment.length <= 96 && !segment.startsWith("_") && !segment.includes(".");
}

export function isPublicPageRequest(request: Request, env?: CacheEnvironment) {
  if (request.method !== "GET") return false;
  if (request.headers.has("authorization") || request.headers.has("cookie")) return false;

  const accept = request.headers.get("accept") ?? "";
  if (accept && !accept.includes("text/html") && !accept.includes("*/*")) return false;

  const url = new URL(request.url);
  const segments = pathSegments(url.pathname);

  if (!isApplicationOrigin(url, env)) {
    return segments.length <= 1 && segments.every(looksLikePublicSegment);
  }

  if (
    url.origin ===
      configuredPublicOrigin(
        typeof env?.VITE_PUBLIC_URL === "string" ? env.VITE_PUBLIC_URL : undefined,
      ) &&
    segments.length === 0
  )
    return true;

  if (segments[0] === "p") {
    return segments.length === 2 && looksLikePublicSegment(segments[1]);
  }

  if (segments[0]?.startsWith("@") && segments[1]?.toLowerCase() === "products") {
    return segments.length === 3 && segments.every(looksLikePublicSegment);
  }

  return (
    segments.length >= 1 &&
    segments.length <= 2 &&
    !RESERVED_APPLICATION_SEGMENTS.has(segments[0]?.toLowerCase()) &&
    segments.every(looksLikePublicSegment)
  );
}

function defaultCache() {
  return typeof caches === "undefined"
    ? null
    : (caches as CacheStorage & { default: Cache }).default;
}

function cacheRequestFor(request: Request) {
  const key = new URL(request.url);
  key.search = `?__bento_public_page_cache=${PUBLIC_PAGE_CACHE_VERSION}`;
  return new Request(key.toString(), { method: "GET" });
}

function cacheTtlSeconds(env: CacheEnvironment) {
  const configured = Number(
    (env as { PUBLIC_PAGE_CACHE_TTL_SECONDS?: unknown } | undefined)?.PUBLIC_PAGE_CACHE_TTL_SECONDS,
  );
  if (Number.isInteger(configured) && configured >= 5 && configured <= 300) {
    return configured;
  }
  return DEFAULT_PUBLIC_PAGE_TTL_SECONDS;
}

function withCacheStatus(response: Response, status: "HIT" | "MISS" | "BYPASS") {
  const headers = new Headers(response.headers);
  headers.set("x-bento-cache", status);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function readPublicPageCache(request: Request, env?: CacheEnvironment) {
  if (!isPublicPageRequest(request, env)) return null;
  const cache = defaultCache();
  if (!cache) return null;
  try {
    const cached = await cache.match(cacheRequestFor(request));
    return cached ? withCacheStatus(cached, "HIT") : null;
  } catch (error) {
    // Edge cache availability must never decide whether a public profile is
    // available. A cache miss is slower but still correct.
    console.warn("[public-page-cache] read failed; continuing without cache", error);
    return null;
  }
}

export async function storePublicPageCache(
  request: Request,
  response: Response,
  env: CacheEnvironment,
  context?: CacheContext,
) {
  if (!isPublicPageRequest(request, env)) return response;
  const cache = defaultCache();
  const contentType = response.headers.get("content-type") ?? "";
  if (!cache || response.status !== 200 || !contentType.includes("text/html")) {
    return withCacheStatus(response, "BYPASS");
  }
  // A personalized response must never enter the shared cache. Returning an
  // explicit status makes this safety decision visible in staging load tests.
  if (response.headers.has("set-cookie")) return withCacheStatus(response, "BYPASS");

  const ttl = cacheTtlSeconds(env);
  const cacheHeaders = new Headers(response.headers);
  cacheHeaders.set("cache-control", `public, max-age=${ttl}, stale-while-revalidate=${ttl * 4}`);
  cacheHeaders.set("x-bento-cache", "HIT");
  const cacheable = new Response(response.clone().body, {
    status: response.status,
    statusText: response.statusText,
    headers: cacheHeaders,
  });
  const write = cache.put(cacheRequestFor(request), cacheable).catch((error) => {
    console.warn("[public-page-cache] write failed; response was still served", error);
  });
  if (typeof context?.waitUntil === "function") context.waitUntil(write);
  else await write;

  return withCacheStatus(response, "MISS");
}
import { configuredAppOrigin, configuredPublicOrigin } from "./application-urls";
