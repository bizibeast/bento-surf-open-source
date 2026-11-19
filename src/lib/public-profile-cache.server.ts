import {
  configuredAppOrigin,
  configuredPublicOrigin,
  publicProfilePath,
} from "./application-urls";
import { clearPublicPageCache } from "./public-page-cache.server";

const PUBLIC_PROFILE_CACHE_VERSION = "v2";
const PUBLIC_PROFILE_TTL_SECONDS = 30;
const MISSING_PROFILE_TTL_SECONDS = 10;

type CachedValue<T> = { value: T };

function defaultCache() {
  return typeof caches === "undefined"
    ? null
    : (caches as CacheStorage & { default: Cache }).default;
}

export function publicProfileCacheKey(hostname: string | null, segments: string[]) {
  const scope = hostname ? `host/${hostname.toLowerCase()}` : "bento";
  const path = segments.map((segment) => encodeURIComponent(segment.toLowerCase())).join("/");
  return `https://profile-cache.bento.internal/${PUBLIC_PROFILE_CACHE_VERSION}/${scope}/${path}`;
}

export async function readPublicProfileCache<T>(key: string) {
  const cache = defaultCache();
  if (!cache) return { hit: false as const, value: null as T | null };
  try {
    const response = await cache.match(new Request(key));
    if (!response) return { hit: false as const, value: null as T | null };
    const payload = (await response.json()) as CachedValue<T | null>;
    return { hit: true as const, value: payload.value };
  } catch (error) {
    console.warn("[public-profile-cache] read failed; falling back to Supabase", error);
    return { hit: false as const, value: null as T | null };
  }
}

export async function writePublicProfileCache<T>(key: string, value: T | null) {
  const cache = defaultCache();
  if (!cache) return;
  const ttl = value === null ? MISSING_PROFILE_TTL_SECONDS : PUBLIC_PROFILE_TTL_SECONDS;
  const response = Response.json({ value } satisfies CachedValue<T | null>, {
    headers: { "cache-control": `public, max-age=${ttl}` },
  });
  try {
    await cache.put(new Request(key), response);
  } catch (error) {
    console.warn("[public-profile-cache] write failed; profile data was still served", error);
  }
}

export async function clearPublicProfileCache(
  username: string,
  pageSlugs: string[] = [],
  hostnames: string[] = [],
) {
  const cache = defaultCache();
  if (!cache) return;
  const configuredHosts = [
    ...new Set(
      [configuredPublicOrigin(), configuredAppOrigin()].map((origin) => new URL(origin).host),
    ),
  ];
  const slugs = new Set([
    "",
    "calendar",
    "store",
    "products",
    "insights",
    "newsletter",
    "newsletters",
    ...pageSlugs,
  ]);
  try {
    await Promise.all(
      [...slugs].flatMap((slug) => {
        const suffix = slug ? [slug] : [];
        const hostedPath = publicProfilePath(username, slug);
        const domainPath = slug ? `/${encodeURIComponent(slug)}` : "/";
        const dataKeys = [
          ...[null, ...configuredHosts].map((host) =>
            publicProfileCacheKey(host, [username, ...suffix]),
          ),
          ...hostnames.map((host) => publicProfileCacheKey(host, suffix)),
        ];
        return [
          ...dataKeys.map((key) => cache.delete(new Request(key))),
          clearPublicPageCache([
            ...[configuredPublicOrigin(), configuredAppOrigin()].map(
              (origin) => `${origin}${hostedPath}`,
            ),
            ...hostnames.map((host) => `https://${host}${domainPath}`),
          ]),
        ];
      }),
    );
  } catch (error) {
    console.warn("[public-profile-cache] clear failed", error);
  }
}
