import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { findPlatform } from "@/lib/platforms";
import {
  getSocialPreview,
  normalizeSocialHandle,
  type SocialPreview,
} from "@/lib/social-preview.functions";
import {
  formatSocialMetric,
  getSocialTileStyle,
  SOCIAL_LOGO_ICON,
  SOCIAL_LOGO_SQUARE,
  SOCIAL_TILE_SHELL,
  socialCtaFor,
  SocialTile,
} from "./SocialTile";
import { githubActivityWeekCount } from "@/lib/github-activity";
import { safeCssColor, safeMediaUrl, safeNavigationHref } from "@/lib/safe-url";
import { YouTubePlayer } from "./YouTubePlayer";
import { liveSocialRefetchInterval } from "./live-social-refetch";
import { DecodedImage } from "@/components/DecodedImage";

const LIVE_PLATFORM_KEYS = [
  "instagram",
  "twitter",
  "tiktok",
  "linkedin",
  "youtube",
  "github",
  "gitlab",
  "reddit",
  "bluesky",
  "mastodon",
] as const;
type LivePlatform = (typeof LIVE_PLATFORM_KEYS)[number];
const LIVE_PLATFORMS = new Set<string>(LIVE_PLATFORM_KEYS);

type ExpandedSocialCardProps = {
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
  w: number;
  h: number;
};

function useSocialPreview(
  platform: string,
  handle?: string,
  blockId?: string,
  liveEnabled = false,
) {
  const cleanHandle = handle ? normalizeSocialHandle(platform, handle) : "";
  const [settledHandle, setSettledHandle] = useState(cleanHandle);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettledHandle(cleanHandle), 700);
    return () => window.clearTimeout(timer);
  }, [cleanHandle]);

  return useQuery({
    queryKey: ["social-preview", liveEnabled ? blockId : "locked", platform, settledHandle],
    queryFn: () =>
      getSocialPreview({
        data: { platform: platform as LivePlatform, handle: settledHandle, blockId },
      }),
    enabled:
      liveEnabled &&
      !!blockId &&
      !!settledHandle &&
      settledHandle === cleanHandle &&
      LIVE_PLATFORMS.has(platform),
    staleTime: 15 * 60 * 1_000,
    retry: ["github", "linkedin", "reddit"].includes(platform) ? 2 : false,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    // Bright Data profile requests run as durable background snapshots. Keep
    // polling while the server resumes that snapshot or retries unfinished R2
    // media, for as long as the Instagram tile is mounted.
    refetchInterval: (query) =>
      liveSocialRefetchInterval(platform, query.state.data, query.state.dataUpdateCount),
  });
}

export function LiveYouTubeVideo({
  handle,
  blockId,
  liveEnabled = false,
}: {
  handle?: string;
  blockId?: string;
  liveEnabled?: boolean;
}) {
  const { data, isLoading } = useSocialPreview("youtube", handle, blockId, liveEnabled);
  const video = data?.latestVideo;

  if (video) {
    return <YouTubePlayer videoId={video.id} title={video.title} testId="youtube-latest-embed" />;
  }

  return (
    <div className="flex size-full flex-col items-center justify-center gap-1 bg-black px-4 text-center text-white/65">
      <span className="text-xs font-medium">
        {isLoading ? "Finding the latest video…" : "Latest video unavailable"}
      </span>
      {!!handle && !isLoading && <span className="text-[10px] text-white/40">@{handle}</span>}
    </div>
  );
}

export function LiveSocialTile({
  platform,
  handle,
  showGraph,
  fallbackFollowerCount,
  blockId,
  liveEnabled = false,
  ...tileProps
}: {
  platform: string;
  handle?: string;
  showGraph?: boolean;
  fallbackFollowerCount?: number | null;
  blockId?: string;
  liveEnabled?: boolean;
  url?: string;
  title?: string;
  description?: string;
  colorOverride?: string | null;
  material?: "gradient" | "transparent" | "glass" | "fill";
  ctaEnabled?: boolean;
  ctaLabel?: string;
  ctaBgColor?: string | null;
  ctaTextColor?: string | null;
  w: number;
  h: number;
}) {
  const { data } = useSocialPreview(platform, handle, blockId, liveEnabled);
  const followerCount = data?.followerCount ?? (liveEnabled ? fallbackFollowerCount : null) ?? null;

  const hasRoomForGitHubGraph =
    (tileProps.w >= 3 && tileProps.h >= 2) || (tileProps.w >= 2 && tileProps.h >= 3);
  if (platform === "github" && liveEnabled && showGraph && hasRoomForGitHubGraph) {
    return (
      <GitHubActivityTile
        handle={handle}
        followerCount={followerCount}
        contributions={data?.contributions ?? []}
        {...tileProps}
      />
    );
  }

  return (
    <SocialTile
      platformKey={platform}
      handle={handle}
      followerCount={followerCount}
      metricName={data?.metricName}
      {...tileProps}
    />
  );
}

