import { describe, expect, it } from "vitest";
import { discoverInspirationScore, rankDiscoverRecommendations } from "./content-discover-ranking";

const now = Date.parse("2026-10-10T18:00:00Z");
const source = { publishedAt: "2026-10-09T18:00:00Z", stats: { views: 20_000, likes: 500 } };

describe("Discover inspiration ranking", () => {
  it("puts recent relevant momentum ahead of an old all-time hit", () => {
    expect(discoverInspirationScore(source, 25, {}, now)).toBeGreaterThan(
      discoverInspirationScore(
        { publishedAt: "2023-10-01", stats: { views: 90_000_000 } },
        25,
        { followed: true },
        now,
      ),
    );
  });
  it("does not reward missing dates as newly published", () => {
    expect(discoverInspirationScore(source, 25, {}, now)).toBeGreaterThan(
      discoverInspirationScore({ ...source, publishedAt: null }, 25, {}, now),
    );
  });
  it("uses observed performance without turning unrelated fame into relevance", () => {
    expect(discoverInspirationScore(source, 30, {}, now)).toBeGreaterThan(
      discoverInspirationScore(
        { ...source, stats: { views: 99_000_000 } },
        0,
        { established: true },
        now,
      ),
    );
    expect(discoverInspirationScore(source, 30, {}, now)).toBeGreaterThan(
      discoverInspirationScore({ ...source, stats: {} }, 30, {}, now),
    );
  });
  it("puts a strong Brain match ahead of a weak match with celebrity affinity and huge metrics", () => {
    const relevant = discoverInspirationScore(
      { ...source, publishedAt: "2026-09-26T18:00:00Z" },
      30,
      {},
      now,
    );
    const famous = discoverInspirationScore(
      { ...source, stats: { followers: 90_000_000, views: 99_000_000, likes: 5_000_000 } },
      5,
      { followed: true, established: true },
      now,
    );
    expect(relevant).toBeGreaterThan(famous);
    expect(discoverInspirationScore(source, 0, { followed: true }, now)).toBe(0);
  });
  it("does not use audience size as a ranking boost or invalid metrics as evidence", () => {
    const score = discoverInspirationScore(source, 30, {}, now);
    expect(
      discoverInspirationScore(
        { ...source, stats: { ...source.stats, followers: 90_000_000 } },
        30,
        {},
        now,
      ),
    ).toBe(score);
    expect(
      discoverInspirationScore({ ...source, stats: { views: Infinity, likes: NaN } }, 30, {}, now),
    ).toBe(discoverInspirationScore({ ...source, stats: {} }, 30, {}, now));
    expect(discoverInspirationScore(source, NaN, {}, now)).toBe(0);
  });
  it("preserves the combined relevance and momentum rank across the one-week boundary", () => {
    const items = [
      { id: "weak-recent", sourcePublishedAt: source.publishedAt, relevanceScore: 20 },
      { id: "strong-recent", sourcePublishedAt: "2026-10-01T18:00:00Z", relevanceScore: 95 },
    ];
    expect(rankDiscoverRecommendations(items, now).map((item) => item.id)).toEqual([
      "strong-recent",
      "weak-recent",
    ]);
  });
  it("keeps a current post above an archived or undated cached high score", () => {
    const items = [
      { id: "archive", sourcePublishedAt: "2023-01-01", relevanceScore: 200 },
      { id: "unknown", sourcePublishedAt: null, relevanceScore: 300 },
      { id: "fresh", sourcePublishedAt: source.publishedAt, relevanceScore: 40 },
    ];
    expect(rankDiscoverRecommendations(items, now).map((item) => item.id)).toEqual([
      "fresh",
      "unknown",
      "archive",
    ]);
    expect(items[0].id).toBe("archive");
  });
});
