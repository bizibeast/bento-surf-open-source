import { describe, expect, it, vi } from "vitest";
import {
  canonicalizeContentSourceUrl,
  dedupeSourceItems,
  fetchGdeltStories,
  fetchHackerNewsStories,
  fetchHackerNewsStoryPage,
  fetchNewsStories,
  fetchRedditStories,
  fetchYouTubeStories,
  fetchYouTubeStoryPage,
  fetchSyndicationFeed,
  parseSyndicationFeed,
} from "./content-sources.server";

const fixtureNow = new Date("2026-10-10T12:00:00Z");

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
  it("searches Hacker News by niche without thirty individual story requests", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        hits: [
          {
            objectID: "42",
            title: "My startup journey",
            url: "https://example.com/founder",
            created_at_i: 1789721200,
            author: "founder",
            points: 200,
            num_comments: 12,
          },
        ],
      }),
    );
    const posts = await fetchHackerNewsStories("startup journey", { fetcher, now: fixtureNow });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain("hn.algolia.com/api/v1/search");
    expect(posts[0]).toMatchObject({ author: "founder", stats: { likes: 200, comments: 12 } });
  });
  it("uses Reddit's public Atom feed when JSON is blocked, preserving authors, dates and media", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Forbidden", { status: 403 }))
      .mockResolvedValueOnce(
        new Response(
          `<feed><title>startups</title><entry><author><name>/u/founder</name><uri>https://www.reddit.com/user/founder</uri></author><title>A startup lesson</title><link href="https://www.reddit.com/r/startups/comments/abc/lesson/"/><updated>2026-10-07T10:00:00Z</updated><content type="html">&lt;p&gt;Build &amp;amp; learn&lt;/p&gt;</content><media:thumbnail url="https://preview.redd.it/lesson.jpg"/></entry></feed>`,
        ),
      );
    const posts = await fetchRedditStories("", {
      profileUrl: "https://www.reddit.com/r/startups",
      fetcher,
      now: fixtureNow,
    });
    expect(String(fetcher.mock.calls[1][0])).toContain("/r/startups/new/.rss");
    expect(posts[0]).toMatchObject({
      author: "founder",
      authorUrl: "https://www.reddit.com/user/founder",
      platform: "Reddit",
      sourceName: "r/startups",
      thumbnailUrl: "https://preview.redd.it/lesson.jpg",
      publishedAt: "2026-10-07T10:00:00.000Z",
    });
    expect(posts[0].summary).not.toContain("<p>");
  });
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

  it("keeps GDELT crawl times separate from an unknown article publication date", async () => {
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
    ).resolves.toEqual([
      expect.objectContaining({ kind: "gdelt", sourceName: "publisher.com", publishedAt: null }),
    ]);
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
    const stories = await fetchHackerNewsStories("AI", { fetcher, now: fixtureNow });
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
    await expect(
      fetchYouTubeStories("creator AI", { fetcher, apiKey: "test", now: fixtureNow }),
    ).resolves.toEqual([
      expect.objectContaining({
        platform: "YouTube",
        stats: { views: 120_000, likes: 8_400, comments: 320, followers: null },
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
    await expect(fetchRedditStories("creator AI", { fetcher, now: fixtureNow })).resolves.toEqual([
      expect.objectContaining({
        platform: "Reddit",
        author: "builder",
        stats: { likes: 920, comments: 84, engagementRate: 0.94 },
      }),
    ]);
  });
});

it("retrieves a larger relevant recent YouTube pool in the requested locale and keeps videos when stats fail", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/search"))
      return Response.json({
        items: [
          {
            id: { videoId: "recent" },
            snippet: { title: "Recent comedy", publishedAt: "2026-10-05T08:00:00Z" },
          },
          {
            id: { videoId: "old" },
            snippet: { title: "Old comedy", publishedAt: "2023-10-05T08:00:00Z" },
          },
        ],
      });
    return new Response("Forbidden", { status: 403 });
  });
  const items = await fetchYouTubeStories("comedy", {
    fetcher,
    apiKey: "test",
    now: new Date("2026-10-06T08:00:00Z"),
    language: "en",
    region: "in",
  });
  const target = new URL(String(fetcher.mock.calls[0][0]));
  expect(target.searchParams.get("publishedAfter")).toBe("2026-09-06T08:00:00.000Z");
  expect(target.searchParams.get("maxResults")).toBe("50");
  expect(target.searchParams.get("order")).toBe("relevance");
  expect(target.searchParams.get("relevanceLanguage")).toBe("en");
  expect(target.searchParams.get("regionCode")).toBe("IN");
  expect(items).toHaveLength(1);
  expect(items[0].canonicalUrl).toContain("recent");
  expect(items[0].stats?.views).toBeNull();
});

it("automatically retries transient public API failures within a bounded attempt count", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
    .mockResolvedValueOnce(Response.json({ hits: [] }));
  await expect(fetchHackerNewsStories("AI", { fetcher, now: fixtureNow })).resolves.toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("rejects old Hacker News hits even when the provider ignores its requested date filter", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      hits: [
        {
          objectID: "old",
          title: "AI startup",
          created_at_i: Date.parse("2021-10-05T00:00:00Z") / 1000,
        },
        {
          objectID: "recent",
          title: "AI startup recent",
          created_at_i: Date.parse("2026-10-05T00:00:00Z") / 1000,
        },
      ],
    }),
  );
  const items = await fetchHackerNewsStories("startup", {
    fetcher,
    now: new Date("2026-10-06T00:00:00Z"),
  });
  expect(items).toHaveLength(1);
  const target = new URL(String(fetcher.mock.calls[0][0]));
  expect(target.searchParams.get("hitsPerPage")).toBe("6");
  expect(target.searchParams.get("numericFilters")).toBe(
    `created_at_i>${Date.parse("2026-09-06T00:00:00Z") / 1000}`,
  );
});

