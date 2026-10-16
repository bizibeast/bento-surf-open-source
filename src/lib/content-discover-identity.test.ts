import { describe, expect, it } from "vitest";
import {
  discoverPostKey,
  uniqueDiscoverPosts,
  visibleDiscoverRecommendations,
} from "./content-discover-identity";
import { storedDiscoverData } from "./content-discovery.functions";
import type { DiscoverRecommendation } from "./content-discovery.functions";
const post = {
  id: "post",
  fingerprint: "trend:a",
  kind: "trend",
  sourceUrl: "https://example.com/post",
  feedback: "pending",
} as DiscoverRecommendation;
describe("Discover source identity", () => {
  it.each([
    [
      "https://www.linkedin.com/posts/founder_launch-activity-123456-abc?trk=share",
      "https://linkedin.com/feed/update/urn:li:activity:123456/",
    ],
    [
      "https://facebook.com/founder/posts/987654?mibextid=share",
      "https://www.facebook.com/permalink.php?story_fbid=987654&id=123",
    ],
    [
      "https://tiktok.com/@founder/video/123456?is_from_webapp=1",
      "https://www.tiktok.com/@founder/video/123456",
    ],
    ["https://twitter.com/alex/status/123?s=20", "https://www.x.com/alex/status/123/photo/1"],
    ["https://youtu.be/abcdefghijk?si=ref", "https://youtube.com/shorts/abcdefghijk"],
    ["https://instagram.com/p/AbCd/?igsh=share", "https://www.instagram.com/reel/AbCd"],
    ["https://example.com/post/?utm_source=email#title", "https://www.example.com/post"],
  ])("recognizes %s and %s as the same post", (a, b) => {
    expect(discoverPostKey({ sourceUrl: a })).toBe(discoverPostKey({ sourceUrl: b }));
  });
  it("does not collapse different posts with the same caption or missing URLs", () => {
    expect(
      uniqueDiscoverPosts([post, { ...post, id: "other", sourceUrl: "https://example.com/other" }]),
    ).toHaveLength(2);
    expect(
      uniqueDiscoverPosts([
        { ...post, sourceUrl: null },
        { ...post, id: "b", fingerprint: "trend:b", sourceUrl: null },
      ]),
    ).toHaveLength(2);
  });
  it("keeps a rejected source hidden across aliases, ideas and a stored-feed reload", () => {
    const posts = [
      { ...post, feedback: "not_relevant" as const },
      {
        ...post,
        id: "idea",
        fingerprint: "idea:a",
        kind: "idea" as const,
        sourceUrl: `${post.sourceUrl}/?utm_source=social`,
      },
    ];
    expect(visibleDiscoverRecommendations(posts)).toEqual([]);
    expect(storedDiscoverData(posts, null)).toMatchObject({ trends: [], ideas: [] });
  });
});
