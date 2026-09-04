const PUBLIC_BOOKING_CALENDAR_CACHE_VERSION = "v1";
const PUBLIC_BOOKING_CALENDAR_TTL_SECONDS = 30;
const MISSING_BOOKING_CALENDAR_TTL_SECONDS = 10;

type CachedValue<T> = { value: T };

function defaultCache() {
  return typeof caches === "undefined"
    ? null
    : (caches as CacheStorage & { default: Cache }).default;
}

export function publicBookingCalendarCacheKey(username: string) {
  return `https://booking-calendar-cache.bento.internal/${PUBLIC_BOOKING_CALENDAR_CACHE_VERSION}/${encodeURIComponent(username.toLowerCase())}`;
}

export async function readPublicBookingCalendarCache<T>(key: string) {
  const cache = defaultCache();
  if (!cache) return { hit: false as const, value: null as T | null };
  try {
    const response = await cache.match(new Request(key));
    if (!response) return { hit: false as const, value: null as T | null };
    const payload = (await response.json()) as CachedValue<T | null>;
    return { hit: true as const, value: payload.value };
  } catch (error) {
    console.warn("[public-booking-calendar-cache] read failed; falling back to Supabase", error);
    return { hit: false as const, value: null as T | null };
  }
}

export async function writePublicBookingCalendarCache<T>(key: string, value: T | null) {
  const cache = defaultCache();
  if (!cache) return;
  const ttl =
    value === null ? MISSING_BOOKING_CALENDAR_TTL_SECONDS : PUBLIC_BOOKING_CALENDAR_TTL_SECONDS;
  const response = Response.json({ value } satisfies CachedValue<T | null>, {
    headers: { "cache-control": `public, max-age=${ttl}` },
  });
  try {
    await cache.put(new Request(key), response);
  } catch (error) {
    console.warn(
      "[public-booking-calendar-cache] write failed; calendar data was still served",
      error,
    );
  }
}

export async function clearPublicBookingCalendarCache(username: string) {
  const cache = defaultCache();
  if (!cache) return;
  try {
    await cache.delete(new Request(publicBookingCalendarCacheKey(username)));
  } catch (error) {
    console.warn("[public-booking-calendar-cache] clear failed", error);
  }
}
