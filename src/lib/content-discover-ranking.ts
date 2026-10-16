import { sourceFreshnessTier, sourcePublicationTime } from "./content-source-recency";
import type { ContentSourceStats } from "./content-sources.server";

/** Bounded, age-adjusted evidence; this is a ranking score, never a claimed outlier metric. */
export function discoverInspirationScore(
  source: { publishedAt: string | null; stats?: ContentSourceStats },
  relevance: number,
  affinity: { followed?: boolean; established?: boolean } = {},
  now = Date.now(),
) {
  const fit = Number.isFinite(relevance) ? Math.max(0, Math.min(70, relevance)) : 0;
  if (!fit) return 0;
  const published = sourcePublicationTime(source.publishedAt, now);
  const ageDays = published === null ? null : Math.max(0, (now - published) / 86_400_000);
  if (ageDays !== null && ageDays > 30) return Math.round(fit * 0.1);
  const stats = source.stats || {};
  const observedCount = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  const observed =
    observedCount(stats.views) / 20 +
    observedCount(stats.likes) +
    observedCount(stats.comments) * 3 +
    observedCount(stats.shares) * 5 +
    observedCount(stats.saves) * 5;
  const evidence = Math.min(16, Math.log10(1 + observed / Math.max(1, ageDays || 1)) * 4);
  const fresh = ageDays === null ? 0 : 30 * Math.exp(-ageDays / 10);
  const creator = affinity.followed ? 10 : affinity.established ? 6 : 0;
  // Popularity and creator affinity support the Brain match; they cannot supply it.
  // Audience size is only an admission gate, never a reason to outrank a better fit.
  const fitWeight = Math.min(1, fit / 20);
  return Math.round((fit * 2 + (fresh + evidence + creator) * fitWeight) * 10) / 10;
}

/** Stored feeds cannot let an old cache score turn an archive into today's inspiration. */
export function rankDiscoverRecommendations<
  T extends { sourcePublishedAt: string | null; relevanceScore?: number },
>(items: T[], now = Date.now()): T[] {
  return [...items].sort(
    (a, b) =>
      Math.min(2, sourceFreshnessTier(b.sourcePublishedAt, now)) -
        Math.min(2, sourceFreshnessTier(a.sourcePublishedAt, now)) ||
      (b.relevanceScore || 0) - (a.relevanceScore || 0) ||
      (sourcePublicationTime(b.sourcePublishedAt, now) || 0) -
        (sourcePublicationTime(a.sourcePublishedAt, now) || 0),
  );
}
