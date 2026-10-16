import { expect, it, vi } from "vitest";
import {
  creatorMatchesSource,
  normalizeDiscoverCreator,
  trackDiscoverCreatorSchema,
} from "./content-discover-creators";
import { fetchTrackedCreatorPosts } from "./content-discover-follows.server";

it("normalizes supported profiles and communities while rejecting posts, spoofed hosts and private targets", () => {
  expect(normalizeDiscoverCreator("https://reddit.com/u/Alice/")).toMatchObject({
    profileUrl: "https://www.reddit.com/user/alice",
    platform: "Reddit",
  });
  expect(normalizeDiscoverCreator("https://www.facebook.com/zuck?ref=search")).toMatchObject({
    name: "zuck",
    profileUrl: "https://www.facebook.com/zuck",
  });
  expect(
    normalizeDiscoverCreator("https://www.facebook.com/profile.php?id=123").profileUrl,
  ).toContain("?id=123");
  for (const url of [
    "https://facebook.com.evil.test/zuck",
    "http://facebook.com/zuck",
    "https://127.0.0.1/a",
    "https://www.facebook.com/reel/123",
    "https://www.instagram.com/p/ABC",
    "https://name:pass@facebook.com/zuck",
    "https://reddit.com/r/",
  ])
    expect(trackDiscoverCreatorSchema.safeParse({ profileUrl: url }).success).toBe(false);
});

it("matches creator ownership without matching similarly named creators", () => {
  const creator = { profileUrl: "https://www.facebook.com/alice", platform: "Facebook" };
  expect(
    creatorMatchesSource(creator, { canonicalUrl: "https://facebook.com/alice/posts/123" }),
  ).toBe(true);
  expect(
    creatorMatchesSource(creator, { canonicalUrl: "https://facebook.com/alice2/posts/123" }),
  ).toBe(false);
  expect(
    creatorMatchesSource(
      { profileUrl: "https://www.reddit.com/r/startups", platform: "Reddit" },
      { sourceUrl: "https://www.reddit.com/r/startups/comments/abc/story" },
    ),
  ).toBe(true);
  const numeric = {
    profileUrl: "https://www.facebook.com/profile.php?id=123",
    platform: "Facebook",
  };
  expect(
    creatorMatchesSource(numeric, {
      sourceUrl: "https://www.facebook.com/permalink.php?story_fbid=99&id=123",
    }),
  ).toBe(true);
  expect(
    creatorMatchesSource(numeric, {
      sourceUrl: "https://www.facebook.com/permalink.php?story_fbid=99&id=999",
    }),
  ).toBe(false);
});

it("falls back after Reddit blocks the JSON API and excludes unrelated indexed results", async () => {
  const creator = {
    id: "a",
    profileUrl: "https://www.reddit.com/r/startups",
    platform: "Reddit",
    name: "Startups",
    topics: "",
    avatarUrl: null,
  };
  const posts = [
    { canonicalUrl: `${creator.profileUrl}/comments/abc/story`, title: "Startup story" },
    { canonicalUrl: "https://www.reddit.com/r/pics/comments/other/story", title: "Other" },
  ];
  const dependencies = {
    reddit: vi.fn().mockRejectedValue(new Error("403")),
    search: vi.fn().mockResolvedValue(posts),
    enrich: vi.fn(async (items) => items),
  };
  const results = await fetchTrackedCreatorPosts(
    creator,
    { language: "en", region: "global" },
    dependencies,
  );
  expect(dependencies.search).toHaveBeenCalledWith(
    expect.objectContaining({ group: "site:reddit.com/r/startups/comments/" }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(results).toEqual([posts[0]]);
});
