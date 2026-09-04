import { useEffect, useRef, useState, type ImgHTMLAttributes, type SyntheticEvent } from "react";

import { cn } from "@/lib/utils";

/**
 * Keeps an image transparent until the complete frame has decoded. This stops
 * large/progressive JPEGs from visibly painting one scanline at a time while
 * retaining native lazy loading and the browser cache.
 */
export function DecodedImage({
  className,
  onLoad,
  onError,
  src,
  decoding = "async",
  ...props
}: ImgHTMLAttributes<HTMLImageElement>) {
  const eager = props.loading === "eager";
  const [ready, setReady] = useState(eager);
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (eager) {
      setReady(true);
      return;
    }
    setReady(false);
    const image = imageRef.current;
    if (!image) return;
    let stale = false;
    const revealCompletedImage = async () => {
      if (image.naturalWidth === 0) return;
      const loadedSource = image.currentSrc || image.src;
      try {
        if (typeof image.decode === "function") await image.decode();
      } catch {
        // A completed image is still safe to reveal when decode() rejects.
      }
      if (!stale && imageRef.current === image && (image.currentSrc || image.src) === loadedSource)
        setReady(true);
    };
    image.addEventListener("load", revealCompletedImage);
    if (image.complete) void revealCompletedImage();
    return () => {
      stale = true;
      image.removeEventListener("load", revealCompletedImage);
    };
  }, [eager, src]);

  const reveal = async (event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    const loadedSource = image.currentSrc || image.src;
    // React only guarantees currentTarget while the event handler is running.
    // Forward the native load notification before awaiting decode() so callers
    // can safely inspect dimensions and other element state.
    onLoad?.(event);
    try {
      if (typeof image.decode === "function") await image.decode();
    } catch {
      // A successful load is still safe to reveal when decode() is unsupported
      // or rejects because the image came from the memory cache.
    }
    // Ignore a late decode from a previous image when src changes quickly.
    if ((image.currentSrc || image.src) !== loadedSource) return;
    setReady(true);
  };

  return (
    <img
      ref={imageRef}
      {...props}
      src={src}
      decoding={decoding}
      data-image-ready={ready ? "true" : "false"}
      className={cn(
        "transition-opacity duration-150",
        ready ? "opacity-100" : "opacity-0",
        className,
      )}
      onLoad={reveal}
      onError={(event) => {
        setReady(false);
        onError?.(event);
      }}
    />
  );
}
