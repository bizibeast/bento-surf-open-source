import { useEffect, useMemo, useRef } from "react";
import type { StoredMapView } from "@/lib/map.functions";
import { configuredPublicOrigin } from "@/lib/application-urls";

type Props = StoredMapView & {
  interactive: boolean;
  onViewChange?: (view: StoredMapView) => void;
};

type MapViewMessage = StoredMapView & { type: "bento-map-view" };

export function resolveMapsOrigin(
  currentOrigin: string,
  currentHostname: string,
  configuredPublicUrl?: string,
) {
  if (/^(localhost|127\.0\.0\.1)$/.test(currentHostname)) return currentOrigin;
  return configuredPublicOrigin(configuredPublicUrl);
}

function mapsOrigin() {
  if (typeof window === "undefined") {
    return configuredPublicOrigin(import.meta.env.VITE_PUBLIC_URL);
  }

  // Keep the key-bearing iframe on the configured public origin while the editor
  // can run on a separate application origin.
  return resolveMapsOrigin(
    window.location.origin,
    window.location.hostname,
    import.meta.env.VITE_PUBLIC_URL,
  );
}

function embedUrl(view: StoredMapView, interactive: boolean) {
  const url = new URL("/api/maps/embed", mapsOrigin());
  url.searchParams.set("lat", String(view.mapLat));
  url.searchParams.set("lng", String(view.mapLng));
  url.searchParams.set("zoom", String(view.mapZoom));
  if (interactive) url.searchParams.set("interactive", "1");
  return url.toString();
}

function isMapViewMessage(value: unknown): value is MapViewMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<MapViewMessage>;
  return (
    message.type === "bento-map-view" &&
    Number.isFinite(message.mapLat) &&
    Number.isFinite(message.mapLng) &&
    Number.isFinite(message.mapZoom)
  );
}

export function PersistentMap({ mapLat, mapLng, mapZoom, interactive, onViewChange }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const callbackRef = useRef(onViewChange);
  const interactiveRef = useRef(interactive);
  const lastEmittedRef = useRef(`${mapLat}:${mapLng}:${mapZoom}`);
  const initialSrc = useMemo(
    () => embedUrl({ mapLat, mapLng, mapZoom }, interactive),
    // The live map receives later camera changes through postMessage so a drag
    // does not reload the iframe and incur another Maps JavaScript API load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [interactive],
  );

  useEffect(() => {
    callbackRef.current = onViewChange;
  }, [onViewChange]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== mapsOrigin() || event.source !== iframeRef.current?.contentWindow)
        return;
      if (!isMapViewMessage(event.data)) return;
      const view = {
        mapLat: Number(event.data.mapLat.toFixed(6)),
        mapLng: Number(event.data.mapLng.toFixed(6)),
        mapZoom: Math.round(event.data.mapZoom),
      };
      const signature = `${view.mapLat}:${view.mapLng}:${view.mapZoom}`;
      if (signature === lastEmittedRef.current) return;
      lastEmittedRef.current = signature;
      callbackRef.current?.(view);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (interactiveRef.current !== interactive) {
      interactiveRef.current = interactive;
      if (iframeRef.current) {
        iframeRef.current.src = embedUrl({ mapLat, mapLng, mapZoom }, interactive);
      }
      return;
    }
    iframeRef.current?.contentWindow?.postMessage(
      { type: "bento-map-set-view", mapLat, mapLng, mapZoom },
      mapsOrigin(),
    );
  }, [interactive, mapLat, mapLng, mapZoom]);

  return (
    <iframe
      ref={iframeRef}
      src={initialSrc}
      title="Google Map"
      data-testid="map-canvas"
      data-map-interactive={interactive ? "true" : "false"}
      className="size-full border-0 bg-[#e8eef4]"
      loading="lazy"
      tabIndex={interactive ? 0 : -1}
      referrerPolicy="origin"
      onLoad={() =>
        iframeRef.current?.contentWindow?.postMessage(
          { type: "bento-map-set-view", mapLat, mapLng, mapZoom },
          mapsOrigin(),
        )
      }
      style={{ pointerEvents: interactive ? "auto" : "none" }}
    />
  );
}
