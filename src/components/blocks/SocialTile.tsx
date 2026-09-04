import { findPlatform } from "@/lib/platforms";
import { Link as LinkIcon } from "lucide-react";
import { safeCssColor, safeNavigationHref } from "@/lib/safe-url";

/** Default CTA label per platform category. */
export function socialCtaFor(key: string): string {
  const p = findPlatform(key);
  if (!p) return "Visit";
  if (p.cta) return p.cta;
  switch (p.category) {
    case "video":
      return key === "youtube" ? "Subscribe" : "Watch";
    case "music":
      return "Listen";
    case "shop":
      return "Support";
    case "contact":
      return key === "email" || key === "phone" ? "Contact" : "Book";
    case "dev":
    case "design":
    case "writing":
      return "Follow";
    case "social":
      return "Follow";
    default:
      return "Visit";
  }
}

export const SOCIAL_TILE_SHELL =
  "group @container block size-full overflow-hidden rounded-[28px] transition-all duration-300 will-change-transform " +
  "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.08)] " +
  "hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgba(0,0,0,0.06),0_16px_32px_-12px_rgba(0,0,0,0.12)]";

export const SOCIAL_LOGO_SQUARE = "flex size-9 shrink-0 items-center justify-center rounded-[30%]";
export const SOCIAL_LOGO_ICON = "size-[52%]";

const SOCIAL_LIGHT_TINTS: Record<string, string> = {
  instagram: "#ffe4ef",
  youtube: "#ffe1e1",
  twitter: "#ececec",
  threads: "#ececec",
  tiktok: "#ececec",
  linkedin: "#e1efff",
  facebook: "#e4eeff",
  pinterest: "#ffe1e5",
  reddit: "#ffe6dc",
  bluesky: "#e1efff",
  mastodon: "#e8e8ff",
  discord: "#e8eaff",
  telegram: "#e1f3ff",
  whatsapp: "#dff7e6",
  snapchat: "#fffce0",
  youtube_embed: "#ffe1e1",
  vimeo: "#e1f4fc",
  twitch: "#efe6ff",
  loom: "#eae8ff",
  spotify: "#e0f5e6",
  apple_music: "#ffe1e5",
  soundcloud: "#ffe7d9",
  bandcamp: "#e6eef0",
  github: "#ececec",
  gitlab: "#ffe7d9",
  stackoverflow: "#fff0dd",
  codepen: "#ececec",
  producthunt: "#ffe5dd",
  dribbble: "#ffe1ec",
  behance: "#e1ecff",
  figma: "#f0e6ff",
  medium: "#ececec",
  substack: "#ffe5d6",
  devto: "#ececec",
  notion: "#ececec",
  gumroad: "#ffe7f8",
  etsy: "#ffe7d6",
  kofi: "#ffe3e2",
  bmac: "#fff8cc",
  paypal: "#dfeaff",
  patreon: "#ffe0e3",
  calendly: "#deebff",
  savvycal: "#ececec",
};

export function getSocialTileStyle(
  platformKey: string,
  brand: string,
  colorOverride?: string | null,
  material: "gradient" | "transparent" | "glass" | "fill" = "fill",
): React.CSSProperties {
  colorOverride = safeCssColor(colorOverride);
  const safeBrand =
    brand.startsWith("linear-gradient") || brand.startsWith("radial-gradient") ? "#888" : brand;
  const baseBg =
    colorOverride ??
    SOCIAL_LIGHT_TINTS[platformKey] ??
    `color-mix(in oklab, ${safeBrand} 12%, white)`;

  if (!colorOverride) return { background: baseBg, color: "#0f172a" };
  if (material === "gradient") {
    return {
      background: `linear-gradient(135deg, color-mix(in oklab, ${colorOverride} 28%, white), color-mix(in oklab, ${colorOverride} 78%, black 8%))`,
      color: "#0f172a",
    };
  }
  if (material === "transparent") {
    return {
      background: "transparent",
      color: "#0f172a",
      boxShadow: "inset 0 0 0 1px rgba(15,23,42,0.12)",
    };
  }
  if (material === "glass") {
    return {
      background: `linear-gradient(135deg, color-mix(in oklab, ${colorOverride} 10%, rgba(255,255,255,0.74)), rgba(255,255,255,0.36))`,
      color: "#0f172a",
      backdropFilter: "blur(22px) saturate(190%)",
    };
  }
  return { background: `color-mix(in oklab, ${colorOverride} 20%, white)`, color: "#0f172a" };
}

