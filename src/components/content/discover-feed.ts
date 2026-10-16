import type { DiscoverRecommendation } from "@/lib/content-discovery.functions";
import { discoverPostKey } from "@/lib/content-discover-identity";
import { creatorKey, platformName } from "./discover-utils";

export function publishedWithin(item: DiscoverRecommendation, days: number, now: Date) {
  if (!days) return true;
  const published = Date.parse(item.sourcePublishedAt || "");
  return (
    Number.isFinite(published) &&
    published <= now.getTime() &&
    published >= now.getTime() - days * 86_400_000
  );
}

/** Rank every distinct post; diversity changes order, never the available inventory. */
export function curateDiscoverPosts(items: DiscoverRecommendation[], now: Date) {
  const ranked = items
    .map((item) => {
      const age = (now.getTime() - Date.parse(item.sourcePublishedAt || "")) / 86_400_000;
      const recency = Number.isFinite(age) && age >= 0 ? Math.max(0, 30 - age) : 0;
      const metrics = [item.stats?.views, item.stats?.likes].filter(
        (value): value is number => typeof value === "number" && Number.isFinite(value),
      );
      const evidence = Math.min(8, Math.log10(1 + Math.max(0, ...metrics)));
      return {
        item,
        score: (item.relevanceScore || 0) + recency + evidence,
        creator: creatorKey(item),
        platform: platformName(item).toLowerCase(),
      };
    })
    .sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const remaining = ranked.filter(({ item }) => {
    const key = discoverPostKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const selected: DiscoverRecommendation[] = [];
  const recent: typeof ranked = [];
  while (remaining.length) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < remaining.length; index++) {
      const candidate = remaining[index];
      // Bounded, local penalties let similarly relevant creators alternate while
      // preserving a strong relevance/freshness advantage over weaker matches.
      const creatorRepeats = recent.filter((item) => item.creator === candidate.creator).length;
      const platformRepeats = recent
        .slice(-3)
        .filter((item) => item.platform === candidate.platform).length;
      const score = candidate.score - creatorRepeats * 8 - platformRepeats * 4;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    const [next] = remaining.splice(bestIndex, 1);
    selected.push(next.item);
    recent.push(next);
    if (recent.length > 6) recent.shift();
  }
  return selected;
}
