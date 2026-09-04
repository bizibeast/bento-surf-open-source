import { Mail, Calendar, Heart, MapPin, Quote as QuoteIcon, Phone, Briefcase } from "lucide-react";
import { useState } from "react";
import type { Database } from "@/integrations/supabase/types";
import { FaviconTile } from "./FaviconTile";
import { tileMaterialStyle, type Material } from "./tile-material";
import { CommerceTile } from "./CommerceTile";
import { findPlatform } from "@/lib/platforms";
import { LiveSocialGallery, LiveSocialTile, LiveYouTubeVideo } from "./LiveSocialBlock";
import { extractWidgetUrl, googleMapsEmbedUrl } from "@/lib/embeds";
import { PersistentMap } from "./PersistentMap";
import type { StoredMapView } from "@/lib/map.functions";
import {
  socialEmbedLabel,
  socialEmbedProviderFromContent,
  socialEmbedUrl,
  youtubeVideoIdFromUrl,
} from "@/lib/social-embeds";
import { YouTubePlayer } from "./YouTubePlayer";
import { DecodedImage } from "@/components/DecodedImage";
import {
  safeCssColor,
  safeMediaUrl,
  safeNavigationHref,
  safeSpotifyEmbedUrl,
} from "@/lib/safe-url";
import { capturePublicEmailCapture } from "@/lib/commerce-growth.functions";

type BlockType = Database["public"]["Enums"]["block_type"];
// Blocks intentionally persist provider-specific JSON. Keep the dynamic boundary
// centralized here; all URLs and embeds are still validated before rendering.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BlockContent = Record<string, any>;
export type Block = {
  id: string;
  type: BlockType;
  content: BlockContent;
  w: number;
  h: number;
  cover_url?: string | null;
};

type BlockRendererProps = {
  block: Block;
  mapInteractive?: boolean;
  onMapViewChange?: (view: StoredMapView) => void;
  liveSocialEnabled?: boolean;
  emailCaptureInteractive?: boolean;
};

// This is the canonical visual boundary for a Bento block. Both the editor and
// public profile render through this component, so clipping and corner geometry
// cannot depend on the different grid wrappers used by those two surfaces.
export const BLOCK_RENDER_SURFACE_CLASS = "size-full overflow-hidden rounded-[28px]";

// Uniform shell: all bento tiles share the same rounded surface + soft shadow.
const SHELL =
  "@container block size-full overflow-hidden rounded-[28px] transition-all duration-300 will-change-transform " +
  "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.08)] " +
  "hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgba(0,0,0,0.06),0_16px_32px_-12px_rgba(0,0,0,0.12)]";

const TINTS: Record<string, string> = {
  sky: "bg-[color:var(--color-tint-sky)] text-[color:var(--color-tint-sky-fg)]",
  rose: "bg-[color:var(--color-tint-rose)] text-[color:var(--color-tint-rose-fg)]",
  mint: "bg-[color:var(--color-tint-mint)] text-[color:var(--color-tint-mint-fg)]",
  lavender: "bg-[color:var(--color-tint-lavender)] text-[color:var(--color-tint-lavender-fg)]",
  amber: "bg-[color:var(--color-tint-amber)] text-[color:var(--color-tint-amber-fg)]",
  neutral: "bg-card text-card-foreground",
};
const tintClass = (t?: string) => TINTS[t ?? "neutral"] ?? TINTS.neutral;

const HEADING_LEVELS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;
type HeadingLevel = (typeof HEADING_LEVELS)[number];

const HEADING_SIZE_CLASSES: Record<HeadingLevel, string> = {
  h1: "text-4xl @[200px]:text-5xl",
  h2: "text-3xl @[200px]:text-4xl",
  h3: "text-2xl @[200px]:text-3xl",
  h4: "text-xl @[200px]:text-2xl",
  h5: "text-lg @[200px]:text-xl",
  h6: "text-base @[200px]:text-lg",
};

function headingLevel(value: unknown): HeadingLevel {
  return HEADING_LEVELS.includes(value as HeadingLevel) ? (value as HeadingLevel) : "h2";
}