it("keeps distinct social posts with generic creator titles", () => {
  const base = {
    canonicalUrl: "https://instagram.com/p/one",
    title: "Instagram photo",
    summary: "A creator caption",
    sourceName: "Instagram",
    platform: "Instagram",
    kind: "social_search" as const,
    publishedAt: null,
    retrievedAt: "2026-10-10T00:00:00Z",
  };
  expect(
    dedupeSourceItems([
      base,
      { ...base, canonicalUrl: "https://instagram.com/p/two" },
      { ...base, canonicalUrl: "https://instagram.com/p/one?utm_source=x" },
    ]),
  ).toHaveLength(2);
});

it("follows public RSS redirects on Workers without accepting private redirect targets", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "/public-feed" } }),
    )
    .mockResolvedValueOnce(new Response(rssFixture));
  const items = await fetchSyndicationFeed("https://example.com/feed", fetcher);
  expect(items).toHaveLength(1);
  expect(fetcher.mock.calls.map(([, init]) => init?.redirect)).toEqual(["manual", "manual"]);
  expect(String(fetcher.mock.calls[1][0])).toBe("https://example.com/public-feed");
  const unsafe = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } }),
    );
  await expect(fetchSyndicationFeed("https://example.com/feed", unsafe)).rejects.toThrow(
    "public HTTPS",
  );
  expect(unsafe).toHaveBeenCalledTimes(1);
});

it("queries a bounded current news feed for the creator's niche", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(rssFixture));
  const items = await fetchNewsStories("startup founder", {
    fetcher,
    limit: 1,
    language: "en",
    region: "global",
  });
  const url = new URL(String(fetcher.mock.calls[0][0]));
  expect(url.hostname).toBe("news.google.com");
  expect(url.searchParams.get("q")).toContain("startup founder when:7d");
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "rss", publishedAt: "2026-09-18T08:00:00.000Z" });
});

it("uses real YouTube pagination and observed subscriber counts without turning hidden or missing counts into zero", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/search"))
      return Response.json({
        nextPageToken: "real-next-token",
        items: ["public", "hidden", "missing", "zero"].map((channelId) => ({
          id: { videoId: channelId },
          snippet: { title: `Comedy ${channelId}`, channelId, publishedAt: "2026-10-10T00:00:00Z" },
        })),
      });
    if (url.pathname.endsWith("/channels"))
      return Response.json({
        items: [
          { id: "public", statistics: { subscriberCount: "125000", hiddenSubscriberCount: false } },
          { id: "hidden", statistics: { subscriberCount: "50000", hiddenSubscriberCount: true } },
          { id: "missing", statistics: {} },
          { id: "zero", statistics: { subscriberCount: "0", hiddenSubscriberCount: false } },
        ],
      });
    return Response.json({ items: [] });
  });
  const page = await fetchYouTubeStoryPage("comedy", {
    fetcher,
    apiKey: "test",
    now: new Date("2026-10-11T00:00:00Z"),
    pageToken: "previous-token",
    publishedAfter: "2026-09-11T00:00:00Z",
    publishedBefore: "2026-10-11T00:00:00Z",
  });
  expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get("pageToken")).toBe(
    "previous-token",
  );
  expect(page.nextPageToken).toBe("real-next-token");
  expect(page.items.map((item) => item.stats?.followers)).toEqual([125000, null, null, 0]);
  const channels = fetcher.mock.calls.find(([input]) =>
    new URL(String(input)).pathname.endsWith("/channels"),
  );
  expect(new URL(String(channels![0])).searchParams.get("part")).toBe("snippet,statistics");
});

it("paginates Hacker News using real Algolia page metadata and preserves observed performance", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      page: 1,
      nbPages: 3,
      hits: [
        {
          objectID: "second-page",
          title: "Recent AI systems",
          url: "https://example.com/ai",
          created_at_i: Date.parse("2026-10-10T00:00:00Z") / 1000,
          points: 340,
          num_comments: 48,
        },
      ],
    }),
  );
  const page = await fetchHackerNewsStoryPage("AI", {
    fetcher,
    page: 1,
    limit: 30,
    now: new Date("2026-10-11T00:00:00Z"),
    publishedAfter: "2026-09-11T00:00:00Z",
    publishedBefore: "2026-10-11T00:00:00Z",
  });
  const url = new URL(String(fetcher.mock.calls[0][0]));
  expect(url.searchParams.get("page")).toBe("1");
  expect(url.searchParams.get("hitsPerPage")).toBe("30");
  expect(url.searchParams.get("numericFilters")).toContain(",created_at_i<");
  expect(page.nextPage).toBe(2);
  expect(page.items[0]).toMatchObject({
    platform: "Hacker News",
    publishedAt: "2026-10-10T00:00:00.000Z",
    stats: { likes: 340, comments: 48 },
  });
});

it("does not recycle Hacker News top stories when a continuation fails", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("Forbidden", { status: 403 }));
  await expect(fetchHackerNewsStoryPage("AI", { fetcher, page: 1 })).rejects.toThrow("403");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0][0])).toContain("hn.algolia.com");
});
