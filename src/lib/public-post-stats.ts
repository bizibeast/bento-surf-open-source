import { parsePublicHttpUrl } from "./safe-url";

export const PUBLIC_POST_STATS_PATH = "/api/tools/public-post-stats";
export const publicPostPlatforms = [
  "Instagram",
  "YouTube",
  "TikTok",
  "LinkedIn",
  "X",
  "Facebook",
  "Threads",
  "Reddit",
] as const;
export type PublicPostPlatform = (typeof publicPostPlatforms)[number];
export const publicPostMetricLabels = {
  views: "Views",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  reposts: "Reposts",
  reshares: "Reposts and quotes",
  quotes: "Quote posts",
  saves: "Saves",
  score: "Score",
  impressions: "Impressions",
  reach: "Accounts reached",
  unique_viewers: "Unique video viewers",
  watch_time_ms: "Video watch time (ms)",
  sends: "Sends",
  link_clicks: "Link clicks",
} as const;
export type PublicPostMetric = keyof typeof publicPostMetricLabels;
export type PostStatsEvidence = {
  kind:
    "platform_api" | "business_discovery" | "public_metadata" | "rendered_page" | "managed_public";
  label: string;
  observedAt: string;
  precision: "reported" | "rounded" | "unknown";
  definition: string;
  visibility: "public" | "workspace";
};
export type PublicPostStats = {
  platform: PublicPostPlatform;
  sourceUrl: string;
  retrievedAt: string;
  cached: boolean;
  status: "available" | "partial" | "unavailable";
  metrics: Array<{
    key: PublicPostMetric;
    label: string;
    value: number | null;
    availability?:
      "observed" | "not_public" | "not_returned" | "failed" | "unverified" | "requires_sign_in";
    evidence?: PostStatsEvidence;
  }>;
  scope?: "public" | "workspace";
  authorHandle?: string;
  accessNotes?: string[];
  requestedUrl?: string;
  extractionMethod?: string;
  note: string;
};
export const platformPostMetrics: Record<PublicPostPlatform, readonly PublicPostMetric[]> = {
  Instagram: ["views", "likes", "comments", "shares", "reposts", "saves"],
  YouTube: ["views", "likes", "comments"],
  TikTok: ["views", "likes", "comments", "shares", "saves"],
  LinkedIn: ["views", "likes", "comments", "reposts"],
  X: ["views", "likes", "comments", "reposts", "quotes", "saves"],
  Facebook: ["views", "likes", "comments", "shares"],
  Threads: ["views", "likes", "comments", "reposts", "quotes", "reshares", "shares"],
  Reddit: ["score", "comments"],
};

/** Only supported post URLs. No arbitrary-site fetches, credentials or query forwarding. */
export function normalizePublicPostUrl(
  value: unknown,
): { platform: PublicPostPlatform; url: string; short: boolean } | null {
  const url = parsePublicHttpUrl(typeof value === "string" ? value.trim() : value, {
    requireHttps: true,
    allowNonStandardPort: false,
  });
  if (!url) return null;
  let host = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  if (host === "twitter.com") host = "x.com";
  if (host === "threads.net") host = "threads.com";
  const path = url.pathname.replace(/\/+$/, "");
  const make = (platform: PublicPostPlatform, pathname: string, query = "", short = false) => ({
    platform,
    url: `https://${host}${pathname}${query}`,
    short,
  });
  if (host === "youtube.com" || host === "youtu.be") {
    const id =
      host === "youtu.be"
        ? path.slice(1)
        : url.searchParams.get("v") || path.match(/^\/(?:shorts|embed|live)\/([\w-]+)$/)?.[1];
    return id && /^[\w-]{11}$/.test(id)
      ? { platform: "YouTube", url: `https://www.youtube.com/watch?v=${id}`, short: false }
      : null;
  }
  if (host === "instagram.com") {
    const post = path.match(/^\/(?:[A-Za-z0-9._]{1,30}\/)?(p|reels?)\/([\w-]+)$/);
    if (post) return make("Instagram", `/${post[1]}/${post[2]}`);
  }
  if (host === "tiktok.com" && /^\/@[\w.]+\/(?:video|photo)\/\d+$/.test(path))
    return make("TikTok", path);
  if (["vm.tiktok.com", "vt.tiktok.com"].includes(host) && /^\/[\w-]+$/.test(path))
    return make("TikTok", path, "", true);
  if (host === "x.com" && /^\/(?:[\w]+|i\/web)\/status\/\d+$/.test(path)) return make("X", path);
  if (
    host === "linkedin.com" &&
    (/^\/posts\/[\w%-]+-activity-\d+[\w%-]*$/.test(path) ||
      /^\/feed\/update\/urn:li:(?:activity|share|ugcPost):\d+$/.test(path))
  )
    return make("LinkedIn", path);
  if (host === "threads.com" && /^\/@[\w.]+\/post\/[\w-]+$/.test(path))
    return make("Threads", path);
  if (host === "facebook.com") {
    if (/^\/(?:[\w.]+\/(?:posts|videos)|reel)\/[\w-]+$/.test(path)) return make("Facebook", path);
    const id = url.searchParams.get(path === "/watch" ? "v" : "story_fbid");
    if (["/watch", "/permalink.php", "/story.php"].includes(path) && id && /^\d+$/.test(id))
      return make("Facebook", path, `?${path === "/watch" ? "v" : "story_fbid"}=${id}`);
  }
  if (host === "reddit.com" && /^\/(?:r\/[\w]+\/)?comments\/[a-z0-9]+(?:\/[^/]+)?$/i.test(path))
    return make("Reddit", path);
  return null;
}
