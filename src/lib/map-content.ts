import type { StoredMapView } from "./map.functions";

export type MapContent = {
  location?: string;
  mapLat?: number;
  mapLng?: number;
  mapZoom?: number;
  [key: string]: unknown;
};

export function storedMapView(content: MapContent | null | undefined): StoredMapView | null {
  const mapLat = Number(content?.mapLat);
  const mapLng = Number(content?.mapLng);
  const mapZoom = Number(content?.mapZoom);
  if (
    !Number.isFinite(mapLat) ||
    !Number.isFinite(mapLng) ||
    !Number.isFinite(mapZoom) ||
    mapLat < -90 ||
    mapLat > 90 ||
    mapLng < -180 ||
    mapLng > 180 ||
    mapZoom < 2 ||
    mapZoom > 18
  ) {
    return null;
  }
  return { mapLat, mapLng, mapZoom };
}

export async function enrichMapContent(
  content: MapContent,
  geocode: (location: string) => Promise<StoredMapView>,
): Promise<MapContent> {
  const location = String(content.location ?? "").trim();
  if (!location || storedMapView(content)) return content;

  try {
    return { ...content, ...(await geocode(location)) };
  } catch {
    // A temporary geocoder failure must never prevent a valid location block
    // from being created. The renderer can display the typed Google Maps query
    // immediately and the editor can enrich it with a persisted camera later.
    return content;
  }
}
