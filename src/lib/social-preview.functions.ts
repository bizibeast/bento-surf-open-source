import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  enforceRequestRateLimit,
  readResponseBytes,
  readResponseText,
} from "./request-security.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { getMediaBucket, mediaObjectUrl } from "./r2-storage.server";
import { getPlan } from "./plan.server";
import { planHasEntitlement } from "./plans";
import {
  claimBrightDataAttempt,
  fetchRenderedSocialHtml,
  runSocialPreviewSource,
  SocialPreviewSourceError,
} from "./social-preview-reliability.server";

const supportedPlatform = z.enum([
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
]);

export type SocialPreview = {
  followerCount: number | null;
  metricName: "followers" | "subscribers";
  recentPosts: Array<{ imageUrl: string; permalink?: string }>;
  contributions: Array<{ date: string; level: number }>;
  latestVideo: {
    id: string;
    title: string;
    thumbnailUrl: string | null;
    permalink: string;
  } | null;
  available: boolean;
  /**
   * The last good preview remains usable while a provider snapshot or media
   * cache is still being completed. Clients use this to keep polling without
   * replacing the card with an empty state.
   */
  refreshing?: boolean;
};

const EMPTY_PREVIEW: SocialPreview = {
  followerCount: null,
  metricName: "followers",
  recentPosts: [],
  contributions: [],
  latestVideo: null,
  available: false,
  refreshing: false,
};

const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const INSTAGRAM_CACHE_TTL_MS = DEFAULT_CACHE_TTL_MS;
const TWITTER_CACHE_TTL_MS = DEFAULT_CACHE_TTL_MS;
const LINKEDIN_CACHE_TTL_MS = DEFAULT_CACHE_TTL_MS;
const REDDIT_CACHE_TTL_MS = DEFAULT_CACHE_TTL_MS;
const INSTAGRAM_RETRY_TTL_MS = 60_000;
const INSTAGRAM_SNAPSHOT_POLL_MS = 8_000;
const INSTAGRAM_FAILED_REFRESH_RETRY_MS = 8_000;
const INSTAGRAM_SOURCE_REUSE_MS = 15 * 60 * 1_000;
const INSTAGRAM_SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1_000;
const STALE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const FREE_RETRY_DELAYS_MS = [60_000, 15 * 60_000, 2 * 60 * 60_000] as const;
const REFRESH_LEASE_MS = 15_000;
const INSTAGRAM_REFRESH_LEASE_MS = 90_000;
const INSTAGRAM_CACHE_VERSION = "worker-free-first-v12";
const GITHUB_CACHE_VERSION = "activity-v3";
const TWITTER_CACHE_VERSION = "public-profile-v1";
const YOUTUBE_CACHE_VERSION = "latest-video-v1";
const LINKEDIN_CACHE_VERSION = "worker-free-first-v2";
const REDDIT_CACHE_VERSION = "public-html-v3";
const BRIGHT_DATA_INSTAGRAM_PROFILE_DATASET_ID = "gd_l1vikfch901nx3by4";
const BRIGHT_DATA_LINKEDIN_PROFILE_DATASET_ID = "gd_l1viktl72bvl7bjuj0";
const INSTAGRAM_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const MAX_INSTAGRAM_IMAGE_BYTES = 10 * 1024 * 1024;
const cache = new Map<string, { expiresAt: number; value: SocialPreview }>();

const socialPreviewSchema = z.object({
  followerCount: z.number().nullable(),
  metricName: z.enum(["followers", "subscribers"]),
  recentPosts: z.array(z.object({ imageUrl: z.string(), permalink: z.string().optional() })),
  contributions: z.array(z.object({ date: z.string(), level: z.number() })),
  latestVideo: z
    .object({
      id: z.string(),
      title: z.string(),
      thumbnailUrl: z.string().nullable(),
      permalink: z.string(),
    })
    .nullable()
    .default(null),
  available: z.boolean(),
  refreshing: z.boolean().optional().default(false),
});

type InstagramSource = {
  followerCount: number;
  recentPosts: Array<{ shortcode: string; imageUrl: string }>;
};

const brightDataSnapshotIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);

const instagramRefreshStateSchema = z.object({
  snapshotId: brightDataSnapshotIdSchema.optional(),
  snapshotStartedAt: z.number().nonnegative().optional(),
  source: z
    .object({
      followerCount: z.number().int().nonnegative(),
      recentPosts: z.array(
        z.object({
          shortcode: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
          imageUrl: z.string().url(),
        }),
      ),
    })
    .optional(),
  sourceFetchedAt: z.number().nonnegative().optional(),
});

type InstagramRefreshState = z.infer<typeof instagramRefreshStateSchema>;

const refreshStateSchema = z.object({
  nextAttempt: z.number().int().min(1).max(4),
  nextRetryAt: z.number().nonnegative(),
  lastSource: z.string().max(64).optional(),
});

export type SocialPreviewRefreshState = z.infer<typeof refreshStateSchema>;

type PersistentPreview = {
  value: SocialPreview;
  expiresAt: number;
  staleUntil: number;
  instagramRefresh?: InstagramRefreshState;
  refresh?: SocialPreviewRefreshState;
};

export function socialPreviewRefreshWindow(
  platform: z.infer<typeof supportedPlatform>,
  now: number,
) {
  const leaseMs =
    platform === "instagram"
      ? INSTAGRAM_REFRESH_LEASE_MS
      : platform === "linkedin"
        ? 60_000
        : REFRESH_LEASE_MS;
  return {
    expiresAt: new Date(now + leaseMs).toISOString(),
    staleUntil: new Date(now + STALE_CACHE_TTL_MS).toISOString(),
  };
}

async function readPersistentPreview(key: string): Promise<PersistentPreview | null> {
  const { data, error } = await supabaseAdmin
    .from("social_preview_cache")
    .select("preview, expires_at, stale_until")
    .eq("cache_key", key)
    .maybeSingle();
  if (error || !data) return null;
  const parsed = socialPreviewSchema.safeParse(data.preview);
  const rawPreview =
    data.preview && typeof data.preview === "object" && !Array.isArray(data.preview)
      ? (data.preview as Record<string, unknown>)
      : null;
  const refresh = instagramRefreshStateSchema.safeParse(rawPreview?._instagramRefresh);
  const genericRefresh = refreshStateSchema.safeParse(rawPreview?._refresh);
  const expiresAt = Date.parse(data.expires_at);
  const staleUntil = Date.parse(data.stale_until);
  if (!parsed.success || !Number.isFinite(expiresAt) || !Number.isFinite(staleUntil)) return null;
  return {
    value: parsed.data,
    expiresAt,
    staleUntil,
    instagramRefresh: refresh.success ? refresh.data : undefined,
    refresh: genericRefresh.success ? genericRefresh.data : undefined,
  };
}

async function writePersistentPreview(
  key: string,
  platform: z.infer<typeof supportedPlatform>,
  handle: string,
  value: SocialPreview,
  options: {
    cacheTtlMs?: number;
    instagramRefresh?: InstagramRefreshState;
    refresh?: SocialPreviewRefreshState;
    staleUntil?: number;
  } = {},
) {
  const now = Date.now();
  const cacheTtl =
    options.cacheTtlMs ??
    (platform === "instagram"
      ? INSTAGRAM_CACHE_TTL_MS
      : platform === "twitter"
        ? TWITTER_CACHE_TTL_MS
        : platform === "linkedin"
          ? LINKEDIN_CACHE_TTL_MS
          : platform === "reddit"
            ? REDDIT_CACHE_TTL_MS
            : DEFAULT_CACHE_TTL_MS);
  const preview = {
    ...value,
    ...(options.instagramRefresh ? { _instagramRefresh: options.instagramRefresh } : {}),
    ...(options.refresh ? { _refresh: options.refresh } : {}),
  };
  const { error } = await supabaseAdmin.from("social_preview_cache").upsert({
    cache_key: key,
    platform,
    handle,
    preview: preview as unknown as Json,
    fetched_at: new Date(now).toISOString(),
    expires_at: new Date(now + cacheTtl).toISOString(),
    stale_until: new Date(options.staleUntil ?? now + STALE_CACHE_TTL_MS).toISOString(),
  });
  if (error) console.warn("Could not persist social preview cache", { platform, handle });
}

