import { describe, expect, it, vi } from "vitest";
import { enrichMapContent, storedMapView } from "./map-content";

describe("map content", () => {
  it("keeps a typed location when geocoding is temporarily unavailable", async () => {
    const content = { location: "Gateway of India", title: "Mumbai" };
    const result = await enrichMapContent(content, vi.fn().mockRejectedValue(new Error("timeout")));

    expect(result).toEqual(content);
  });

  it("persists a valid camera when geocoding succeeds", async () => {
    const geocode = vi.fn().mockResolvedValue({
      mapLat: 18.921984,
      mapLng: 72.834654,
      mapZoom: 16,
    });
    const result = await enrichMapContent({ location: "Gateway of India" }, geocode);

    expect(storedMapView(result)).toEqual({
      mapLat: 18.921984,
      mapLng: 72.834654,
      mapZoom: 16,
    });
  });

  it("does not geocode content that already has a valid camera", async () => {
    const geocode = vi.fn();
    const content = {
      location: "Mumbai",
      mapLat: 19.076,
      mapLng: 72.8777,
      mapZoom: 12,
    };

    expect(await enrichMapContent(content, geocode)).toEqual(content);
    expect(geocode).not.toHaveBeenCalled();
  });
});
