import { useEffect, useMemo, useRef, useState } from "react";
import { Link as LinkIcon } from "lucide-react";
import { dominantColorFromRgba } from "@/lib/dominant-color";
import { detectPlatformFromUrl } from "@/lib/platform-detection";
import { safeCssColor, safeMediaUrl, safeNavigationHref } from "@/lib/safe-url";
import { tileMaterialStyle, type Material } from "./tile-material";

type Props = {
  href: string;
  favicon?: string | null;
  title: string;
  domain: string;
  description?: string;
  w: number;
  h: number;
  colorOverride?: string | null;
  material?: Material;
  ctaEnabled?: boolean;
  ctaLabel?: string;
  ctaBgColor?: string | null;
  ctaTextColor?: string | null;
  usePlatformIcon?: boolean;
};

function extractAccent(img: HTMLImageElement): string | null {
  try {
    const canvas = document.createElement("canvas");
    const size = 24;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, size, size);
    return dominantColorFromRgba(ctx.getImageData(0, 0, size, size).data);
  } catch {
    return null;
  }
}

export function FaviconTile({
  href,
  favicon,
  title,
  domain,
  description,
  w,
  h,
  colorOverride,
  material = "fill",
  ctaEnabled = true,
  ctaLabel = "Visit",
  ctaBgColor = null,
  ctaTextColor = null,
  usePlatformIcon = true,
}: Props) {
  const safeHref = safeNavigationHref(href, { allowRelative: true }) || "#";
  const accentImgRef = useRef<HTMLImageElement>(null);
  const [accent, setAccent] = useState<string | null>(null);
  const platformMatch = useMemo(
    () => (usePlatformIcon ? detectPlatformFromUrl(safeHref) : null),
    [safeHref, usePlatformIcon],
  );
  const platform = platformMatch?.platform ?? null;
  const PlatformIcon = platform?.icon;

  const googleFavicon = (() => {
    try {
      const u = new URL(safeHref);
      return `https://www.google.com/s2/favicons?sz=128&domain=${u.hostname}`;
    } catch {
      return null;
    }
  })();
  const duckFavicon = (() => {
    try {
      return `https://icons.duckduckgo.com/ip3/${new URL(safeHref).hostname}.ico`;
    } catch {
      return null;
    }
  })();
  const customFavicon = safeMediaUrl(favicon);
  const [imgSrc, setImgSrc] = useState<string | null>(
    platform ? null : customFavicon || googleFavicon,
  );

  useEffect(() => {
    setImgSrc(platform ? null : customFavicon || googleFavicon);
  }, [customFavicon, googleFavicon, platform]);

  useEffect(() => {
    if (colorOverride || platform) return;
    const img = accentImgRef.current;
    if (!img || !imgSrc) return;
    const handle = () => {
      const c = extractAccent(img);
      if (c) setAccent(c);
    };
    if (img.complete && img.naturalWidth) handle();
    else img.addEventListener("load", handle, { once: true });
    return () => img.removeEventListener("load", handle);
  }, [imgSrc, colorOverride, platform]);

  const platformAccent = platform?.color?.includes("gradient") ? "#e1306c" : platform?.color;
  const brand = safeCssColor(colorOverride) ?? platformAccent ?? safeCssColor(accent) ?? "#1f2937";
  const styles = tileMaterialStyle(material, brand);
  const subFg = "rgba(15,23,42,0.6)";

  const shell =
    "group @container block size-full overflow-hidden rounded-[28px] transition-all duration-300 will-change-transform " +
    "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.08)] " +
    "hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgba(0,0,0,0.06),0_16px_32px_-12px_rgba(0,0,0,0.12)]";

  const onImgError = () => {
    if (imgSrc === customFavicon && googleFavicon) setImgSrc(googleFavicon);
    else if ((imgSrc === customFavicon || imgSrc === googleFavicon) && duckFavicon)
      setImgSrc(duckFavicon);
    else setImgSrc(null);
  };

  const Favicon = () => {
    if (PlatformIcon) return <PlatformIcon className="size-[52%]" />;
    return imgSrc ? (
      <img
        src={imgSrc}
        alt=""
        loading="lazy"
        onError={onImgError}
        className="size-full object-cover"
      />
    ) : (
      <LinkIcon className="size-1/2" style={{ color: "rgba(15,23,42,0.6)" }} />
    );
  };

  const isSquare1 = w === 1 && h === 1;
  const isRow1 = h === 1 && w > 1;
  const logoSquare =
    "flex size-9 shrink-0 items-center justify-center rounded-[30%] overflow-hidden";
  const logoStyle: React.CSSProperties | undefined = platform
    ? { background: platform.color, color: platform.fg ?? "#fff" }
    : undefined;

  // Colour sampling needs an anonymous-CORS image, but the visible icon does
  // not. Keeping these separate means an R2/CDN image can still render even
  // when its response cannot be read by a canvas.
  const accentSampler =
    imgSrc && !platform && !colorOverride ? (
      <img
        ref={accentImgRef}
        src={imgSrc}
        alt=""
        crossOrigin="anonymous"
        aria-hidden
        className="hidden"
      />
    ) : null;

  if (isSquare1) {
    return (
      <a
        href={safeHref}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={title}
        className={`${shell} flex items-center justify-center p-3`}
        style={styles}
      >
        <div className={logoSquare} style={logoStyle}>
          <Favicon />
        </div>
        {accentSampler}
      </a>
    );
  }

  const ctaStyle: React.CSSProperties = {
    background: safeCssColor(ctaBgColor) || platform?.color || brand,
    color: safeCssColor(ctaTextColor) || platform?.fg || "#fff",
  };

  if (isRow1) {
    return (
      <a
        href={safeHref}
        target="_blank"
        rel="noopener noreferrer"
        className={`${shell} flex items-center gap-3 p-3`}
        style={styles}
      >
        <div className={logoSquare} style={logoStyle}>
          <Favicon />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-base leading-tight">{title}</div>
          <div className="truncate text-[11px]" style={{ color: subFg }}>
            {description || domain}
          </div>
        </div>
        {ctaEnabled && (
          <span
            className="ml-2 inline-flex shrink-0 items-center rounded-lg px-3 py-1.5 text-xs font-semibold"
            style={ctaStyle}
          >
            {ctaLabel}
          </span>
        )}
        {accentSampler}
      </a>
    );
  }

  return (
    <a
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer"
      className={`${shell} flex flex-col justify-between p-4`}
      style={styles}
    >
      <div className={logoSquare} style={logoStyle}>
        <Favicon />
      </div>
      <div className="min-w-0">
        {!description && !ctaEnabled && (
          <div className="truncate text-xs" style={{ color: subFg }}>
            {domain}
          </div>
        )}
        <div className="truncate font-display text-lg leading-tight">{title}</div>
        {ctaEnabled && !description && (
          <div className="mt-1 truncate text-xs" style={{ color: subFg }}>
            {domain}
          </div>
        )}
        {description && (
          <div className="mt-1 line-clamp-2 text-xs" style={{ color: subFg }}>
            {description}
          </div>
        )}
        {ctaEnabled && !description && (
          <span
            className="mt-3 inline-flex items-center rounded-lg px-3 py-1.5 text-xs font-semibold transition-transform group-hover:scale-105"
            style={ctaStyle}
          >
            {ctaLabel}
          </span>
        )}
      </div>
      {accentSampler}
    </a>
  );
}
