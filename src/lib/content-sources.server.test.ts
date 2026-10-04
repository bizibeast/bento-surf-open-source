import { describe, expect, it, vi } from "vitest";
import {
  canonicalizeContentSourceUrl,
  dedupeSourceItems,
  fetchGdeltStories,
  fetchHackerNewsStories,
  fetchRedditStories,
  fetchYouTubeStories,
  parseSyndicationFeed,
} from "./content-sources.server";

const rssFixture = `
  <rss><channel><title>Example</title>
    <item>
      <title><![CDATA[Creator AI launches today]]></title>
      <link>https://example.com/posts/one?utm_source=newsletter</link>
      <pubDate>Thu, 18 Sep 2026 08:00:00 GMT</pubDate>
      <description><![CDATA[A concise launch summary.]]></description>
    </item>
  </channel></rss>`;

describe("content sources", () => {
  it("accepts only bounded public HTTP(S) articles with source and publication time", () => {
    expect(parseSyndicationFeed(rssFixture, "https://example.com/feed.xml")).toEqual([
      expect.objectContaining({
        canonicalUrl: "https://example.com/posts/one",
        sourceName: "Example",
        publishedAt: "2026-09-18T08:00:00.000Z",
      }),
    ]);
    expect(() => canonicalizeContentSourceUrl("file:///etc/passwd")).toThrow();
    expect(() => canonicalizeContentSourceUrl("https://127.0.0.1/admin")).toThrow();
  });

  it("deduplicates tracking variants and near-identical headlines", () => {
    const base = {
      canonicalUrl: "https://example.com/post",
      title: "Creator AI launches today",
      summary: "Summary",
      sourceName: "Example",
      publishedAt: "2026-09-18T08:00:00.000Z",
      retrievedAt: "2026-09-18T09:00:00.000Z",
      kind: "rss" as const,
    };
    expect(
      dedupeSourceItems([
        base,
        { ...base, canonicalUrl: "https://example.com/post?utm_source=x" },
        { ...base, canonicalUrl: "https://other.com/story", title: "Creator AI launches today!" },
      ]),
    ).toHaveLength(1);
  });

  it("parses documented GDELT fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        articles: [
          {
            url: "https://publisher.com/news",
            title: "Creator tools update",
            seendate: "20260918T083000Z",
            domain: "publisher.com",
          },
        ],
      }),
    );
    await expect(
      fetchGdeltStories("creator tools", { fetcher, now: new Date("2026-09-18T09:00:00Z") }),
    ).resolves.toEqual([expect.objectContaining({ kind: "gdelt", sourceName: "publisher.com" })]);
  });

  it("filters the official Hacker News top stories by query", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("topstories.json")) return Response.json([1, 2]);
      if (url.includes("item/1")) {
        return Response.json({
          id: 1,
          title: "AI agents for creators",
          url: "https://creatornews.com/agents",
          time: 1_789_721_200,
        });
      }
      return Response.json({
        id: 2,
        title: "Email deliverability update",
        time: 1_789_721_200,
      });
    });
    const stories = await fetchHackerNewsStories("AI", { fetcher });
    expect(stories).toHaveLength(1);
    expect(stories[0]).toMatchObject({ kind: "hackernews", title: "AI agents for creators" });
  });

  it("skips YouTube search without the configured official API key", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(fetchYouTubeStories("creator AI", { fetcher, apiKey: "" })).resolves.toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("loads official YouTube statistics for top niche videos", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/search")) {
        return Response.json({
          items: [
            {
              id: { videoId: "video-1" },
              snippet: {
                title: "Creator AI systems",
                description: "A practical walkthrough",
                channelTitle: "Creator Lab",
                publishedAt: "2026-09-18T08:00:00Z",
                thumbnails: { high: { url: "https://img.youtube.com/video-1.jpg" } },
              },
            },
          ],
        });
      }
      return Response.json({
        items: [
          {
            id: "video-1",
            statistics: { viewCount: "120000", likeCount: "8400", commentCount: "320" },
          },
        ],
      });
    });
    await expect(fetchYouTubeStories("creator AI", { fetcher, apiKey: "test" })).resolves.toEqual([
      expect.objectContaining({
        platform: "YouTube",
        stats: { views: 120_000, likes: 8_400, comments: 320 },
      }),
    ]);
  });

  it("loads top Reddit posts with public engagement statistics", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: {
          children: [
            {
              data: {
                title: "How creators use AI agents",
                permalink: "/r/creators/comments/example/how_creators_use_ai_agents/",
                subreddit: "creators",
                author: "builder",
                created_utc: 1_789_721_200,
                score: 920,
                num_comments: 84,
                upvote_ratio: 0.94,
                selftext: "A practical workflow.",
              },
            },
          ],
        },
      }),
    );
    await expect(fetchRedditStories("creator AI", { fetcher })).resolves.toEqual([
      expect.objectContaining({
        platform: "Reddit",
        author: "builder",
        stats: { likes: 920, comments: 84, engagementRate: 0.94 },
      }),
    ]);
  });
});