async function createInitialRefreshLease(
  key: string,
  platform: z.infer<typeof supportedPlatform>,
  handle: string,
) {
  const now = Date.now();
  const leaseUntil = new Date(
    now +
      (platform === "instagram"
        ? INSTAGRAM_REFRESH_LEASE_MS
        : platform === "linkedin"
          ? 60_000
          : REFRESH_LEASE_MS),
  ).toISOString();
  const { data, error } = await supabaseAdmin
    .from("social_preview_cache")
    .insert({
      cache_key: key,
      platform,
      handle,
      preview: { ...EMPTY_PREVIEW, refreshing: true } as unknown as Json,
      fetched_at: new Date(now).toISOString(),
      expires_at: leaseUntil,
      stale_until: leaseUntil,
    })
    .select("cache_key")
    .maybeSingle();
  return !error && !!data;
}

async function claimExpiredRefresh(
  key: string,
  platform: z.infer<typeof supportedPlatform>,
  now: number,
  staleUntil: number,
) {
  const refreshWindow = socialPreviewRefreshWindow(platform, now);
  const requestedLeaseUntil = Date.parse(refreshWindow.expiresAt);
  const staleAvailable = staleUntil > now;
  const leaseUntil = staleAvailable
    ? Math.min(staleUntil, requestedLeaseUntil)
    : requestedLeaseUntil;
  const { data, error } = await supabaseAdmin
    .from("social_preview_cache")
    .update({
      expires_at: new Date(leaseUntil).toISOString(),
      // Never serve a successful stale value past its original deadline.
      stale_until: new Date(staleAvailable ? staleUntil : leaseUntil).toISOString(),
      ...(staleAvailable ? {} : { preview: EMPTY_PREVIEW as unknown as Json }),
    })
    .eq("cache_key", key)
    .lte("expires_at", new Date(now).toISOString())
    .select("cache_key")
    .maybeSingle();
  return !error && !!data;
}

async function waitForInitialPreview(key: string) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const preview = await readPersistentPreview(key);
    if (preview?.value.available) return preview;
  }
  return null;
}

export function normalizeSocialHandle(platform: string, value: string) {
  let candidate = value.trim();
  try {
    const withProtocol = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
    const url = new URL(withProtocol);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const platformHosts: Record<string, string[]> = {
      instagram: ["instagram.com"],
      youtube: ["youtube.com", "m.youtube.com", "youtu.be"],
      github: ["github.com"],
      twitter: ["x.com", "twitter.com"],
      tiktok: ["tiktok.com"],
      linkedin: ["linkedin.com"],
      reddit: ["reddit.com"],
      gitlab: ["gitlab.com"],
    };
    if (platformHosts[platform]?.includes(host)) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (platform === "youtube" && parts[0] === "channel" && parts[1]) candidate = parts[1];
      else if (platform === "youtube" && ["c", "user"].includes(parts[0]) && parts[1]) {
        candidate = parts[1];
      } else if (platform === "linkedin" && ["in", "company"].includes(parts[0]) && parts[1]) {
        candidate = parts[1];
      } else if (platform === "reddit" && parts[0]?.toLowerCase() === "user" && parts[1]) {
        candidate = parts[1];
      } else if (parts[0]) candidate = parts[0];
    }
  } catch {
    // Plain handles are expected and do not need URL parsing.
  }
  return candidate
    .replace(/^@/, "")
    .replace(/[/?#].*$/, "")
    .trim()
    .slice(0, 100);
}

async function fetchJson(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "bento.surf-social-preview", ...headers },
    signal: AbortSignal.timeout(6_000),
  });
  if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
  // Upstream schemas vary by social platform and are validated by each adapter below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return JSON.parse(await readResponseText(response, 2 * 1024 * 1024)) as any;
}

export function parseGitHubContributions(html: string) {
  const contributions = new Map<string, number>();
  for (const tag of html.match(/<[^>]+data-date="[^"]+"[^>]*>/g) ?? []) {
    const date = tag.match(/data-date="([^"]+)"/)?.[1];
    const level = Number(tag.match(/data-level="([0-4])"/)?.[1] ?? 0);
    if (date) contributions.set(date, Math.max(level, contributions.get(date) ?? 0));
  }
  return [...contributions.entries()]
    .map(([date, level]) => ({ date, level }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-371);
}

export async function fetchGitHubPreview(handle: string): Promise<SocialPreview> {
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(handle)) {
    throw new Error("Invalid GitHub username");
  }

  // The public profile API is rate-limited per Worker egress IP. Contribution
  // data comes from a separate public endpoint, so a follower-count failure
  // must never blank an otherwise valid activity chart.
  const [contributionResult, profileResult] = await Promise.allSettled([
    fetch(`https://github.com/users/${encodeURIComponent(handle)}/contributions`, {
      headers: { Accept: "text/html", "User-Agent": "bento.surf-social-preview" },
      signal: AbortSignal.timeout(12_000),
    }),
    fetchJson(`https://api.github.com/users/${encodeURIComponent(handle)}`),
  ]);

  if (contributionResult.status === "rejected") throw contributionResult.reason;
  const contributionResponse = contributionResult.value;
  if (!contributionResponse.ok) {
    throw new Error(`GitHub contributions returned ${contributionResponse.status}`);
  }
  const contributions = parseGitHubContributions(
    await readResponseText(contributionResponse, 2 * 1024 * 1024),
  );
  if (contributions.length === 0) {
    throw new Error("GitHub returned an invalid contribution calendar");
  }
  const profile = profileResult.status === "fulfilled" ? profileResult.value : null;
  return {
    ...EMPTY_PREVIEW,
    followerCount: typeof profile?.followers === "number" ? profile.followers : null,
    contributions,
    available: true,
  };
}

type BrightDataSnapshot = {
  snapshot_id?: unknown;
  status?: unknown;
};

function instagramShortcode(permalink: unknown) {
  if (typeof permalink !== "string") return null;
  try {
    return new URL(permalink).pathname.split("/").filter(Boolean).at(-1) ?? null;
  } catch {
    return null;
  }
}

function nonNegativeInteger(value: unknown) {
  const normalized =
    typeof value === "string" && /^[\d,\s]+$/.test(value)
      ? Number(value.replaceAll(",", "").trim())
      : value;
  return typeof normalized === "number" && Number.isSafeInteger(normalized) && normalized >= 0
    ? normalized
    : null;
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    const record = objectValue(value);
    const nested = record?.url ?? record?.src ?? record?.image_url ?? record?.display_url;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  return null;
}

function firstInstagramImage(post: Record<string, unknown>) {
  const photos = Array.isArray(post.photos) ? post.photos : [];
  const images = Array.isArray(post.images) ? post.images : [];
  const carousel = Array.isArray(post.carousel_media) ? post.carousel_media : [];
  return firstString(
    post.image_url,
    post.display_url,
    post.thumbnail_url,
    post.thumbnail,
    post.picture_url,
    post.media_url,
    photos[0],
    images[0],
    carousel[0],
  );
}

export function parseBrightDataInstagramSource(value: unknown): InstagramSource | null {
  const container = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const records = Array.isArray(value)
    ? value
    : Array.isArray(container?.data)
      ? container.data
      : Array.isArray(container?.records)
        ? container.records
        : null;
  // Snapshot delivery can add provider-owned envelopes (for example
  // `result.data`) around the documented record array. Walk a small, bounded
  // portion of the JSON tree so those wrappers cannot blank a valid profile.
  const candidates: Record<string, unknown>[] = [];
  const visit = (candidate: unknown, depth: number) => {
    if (depth > 5 || candidates.length >= 2_000) return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    const record = objectValue(candidate);
    if (!record) return;
    candidates.push(record);
    for (const nested of Object.values(record)) {
      if (nested && typeof nested === "object") visit(nested, depth + 1);
    }
  };
  visit(records ?? value, 0);
  const followerEntry = candidates
    .map((record) => {
      const nestedFollowers = objectValue(record.edge_followed_by);
      return {
        record,
        count: nonNegativeInteger(
          record.followers ??
            record.followers_count ??
            record.follower_count ??
            record.account_followers ??
            nestedFollowers?.count,
        ),
      };
    })
    .find((entry) => entry.count !== null);
  const followerCount = followerEntry?.count ?? null;
  if (followerCount === null) return null;
  const profile = followerEntry?.record ?? candidates[0];
  if (!profile) return null;
  const nestedPosts = Array.isArray(profile.posts)
    ? profile.posts
    : Array.isArray(profile.recent_posts)
      ? profile.recent_posts
      : Array.isArray(profile.latest_posts)
        ? profile.latest_posts
        : [];
  // Profile collection returns one profile row. The recent-post discovery
  // endpoint returns one row per post and includes the profile's follower
  // count on those rows. Support both shapes so an in-flight provider schema
  // migration cannot blank an otherwise public tile.
  const posts = nestedPosts.length > 0 ? nestedPosts : candidates;
  const recentPosts = [...posts]
    .filter((post): post is Record<string, unknown> => !!post && typeof post === "object")
    .sort((a, b) =>
      String(b.datetime ?? b.date_posted ?? b.timestamp ?? "").localeCompare(
        String(a.datetime ?? a.date_posted ?? a.timestamp ?? ""),
      ),
    )
    .map((post) => {
      const directShortcode =
        typeof post.shortcode === "string" && post.shortcode ? post.shortcode : null;
      return {
        shortcode:
          directShortcode ?? instagramShortcode(post.url ?? post.post_url ?? post.permalink),
        imageUrl: firstInstagramImage(post),
      };
    })
    .filter(
      (post): post is { shortcode: string; imageUrl: string } =>
        typeof post.shortcode === "string" &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(post.shortcode) &&
        typeof post.imageUrl === "string" &&
        post.imageUrl.length > 0,
    )
    .slice(0, 6);
  return { followerCount, recentPosts };
}