function Shell({
  children,
  className = "",
  href,
  padded = true,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  href?: string;
  padded?: boolean;
  style?: React.CSSProperties;
}) {
  const cls = `${SHELL} ${padded ? "p-3 @[160px]:p-4 @[200px]:p-5" : ""} ${className}`;
  const safeHref = safeNavigationHref(href, { allowRelative: true });
  if (safeHref) {
    return (
      <a href={safeHref} target="_blank" rel="noopener noreferrer" className={cls} style={style}>
        {children}
      </a>
    );
  }
  return (
    <div className={cls} style={style}>
      {children}
    </div>
  );
}

function TextTag({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-full truncate rounded-2xl bg-white/88 px-4 py-2.5 font-display text-base leading-tight text-[#182131] shadow-lg backdrop-blur-md">
      {children}
    </div>
  );
}

export function BlockRenderer({
  block,
  mapInteractive,
  onMapViewChange,
  liveSocialEnabled = false,
  emailCaptureInteractive = false,
}: BlockRendererProps) {
  return (
    <div
      className={BLOCK_RENDER_SURFACE_CLASS}
      data-testid="block-render-surface"
      data-block-type={block.type}
      data-render-block-id={block.id}
    >
      <BlockContent
        block={block}
        mapInteractive={mapInteractive}
        onMapViewChange={onMapViewChange}
        liveSocialEnabled={liveSocialEnabled}
        emailCaptureInteractive={emailCaptureInteractive}
      />
    </div>
  );
}

function BlockContent({
  block,
  mapInteractive,
  onMapViewChange,
  liveSocialEnabled = false,
  emailCaptureInteractive = false,
}: BlockRendererProps) {
  const c = block.content || {};

  switch (block.type) {
    case "heading": {
      const level = headingLevel(c.headingLevel);
      const HeadingTag = level;
      const textColor = safeCssColor(c.textColor);
      const heading = (
        <HeadingTag
          className={`font-display leading-tight ${HEADING_SIZE_CLASSES[level]}`}
          data-heading-level={level}
          style={textColor ? { color: textColor } : undefined}
        >
          {c.text ?? "Your heading"}
        </HeadingTag>
      );
      if (c.shadow === false) {
        return (
          <div className="@container flex size-full items-center px-2 py-1 text-card-foreground">
            {heading}
          </div>
        );
      }
      return (
        <Shell className={tintClass(c.tint ?? "neutral")}>
          <div className="flex h-full items-center">{heading}</div>
        </Shell>
      );
    }

    case "section_title":
      return (
        <div className="flex h-full items-end px-2 pb-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-card-foreground/55">
            {c.text ?? "Section"}
          </span>
        </div>
      );

    case "note":
      return (
        <Shell className={tintClass(c.tint ?? "amber")}>
          <p className="text-sm leading-relaxed md:text-base">{c.text ?? "A short note…"}</p>
        </Shell>
      );

    case "quote": {
      const color = safeCssColor(c.color);
      const material: "fill" | "gradient" | "transparent" | "glass" = c.material ?? "fill";
      let style: React.CSSProperties | undefined;
      if (color) {
        if (material === "gradient") {
          style = {
            background: `linear-gradient(135deg, color-mix(in oklab, ${color} 30%, white), color-mix(in oklab, ${color} 78%, black 8%))`,
            color: "#0f172a",
          };
        } else if (material === "transparent") {
          style = {
            background: "transparent",
            color: "#0f172a",
            boxShadow: "inset 0 0 0 1px rgba(15,23,42,0.12)",
          };
        } else if (material === "glass") {
          style = {
            background: `linear-gradient(135deg, color-mix(in oklab, ${color} 12%, rgba(255,255,255,0.78)), rgba(255,255,255,0.38))`,
            color: "#0f172a",
            backdropFilter: "blur(22px) saturate(190%)",
          };
        } else {
          style = { background: `color-mix(in oklab, ${color} 20%, white)`, color: "#0f172a" };
        }
      }
      return (
        <Shell className={color ? "" : tintClass(c.tint ?? "lavender")} style={style}>
          <div className="flex h-full flex-col justify-between gap-3">
            <QuoteIcon className="size-5 opacity-50" />
            <p className="font-display text-2xl leading-snug">
              {c.text ?? c.title ?? "A favorite quote."}
            </p>
            {(c.author ?? c.description) && (
              <span className="text-xs opacity-70">- {c.author ?? c.description}</span>
            )}
          </div>
        </Shell>
      );
    }

    case "social_link": {
      const showInstagramGallery =
        liveSocialEnabled &&
        c.platform === "instagram" &&
        !!c.handle &&
        ((block.w >= 3 && block.h >= 2) || block.h >= 3);
      if (showInstagramGallery) {
        return (
          <LiveSocialGallery
            platform="instagram"
            handle={c.handle}
            blockId={block.id}
            liveEnabled={liveSocialEnabled}
            fallbackUrls={c.urls ?? []}
            fallbackFollowerCount={c.fallbackFollowerCount}
            url={c.url}
            title={c.title}
            description={c.description}
            colorOverride={c.color ?? null}
            material={c.material ?? "fill"}
            ctaEnabled={c.ctaEnabled ?? true}
            ctaLabel={c.ctaLabel}
            ctaBgColor={c.ctaBgColor ?? null}
            ctaTextColor={c.ctaTextColor ?? null}
            w={block.w}
            h={block.h}
          />
        );
      }
      return (
        <LiveSocialTile
          platform={c.platform ?? "twitter"}
          handle={c.handle}
          blockId={block.id}
          liveEnabled={liveSocialEnabled}
          url={c.url}
          title={c.title}
          description={c.description}
          colorOverride={c.color ?? null}
          material={c.material ?? "fill"}
          ctaEnabled={c.ctaEnabled ?? true}
          ctaLabel={c.ctaLabel}
          ctaBgColor={c.ctaBgColor ?? null}
          ctaTextColor={c.ctaTextColor ?? null}
          showGraph={c.showGraph ?? c.platform === "github"}
          fallbackFollowerCount={c.fallbackFollowerCount}
          w={block.w}
          h={block.h}
        />
      );
    }

    case "generic_link": {
      if (c.kind === "widget" || c.widgetUrl) {
        const widgetUrl = extractWidgetUrl(c.widgetUrl ?? c.url ?? "");
        return (
          <Shell padded={false} className="relative bg-card">
            {widgetUrl ? (
              <iframe
                src={widgetUrl}
                title={c.title || "Custom widget"}
                className="size-full border-0 bg-white"
                loading="lazy"
                sandbox="allow-scripts allow-forms allow-popups"
                referrerPolicy="strict-origin-when-cross-origin"
              />
            ) : (
              <div className="flex size-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                Add a valid HTTPS widget URL
              </div>
            )}
          </Shell>
        );
      }
      const href = c.url || "#";
      const favicon = c.customIcon || block.cover_url || c.image || c.favicon;
      const title = c.title || "Link";
      let domain = "";
      try {
        domain = new URL(href).hostname.replace(/^www\./, "");
      } catch {
        domain = (href || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "") || "link";
      }
      return (
        <FaviconTile
          href={href}
          favicon={favicon}
          title={title}
          domain={domain}
          description={c.description}
          w={block.w}
          h={block.h}
          colorOverride={c.color ?? null}
          material={c.material ?? "fill"}
          ctaEnabled={c.ctaEnabled ?? false}
          ctaLabel={c.ctaLabel ?? "Visit"}
          ctaBgColor={c.ctaBgColor ?? null}
          ctaTextColor={c.ctaTextColor ?? null}
          usePlatformIcon={!c.customIcon}
        />
      );
    }

    case "commerce": {
      return <CommerceTile content={c} w={block.w} h={block.h} shellClass={SHELL} />;
    }

    case "image":
      return (
        <Shell
          padded={false}
          href={c.linkUrl || undefined}
          className="relative overflow-hidden bg-muted"
        >
          {safeMediaUrl(c.url) ? (
            <DecodedImage
              src={safeMediaUrl(c.url)!}
              alt={c.alt ?? ""}
              className="size-full object-cover"
              loading={c.loading === "eager" ? "eager" : "lazy"}
              fetchPriority={c.fetchPriority === "high" ? "high" : undefined}
            />
          ) : (
            <div className="flex size-full items-center justify-center text-xs text-muted-foreground">
              Upload an image
            </div>
          )}
          {(c.title || c.description) && (
            <div className="absolute inset-x-0 bottom-0 flex flex-col items-start justify-end p-4 text-left">
              {c.title && <TextTag>{c.title}</TextTag>}
              {c.description && (
                <div className="mt-2 line-clamp-2 rounded-xl bg-black/55 px-3 py-2 text-xs text-white/90 backdrop-blur-md">
                  {c.description}
                </div>
              )}
            </div>
          )}
        </Shell>
      );

    case "image_gallery": {
      const urls: string[] = (Array.isArray(c.urls) ? c.urls : [])
        .map(safeMediaUrl)
        .filter((url): url is string => Boolean(url))
        .slice(0, 4);
      const p = c.platform ? findPlatform(c.platform) : null;
      if (!liveSocialEnabled && c.platform === "instagram" && c.handle) {
        return (
          <LiveSocialTile
            platform="instagram"
            handle={c.handle}
            blockId={block.id}
            liveEnabled={false}
            w={block.w}
            h={block.h}
          />
        );
      }
      if (liveSocialEnabled && p && c.handle && (c.livePosts || block.w === 4 || block.h === 4)) {
        return (
          <LiveSocialGallery
            platform={c.platform}
            handle={c.handle}
            blockId={block.id}
            liveEnabled={liveSocialEnabled}
            fallbackUrls={urls}
            fallbackFollowerCount={c.fallbackFollowerCount}
            w={block.w}
            h={block.h}
          />
        );
      }
      return (
        <div
          className={`${SHELL} flex flex-col overflow-hidden p-3`}
          style={p ? { background: `color-mix(in oklab, ${p.color} 10%, white)` } : undefined}
        >
          {p && (
            <div className="mb-2 flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <div
                  className="flex size-8 items-center justify-center rounded-md"
                  style={{ background: p.color, color: p.fg }}
                >
                  <p.icon className="size-4" />
                </div>
                {c.handle && <span className="text-xs font-medium">@{c.handle}</span>}
              </div>
              <span
                className="rounded-lg px-2.5 py-0.5 text-[10px] font-semibold"
                style={{ background: p.color, color: p.fg }}
              >
                Follow
              </span>
            </div>
          )}
          <div className="grid flex-1 grid-cols-2 gap-2">
            {urls.length > 0 ? (
              urls.map((u, i) => (
                <DecodedImage
                  key={i}
                  src={u}
                  alt=""
                  className="size-full rounded-2xl object-cover"
                  loading="lazy"
                />
              ))
            ) : (
              <div className="col-span-2 flex items-center justify-center text-xs text-muted-foreground">
                Add images
              </div>
            )}
          </div>
        </div>
      );
    }

    case "video": {
      if (c.liveProvider === "youtube") {
        if (!liveSocialEnabled) {
          return (
            <LiveSocialTile
              platform="youtube"
              handle={c.handle}
              blockId={block.id}
              liveEnabled={false}
              w={block.w}
              h={block.h}
            />
          );
        }
        return (
          <Shell padded={false} className="overflow-hidden bg-black">
            <LiveYouTubeVideo
              handle={c.handle}
              blockId={block.id}
              liveEnabled={liveSocialEnabled}
            />
          </Shell>
        );
      }
      const embedProvider = socialEmbedProviderFromContent(c);
      const twitterTheme = c.twitterTheme === "dark" ? "dark" : "light";
      const embedUrl = embedProvider
        ? socialEmbedUrl(embedProvider, String(c.originalUrl || c.url || ""), {
            twitterTheme,
          })
        : null;
      const youtubeVideoId =
        embedProvider === "youtube"
          ? youtubeVideoIdFromUrl(String(c.originalUrl || c.url || ""))
          : null;
      const videoUrl = embedProvider ? null : safeMediaUrl(c.url);
      return (
        <Shell
          padded={false}
          className={`relative overflow-hidden ${
            embedProvider === "twitter" && twitterTheme === "light" ? "bg-white" : "bg-black"
          }`}
        >
          {youtubeVideoId ? (
            <YouTubePlayer
              videoId={youtubeVideoId}
              title={socialEmbedLabel("youtube")}
              posterFit={block.w > block.h ? "cover" : "contain"}
            />
          ) : embedUrl ? (
            <iframe
              data-testid={embedProvider ? `${embedProvider}-embed` : "video-embed"}
              title={embedProvider ? socialEmbedLabel(embedProvider) : "Embedded video"}
              src={embedUrl}
              className="size-full border-0"
              allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture; web-share"
              allowFullScreen
              loading="lazy"
              referrerPolicy="strict-origin-when-cross-origin"
            />
          ) : videoUrl ? (
            <video
              data-testid="video-player"
              src={videoUrl}
              className="size-full object-cover"
              controls
              playsInline
              preload="metadata"
            />
          ) : (
            <div className="flex size-full items-center justify-center text-xs text-muted-foreground">
              Add a {embedProvider === "twitter" ? "post" : "video"} URL
            </div>
          )}
          {c.title && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-end p-4 text-left">
              <TextTag>{c.title}</TextTag>
            </div>
          )}
        </Shell>
      );
    }

    case "spotify": {
      const spotifyUrl = safeSpotifyEmbedUrl(c.url);
      return (
        <Shell padded={false} className="overflow-hidden">
          {spotifyUrl ? (
            <iframe
              src={spotifyUrl}
              title="Spotify player"
              className="size-full"
              allow="encrypted-media"
              sandbox="allow-scripts allow-same-origin allow-popups"
              referrerPolicy="strict-origin-when-cross-origin"
            />
          ) : (
            <div
              className={`flex size-full items-center justify-center text-sm ${tintClass("mint")}`}
            >
              Add a Spotify embed URL
            </div>
          )}
        </Shell>
      );
    }

    case "audio":
      return (
        <Shell className={tintClass("neutral")}>
          <div className="flex h-full flex-col justify-between gap-2">
            <div className="text-xs uppercase tracking-wider text-card-foreground/60">Audio</div>
            {safeMediaUrl(c.url) ? (
              <audio src={safeMediaUrl(c.url)!} controls className="w-full" />
            ) : (
              <div className="text-xs text-muted-foreground">Add an audio URL</div>
            )}
          </div>
        </Shell>
      );

    case "link_preview":
      return (
        <Shell href={c.url || "#"} className="bg-card">
          <div className="flex h-full gap-3">
            {safeMediaUrl(c.image) && (
              <DecodedImage
                src={safeMediaUrl(c.image)!}
                alt=""
                className="size-16 rounded-xl object-cover"
              />
            )}
            <div className="min-w-0">
              <div className="truncate text-xs text-card-foreground/60">{c.domain ?? "link"}</div>
              <div className="line-clamp-2 font-medium">{c.title ?? c.url}</div>
            </div>
          </div>
        </Shell>
      );

    case "map": {
      const mapLat = Number(c.mapLat);
      const mapLng = Number(c.mapLng);
      const mapZoom = Number(c.mapZoom);
      const mapLabel = String(c.title ?? c.label ?? "").trim();
      const hasStoredView =
        Number.isFinite(mapLat) &&
        Number.isFinite(mapLng) &&
        Number.isFinite(mapZoom) &&
        mapLat >= -90 &&
        mapLat <= 90 &&
        mapLng >= -180 &&
        mapLng <= 180 &&
        mapZoom >= 2 &&
        mapZoom <= 18;
      return (
        <Shell
          padded={false}
          className={`relative bg-[#e8eef4] ${mapInteractive ? "hover:!translate-y-0" : ""}`}
        >
          {hasStoredView ? (
            <div className="absolute inset-0 overflow-hidden">
              <PersistentMap
                mapLat={mapLat}
                mapLng={mapLng}
                mapZoom={mapZoom}
                interactive={!!mapInteractive}
                onViewChange={onMapViewChange}
              />
            </div>
          ) : c.location ? (
            <div className="absolute inset-0 overflow-hidden">
              <iframe
                title={`Map of ${c.location}`}
                src={googleMapsEmbedUrl(c.location)}
                className={`absolute left-0 w-full border-0 transition-[top,height] duration-200 ${
                  mapInteractive ? "top-0 h-full" : "-top-28 h-[calc(100%+7rem)]"
                }`}
                loading="lazy"
                tabIndex={mapInteractive === false ? -1 : 0}
                referrerPolicy="no-referrer-when-downgrade"
              />
            </div>
          ) : (
            <div className="flex size-full items-center justify-center text-sm text-muted-foreground">
              Add a location
            </div>
          )}
          {c.location && (
            <div
              data-testid="map-location-pin"
              className="pointer-events-none absolute left-1/2 top-1/2 z-[500] -translate-x-1/2 -translate-y-full drop-shadow-md"
            >
              <MapPin className="size-9 fill-[#ea4335] text-white" strokeWidth={1.75} />
            </div>
          )}
          {mapLabel && !mapInteractive && (
            <div
              data-testid="map-location-chip"
              className="pointer-events-none absolute bottom-4 left-4 z-[500] inline-flex w-fit max-w-[calc(100%-2rem)] rounded-xl bg-white/90 px-3 py-2 text-xs font-medium leading-none text-[#182131] shadow-md backdrop-blur-md"
            >
              <span className="truncate">{mapLabel}</span>
            </div>
          )}
        </Shell>
      );
    }

    case "contact": {
      const kind = c.kind ?? "email";
      const href =
        safeNavigationHref(kind === "phone" ? `tel:${c.value}` : `mailto:${c.value}`) || undefined;
      const Icon = kind === "phone" ? Phone : Mail;
      const label = c.label ?? (kind === "phone" ? "Call me" : "Email me");
      const ctaLabel = c.ctaLabel ?? (kind === "phone" ? "Call" : "Email");
      const domain = kind === "phone" ? "phone" : "email";
      const brand = safeCssColor(c.color) ?? (kind === "phone" ? "#0f766e" : "#475569");
      const material: Material =
        c.material === "gradient" ||
        c.material === "transparent" ||
        c.material === "glass" ||
        c.material === "fill"
          ? c.material
          : "fill";
      const tileStyle = tileMaterialStyle(material, brand);
      const logoStyle: React.CSSProperties = {
        background: brand,
        color: "#fff",
      };
      const ctaStyle: React.CSSProperties = {
        background: safeCssColor(c.ctaBgColor) ?? brand,
        color: safeCssColor(c.ctaTextColor) ?? "#fff",
      };
      const w = block.w,
        h = block.h;
      const isSquare1 = w === 1 && h === 1;
      const isRow1 = h === 1 && w > 1;
      const logoSquare = "flex size-9 shrink-0 items-center justify-center rounded-[30%]";
      const logoIcon = "size-[52%]";

      if (isSquare1) {
        return (
          <a
            href={href}
            aria-label={label}
            className={`${SHELL} flex items-center justify-center p-3`}
            style={tileStyle}
            data-testid="contact-tile"
            data-material={material}
          >
            <div className={logoSquare} style={logoStyle}>
              <Icon className={logoIcon} />
            </div>
          </a>
        );
      }
      if (isRow1) {
        return (
          <a
            href={href}
            className={`${SHELL} flex items-center gap-3 p-3`}
            style={tileStyle}
            data-testid="contact-tile"
            data-material={material}
          >
            <div className={logoSquare} style={logoStyle}>
              <Icon className={logoIcon} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-display text-base leading-tight">{label}</div>
              {c.value && <div className="truncate text-[11px] opacity-60">{c.value}</div>}
            </div>
            {(c.ctaEnabled ?? true) && (
              <span
                className="ml-2 inline-flex shrink-0 items-center rounded-lg px-3 py-1.5 text-xs font-semibold"
                style={ctaStyle}
              >
                {ctaLabel}
              </span>
            )}
          </a>
        );
      }
      return (
        <a
          href={href}
          className={`${SHELL} flex flex-col justify-between p-4`}
          style={tileStyle}
          data-testid="contact-tile"
          data-material={material}
        >
          <div className={logoSquare} style={logoStyle}>
            <Icon className={logoIcon} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-xs opacity-55">{c.value || domain}</div>
            <div className="truncate font-display text-lg leading-tight">{label}</div>
            {(c.ctaEnabled ?? true) && (
              <span
                className="mt-3 inline-flex items-center rounded-lg px-3 py-1.5 text-xs font-semibold"
                style={ctaStyle}
              >
                {ctaLabel}
              </span>
            )}
          </div>
        </a>
      );
    }

    case "email_capture": {
      const title = c.title ?? "Join my newsletter";
      const publicationHref = safeNavigationHref(c.url, { allowRelative: true });
      return (
        <Shell className={tintClass(c.tint ?? "sky")}>
          <div className="flex h-full flex-col justify-between gap-3">
            <Mail className="size-5" />
            <div>
              {publicationHref ? (
                <a href={publicationHref} className="font-display text-xl hover:underline">
                  {title}
                </a>
              ) : (
                <div className="font-display text-xl">{title}</div>
              )}
              <p className="text-xs opacity-70">{c.subtitle ?? "Get new posts in your inbox."}</p>
            </div>
            <EmailCaptureForm
              blockId={block.id}
              buttonLabel={c.buttonLabel ?? "Join"}
              interactive={emailCaptureInteractive}
            />
          </div>
        </Shell>
      );
    }

    case "booking":
      return (
        <Shell href={c.url || "#"} className={tintClass(c.tint ?? "lavender")}>
          <div className="flex h-full flex-col justify-between">
            <Calendar className="size-5" />
            <div>
              <div className="font-display text-xl">{c.title ?? "Book a call"}</div>
              <p className="text-xs opacity-70">{c.subtitle ?? "Pick a time that works."}</p>
            </div>
          </div>
        </Shell>
      );

    case "tip_jar":
      return (
        <Shell className={tintClass(c.tint ?? "rose")}>
          <div className="flex h-full flex-col justify-between gap-3">
            <Heart className="size-5" />
            <div>
              <div className="font-display text-xl">{c.title ?? "Support my work"}</div>
              <p className="text-xs opacity-70">{c.subtitle ?? "Buy me a coffee ☕"}</p>
            </div>
            <div className="flex gap-2">
              {[2, 5, 10].map((a) => (
                <button
                  key={a}
                  className="flex-1 rounded-lg bg-background/70 px-2 py-1.5 text-xs font-medium ring-1 ring-border hover:bg-background"
                >
                  ${a}
                </button>
              ))}
            </div>
          </div>
        </Shell>
      );

    case "experience": {
      const items: Array<{
        id: string;
        company: string;
        position?: string;
        from?: string;
        to?: string;
        logo?: string;
      }> = Array.isArray(c.items) ? c.items : [];
      const w = block.w,
        h = block.h;
      const area = w * h;

      const LogoBadge = ({ src, size = "size-10" }: { src?: string; size?: string }) => (
        <div
          className={`${size} shrink-0 overflow-hidden rounded-full bg-muted flex items-center justify-center ring-1 ring-border/60`}
        >
          {safeMediaUrl(src) ? (
            <DecodedImage
              src={safeMediaUrl(src)!}
              alt=""
              className="size-full object-cover"
              loading="lazy"
            />
          ) : (
            <Briefcase className="size-1/2 text-card-foreground/50" />
          )}
        </div>
      );

      // 1x1: compact - first logo + company name
      if (w === 1 && h === 1) {
        const first = items[0];
        return (
          <Shell className="bg-card">
            <div className="flex h-full flex-col items-start justify-between gap-2">
              <LogoBadge src={first?.logo} size="size-9" />
              <div className="min-w-0">
                <div className="truncate text-[11px] uppercase tracking-wider text-card-foreground/55">
                  Experience
                </div>
                <div className="truncate font-display text-sm leading-tight">
                  {first?.company ?? "Add role"}
                </div>
              </div>
            </div>
          </Shell>
        );
      }

      // Compute how many rows fit. Roughly ~64px per row.
      const maxRows = Math.max(
        1,
        Math.min(items.length, area >= 6 ? 5 : area >= 4 ? 4 : area >= 3 ? 3 : 2),
      );
      const shown = items.slice(0, maxRows);
      const remaining = items.length - shown.length;

      return (
        <Shell className="bg-card">
          <div className="flex h-full flex-col gap-2">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-card-foreground/55">
              <Briefcase className="size-3.5" />
              <span>Experience</span>
            </div>
            <ul className="flex flex-1 flex-col divide-y divide-border/50 overflow-hidden">
              {shown.length === 0 ? (
                <li className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                  Add your first role
                </li>
              ) : (
                shown.map((it) => (
                  <li
                    key={it.id}
                    className="flex min-w-0 items-center gap-3 py-2 first:pt-0 last:pb-0"
                  >
                    <LogoBadge src={it.logo} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-display text-[15px] font-normal leading-tight">
                        {it.company || "Company"}
                      </div>
                      {it.position && (
                        <div className="truncate text-xs text-card-foreground/60">
                          {it.position}
                        </div>
                      )}
                    </div>
                    {(it.from || it.to) && (
                      <div className="shrink-0 text-[11px] text-card-foreground/55 tabular-nums">
                        {it.from || ""}
                        {it.from || it.to ? " – " : ""}
                        {it.to || ""}
                      </div>
                    )}
                  </li>
                ))
              )}
            </ul>
            {remaining > 0 && (
              <div className="text-[11px] text-card-foreground/55">+ {remaining} more</div>
            )}
          </div>
        </Shell>
      );
    }

    default:
      return (
        <Shell className={tintClass("neutral")}>
          <div className="text-xs opacity-70">{block.type}</div>
        </Shell>
      );
  }
}

