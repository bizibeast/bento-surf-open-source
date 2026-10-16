import type { ContentSourceStats } from "./content-sources.server";

export const DISCOVER_QUALITY_THRESHOLDS = {
  recentDays: 30,
  social: { followers: 1_000, views: 10_000, likes: 100 },
  reddit: { votes: 100, comments: 10 },
  hackernews: { votes: 50, comments: 10 },
} as const;

type QualityInput = {
  platform?: string | null;
  kind?: string | null;
  stats?: ContentSourceStats;
  publishedAt?: string | null;
  sourcePublishedAt?: string | null;
};

export type DiscoverQualityReason =
  | "eligible"
  | "publication_unknown"
  | "publication_future"
  | "publication_stale"
  | "unsupported_platform"
  | "followers_unknown"
  | "audience_too_small"
  | "traction_unknown"
  | "traction_too_low";

/** Missing observations stay unknown; an explicit zero remains a real observation. */
function count(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Admission uses observed publication, audience and performance, never creator fame. */
export function evaluateDiscoverQuality(input: QualityInput, now = Date.now()) {
  const evidence = {
    followers: count(input.stats?.followers),
    views: count(input.stats?.views),
    likes: count(input.stats?.likes),
    comments: count(input.stats?.comments),
  };
  const published = Date.parse(input.publishedAt ?? input.sourcePublishedAt ?? "");
  const ageDays = Number.isFinite(published) ? (now - published) / 86_400_000 : null;
  const platform = (input.platform || input.kind || "").toLowerCase().replace(/[\s_-]/g, "");
  const result = (reason: DiscoverQualityReason) => ({
    eligible: reason === "eligible",
    reason,
    ageDays,
    platform,
    evidence,
  });
  if (ageDays === null) return result("publication_unknown");
  if (ageDays < 0) return result("publication_future");
  if (ageDays > DISCOVER_QUALITY_THRESHOLDS.recentDays) return result("publication_stale");

  if (platform === "reddit" || platform === "hackernews" || platform === "hn") {
    const threshold = DISCOVER_QUALITY_THRESHOLDS[platform === "reddit" ? "reddit" : "hackernews"];
    if (evidence.likes === null || evidence.comments === null) return result("traction_unknown");
    return result(
      evidence.likes >= threshold.votes && evidence.comments >= threshold.comments
        ? "eligible"
        : "traction_too_low",
    );
  }

  if (
    !["youtube", "instagram", "linkedin", "tiktok", "x", "twitter", "threads", "facebook"].includes(
      platform,
    )
  )
    return result("unsupported_platform");
  if (evidence.followers === null) return result("followers_unknown");
  if (evidence.followers < DISCOVER_QUALITY_THRESHOLDS.social.followers)
    return result("audience_too_small");
  if (evidence.views === null && evidence.likes === null) return result("traction_unknown");
  return result(
    (evidence.views !== null && evidence.views >= DISCOVER_QUALITY_THRESHOLDS.social.views) ||
      (evidence.likes !== null && evidence.likes >= DISCOVER_QUALITY_THRESHOLDS.social.likes)
      ? "eligible"
      : "traction_too_low",
  );
}
