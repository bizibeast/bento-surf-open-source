import { describe, expect, it } from "vitest";
import type { SocialContentInsight } from "./social-content-insights.server";
import { creatorPerformancePatterns, rankCreatorPosts } from "./content-discovery";

function insight(overrides: Partial<SocialContentInsight> = {}): SocialContentInsight {
  return {
    connectionId: "connection",
    provider: "linkedin",
    remotePostId: crypto.randomUUID(),
    remotePostUrl: null,
    contentType: "text",
    caption: "A creator post",
    thumbnailUrl: null,
    publishedAt: "2026-09-18T00:00:00.000Z",
    views: null,
    impressions: null,
    reach: null,
    engagements: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    fetchedAt: "2026-09-18T01:00:00.000Z",
    ...overrides,
  };
}

describe("content discovery ranking", () => {
  it("ranks within provider and content type instead of comparing raw cross-platform totals", () => {
    const ranked = rankCreatorPosts(
      [
        insight({ provider: "linkedin", impressions: 1_000, engagements: 80 }),
        insight({ provider: "linkedin", impressions: 400, engagements: 16 }),
        insight({ provider: "tiktok", contentType: "video", views: 50_000, engagements: 600 }),
        insight({ provider: "tiktok", contentType: "video", views: 100_000, engagements: 700 }),
      ],
      4,
    );
    expect(ranked[0]).toMatchObject({ provider: "linkedin", metric: "impressions" });
    expect(ranked[0].outlierScore).toBeCloseTo(1.43, 2);
    expect(ranked.find((item) => item.provider === "tiktok")?.metric).toBe("views");
  });

  it("preserves unavailable metrics instead of treating them as zero", () => {
    expect(
      rankCreatorPosts([insight({ views: null, impressions: null, engagements: null })], 1)[0],
    ).toMatchObject({ metric: null, value: null, outlierScore: null });
  });

  it("does not claim a performance pattern without three comparable posts", () => {
    expect(
      creatorPerformancePatterns([insight({ impressions: 100 }), insight({ impressions: 200 })]),
    ).toEqual([]);
    expect(
      creatorPerformancePatterns([
        insight({ impressions: 100 }),
        insight({ impressions: 200 }),
        insight({ impressions: 300 }),
      ]),
    ).toEqual([
      expect.objectContaining({
        provider: "linkedin",
        contentType: "text",
        metric: "impressions",
        posts: 3,
        averageValue: 200,
      }),
    ]);
  });

  it("returns the requested number of winners with null-ranked posts last", () => {
    const ranked = rankCreatorPosts(
      [
        insight({ remotePostId: "missing" }),
        insight({ remotePostId: "low", impressions: 100 }),
        insight({ remotePostId: "high", impressions: 500 }),
      ],
      2,
    );
    expect(ranked.map((item) => item.remotePostId)).toEqual(["high", "low"]);
  });
});