function jsonScriptPayloads(html: string) {
  const payloads: unknown[] = [];
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    const text = match[1].trim();
    if (!text || (text[0] !== "{" && text[0] !== "[")) continue;
    try {
      payloads.push(JSON.parse(text));
    } catch {
      // Third-party pages contain non-JSON scripts; only embedded JSON matters.
    }
    if (payloads.length >= 100) break;
  }
  return payloads;
}

function htmlText(value: string) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&nbsp;", " ");
}

export function parseInstagramPublicSource(html: string): InstagramSource | null {
  for (const payload of jsonScriptPayloads(html)) {
    const parsed = parseBrightDataInstagramSource(payload);
    if (parsed) return parsed;
  }

  const structured = html.match(
    /["'](?:follower_count|followers_count|followers)["']\s*:\s*["']?([\d,]+)/i,
  )?.[1];
  const edgeCount = html.match(
    /["']edge_followed_by["']\s*:\s*\{[^}]{0,200}["']count["']\s*:\s*([\d,]+)/i,
  )?.[1];
  const descriptions = [...html.matchAll(/<meta\b[^>]*>/gi)]
    .map((match) => htmlText(match[0]))
    .filter((tag) => /(?:description|og:description)/i.test(tag));
  const descriptionCount = descriptions
    .map((tag) => tag.match(/\b([\d,.]+\s*[kmb]?)\s+followers?\b/i)?.[1])
    .map(compactSocialCount)
    .find((count) => count !== null);
  const followerCount =
    compactSocialCount(structured) ?? compactSocialCount(edgeCount) ?? descriptionCount ?? null;
  return followerCount === null ? null : { followerCount, recentPosts: [] };
}

export function parseTikTokFollowerCount(html: string, expectedHandle: string) {
  for (const payload of jsonScriptPayloads(html)) {
    const stack: unknown[] = [payload];
    let visited = 0;
    while (stack.length && visited < 20_000) {
      const candidate = stack.pop();
      visited += 1;
      if (Array.isArray(candidate)) {
        stack.push(...candidate);
        continue;
      }
      const record = objectValue(candidate);
      if (!record) continue;
      const user = objectValue(record.user);
      const stats = objectValue(record.stats) ?? objectValue(record.authorStats);
      const uniqueId = user?.uniqueId ?? record.uniqueId;
      if (typeof uniqueId === "string" && uniqueId.toLowerCase() === expectedHandle.toLowerCase()) {
        const count = nonNegativeInteger(stats?.followerCount ?? record.followerCount);
        if (count !== null) return count;
      }
      stack.push(...Object.values(record));
    }
  }
  return null;
}

export function parseRedditPublicFollowerCount(html: string) {
  for (const payload of jsonScriptPayloads(html)) {
    const count = parseRedditFollowerCount(payload);
    if (count !== null) return count;
  }
  return compactSocialCount(
    html.match(/["'](?:subscribers|followers_count|follower_count)["']\s*:\s*([\d,]+)/i)?.[1],
  );
}

function compactSocialCount(value: unknown) {
  const exact = nonNegativeInteger(value);
  if (exact !== null) return exact;
  if (typeof value !== "string") return null;
  const match = value
    .replaceAll("\u00a0", " ")
    .trim()
    .match(/^([\d,.]+)\s*([kmb])\+?$/i);
  if (!match) return null;
  const amount = Number(match[1].replaceAll(",", ""));
  const multiplier = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[
    match[2].toLowerCase() as "k" | "m" | "b"
  ];
  const count = Math.round(amount * multiplier);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export function parseBrightDataLinkedInFollowerCount(value: unknown) {
  const candidates: Record<string, unknown>[] = [];
  const visit = (candidate: unknown, depth: number) => {
    if (depth > 4 || candidates.length >= 500) return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    const record = objectValue(candidate);
    if (!record) return;
    candidates.push(record);
    for (const nested of Object.values(record)) {
      if (nested && typeof nested === "object") visit(nested, depth + 1);
    }
  };
  visit(value, 0);
  for (const record of candidates) {
    const count = compactSocialCount(
      record.followers ??
        record.followers_count ??
        record.follower_count ??
        record.number_of_followers,
    );
    if (count !== null) return count;
  }
  return null;
}

export function parseLinkedInPublicFollowerCount(html: string) {
  const structured = html.match(
    /["'](?:followerCount|followers_count|number_of_followers)["']\s*:\s*["']?([\d,.]+\s*[kmb]?)/i,
  )?.[1];
  const structuredCount = compactSocialCount(structured);
  if (structuredCount !== null) return structuredCount;

  const prioritySections = [
    ...html.matchAll(
      /<(?:meta|h1|h2|h3|div|span)[^>]*(?:description|top-card|first-subline)[^>]*>?.{0,1_500}/gi,
    ),
  ].map((match) => match[0]);
  for (const section of [...prioritySections, html.slice(0, 500_000)]) {
    const match = section.match(/\b([\d,.]+\s*[kmb]?)\+?\s+followers?\b/i);
    const count = compactSocialCount(match?.[1]);
    if (count !== null) return count;
  }
  return null;
}

export function parseRedditFollowerCount(value: unknown) {
  const root = objectValue(value);
  const data = objectValue(root?.data) ?? root;
  const profile = objectValue(data?.subreddit);
  return compactSocialCount(
    profile?.subscribers ?? data?.followers ?? data?.followers_count ?? data?.follower_count,
  );
}

function brightDataSnapshotId(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const snapshotId = (value as BrightDataSnapshot).snapshot_id;
  return brightDataSnapshotIdSchema.safeParse(snapshotId).data ?? null;
}

async function readBrightDataJson(response: Response) {
  const text = await readResponseText(response, 4 * 1024 * 1024);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const providerMessage = text
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    throw new Error(
      `Bright Data returned invalid JSON (${response.status})${
        providerMessage ? `: ${providerMessage}` : ""
      }`,
    );
  }
}

type InstagramCollectionResult =
  | { status: "ready"; source: InstagramSource }
  | { status: "pending"; snapshotId: string }
  | { status: "failed" };

function brightDataApiKey() {
  const apiKey = process.env.BRIGHT_DATA_API_KEY?.trim();
  if (!apiKey) throw new Error("Bright Data is not configured");
  return apiKey;
}

function describeInstagramPayload(payload: unknown) {
  const root = objectValue(payload);
  const first = Array.isArray(payload)
    ? objectValue(payload[0])
    : Array.isArray(root?.data)
      ? objectValue(root.data[0])
      : Array.isArray(root?.records)
        ? objectValue(root.records[0])
        : null;
  const error =
    firstString(first?.error, first?.error_message, first?.message, root?.error, root?.message) ??
    "none";
  return JSON.stringify({
    shape: Array.isArray(payload) ? "array" : typeof payload,
    rootKeys: root ? Object.keys(root).slice(0, 12) : [],
    firstKeys: first ? Object.keys(first).slice(0, 20) : [],
    error: error.slice(0, 160),
  });
}

function parseInstagramCollection(payload: unknown): InstagramSource {
  const source = parseBrightDataInstagramSource(payload);
  if (!source) {
    throw new Error(
      `Bright Data did not return a public Instagram profile: ${describeInstagramPayload(payload)}`,
    );
  }
  return source;
}

async function requestInstagramCollection(
  handle: string,
  apiKey: string,
): Promise<InstagramCollectionResult> {
  // The async endpoint returns a durable snapshot ID immediately. That lets a
  // later request resume the same job instead of keeping a Worker request open
  // for the synchronous endpoint's one-minute timeout.
  const url = new URL("https://api.brightdata.com/datasets/v3/trigger");
  url.searchParams.set("dataset_id", BRIGHT_DATA_INSTAGRAM_PROFILE_DATASET_ID);
  url.searchParams.set("include_errors", "true");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    // Profile collection returns the current follower count and its recent
    // public `posts` array in one job. Unlike post discovery, it also succeeds
    // for valid public profiles that have not published a post yet.
    body: JSON.stringify([
      {
        url: `https://www.instagram.com/${encodeURIComponent(handle)}/`,
      },
    ]),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await readBrightDataJson(response);
  const snapshotId = brightDataSnapshotId(payload);
  if (snapshotId) {
    return { status: "pending", snapshotId };
  }
  if (!response.ok) throw new Error(`Bright Data returned ${response.status}`);
  return { status: "ready", source: parseInstagramCollection(payload) };
}

async function checkInstagramSnapshot(
  apiKey: string,
  snapshotId: string,
): Promise<InstagramCollectionResult> {
  const headers = { Accept: "application/json", Authorization: `Bearer ${apiKey}` };
  const progress = await fetch(
    `https://api.brightdata.com/datasets/v3/progress/${encodeURIComponent(snapshotId)}`,
    { headers, signal: AbortSignal.timeout(10_000) },
  );
  if (!progress.ok) throw new Error(`Bright Data snapshot status returned ${progress.status}`);
  const progressPayload = await readBrightDataJson(progress);
  const status =
    progressPayload && typeof progressPayload === "object"
      ? (progressPayload as BrightDataSnapshot).status
      : null;
  if (status === "failed") return { status: "failed" };
  if (status !== "ready") return { status: "pending", snapshotId };

  const snapshot = await fetch(
    `https://api.brightdata.com/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}?format=json`,
    { headers, signal: AbortSignal.timeout(20_000) },
  );
  if (!snapshot.ok) throw new Error(`Bright Data snapshot returned ${snapshot.status}`);
  return {
    status: "ready",
    source: parseInstagramCollection(await readBrightDataJson(snapshot)),
  };
}

async function downloadBrightDataSnapshot(apiKey: string, snapshotId: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_500));
    const result = await checkInstagramSnapshot(apiKey, snapshotId);
    if (result.status === "ready") return result.source;
    if (result.status === "failed") {
      throw new Error("Bright Data could not collect this Instagram profile");
    }
  }
  throw new Error("Bright Data is still collecting this Instagram profile");
}

