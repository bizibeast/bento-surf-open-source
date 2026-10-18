const PUBLIC_PAGE_CACHE_VERSION = "v2";
const DEFAULT_PUBLIC_PAGE_TTL_SECONDS = 30;
const BLOG_FRESH_SECONDS = 600;
const BLOG_LAST_GOOD_SECONDS = 604800;

export const PUBLIC_BLOG_CACHE_CONTROL =
  "public, max-age=600, s-maxage=600, stale-while-revalidate=86400, stale-if-error=604800";

export const PUBLIC_SITEMAP_CACHE_CONTROL =
  "public, max-age=300, s-maxage=600, stale-while-revalidate=86400, stale-if-error=604800";

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
  "content",
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
  "pricing",
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

export function isPublicBlogPage(request: Request) {
  if (!isPublicPageRequest(request)) return false;
  const path = new URL(request.url).pathname;
  return (
    path === "/blog" || (path.startsWith("/blog/") && !path.slice("/blog/".length).includes("."))
  );
}

function cacheRequestFor(request: Request, generation = PUBLIC_PAGE_CACHE_VERSION) {
  const key = new URL(request.url);
  key.search = `?__bento_public_page_cache=${generation}`;
  return new Request(key.toString(), { method: "GET" });
}

function lastGoodRequestFor(request: Request) {
  return cacheRequestFor(request, `${PUBLIC_PAGE_CACHE_VERSION}-last-good`);
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

function withCacheStatus(response: Response, status: "HIT" | "MISS" | "BYPASS" | "STALE") {
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
    if (!cached) return null;
    const hit = withCacheStatus(cached, "HIT");
    return hit;
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

  const blog = isPublicBlogPage(request);
  const ttl = cacheTtlSeconds(env);
  const cacheControl = blog
    ? `public, max-age=${BLOG_FRESH_SECONDS}`
    : `public, max-age=${ttl}, stale-while-revalidate=86400`;
  const cacheHeaders = new Headers(response.headers);
  cacheHeaders.set("cache-control", cacheControl);
  cacheHeaders.set("x-bento-cache", "HIT");
  const cacheable = new Response(response.clone().body, {
    status: response.status,
    statusText: response.statusText,
    headers: cacheHeaders,
  });
  const writes = [
    cache.put(cacheRequestFor(request), cacheable).catch((error) => {
      console.warn("[public-page-cache] write failed; response was still served", error);
    }),
  ];
  if (blog) {
    const lastGoodHeaders = new Headers(cacheHeaders);
    lastGoodHeaders.set("cache-control", `public, max-age=${BLOG_LAST_GOOD_SECONDS}`);
    writes.push(
      cache
        .put(
          lastGoodRequestFor(request),
          new Response(response.clone().body, {
            status: response.status,
            statusText: response.statusText,
            headers: lastGoodHeaders,
          }),
        )
        .catch((error) => {
          console.warn("[public-page-cache] last-good write failed", error);
        }),
    );
  }
  const write = Promise.all(writes);
  if (typeof context?.waitUntil === "function") context.waitUntil(write);
  else await write;

  const missHeaders = new Headers(response.headers);
  missHeaders.set("cache-control", blog ? PUBLIC_BLOG_CACHE_CONTROL : cacheControl);
  missHeaders.set("x-bento-cache", "MISS");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: missHeaders,
  });
}

export async function publicBlogFailureFallback(request: Request, response: Response) {
  if (response.status < 500 || !isPublicBlogPage(request)) return response;
  const cache = defaultCache();
  if (!cache) return response;
  try {
    const cached = await cache.match(lastGoodRequestFor(request));
    if (!cached || cached.status !== 200) return response;
    const headers = new Headers(cached.headers);
    headers.set("cache-control", PUBLIC_BLOG_CACHE_CONTROL);
    headers.set("x-bento-cache", "STALE");
    headers.set("x-bento-content", "last-good");
    return new Response(cached.body, { status: 200, statusText: "OK", headers });
  } catch (error) {
    console.warn("[public-page-cache] last-good read failed", error);
    return response;
  }
}
import { configuredAppOrigin, configuredPublicOrigin } from "./application-urls";
