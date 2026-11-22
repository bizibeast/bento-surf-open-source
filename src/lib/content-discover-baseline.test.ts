import { describe, expect, it } from "vitest";
import { measureDiscoverBaselines } from "./content-discover-baseline";
import type { ContentSourceItem } from "./content-sources.server";

const now = Date.parse("2026-11-15T12:00:00Z");
function post(day: number, counts: ContentSourceItem["stats"] = { views: 40 }): ContentSourceItem {
  const publishedAt = `2026-11-${String(day).padStart(2, "0")}T00:00:00Z`;
  return {
    canonicalUrl: `https://www.instagram.com/reel/post-${day}`,
    title: "Research",
    summary: "",
    sourceName: "Instagram",
    platform: "Instagram",
    authorUrl: "https://www.instagram.com/creator",
    kind: "social_search",
    publishedAt,
    retrievedAt: publishedAt.replace("T00:", "T03:"),
    stats: counts,
  };
}

describe("cached Discover creator baseline", () => {
  it("requires five measured prior posts from the same creator, format and age window", () => {
    const target = post(13);
    const fourPeers = [1, 2, 3, 4].map((day) => post(day));
    const otherCreator = { ...post(5), authorUrl: "https://www.instagram.com/other" };
    const laterObserved = { ...post(6), retrievedAt: "2026-11-10T00:00:00Z" };
    const differentFormat = {
      ...post(7),
      canonicalUrl: "https://www.instagram.com/p/post-7",
      mediaType: "carousel" as const,
    };
    const duplicate = { ...fourPeers[0], canonicalUrl: "https://instagram.com/reel/post-1/" };
    expect(
      measureDiscoverBaselines(
        [target],
        [target, ...fourPeers, otherCreator, laterObserved, differentFormat, duplicate],
        now,
      ).size,
    ).toBe(0);
  });

  it("preserves zero measured likes and uses them when views have no comparable median", () => {
    const target = post(13, { views: 40, likes: 0 });
    const evidence = [1, 2, 3, 4, 5].map((day) => post(day, { views: 0, likes: day * 10 }));
    expect(
      measureDiscoverBaselines([target], evidence, now).get("instagram:post-13"),
    ).toMatchObject({ metric: "likes", observed: 0, median: 30, ratio: 0, sampleSize: 5 });
  });
});