function ContributionGrid({
  contributions,
  weeks,
}: {
  contributions: SocialPreview["contributions"];
  weeks: number;
}) {
  const cellCount = weeks * 7;
  const latest = [...contributions].sort((a, b) => a.date.localeCompare(b.date)).slice(-cellCount);
  const cells = [
    ...Array.from({ length: Math.max(0, cellCount - latest.length) }, () => ({
      date: "",
      level: 0,
    })),
    ...latest,
  ];
  const levels = ["rgba(15,23,42,0.07)", "#9be9a8", "#40c463", "#30a14e", "#216e39"];
  return (
    <div
      className="grid size-full min-h-0 min-w-0 grid-flow-col gap-x-[2px] gap-y-[4px] overflow-hidden"
      style={{
        gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))`,
        gridTemplateRows: "repeat(7, minmax(0, 1fr))",
      }}
      aria-label="Recent GitHub contribution activity"
      data-testid="github-activity-grid"
      data-weeks={weeks}
      data-live={contributions.length > 0 ? "true" : "false"}
    >
      {cells.map((cell, index) => (
        <span
          key={`${cell.date}-${index}`}
          className="size-full min-h-0 min-w-0 rounded-[2px]"
          style={{ background: levels[cell.level] ?? levels[0] }}
          title={cell.date ? `${cell.date}: level ${cell.level}` : "No activity"}
        />
      ))}
    </div>
  );
}

function GitHubActivityTile({
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
  contributions,
  w,
  h,
}: ExpandedSocialCardProps & {
  followerCount: number | null;
  contributions: SocialPreview["contributions"];
}) {
  const platform = findPlatform("github")!;
  const Icon = platform.icon;
  const href =
    safeNavigationHref(url || (handle ? `https://github.com/${handle}` : "https://github.com")) ||
    "https://github.com";
  const wide = w === 4 && h <= 2;
  const metric = formatSocialMetric(followerCount);
  const cta = ctaLabel || socialCtaFor("github");
  const buttonBg = safeCssColor(ctaBgColor) || safeCssColor(colorOverride) || platform.color;
  const buttonFg = safeCssColor(ctaTextColor) || platform.fg;
  const activityWeeks = githubActivityWeekCount(w, h);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open GitHub${handle ? ` @${handle}` : ""}`}
      className={`${SOCIAL_TILE_SHELL} min-w-0 p-4 ${wide ? "grid grid-cols-[minmax(0,0.29fr)_minmax(0,0.71fr)] gap-4" : "flex flex-col"}`}
      style={getSocialTileStyle("github", platform.color, colorOverride, material)}
      data-testid="github-activity-tile"
      data-layout={wide ? "horizontal" : "stacked"}
    >
      <div className="flex min-h-0 min-w-0 flex-col">
        <div
          className={SOCIAL_LOGO_SQUARE}
          style={{ background: platform.color, color: platform.fg }}
        >
          <Icon className={SOCIAL_LOGO_ICON} />
        </div>
        <div className="mt-4">
          <div className="truncate font-display text-lg leading-tight">{title || "GitHub"}</div>
          {handle && (
            <div className="mt-0.5 truncate text-xs text-card-foreground/60">@{handle}</div>
          )}
          {description && (
            <div className="mt-1 line-clamp-2 text-xs text-card-foreground/60">{description}</div>
          )}
        </div>
        {ctaEnabled && (
          <span
            className={`${wide ? "mt-auto" : "mt-7"} inline-flex w-fit items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-transform group-hover:scale-105`}
            style={{ background: buttonBg, color: buttonFg }}
          >
            {cta} {metric && <span className="opacity-80">{metric}</span>}
          </span>
        )}
      </div>
      <div
        className={`w-full min-w-0 max-w-full overflow-hidden ${wide ? "h-[46%] self-center" : "mb-5 mt-auto h-[29%]"}`}
      >
        <ContributionGrid contributions={contributions} weeks={activityWeeks} />
      </div>
    </a>
  );
}

export function LiveSocialGallery({
  platform,
  handle,
  fallbackUrls,
  fallbackFollowerCount,
  blockId,
  liveEnabled = false,
  url,
  title,
  description,
  colorOverride,
  material = "fill",
  ctaEnabled = true,
  ctaLabel,
  ctaBgColor,
  ctaTextColor,
  w,
  h,
}: Omit<ExpandedSocialCardProps, "handle"> & {
  platform: string;
  handle?: string;
  fallbackUrls: string[];
  fallbackFollowerCount?: number | null;
  blockId?: string;
  liveEnabled?: boolean;
}) {
  const { data } = useSocialPreview(platform, handle, blockId, liveEnabled);
  const p = findPlatform(platform);
  const Icon = p?.icon;
  const posts: Array<{ imageUrl: string; permalink?: string }> = data?.recentPosts?.length
    ? data.recentPosts
    : platform === "instagram"
      ? []
      : fallbackUrls.filter(Boolean).map((imageUrl) => ({ imageUrl }));
  const followerCount =
    data?.followerCount ??
    (liveEnabled && platform !== "instagram" ? fallbackFollowerCount : null) ??
    null;
  const wide = w === 4 && h <= 2;
  const href =
    safeNavigationHref(
      url || (handle && p?.urlBase ? `${p.urlBase}${handle}` : p?.urlBase || ""),
    ) || "#";
  const [failedImages, setFailedImages] = useState<Set<string>>(() => new Set());
  const postSignature = posts.map((post) => post.imageUrl).join("|");

  useEffect(() => {
    setFailedImages(new Set());
  }, [platform, handle, postSignature]);

  const shown = posts
    .filter((post) => {
      const imageUrl = safeMediaUrl(post.imageUrl);
      return Boolean(imageUrl && !failedImages.has(imageUrl));
    })
    .slice(0, wide ? 4 : 6);
  const hasPosts = shown.length > 0;
  const brand = p?.color ?? "#1f2937";
  const fg = p?.fg ?? "#fff";
  const cta = ctaLabel || socialCtaFor(platform);
  const buttonBg =
    safeCssColor(ctaBgColor) ||
    safeCssColor(colorOverride) ||
    (platform === "instagram" ? "#0095f6" : brand);
  const buttonFg = safeCssColor(ctaTextColor) || (platform === "instagram" ? "#fff" : fg);
  const metric = formatSocialMetric(followerCount);

  // Recent-post grids are designed for 4×2 and 4×4 cards. At compact sizes,
  // fall back to the standard social tile so 1×1 remains a centered logo and
  // 2×2 follows the same identity layout as every other platform.
  if (w < 4 || h < 2) {
    return (
      <SocialTile
        platformKey={platform}
        handle={handle}
        url={url}
        title={title}
        description={description}
        colorOverride={colorOverride}
        material={material}
        ctaEnabled={ctaEnabled}
        ctaLabel={ctaLabel}
        ctaBgColor={ctaBgColor}
        ctaTextColor={ctaTextColor}
        followerCount={followerCount}
        metricName={data?.metricName}
        w={w}
        h={h}
      />
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${p?.label || platform}${handle ? ` @${handle}` : ""}`}
      data-testid="social-gallery-tile"
      className={`${SOCIAL_TILE_SHELL} min-w-0 p-4 ${wide && hasPosts ? "grid grid-cols-[minmax(0,0.52fr)_minmax(0,0.48fr)] gap-4" : "flex flex-col"}`}
      style={getSocialTileStyle(platform, brand, colorOverride, material)}
    >
      <div className={`flex min-w-0 flex-col ${hasPosts ? "" : "h-full"}`}>
        {p && Icon && (
          <div className={SOCIAL_LOGO_SQUARE} style={{ background: brand, color: fg }}>
            <Icon className={SOCIAL_LOGO_ICON} />
          </div>
        )}
        <div className="mt-3">
          <div className="truncate font-display text-lg leading-tight">
            {title || p?.label || platform}
          </div>
          {handle && (
            <div className="mt-0.5 truncate text-xs text-card-foreground/60">@{handle}</div>
          )}
          {description && (
            <div className="mt-1 line-clamp-2 text-xs text-card-foreground/60">{description}</div>
          )}
        </div>
        {ctaEnabled && (
          <span
            className={`${hasPosts ? "mt-4" : "mt-auto"} inline-flex w-fit items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold`}
            style={{ background: buttonBg, color: buttonFg }}
          >
            {cta} {metric && <span className="opacity-80">{metric}</span>}
          </span>
        )}
      </div>
      {hasPosts && (
        <div
          data-testid="social-post-grid"
          className={`grid min-h-0 min-w-0 flex-1 gap-1.5 overflow-hidden ${
            shown.length === 1
              ? "grid-cols-1"
              : shown.length <= 4
                ? "grid-cols-2"
                : "grid-cols-2 @[280px]:grid-cols-3"
          } ${wide ? "" : "mt-3"}`}
        >
          {shown.map((post, index) => {
            const imageUrl = safeMediaUrl(post.imageUrl)!;
            return (
              <div
                key={`${imageUrl}-${index}`}
                className="min-h-0 min-w-0 overflow-hidden rounded-lg"
              >
                <DecodedImage
                  src={imageUrl}
                  alt=""
                  className="size-full object-cover"
                  loading={index < 4 ? "eager" : "lazy"}
                  decoding="async"
                  referrerPolicy="no-referrer"
                  onError={() => {
                    setFailedImages((current) => {
                      const next = new Set(current);
                      next.add(imageUrl);
                      return next;
                    });
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
    </a>
  );
}
