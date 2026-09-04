import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { enforceRequestRateLimit } from "./request-security.server";

export type StoredMapView = {
  mapLat: number;
  mapLng: number;
  mapZoom: number;
};

const geocodeCache = new Map<string, StoredMapView>();
let nextGeocodeAt = 0;

function zoomForBoundingBox(value: unknown) {
  if (!Array.isArray(value) || value.length !== 4) return 14;
  const [south, north, west, east] = value.map(Number);
  if (![south, north, west, east].every(Number.isFinite)) return 14;
  const span = Math.max(Math.abs(north - south), Math.abs(east - west));
  if (span <= 0) return 14;
  return Math.max(3, Math.min(17, Math.round(Math.log2(720 / span))));
}

async function respectPublicGeocoderLimit() {
  const now = Date.now();
  const waitMs = Math.max(0, nextGeocodeAt - now);
  nextGeocodeAt = Math.max(now, nextGeocodeAt) + 1_000;
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

export const geocodeMapLocation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ location: z.string().trim().min(2).max(240) }).parse(input))
  .handler(async ({ data, context }) => {
    const key = data.location.toLocaleLowerCase();
    const cached = geocodeCache.get(key);
    if (cached) return cached;

    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "map-geocode", context.userId);
    await respectPublicGeocoderLimit();
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", data.location);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("addressdetails", "0");
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Language": "en",
        "User-Agent": "BentoSurfMapEditor/1.0",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Map search returned ${response.status}`);
    const result = (await response.json()) as Array<{
      lat?: string;
      lon?: string;
      boundingbox?: string[];
    }>;
    const mapLat = Number(result[0]?.lat);
    const mapLng = Number(result[0]?.lon);
    if (
      !Number.isFinite(mapLat) ||
      !Number.isFinite(mapLng) ||
      mapLat < -90 ||
      mapLat > 90 ||
      mapLng < -180 ||
      mapLng > 180
    ) {
      throw new Error("Location not found");
    }
    const view = { mapLat, mapLng, mapZoom: zoomForBoundingBox(result[0]?.boundingbox) };
    if (geocodeCache.size > 500) geocodeCache.clear();
    geocodeCache.set(key, view);
    return view;
  });