function EmailCaptureForm({
  blockId,
  buttonLabel,
  interactive,
}: {
  blockId: string;
  buttonLabel: string;
  interactive: boolean;
}) {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState(false);
  const [confirmationRequired, setConfirmationRequired] = useState(false);
  const [error, setError] = useState("");

  return (
    <div>
      <form
        className="flex gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!interactive) {
            setError("Preview only");
            return;
          }
          if (pending || success) return;
          setPending(true);
          setError("");
          try {
            const result = await capturePublicEmailCapture({ data: { blockId, email } });
            setEmail("");
            setConfirmationRequired(result.confirmationRequired);
            setSuccess(true);
          } catch (cause) {
            setError(
              cause instanceof Error && cause.message === "This form is not available."
                ? cause.message
                : "Could not subscribe. Please try again.",
            );
          } finally {
            setPending(false);
          }
        }}
      >
        <input
          aria-label="Email address"
          type="email"
          required={interactive}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          className="min-w-0 flex-1 rounded-lg bg-background/70 px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-foreground"
        />
        <button
          disabled={pending || success}
          className="rounded-lg bg-foreground px-3 py-2 text-xs font-medium text-background disabled:opacity-60"
        >
          {buttonLabel}
        </button>
      </form>
      <p className="mt-2 text-[10px] leading-4 opacity-65">
        Receive emails from this creator. Unsubscribe anytime.
      </p>
      <div aria-live="polite" className="mt-1 text-xs">
        {success
          ? confirmationRequired
            ? "Check your email to confirm."
            : "You're subscribed."
          : error}
      </div>
    </div>
  );
}