export async function fetchInstagramBrightDataSource(handle: string): Promise<InstagramSource> {
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(handle)) throw new Error("Invalid Instagram username");
  const apiKey = brightDataApiKey();
  const result = await requestInstagramCollection(handle, apiKey);
  if (result.status === "ready") return result.source;
  if (result.status === "failed") {
    throw new Error("Bright Data could not collect this Instagram profile");
  }
  return downloadBrightDataSnapshot(apiKey, result.snapshotId);
}

function isInstagramMediaUrl(value: string) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return (
      host === "cdninstagram.com" ||
      host.endsWith(".cdninstagram.com") ||
      host.endsWith(".fbcdn.net")
    );
  } catch {
    return false;
  }
}

function instagramImageExtension(contentType: string) {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/avif") return "avif";
  return "jpg";
}

async function cacheInstagramPost(
  handle: string,
  post: InstagramSource["recentPosts"][number],
  existingNames: Map<string, string>,
) {
  const bucket = getMediaBucket();
  const folder = `cache/instagram/${handle.toLowerCase()}`;
  const existingName = existingNames.get(post.shortcode);
  if (existingName) {
    return {
      imageUrl: mediaObjectUrl(`${folder}/${existingName}`),
      permalink: `https://www.instagram.com/p/${post.shortcode}/`,
    };
  }
  if (!isInstagramMediaUrl(post.imageUrl)) return null;
  let currentUrl = post.imageUrl;
  let response: Response | null = null;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    if (!isInstagramMediaUrl(currentUrl)) throw new Error("Instagram redirected off its media CDN");
    response = await fetch(currentUrl, {
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        Referer: "https://www.instagram.com/",
        "User-Agent": INSTAGRAM_BROWSER_USER_AGENT,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location || redirect === 3) throw new Error("Instagram media redirect was invalid");
    currentUrl = new URL(location, currentUrl).toString();
  }
  if (!response) throw new Error("Instagram image request failed");
  if (!response.ok) throw new Error(`Instagram image returned ${response.status}`);
  const contentType = (response.headers.get("content-type") || "image/jpeg")
    .split(";", 1)[0]
    .toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp", "image/avif"].includes(contentType)) {
    throw new Error("Instagram media was not a supported image");
  }
  const image = await readResponseBytes(response, MAX_INSTAGRAM_IMAGE_BYTES);
  if (image.byteLength === 0 || image.byteLength > MAX_INSTAGRAM_IMAGE_BYTES) {
    throw new Error("Instagram image had an invalid size");
  }
  const name = `${post.shortcode}.${instagramImageExtension(contentType)}`;
  const path = `${folder}/${name}`;
  const object = await bucket.put(path, image, {
    httpMetadata: {
      contentType,
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: { source: "instagram", handle: handle.toLowerCase() },
  });
  if (!object) throw new Error("Could not cache Instagram image in R2");
  return {
    imageUrl: mediaObjectUrl(path),
    permalink: `https://www.instagram.com/p/${post.shortcode}/`,
  };
}

