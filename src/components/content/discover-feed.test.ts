import { describe, expect, it } from "vitest";
import type { DiscoverRecommendation } from "@/lib/content-discovery.functions";
import { curateDiscoverPosts, publishedWithin } from "./discover-feed";

const now = new Date("2026-10-11T12:00:00Z");
const post = (id: string, changes: Partial<DiscoverRecommendation> = {}) =>
  ({
    id,
    sourceUrl: `https://example.com/${id}`,
    author: "Creator",
    platform: "YouTube",
    sourcePublishedAt: "2026-10-10T12:00:00Z",
    relevanceScore: 10,
    ...changes,
  }) as DiscoverRecommendation;

describe("Discover freshness and curation", () => {
  it("requires a real date within the requested period, excluding future and unknown dates", () => {
    for (const date of [null, "not a date", "2023-01-01", "2026-10-12"])
      expect(publishedWithin(post("bad", { sourcePublishedAt: date }), 30, now)).toBe(false);
    expect(publishedWithin(post("recent"), 7, now)).toBe(true);
    expect(
      publishedWithin(post("boundary", { sourcePublishedAt: "2026-10-04T12:00:00Z" }), 7, now),
    ).toBe(true);
    expect(publishedWithin(post("unknown", { sourcePublishedAt: null }), 0, now)).toBe(true);
  });
  it("interleaves creators and platforms without dropping posts from prolific sources", () => {
    const posts = Array.from({ length: 24 }, (_, index) => post(`youtube-${index}`));
    const instagram = post("instagram", {
      platform: "Instagram",
      author: "Another creator",
      relevanceScore: 5,
    });
    const comedy = post("comedy", { author: "Comedy creator", relevanceScore: 8 });
    const curated = curateDiscoverPosts([...posts, instagram, comedy], now);
    expect(curated.slice(0, 3)).toEqual([posts[0], instagram, comedy]);
    expect(curated).toHaveLength(26);
    expect(curated.filter((item) => item.author === "Creator")).toHaveLength(24);
    expect(new Set(curated.map((item) => item.id)).size).toBe(curated.length);
  });
  it("retains the highest-ranked representation of each canonical source without recycling aliases", () => {
    const original = post("original", {
      sourceUrl: "https://www.youtube.com/watch?v=video-id&utm_source=search",
      relevanceScore: 20,
    });
    const alias = post("alias", { sourceUrl: "https://youtu.be/video-id?si=share" });
    const other = post("other");
    expect(curateDiscoverPosts([alias, other, original, original], now)).toEqual([original, other]);
  });
  it("keeps relevance ahead of diversity when another platform only has weak old matches", () => {
    const relevant = Array.from({ length: 4 }, (_, index) =>
      post(`relevant-${index}`, { relevanceScore: 80 }),
    );
    const weak = post("weak", {
      platform: "Instagram",
      relevanceScore: 0,
      sourcePublishedAt: "2023-10-01T12:00:00Z",
      stats: { likes: 9_000_000 },
    });
    expect(curateDiscoverPosts([weak, ...relevant], now)).toEqual([...relevant, weak]);
  });
  it("rewards fresh relevant inspiration even when its public metrics are unavailable", () => {
    const oldPopular = post("popular", {
      sourcePublishedAt: "2026-09-12T12:00:00Z",
      stats: { views: 9_000_000 },
    });
    const fresh = post("fresh", { stats: {} });
    expect(curateDiscoverPosts([oldPopular, fresh], now)[0]).toBe(fresh);
  });
});