/** Derive a clean domain string from the platform's urlBase. */
function domainOf(urlBase?: string): string {
  if (!urlBase) return "";
  try {
    return new URL(urlBase).hostname.replace(/^www\./, "");
  } catch {
    return urlBase.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

export function SocialTile({
  platformKey,
  handle,
  url,
  title,
  description,
  colorOverride,
  material = "fill",
  ctaEnabled = true,
  ctaLabel,
  ctaBgColor,
  ctaTextColor,
  followerCount,
  metricName = "followers",
  w = 1,
  h = 1,
}: {
  platformKey: string;
  handle?: string;
  url?: string;
  title?: string;
  description?: string;
  colorOverride?: string | null;
  material?: "gradient" | "transparent" | "glass" | "fill";
  ctaEnabled?: boolean;
  ctaLabel?: string;
  ctaBgColor?: string | null;
  ctaTextColor?: string | null;
  followerCount?: number | null;
  metricName?: "followers" | "subscribers";
  w?: number;
  h?: number;
}) {
  const p = findPlatform(platformKey);
  const Icon = p?.icon ?? LinkIcon;
  const label = p?.label ?? "Link";
  const brand = p?.color ?? "#1f2937";
  const fg = p?.fg ?? "#fff";
  const href = safeNavigationHref(url || (handle && p?.urlBase ? p.urlBase + handle : "")) || "#";
  const cta = ctaLabel || socialCtaFor(platformKey);
  const metric = formatSocialMetric(followerCount);
  const domain = domainOf(p?.urlBase) || label.toLowerCase();
  const displayTitle = title || (handle ? `@${handle}` : label);
  const isInstagram = platformKey === "instagram";
  const btnBg =
    safeCssColor(ctaBgColor) || safeCssColor(colorOverride) || (isInstagram ? "#0095f6" : brand);
  const btnFg = safeCssColor(ctaTextColor) || (isInstagram ? "#fff" : fg);
  const tileStyle = getSocialTileStyle(platformKey, brand, colorOverride, material);

  const isSquare1 = w === 1 && h === 1;
  const isRow1 = h === 1 && w > 1;
  // Everything else (2x2, 2x4, 4x4, etc.) uses the full "card" layout.

  // 1x1 → tinted tile background with a centered rounded brand square holding
  // the platform icon, padded inside the tile (matches reference example).
  if (isSquare1) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${label}${handle ? ` @${handle}` : ""}`}
        className={`${SOCIAL_TILE_SHELL} relative`}
        style={tileStyle}
      >
        <div
          className={`${SOCIAL_LOGO_SQUARE} absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2`}
          style={{ background: brand, color: fg }}
        >
          <Icon className={`${SOCIAL_LOGO_ICON} block shrink-0`} />
        </div>
      </a>
    );
  }

  // 1xN row → brand square icon on the left, @handle text next to it.
  if (isRow1) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${SOCIAL_TILE_SHELL} flex items-center gap-3 p-3`}
        style={tileStyle}
      >
        <div className={SOCIAL_LOGO_SQUARE} style={{ background: brand, color: fg }}>
          <Icon className={SOCIAL_LOGO_ICON} />
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="truncate font-display text-base leading-tight"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {displayTitle}
          </div>
          {(description || handle) && (
            <div className="truncate text-[11px] text-card-foreground/60">
              {description || domain}
            </div>
          )}
        </div>
        {ctaEnabled && (
          <span
            className="ml-2 inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold"
            style={{ background: btnBg, color: btnFg }}
          >
            {cta}
            {metric && <span className="opacity-80">{metric}</span>}
          </span>
        )}
      </a>
    );
  }

  // 2x2, 2x4, 4x4 → full card: icon + domain + @username + Follow button.
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${SOCIAL_TILE_SHELL} flex flex-col justify-between p-4`}
      style={tileStyle}
    >
      <div className={SOCIAL_LOGO_SQUARE} style={{ background: brand, color: fg }}>
        <Icon className={SOCIAL_LOGO_ICON} />
      </div>
      <div className="min-w-0">
        {!description && !ctaEnabled && (
          <div className="truncate text-xs text-card-foreground/55">{domain}</div>
        )}
        <div className="truncate font-display text-lg leading-tight">{title || label}</div>
        {handle && <div className="mt-0.5 truncate text-xs text-card-foreground/60">@{handle}</div>}
        {description && (
          <div className="mt-1 line-clamp-2 text-xs text-card-foreground/60">{description}</div>
        )}
        {ctaEnabled && !description && (
          <span
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-transform group-hover:scale-105"
            style={{ background: btnBg, color: btnFg }}
            aria-label={`${cta}${metric ? ` ${metric} ${metricName}` : ""}`}
          >
            {cta}
            {metric && <span className="opacity-80">{metric}</span>}
          </span>
        )}
      </div>
    </a>
  );
}

export function formatSocialMetric(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return new Intl.NumberFormat("en", {
    notation: value >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1_000 ? 1 : 0,
  }).format(value);
}

/** Small chip-style social tile for very dense 1x1 placements. */
export function SocialChipTile({
  platformKey,
  handle,
  url,
}: {
  platformKey: string;
  handle?: string;
  url?: string;
}) {
  return <SocialTile platformKey={platformKey} handle={handle} url={url} w={1} h={1} />;
}