async function cacheInstagramSource(
  handle: string,
  source: InstagramSource,
): Promise<{ value: SocialPreview; mediaComplete: boolean }> {
  const folder = `cache/instagram/${handle.toLowerCase()}`;
  const existing = await getMediaBucket().list({ prefix: `${folder}/`, limit: 100 });
  const existingNames = new Map<string, string>();
  for (const object of existing.objects) {
    const name = object.key.slice(folder.length + 1);
    const shortcode = name.split(".", 1)[0];
    if (shortcode) existingNames.set(shortcode, name);
  }
  const cached = await Promise.all(
    source.recentPosts.map((post) =>
      cacheInstagramPost(handle, post, existingNames).catch((error) => {
        console.warn("Instagram media cache failed", {
          handle,
          shortcode: post.shortcode,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return null;
      }),
    ),
  );
  const recentPosts = cached.filter((post): post is NonNullable<typeof post> => post !== null);
  // A transient CDN or R2 issue must not hide an otherwise valid live follower
  // count. Failed images are omitted individually and retried on the next
  // refresh instead of blanking the entire card.
  return {
    value: {
      ...EMPTY_PREVIEW,
      followerCount: source.followerCount,
      recentPosts,
      available: true,
      refreshing: recentPosts.length < source.recentPosts.length,
    },
    mediaComplete: recentPosts.length === source.recentPosts.length,
  };
}

type PreviewLoadResult = {
  value: SocialPreview;
  cacheTtlMs?: number;
  instagramRefresh?: InstagramRefreshState;
};

function pendingInstagramPreview(
  fallback: SocialPreview | undefined,
  instagramRefresh: InstagramRefreshState,
): PreviewLoadResult {
  return {
    value: {
      ...(fallback?.available ? fallback : EMPTY_PREVIEW),
      refreshing: true,
    },
    cacheTtlMs: INSTAGRAM_SNAPSHOT_POLL_MS,
    instagramRefresh,
  };
}

async function cachedInstagramPreview(
  handle: string,
  source: InstagramSource,
  sourceFetchedAt: number,
): Promise<PreviewLoadResult> {
  const cached = await cacheInstagramSource(handle, source);
  if (cached.mediaComplete) {
    return { value: { ...cached.value, refreshing: false } };
  }
  return {
    value: cached.value,
    cacheTtlMs: INSTAGRAM_RETRY_TTL_MS,
    instagramRefresh: { source, sourceFetchedAt },
  };
}

export async function fetchInstagramMetaSource(handle: string): Promise<InstagramSource> {
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(handle)) throw new Error("Invalid Instagram username");
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN?.trim();
  const businessAccountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID?.trim();
  if (!accessToken || !businessAccountId) {
    throw new SocialPreviewSourceError("Meta Business Discovery is not configured", "blocked");
  }
  const version = process.env.META_GRAPH_API_VERSION?.trim() || "v25.0";
  const url = new URL(`https://graph.facebook.com/${version}/${businessAccountId}`);
  url.searchParams.set(
    "fields",
    `business_discovery.username(${handle}){followers_count,media.limit(6){permalink,media_url,thumbnail_url,timestamp}}`,
  );
  url.searchParams.set("access_token", accessToken);
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Meta Business Discovery returned ${response.status}`);
  const payload = objectValue(JSON.parse(await readResponseText(response, 2 * 1024 * 1024)));
  const profile = objectValue(payload?.business_discovery);
  const followerCount = nonNegativeInteger(profile?.followers_count);
  if (followerCount === null) {
    throw new SocialPreviewSourceError(
      "Meta did not return an Instagram follower count",
      "unavailable",
    );
  }
  const media = objectValue(profile?.media);
  const recentPosts = (Array.isArray(media?.data) ? media.data : [])
    .map(objectValue)
    .filter((post): post is Record<string, unknown> => !!post)
    .map((post) => ({
      shortcode: instagramShortcode(post.permalink),
      imageUrl: firstString(post.media_url, post.thumbnail_url),
    }))
    .filter(
      (post): post is { shortcode: string; imageUrl: string } =>
        !!post.shortcode && !!post.imageUrl,
    );
  return { followerCount, recentPosts };
}

async function fetchInstagramPublicHtmlSource(handle: string) {
  const response = await fetch(`https://www.instagram.com/${encodeURIComponent(handle)}/`, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": INSTAGRAM_BROWSER_USER_AGENT,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Instagram public HTML returned ${response.status}`);
  const source = parseInstagramPublicSource(await readResponseText(response, 2 * 1024 * 1024));
  if (!source) {
    throw new SocialPreviewSourceError(
      "Instagram public HTML did not expose a follower count",
      "parse_error",
    );
  }
  return source;
}

async function fetchInstagramFreeSource(handle: string, attemptNumber: number) {
  let lastError: unknown;
  let partialSource: InstagramSource | undefined;
  if (process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID) {
    try {
      const source = await runSocialPreviewSource(
        "instagram",
        "meta_business_discovery",
        attemptNumber,
        async () => ({
          value: await fetchInstagramMetaSource(handle),
        }),
        false,
        (value) => (value.recentPosts.length > 0 ? "success" : "unavailable"),
      );
      if (source.recentPosts.length > 0) return source;
      partialSource = source;
    } catch (error) {
      lastError = error;
    }
  }
  try {
    const source = await runSocialPreviewSource(
      "instagram",
      "public_html",
      attemptNumber,
      async () => ({ value: await fetchInstagramPublicHtmlSource(handle) }),
      false,
      (value) => (value.recentPosts.length > 0 ? "success" : "unavailable"),
    );
    if (source.recentPosts.length > 0) return source;
    partialSource ??= source;
  } catch (error) {
    lastError = error;
  }
  try {
    const source = await runSocialPreviewSource(
      "instagram",
      "browser_run",
      attemptNumber,
      async () => {
        const rendered = await fetchRenderedSocialHtml(
          `https://www.instagram.com/${encodeURIComponent(handle)}/`,
        );
        const source = parseInstagramPublicSource(rendered.value);
        if (!source) {
          throw new SocialPreviewSourceError(
            "Rendered Instagram HTML did not expose a follower count",
            "parse_error",
            rendered.browserMs,
          );
        }
        return { value: source, browserMs: rendered.browserMs };
      },
      false,
      (value) => (value.recentPosts.length > 0 ? "success" : "unavailable"),
    );
    if (source.recentPosts.length > 0) return source;
    return partialSource ?? source;
  } catch (error) {
    lastError = error;
  }
  if (partialSource) return partialSource;
  throw lastError ?? new Error("Instagram did not return public profile data");
}

async function instagramFreePreview(
  handle: string,
  attemptNumber: number,
  persistent?: PersistentPreview | null,
): Promise<PreviewLoadResult> {
  const state = persistent?.instagramRefresh;
  const now = Date.now();
  if (
    state?.source &&
    state.sourceFetchedAt &&
    now - state.sourceFetchedAt <= INSTAGRAM_SOURCE_REUSE_MS
  ) {
    return cachedInstagramPreview(handle, state.source, state.sourceFetchedAt);
  }
  return cachedInstagramPreview(handle, await fetchInstagramFreeSource(handle, attemptNumber), now);
}

async function instagramBrightPreview(
  handle: string,
  persistent?: PersistentPreview | null,
): Promise<PreviewLoadResult> {
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(handle)) throw new Error("Invalid Instagram username");
  const now = Date.now();
  const state = persistent?.instagramRefresh;

  if (
    state?.source &&
    state.sourceFetchedAt &&
    now - state.sourceFetchedAt <= INSTAGRAM_SOURCE_REUSE_MS
  ) {
    return cachedInstagramPreview(handle, state.source, state.sourceFetchedAt);
  }

  const apiKey = brightDataApiKey();
  let collection: InstagramCollectionResult;
  if (state?.snapshotId) {
    if (!state.snapshotStartedAt || now - state.snapshotStartedAt > INSTAGRAM_SNAPSHOT_MAX_AGE_MS) {
      throw new Error("Bright Data Instagram snapshot expired");
    }
    collection = await checkInstagramSnapshot(apiKey, state.snapshotId);
  } else {
    collection = await requestInstagramCollection(handle, apiKey);
  }

  if (collection.status === "failed") {
    throw new Error("Bright Data could not collect this Instagram profile");
  }
  if (collection.status === "pending") {
    return pendingInstagramPreview(
      persistent && persistent.staleUntil > now ? persistent.value : undefined,
      {
        snapshotId: collection.snapshotId,
        snapshotStartedAt:
          state?.snapshotId === collection.snapshotId && state.snapshotStartedAt
            ? state.snapshotStartedAt
            : now,
      },
    );
  }
  return cachedInstagramPreview(handle, collection.source, now);
}

export function parseTwitterTimelineFollowerCount(html: string, expectedHandle: string) {
  const nextData = html.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  )?.[1];
  if (!nextData) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(nextData);
  } catch {
    return null;
  }

  const stack: unknown[] = [payload];
  let visited = 0;
  while (stack.length > 0 && visited < 20_000) {
    const value = stack.pop();
    visited += 1;
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    const record = objectValue(value);
    if (!record) continue;
    if (
      typeof record.screen_name === "string" &&
      record.screen_name.toLowerCase() === expectedHandle.toLowerCase()
    ) {
      const followerCount = nonNegativeInteger(
        record.followers_count ?? record.normal_followers_count,
      );
      if (followerCount !== null) return followerCount;
    }
    stack.push(...Object.values(record));
  }
  return null;
}

export function parseFxTwitterFollowerCount(value: unknown, expectedHandle: string) {
  const payload = objectValue(value);
  const user = objectValue(payload?.user);
  if (
    !user ||
    typeof user.screen_name !== "string" ||
    user.screen_name.toLowerCase() !== expectedHandle.toLowerCase()
  ) {
    return null;
  }
  return nonNegativeInteger(user.followers);
}

export async function fetchTwitterPreview(handle: string): Promise<SocialPreview> {
  if (!/^[a-zA-Z0-9_]{1,15}$/.test(handle)) throw new Error("Invalid X username");

  let followerCount: number | null = null;
  try {
    const response = await fetch(
      `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}`,
      {
        headers: {
          Accept: "text/html",
          "Accept-Language": "en",
          "User-Agent": "bento.surf-social-preview",
        },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (response.ok) {
      followerCount = parseTwitterTimelineFollowerCount(
        await readResponseText(response, 2 * 1024 * 1024),
        handle,
      );
    }
  } catch {
    // New or inactive accounts may not have a public timeline. The open-source
    // profile adapter below covers those profiles without requiring an X key.
  }

  if (followerCount === null) {
    const profile = await fetchJson(`https://api.fxtwitter.com/${encodeURIComponent(handle)}`);
    followerCount = parseFxTwitterFollowerCount(profile, handle);
  }
  if (followerCount === null) throw new Error("X returned an invalid public profile");

  return {
    ...EMPTY_PREVIEW,
    followerCount,
    available: true,
  };
}

export async function fetchYouTubePreview(handle: string): Promise<SocialPreview> {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) return { ...EMPTY_PREVIEW, metricName: "subscribers" };
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "statistics,contentDetails");
  if (/^UC[\w-]{20,}$/i.test(handle)) url.searchParams.set("id", handle);
  else url.searchParams.set("forHandle", handle);
  url.searchParams.set("key", key);
  const data = await fetchJson(url.toString());
  const channel = data.items?.[0];
  const statistics = channel?.statistics;
  const uploadsPlaylist = channel?.contentDetails?.relatedPlaylists?.uploads;
  let latestVideo: SocialPreview["latestVideo"] = null;

  if (typeof uploadsPlaylist === "string" && uploadsPlaylist) {
    const uploadsUrl = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    uploadsUrl.searchParams.set("part", "snippet");
    uploadsUrl.searchParams.set("playlistId", uploadsPlaylist);
    uploadsUrl.searchParams.set("maxResults", "1");
    uploadsUrl.searchParams.set("key", key);
    const uploads = await fetchJson(uploadsUrl.toString());
    const snippet = uploads.items?.[0]?.snippet;
    const id = snippet?.resourceId?.videoId;
    if (typeof id === "string" && /^[A-Za-z0-9_-]{6,15}$/.test(id)) {
      const thumbnails = snippet?.thumbnails;
      const thumbnailUrl =
        thumbnails?.maxres?.url ??
        thumbnails?.standard?.url ??
        thumbnails?.high?.url ??
        thumbnails?.medium?.url ??
        thumbnails?.default?.url ??
        null;
      latestVideo = {
        id,
        title: typeof snippet?.title === "string" ? snippet.title : "Latest YouTube video",
        thumbnailUrl: typeof thumbnailUrl === "string" ? thumbnailUrl : null,
        permalink: `https://www.youtube.com/watch?v=${id}`,
      };
    }
  }

  return {
    ...EMPTY_PREVIEW,
    metricName: "subscribers",
    followerCount:
      statistics && !statistics.hiddenSubscriberCount ? Number(statistics.subscriberCount) : null,
    latestVideo,
    available: !!channel,
  };
}

export async function fetchLinkedInBrightDataPreview(handle: string): Promise<SocialPreview> {
  if (!/^[a-z\d][a-z\d-]{0,99}$/i.test(handle)) {
    throw new Error("Invalid LinkedIn profile handle");
  }

  const apiKey = process.env.BRIGHT_DATA_API_KEY?.trim();
  if (!apiKey) throw new SocialPreviewSourceError("Bright Data is not configured", "blocked");
  const response = await fetch(
    `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${BRIGHT_DATA_LINKEDIN_PROFILE_DATASET_ID}&format=json`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: [{ url: `https://www.linkedin.com/in/${handle}` }],
      }),
      signal: AbortSignal.timeout(45_000),
    },
  );
  if (!response.ok) throw new Error(`Bright Data returned ${response.status}`);
  const payload = JSON.parse(await readResponseText(response, 4 * 1024 * 1024)) as unknown;
  const followerCount = parseBrightDataLinkedInFollowerCount(payload);
  if (followerCount !== null) return { ...EMPTY_PREVIEW, followerCount, available: true };
  throw new SocialPreviewSourceError(
    "Bright Data did not return a LinkedIn follower count",
    "parse_error",
  );
}

export async function fetchLinkedInPreview(
  handle: string,
  attemptNumber = 1,
): Promise<SocialPreview> {
  if (!/^[a-z\d][a-z\d-]{0,99}$/i.test(handle)) {
    throw new Error("Invalid LinkedIn profile handle");
  }
  // LinkedIn's public member and company pages expose a follower count to
  // signed-out visitors without requiring the profile owner to connect it.
  let lastError: unknown;
  for (const kind of ["in", "company"] as const) {
    try {
      return await runSocialPreviewSource(
        "linkedin",
        `public_html_${kind}`,
        attemptNumber,
        async () => {
          const response = await fetch(
            `https://www.linkedin.com/${kind}/${encodeURIComponent(handle)}`,
            {
              headers: {
                Accept: "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
                "User-Agent": INSTAGRAM_BROWSER_USER_AGENT,
              },
              redirect: "follow",
              signal: AbortSignal.timeout(12_000),
            },
          );
          if (!response.ok) throw new Error(`LinkedIn public HTML returned ${response.status}`);
          const followerCount = parseLinkedInPublicFollowerCount(
            await readResponseText(response, 2 * 1024 * 1024),
          );
          if (followerCount === null) {
            throw new SocialPreviewSourceError(
              "LinkedIn public HTML did not expose a follower count",
              "parse_error",
            );
          }
          return { value: { ...EMPTY_PREVIEW, followerCount, available: true } };
        },
      );
    } catch (error) {
      lastError = error;
      // Try the other public LinkedIn profile type before giving up.
    }
  }
  for (const kind of ["in", "company"] as const) {
    try {
      return await runSocialPreviewSource(
        "linkedin",
        `browser_run_${kind}`,
        attemptNumber,
        async () => {
          const rendered = await fetchRenderedSocialHtml(
            `https://www.linkedin.com/${kind}/${encodeURIComponent(handle)}`,
          );
          const followerCount = parseLinkedInPublicFollowerCount(rendered.value);
          if (followerCount === null) {
            throw new SocialPreviewSourceError(
              "Rendered LinkedIn HTML did not expose a follower count",
              "parse_error",
              rendered.browserMs,
            );
          }
          return {
            value: { ...EMPTY_PREVIEW, followerCount, available: true },
            browserMs: rendered.browserMs,
          };
        },
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("LinkedIn did not return a public follower count");
}

export async function fetchRedditPreview(
  handle: string,
  attemptNumber = 1,
): Promise<SocialPreview> {
  if (!/^[a-z\d_-]{1,20}$/i.test(handle)) throw new Error("Invalid Reddit username");
  const userAgent = "web:bento.surf.social-preview:v1.0 (by /u/bentosurf)";
  const urls = [
    ["public_html_www", `https://www.reddit.com/user/${encodeURIComponent(handle)}/`],
    ["public_html_old", `https://old.reddit.com/user/${encodeURIComponent(handle)}/`],
  ] as const;
  let lastError: unknown;
  for (const [source, url] of urls) {
    try {
      return await runSocialPreviewSource("reddit", source, attemptNumber, async () => {
        const response = await fetch(url, {
          headers: {
            Accept: "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
            "User-Agent": userAgent,
          },
          redirect: "follow",
          signal: AbortSignal.timeout(12_000),
        });
        if (!response.ok) throw new Error(`Reddit public HTML returned ${response.status}`);
        const followerCount = parseRedditPublicFollowerCount(
          await readResponseText(response, 2 * 1024 * 1024),
        );
        if (followerCount === null) {
          throw new SocialPreviewSourceError(
            "Reddit public HTML did not expose a follower count",
            "parse_error",
          );
        }
        return { value: { ...EMPTY_PREVIEW, followerCount, available: true } };
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Reddit did not return a public follower count");
}

export async function fetchTikTokPreview(
  handle: string,
  attemptNumber = 1,
): Promise<SocialPreview> {
  if (!/^[a-zA-Z0-9._]{1,24}$/.test(handle)) throw new Error("Invalid TikTok username");
  const url = `https://www.tiktok.com/@${encodeURIComponent(handle)}`;
  try {
    return await runSocialPreviewSource("tiktok", "public_html", attemptNumber, async () => {
      const response = await fetch(url, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": INSTAGRAM_BROWSER_USER_AGENT,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`TikTok public HTML returned ${response.status}`);
      const followerCount = parseTikTokFollowerCount(
        await readResponseText(response, 2 * 1024 * 1024),
        handle,
      );
      if (followerCount === null) {
        throw new SocialPreviewSourceError(
          "TikTok public HTML did not expose a follower count",
          "parse_error",
        );
      }
      return { value: { ...EMPTY_PREVIEW, followerCount, available: true } };
    });
  } catch {
    return runSocialPreviewSource("tiktok", "browser_run", attemptNumber, async () => {
      const rendered = await fetchRenderedSocialHtml(url);
      const followerCount = parseTikTokFollowerCount(rendered.value, handle);
      if (followerCount === null) {
        throw new SocialPreviewSourceError(
          "Rendered TikTok HTML did not expose a follower count",
          "parse_error",
          rendered.browserMs,
        );
      }
      return {
        value: { ...EMPTY_PREVIEW, followerCount, available: true },
        browserMs: rendered.browserMs,
      };
    });
  }
}

async function publicPreview(platform: string, handle: string): Promise<SocialPreview> {
  if (platform === "bluesky") {
    const data = await fetchJson(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`,
    );
    return { ...EMPTY_PREVIEW, followerCount: data.followersCount ?? null, available: true };
  }
  if (platform === "mastodon") {
    const data = await fetchJson(
      `https://mastodon.social/api/v1/accounts/lookup?acct=${encodeURIComponent(handle)}`,
    );
    return { ...EMPTY_PREVIEW, followerCount: data.followers_count ?? null, available: true };
  }
  if (platform === "gitlab") {
    const data = await fetchJson(
      `https://gitlab.com/api/v4/users?username=${encodeURIComponent(handle)}`,
    );
    return {
      ...EMPTY_PREVIEW,
      followerCount: typeof data?.[0]?.followers === "number" ? data[0].followers : null,
      available: !!data?.[0],
    };
  }
  return EMPTY_PREVIEW;
}

const sourceByPlatform = {
  github: "github_api_html",
  twitter: "twitter_public_chain",
  youtube: "youtube_api",
  gitlab: "gitlab_api",
  bluesky: "bluesky_api",
  mastodon: "mastodon_api",
} as const;

async function loadPreview(
  platform: z.infer<typeof supportedPlatform>,
  handle: string,
  persistent?: PersistentPreview | null,
  attemptNumber = 1,
): Promise<PreviewLoadResult> {
  if (platform === "instagram") return instagramFreePreview(handle, attemptNumber, persistent);
  if (platform === "linkedin") {
    return {
      value: await fetchLinkedInPreview(handle, attemptNumber),
      cacheTtlMs: LINKEDIN_CACHE_TTL_MS,
    };
  }
  if (platform === "reddit") {
    return {
      value: await fetchRedditPreview(handle, attemptNumber),
      cacheTtlMs: REDDIT_CACHE_TTL_MS,
    };
  }
  if (platform === "tiktok") {
    return { value: await fetchTikTokPreview(handle, attemptNumber) };
  }
  const value = await runSocialPreviewSource(
    platform,
    sourceByPlatform[platform],
    attemptNumber,
    async () => ({
      value:
        platform === "github"
          ? await fetchGitHubPreview(handle)
          : platform === "twitter"
            ? await fetchTwitterPreview(handle)
            : platform === "youtube"
              ? await fetchYouTubePreview(handle)
              : await publicPreview(platform, handle),
    }),
    false,
    (preview) => (preview.followerCount !== null ? "success" : "unavailable"),
  );
  return {
    value,
    cacheTtlMs: platform === "twitter" ? TWITTER_CACHE_TTL_MS : undefined,
  };
}

async function loadBrightFallback(
  platform: "instagram" | "linkedin",
  handle: string,
  persistent?: PersistentPreview | null,
) {
  if (!process.env.BRIGHT_DATA_API_KEY?.trim()) {
    throw new SocialPreviewSourceError("Bright Data is not configured", "blocked");
  }
  const resumingSnapshot = platform === "instagram" && !!persistent?.instagramRefresh?.snapshotId;
  if (!resumingSnapshot && !(await claimBrightDataAttempt())) {
    throw new SocialPreviewSourceError("Bright Data monthly budget exhausted", "blocked");
  }
  return runSocialPreviewSource(
    platform,
    resumingSnapshot ? "bright_data_snapshot" : "bright_data",
    4,
    async () => ({
      value:
        platform === "instagram"
          ? await instagramBrightPreview(handle, persistent)
          : {
              value: await fetchLinkedInBrightDataPreview(handle),
              cacheTtlMs: LINKEDIN_CACHE_TTL_MS,
            },
    }),
    true,
    (result) => (result.value.available && !result.value.refreshing ? "success" : "unavailable"),
  );
}

export function nextSocialPreviewRetry(attemptNumber: number, now: number) {
  if (attemptNumber < 1 || attemptNumber >= 4) return null;
  const delay = FREE_RETRY_DELAYS_MS[attemptNumber - 1];
  return { nextAttempt: attemptNumber + 1, nextRetryAt: now + delay };
}

export function shouldTryImmediateBrightFallback(
  platform: z.infer<typeof supportedPlatform>,
  hasAvailablePreview: boolean,
  hasRetryState: boolean,
  resumingSnapshot: boolean,
) {
  return (
    (platform === "instagram" || platform === "linkedin") &&
    !hasAvailablePreview &&
    !hasRetryState &&
    !resumingSnapshot
  );
}

export function shouldTryImmediateInstagramMediaFallback(
  platform: z.infer<typeof supportedPlatform>,
  immediateBrightFallback: boolean,
  recentPostCount: number,
) {
  return platform === "instagram" && immediateBrightFallback && recentPostCount === 0;
}

export function preserveInstagramPreviewWhileMediaLoads(
  freePreview: SocialPreview,
  brightPreview: SocialPreview,
) {
  return brightPreview.refreshing && !brightPreview.available && freePreview.available
    ? { ...freePreview, refreshing: true }
    : brightPreview;
}

export function socialPreviewFailureWindow(
  now: number,
  requestedRetryAt: number,
  existingStaleUntil?: number,
) {
  const preservesStale = existingStaleUntil !== undefined && existingStaleUntil > now;
  const expiresAt = preservesStale
    ? Math.min(requestedRetryAt, existingStaleUntil)
    : requestedRetryAt;
  return {
    expiresAt,
    staleUntil: preservesStale ? existingStaleUntil : now + STALE_CACHE_TTL_MS,
  };
}

async function canLoadPremiumSocialPreview(
  blockId: string | undefined,
  platform: z.infer<typeof supportedPlatform>,
  handle: string,
) {
  if (!blockId) return false;
  const { data: block, error } = await supabaseAdmin
    .from("blocks")
    .select("user_id, content")
    .eq("id", blockId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (
    !block ||
    !block.content ||
    typeof block.content !== "object" ||
    Array.isArray(block.content)
  ) {
    return false;
  }

  const content = block.content as Record<string, Json | undefined>;
  const storedPlatform =
    typeof content.platform === "string"
      ? content.platform
      : typeof content.liveProvider === "string"
        ? content.liveProvider
        : "";
  const storedHandle = typeof content.handle === "string" ? content.handle : "";
  if (
    storedPlatform !== platform ||
    normalizeSocialHandle(platform, storedHandle).toLowerCase() !== handle.toLowerCase()
  ) {
    return false;
  }

  return planHasEntitlement(await getPlan(block.user_id), "liveSocialPreviews");
}

export const getSocialPreview = createServerFn({ method: "POST" })
  .validator((input) =>
    z
      .object({
        platform: supportedPlatform,
        handle: z.string().min(1).max(100),
        blockId: z.string().uuid().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "social-preview-request");
    const handle = normalizeSocialHandle(data.platform, data.handle);
    if (!(await canLoadPremiumSocialPreview(data.blockId, data.platform, handle))) {
      return EMPTY_PREVIEW;
    }
    const cacheVersion =
      data.platform === "instagram"
        ? INSTAGRAM_CACHE_VERSION
        : data.platform === "github"
          ? GITHUB_CACHE_VERSION
          : data.platform === "twitter"
            ? TWITTER_CACHE_VERSION
            : data.platform === "youtube"
              ? YOUTUBE_CACHE_VERSION
              : data.platform === "linkedin"
                ? LINKEDIN_CACHE_VERSION
                : data.platform === "reddit"
                  ? REDDIT_CACHE_VERSION
                  : null;
    const key = `${data.platform}:${cacheVersion ? `${cacheVersion}:` : ""}${handle.toLowerCase()}`;
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;

    let persistent = await readPersistentPreview(key);
    if (persistent && persistent.expiresAt > now) {
      if (!persistent.value.available) {
        if (data.platform === "instagram" || persistent.instagramRefresh || persistent.refresh) {
          return persistent.value;
        }
        persistent = await waitForInitialPreview(key);
        if (!persistent) return EMPTY_PREVIEW;
      }
      cache.set(key, { value: persistent.value, expiresAt: persistent.expiresAt });
      return persistent.value;
    }

    if (persistent) {
      const ownsRefresh = await claimExpiredRefresh(key, data.platform, now, persistent.staleUntil);
      if (!ownsRefresh) return persistent.value;
    } else {
      const ownsInitialRefresh = await createInitialRefreshLease(key, data.platform, handle);
      if (!ownsInitialRefresh) {
        persistent = await waitForInitialPreview(key);
        return persistent?.value ?? EMPTY_PREVIEW;
      }
    }

    const resumingBrightSnapshot =
      data.platform === "instagram" && !!persistent?.instagramRefresh?.snapshotId;
    const attemptNumber = resumingBrightSnapshot ? 4 : (persistent?.refresh?.nextAttempt ?? 1);
    const immediateBrightFallback = shouldTryImmediateBrightFallback(
      data.platform,
      !!persistent?.value.available,
      !!persistent?.refresh,
      resumingBrightSnapshot,
    );
    const preservedStaleUntil =
      persistent && persistent.staleUntil > now ? persistent.staleUntil : undefined;

    try {
      await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "social-preview");
      let result = resumingBrightSnapshot
        ? await loadBrightFallback("instagram", handle, persistent)
        : await loadPreview(data.platform, handle, persistent, attemptNumber);

      if (
        shouldTryImmediateInstagramMediaFallback(
          data.platform,
          immediateBrightFallback,
          result.value.recentPosts.length,
        )
      ) {
        try {
          const freeResult = result;
          const brightResult = await loadBrightFallback("instagram", handle, persistent);
          result = {
            ...brightResult,
            value: preserveInstagramPreviewWhileMediaLoads(freeResult.value, brightResult.value),
          };
        } catch (brightError) {
          console.warn("Bright Data Instagram media fallback failed; keeping free follower data", {
            error: brightError instanceof Error ? brightError.message : "Unknown error",
          });
        }
      }

      const value = result.value;
      if (
        data.platform === "instagram" &&
        value.refreshing &&
        result.instagramRefresh?.snapshotId
      ) {
        const cacheTtl = result.cacheTtlMs ?? INSTAGRAM_SNAPSHOT_POLL_MS;
        const pendingWindow = socialPreviewFailureWindow(now, now + cacheTtl, preservedStaleUntil);
        await writePersistentPreview(key, data.platform, handle, value, {
          cacheTtlMs: pendingWindow.expiresAt - now,
          instagramRefresh: result.instagramRefresh,
          staleUntil: pendingWindow.staleUntil,
        });
        cache.set(key, { value, expiresAt: pendingWindow.expiresAt });
        return value;
      }
      if (!value.available) {
        if (data.platform === "instagram" && result.instagramRefresh) {
          await writePersistentPreview(key, data.platform, handle, value, {
            cacheTtlMs: result.cacheTtlMs,
            instagramRefresh: result.instagramRefresh,
          });
          cache.set(key, {
            value,
            expiresAt: Date.now() + (result.cacheTtlMs ?? INSTAGRAM_SNAPSHOT_POLL_MS),
          });
          return value;
        }
        throw new SocialPreviewSourceError(
          `${data.platform} did not return an available public preview`,
          "unavailable",
        );
      }
      await writePersistentPreview(key, data.platform, handle, value, {
        cacheTtlMs: result.cacheTtlMs,
        instagramRefresh: result.instagramRefresh,
      });
      if (cache.size > 500) cache.clear();
      const cacheTtl =
        result.cacheTtlMs ??
        (data.platform === "instagram"
          ? INSTAGRAM_CACHE_TTL_MS
          : data.platform === "twitter"
            ? TWITTER_CACHE_TTL_MS
            : data.platform === "linkedin"
              ? LINKEDIN_CACHE_TTL_MS
              : data.platform === "reddit"
                ? REDDIT_CACHE_TTL_MS
                : DEFAULT_CACHE_TTL_MS);
      cache.set(key, {
        value,
        expiresAt: Date.now() + cacheTtl,
      });
      return value;
    } catch (error) {
      const retry = immediateBrightFallback ? null : nextSocialPreviewRetry(attemptNumber, now);
      if (retry) {
        const staleAvailable = !!persistent?.value.available && persistent.staleUntil > now;
        const fallback = {
          ...(staleAvailable ? persistent!.value : EMPTY_PREVIEW),
          refreshing: true,
        };
        const failureWindow = socialPreviewFailureWindow(
          now,
          retry.nextRetryAt,
          staleAvailable ? persistent!.staleUntil : undefined,
        );
        await writePersistentPreview(key, data.platform, handle, fallback, {
          cacheTtlMs: failureWindow.expiresAt - now,
          refresh: { ...retry, nextRetryAt: failureWindow.expiresAt },
          staleUntil: failureWindow.staleUntil,
        });
        cache.set(key, { value: fallback, expiresAt: failureWindow.expiresAt });
        return fallback;
      }

      if (
        (attemptNumber === 4 || immediateBrightFallback) &&
        !resumingBrightSnapshot &&
        (data.platform === "instagram" || data.platform === "linkedin")
      ) {
        try {
          const brightResult = await loadBrightFallback(data.platform, handle, persistent);
          if (
            data.platform === "instagram" &&
            brightResult.value.refreshing &&
            brightResult.instagramRefresh?.snapshotId
          ) {
            const cacheTtl = brightResult.cacheTtlMs ?? INSTAGRAM_SNAPSHOT_POLL_MS;
            const pendingWindow = socialPreviewFailureWindow(
              now,
              now + cacheTtl,
              preservedStaleUntil,
            );
            await writePersistentPreview(key, data.platform, handle, brightResult.value, {
              cacheTtlMs: pendingWindow.expiresAt - now,
              instagramRefresh: brightResult.instagramRefresh,
              staleUntil: pendingWindow.staleUntil,
            });
            cache.set(key, { value: brightResult.value, expiresAt: pendingWindow.expiresAt });
            return brightResult.value;
          }
          if (brightResult.value.available) {
            await writePersistentPreview(key, data.platform, handle, brightResult.value, {
              cacheTtlMs: brightResult.cacheTtlMs,
              instagramRefresh: brightResult.instagramRefresh,
            });
            const cacheTtl = brightResult.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
            cache.set(key, { value: brightResult.value, expiresAt: Date.now() + cacheTtl });
            return brightResult.value;
          }
          if (data.platform === "instagram" && brightResult.instagramRefresh) {
            await writePersistentPreview(key, data.platform, handle, brightResult.value, {
              cacheTtlMs: brightResult.cacheTtlMs,
              instagramRefresh: brightResult.instagramRefresh,
              staleUntil: preservedStaleUntil,
            });
            cache.set(key, {
              value: brightResult.value,
              expiresAt: Date.now() + (brightResult.cacheTtlMs ?? INSTAGRAM_SNAPSHOT_POLL_MS),
            });
            return brightResult.value;
          }
        } catch (brightError) {
          console.warn("Bright Data social-preview fallback failed", {
            platform: data.platform,
            error: brightError instanceof Error ? brightError.message : "Unknown error",
          });
        }
      }

      if (attemptNumber === 4 || immediateBrightFallback) {
        const requestedNextCycleAt = now + DEFAULT_CACHE_TTL_MS;
        const staleAvailable = !!persistent?.value.available && persistent.staleUntil > now;
        const failureWindow = socialPreviewFailureWindow(
          now,
          requestedNextCycleAt,
          staleAvailable ? persistent!.staleUntil : undefined,
        );
        const fallback = {
          ...(staleAvailable ? persistent!.value : EMPTY_PREVIEW),
          refreshing: false,
        };
        await writePersistentPreview(key, data.platform, handle, fallback, {
          cacheTtlMs: failureWindow.expiresAt - now,
          refresh: { nextAttempt: 1, nextRetryAt: failureWindow.expiresAt },
          staleUntil: failureWindow.staleUntil,
        });
        cache.set(key, { value: fallback, expiresAt: failureWindow.expiresAt });
        return fallback;
      }

      console.error("Social preview refresh failed", {
        platform: data.platform,
        handle,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      if (persistent && persistent.staleUntil > now) {
        if (data.platform !== "instagram") return persistent.value;
        const fallback = { ...persistent.value, refreshing: true };
        const retryTtl = persistent.value.available
          ? INSTAGRAM_RETRY_TTL_MS
          : INSTAGRAM_FAILED_REFRESH_RETRY_MS;
        await writePersistentPreview(key, data.platform, handle, fallback, {
          cacheTtlMs: retryTtl,
          instagramRefresh: persistent.instagramRefresh,
        });
        cache.set(key, {
          value: fallback,
          expiresAt: Date.now() + retryTtl,
        });
        return fallback;
      }
      if (data.platform === "instagram") {
        // A failed first collection must release the long concurrency lease.
        // Persist a short refreshing state so the mounted tile retries after
        // eight seconds instead of remaining empty for the full lease.
        const retrying = { ...EMPTY_PREVIEW, refreshing: true };
        await writePersistentPreview(key, data.platform, handle, retrying, {
          cacheTtlMs: INSTAGRAM_FAILED_REFRESH_RETRY_MS,
          instagramRefresh: persistent?.instagramRefresh,
        });
        cache.set(key, {
          value: retrying,
          expiresAt: Date.now() + INSTAGRAM_FAILED_REFRESH_RETRY_MS,
        });
        return retrying;
      }
      console.warn("Social preview failed", {
        platform: data.platform,
        handle,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      return EMPTY_PREVIEW;
    }
  });
