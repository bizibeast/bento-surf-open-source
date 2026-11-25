import { describe, it, expect, vi } from "vitest";
import { normalizePublicPostUrl, PUBLIC_POST_STATS_PATH } from "./public-post-stats";
import { publicPostCountEvidence } from "./content-source-enrichment.server";
import { readPublicPostStats, handlePublicPostStatsRequest } from "./public-post-stats.server";
import { ProviderBudgetError } from "./provider-budget.server";

const instagram = "https://instagram.com/reel/ExactPost";
const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });
const json = (data: unknown) => `<script type="application/json">${JSON.stringify(data)}</script>`;
const schema = (data: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

describe("public post link stats", () => {
  it("keeps public Instagram reads signed out even when global platform credentials exist", async () => {
    vi.stubEnv("INSTAGRAM_ACCESS_TOKEN", "configured-owner-token");
    vi.stubEnv("INSTAGRAM_BUSINESS_ACCOUNT_ID", "12345");
    const platformFetch = vi
      .fn()
      .mockRejectedValue(new Error("Unexpected authenticated platform read"));
    vi.stubGlobal("fetch", platformFetch);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          sourceUrl: instagram,
          counts: { likes: 12, comments: 3 },
          method: "instagram-download-metadata",
          authorHandle: "creator",
        }),
      )
      .mockResolvedValue(html("<title>Public preview</title>"));
    try {
      const result = await readPublicPostStats(instagram, {
        cache: null,
        fetcher,
        suppressRendered: true,
        env: {
          COBALT_API_URL: "https://media.test.bento.surf",
          COBALT_API_KEY: "internal-service",
        },
      });
      expect(result.authorHandle).toBe("creator");
      expect(result.metrics.find((metric) => metric.key === "likes")?.value).toBe(12);
      expect(platformFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("keeps suspected Instagram embed zeros unverified and attributes a rendered supplement", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          sourceUrl: instagram,
          counts: { likes: 0, comments: 5 },
          method: "instagram-download-metadata",
          authorHandle: "creator",
        }),
      )
      .mockResolvedValue(html("<title>Login</title>"));
    const rendered = vi.fn().mockResolvedValue({
      value: json({ shortcode: "ExactPost", like_count: 42, video_view_count: 100 }),
    });
    const result = await readPublicPostStats(instagram, {
      cache: null,
      fetcher,
      rendered,
      env: { COBALT_API_URL: "https://media.test.bento.surf", COBALT_API_KEY: "service" },
    });
    expect(result.authorHandle).toBe("creator");
    expect(result.metrics.find((metric) => metric.key === "likes")).toMatchObject({
      value: 42,
      evidence: { kind: "rendered_page", precision: "unknown", visibility: "public" },
    });
    expect(rendered).toHaveBeenCalledOnce();
  });
  it("keeps existing public counters when rendering is budget-denied and never retries", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          sourceUrl: instagram,
          counts: { likes: 0, comments: 5 },
          method: "instagram-download-metadata",
        }),
      )
      .mockResolvedValue(html("<title>Login</title>"));
    const rendered = vi.fn().mockRejectedValue(new Error("Budget denied"));
    const result = await readPublicPostStats(instagram, {
      cache: null,
      fetcher,
      rendered,
      env: { COBALT_API_URL: "https://media.test.bento.surf", COBALT_API_KEY: "service" },
    });
    expect(result.metrics.find((metric) => metric.key === "likes")).toMatchObject({
      value: null,
      availability: "unverified",
    });
    expect(result.metrics.find((metric) => metric.key === "comments")?.value).toBe(5);
    expect(rendered).toHaveBeenCalledOnce();
  });
  it("uses extractor counters as the primary path instead of stopping at incomplete HTML", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        counts: { views: 200, likes: 30, comments: 4 },
        method: "native-video-extractor",
      }),
    );
    const reserve = vi.fn().mockResolvedValue(undefined);
    const result = await readPublicPostStats("https://youtu.be/dQw4w9WgXcQ", {
      fetcher,
      cache: null,
      reserve,
      env: {
        COBALT_API_URL: "https://media.test.bento.surf",
        COBALT_API_KEY: "private-app-service-token",
      },
    });
    expect(result.status).toBe("available");
    expect(result.metrics.map((m) => m.value)).toEqual([200, 30, 4]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0][0])).toBe("https://media.test.bento.surf/post-stats");
    expect(reserve).toHaveBeenCalledWith("mcp_media_resolutions", 1);
  });
  it("does not conceal operational quota failures as missing public counters", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "busy" }, { status: 429 }));
    await expect(
      readPublicPostStats("https://x.com/owner/status/123", {
        fetcher,
        cache: null,
        env: {
          COBALT_API_URL: "https://media.test.bento.surf",
          COBALT_API_KEY: "private-app-service-token",
        },
      }),
    ).rejects.toMatchObject({ statusCode: 429 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("retains complete matching metadata before oversized recommendation markup without reading an unbounded body", async () => {
    const body =
      "var ytInitialPlayerResponse = " +
      JSON.stringify({ videoDetails: { videoId: "dQw4w9WgXcQ", viewCount: "42" } }) +
      ";" +
      "x".repeat(1_600_000);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(body));
    const result = await readPublicPostStats("https://youtube.com/watch?v=dQw4w9WgXcQ", {
      fetcher,
      cache: null,
    });
    expect(result.metrics.find((m) => m.key === "views")?.value).toBe(42);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("reads X's public embed with no API credential and never uses a quoted post", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id_str: "123",
        favorite_count: 0,
        conversation_count: 8,
        quoted_tweet: { id_str: "999", favorite_count: 999999 },
      }),
    );
    const result = await readPublicPostStats("https://x.com/name/status/123", {
      fetcher,
      cache: null,
    });
    expect(result.metrics.find((m) => m.key === "likes")?.value).toBe(0);
    expect(result.metrics.find((m) => m.key === "comments")?.value).toBe(8);
    expect(result.metrics.find((m) => m.key === "views")?.value).toBeNull();
    expect(new URL(String(fetcher.mock.calls[0][0])).hostname).toBe("cdn.syndication.twimg.com");
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({ Accept: "application/json" });
    fetcher.mockResolvedValue(Response.json({ id_str: "999", favorite_count: 999999 }));
    expect(
      (await readPublicPostStats("https://x.com/name/status/123", { fetcher, cache: null })).status,
    ).toBe("unavailable");
  });
  it("normalizes supported posts and rejects profiles, credential URLs and lookalike hosts", () => {
    for (const link of [
      instagram,
      "https://www.linkedin.com/posts/alex_news-activity-12345-abcd",
      "https://linkedin.com/feed/update/urn:li:activity:12345/",
      "https://x.com/person/status/12345",
      "https://www.tiktok.com/@artist/video/12345",
      "https://www.facebook.com/reel/12345",
      "https://threads.net/@person/post/exact",
      "https://reddit.com/r/test/comments/abc123/title",
    ]) {
      expect(normalizePublicPostUrl(link)).not.toBeNull();
    }
    expect(normalizePublicPostUrl("https://youtu.be/dQw4w9WgXcQ?si=ignored")).toMatchObject({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(normalizePublicPostUrl("https://m.youtube.com/shorts/dQw4w9WgXcQ")).toMatchObject({
      platform: "YouTube",
    });
    for (const bad of [
      "http://instagram.com/reel/abc",
      "https://instagram.com.evil.example/reel/abc",
      "https://127.0.0.1/reel/abc",
      "https://user:password@instagram.com/reel/abc",
      "https://instagram.com:8443/reel/abc",
      "https://instagram.com/person/",
      "https://youtube.com/watch?v=bad",
      "https://linkedin.com/in/person",
      "https://example.com/video/123",
    ]) {
      expect(normalizePublicPostUrl(bad)).toBeNull();
    }
    expect(normalizePublicPostUrl(instagram + "?token=secret&utm_source=test#private")?.url).toBe(
      instagram,
    );
  });
  it("reads the exact TikTok video including zero; ignores related and account totals", () => {
    const body = json({
      related: { id: "999", stats: { playCount: 999999 } },
      post: {
        id: "12345",
        stats: { playCount: 82, diggCount: 0, commentCount: 3, shareCount: 4, collectCount: 7 },
        authorStats: { followerCount: 99999 },
      },
    });
    expect(publicPostCountEvidence(body, "https://tiktok.com/@artist/video/12345")).toEqual({
      views: 82,
      likes: 0,
      comments: 3,
      shares: 4,
      saves: 7,
    });
  });
  it("keeps Instagram related counters out and does not turn missing counters into zero", () => {
    expect(
      publicPostCountEvidence(
        json([
          { shortcode: "Other", like_count: 1000 },
          { shortcode: "ExactPost", like_count: 0, comment_count: 3, play_count: 10 },
        ]),
        instagram,
      ),
    ).toEqual({ likes: 0, comments: 3, views: 10 });
    expect(
      publicPostCountEvidence(json({ shortcode: "Other", like_count: 1000 }), instagram),
    ).toEqual({});
  });
  it("returns shares and saves only when exposed on the matching public Instagram item", () => {
    expect(
      publicPostCountEvidence(
        json([
          { shortcode: "Other", reshare_count: 999 },
          { shortcode: "ExactPost", reshare_count: 4, save_count: 0 },
        ]),
        instagram,
      ),
    ).toEqual({ shares: 4, saves: 0 });
  });
  it("matches LinkedIn structured data to the requested activity and labels reposts separately", () => {
    const post = (url: string, n: number) => ({
      "@type": "SocialMediaPosting",
      url,
      commentCount: n,
      interactionStatistic: [
        {
          "@type": "InteractionCounter",
          interactionType: "https://schema.org/LikeAction",
          userInteractionCount: n,
        },
        { interactionType: "https://schema.org/ShareAction", userInteractionCount: 2 },
      ],
    });
    const requested = "https://linkedin.com/feed/update/urn:li:activity:12345";
    expect(
      publicPostCountEvidence(
        schema([
          post("https://linkedin.com/posts/a-activity-99999-z", 999),
          post("https://linkedin.com/posts/a-activity-12345-z", 5),
        ]),
        requested,
      ),
    ).toEqual({ likes: 5, comments: 5, reposts: 2 });
    expect(
      publicPostCountEvidence(
        schema({ "@type": "SocialMediaPosting", commentCount: 999 }),
        requested,
      ),
    ).toEqual({});
  });
  it("does not borrow counts from quoted X posts", () => {
    const body = json({
      rest_id: "123",
      legacy: { favorite_count: 0, reply_count: 2, retweet_count: 3, quote_count: 4 },
      views: { count: "80" },
      quoted_status_result: {
        result: {
          rest_id: "999",
          legacy: { favorite_count: 999, retweet_count: 999, quote_count: 999 },
        },
      },
    });
    expect(publicPostCountEvidence(body, "https://x.com/name/status/123")).toEqual({
      likes: 0,
      comments: 2,
      reposts: 3,
      quotes: 4,
      views: 80,
    });
  });
  it("reads YouTube views only when the player response matches the video ID", () => {
    const body =
      "var ytInitialPlayerResponse = " +
      JSON.stringify({ videoDetails: { videoId: "dQw4w9WgXcQ", viewCount: "123" } }) +
      ";";
    expect(publicPostCountEvidence(body, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({
      views: 123,
    });
    expect(publicPostCountEvidence(body, "https://www.youtube.com/watch?v=abcdefghijk")).toEqual(
      {},
    );
  });
  it("uses YouTube's main-video like entity and ignores related-video counters", () => {
    const main = [
      {
        videoPrimaryInfoRenderer: {
          videoActions: {
            menuRenderer: {
              topLevelButtons: [
                {
                  segmentedLikeDislikeButtonViewModel: {
                    likeCountEntity: { likeCountIfIndifferentNumber: "1234" },
                  },
                },
              ],
            },
          },
        },
      },
      {
        itemSectionRenderer: {
          header: {
            commentsHeaderRenderer: {
              countText: { runs: [{ text: "567" }, { text: "Comments" }] },
            },
          },
        },
      },
    ];
    const data = {
      currentVideoEndpoint: { watchEndpoint: { videoId: "dQw4w9WgXcQ" } },
      contents: { twoColumnWatchNextResults: { results: { results: { contents: main } } } },
      secondaryResults: { likeCountIfIndifferentNumber: "999999" },
    };
    const body = `var ytInitialData = ${JSON.stringify(data)};`;
    expect(publicPostCountEvidence(body, "https://youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({
      likes: 1234,
      comments: 567,
    });
    expect(publicPostCountEvidence(body, "https://youtube.com/watch?v=abcdefghijk")).toEqual({});
  });
  it("labels Reddit score accurately, including negative scores", () => {
    expect(
      publicPostCountEvidence(
        '<shreddit-post id="t3_abc123" score="-3" comment-count="0">',
        "https://reddit.com/r/test/comments/abc123/title",
      ),
    ).toEqual({ score: -3, comments: 0 });
  });
  it("returns a partial public snapshot and caches it without another provider reservation", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(html(json({ shortcode: "ExactPost", like_count: 0 })));
    let cached: Response | undefined;
    const cache = {
      match: vi.fn(async () => cached?.clone()),
      put: vi.fn(async (_key: RequestInfo | URL, r: Response) => {
        cached = r.clone();
      }),
    };
    const reserve = vi.fn().mockResolvedValue(undefined);
    const result = await readPublicPostStats(instagram, {
      fetcher,
      cache,
      trustedMcpWorkspaceId: "workspace",
      reserve,
    });
    expect(result.status).toBe("partial");
    expect(result.metrics.find((m) => m.key === "likes")?.value).toBe(0);
    expect(result.metrics.find((m) => m.key === "shares")?.value).toBeNull();
    const again = await readPublicPostStats(instagram, {
      fetcher,
      cache,
      trustedMcpWorkspaceId: "workspace",
      reserve,
    });
    expect(again.cached).toBe(true);
    expect(again.retrievedAt).toBe(result.retrievedAt);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledOnce();
  });
  it("blocks unsafe and changed-identity redirects without following them", async () => {
    for (const location of [
      "http://127.0.0.1/secret",
      "https://instagram.com/reel/Different",
      "https://example.com/video",
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
      const result = await readPublicPostStats(instagram, { fetcher, cache: null });
      expect(result.status).toBe("unavailable");
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it("follows a validated www/trailing-slash redirect without canonicalizing it into a loop", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: "https://www.instagram.com/reel/ExactPost/" },
        }),
      )
      .mockResolvedValueOnce(html(json({ shortcode: "ExactPost", like_count: 7 })));
    const result = await readPublicPostStats(instagram, { fetcher, cache: null });
    expect(result.metrics.find((m) => m.key === "likes")?.value).toBe(7);
    expect(fetcher.mock.calls[1][0]).toBe("https://www.instagram.com/reel/ExactPost/");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("resolves a TikTok short link within the same platform and bounds redirect loops", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://www.tiktok.com/@artist/video/12345" },
        }),
      )
      .mockResolvedValueOnce(html(json({ id: "12345", stats: { playCount: 9 } })));
    expect(
      await readPublicPostStats("https://vm.tiktok.com/abc123", { fetcher, cache: null }),
    ).toMatchObject({ sourceUrl: "https://tiktok.com/@artist/video/12345", status: "partial" });
    const looping = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: instagram } }));
    await readPublicPostStats(instagram, { fetcher: looping, cache: null });
    expect(looping).toHaveBeenCalledTimes(4);
  });
  it("does not retry blocked or oversized pages and keeps all counts unknown", async () => {
    for (const response of [new Response("login", { status: 403 }), html("x".repeat(1_500_001))]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      const result = await readPublicPostStats(instagram, { fetcher, cache: null });
      expect(result.status).toBe("unavailable");
      expect(result.metrics.every((m) => m.value === null)).toBe(true);
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it("denies an MCP budget before executing a network request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const reserve = vi.fn().mockRejectedValue(new Error("Budget denied"));
    await expect(
      readPublicPostStats(instagram, {
        fetcher,
        cache: null,
        trustedMcpWorkspaceId: "workspace",
        reserve,
      }),
    ).rejects.toThrow("Budget denied");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("public stats HTTP boundary", () => {
  const request = (body: unknown, headers: Record<string, string> = {}) =>
    new Request(`https://bento.surf${PUBLIC_POST_STATS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  it("requires same-origin JSON, a limiter and Turnstile for anonymous readers", async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    const env = { APP_ENV: "production", FREE_TOOLS_MEDIA_RATE_LIMITER: { limit } };
    expect(
      (
        await handlePublicPostStatsRequest(
          request({ url: instagram }, { origin: "https://other.example" }),
          env,
        )
      )?.status,
    ).toBe(403);
    expect((await handlePublicPostStatsRequest(request({ url: instagram }), env))?.status).toBe(
      403,
    );
    expect((await handlePublicPostStatsRequest(request({ url: instagram }), {}))?.status).toBe(503);
    expect(
      (await handlePublicPostStatsRequest(request({ url: instagram, workspaceId: "forged" }), env))
        ?.status,
    ).toBe(400);
  });
  it("uses a trusted workspace key and fails closed on reservations and rate limits", async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const fetcher = vi.fn<typeof fetch>();
    const env = { FREE_TOOLS_MEDIA_RATE_LIMITER: { limit } };
    expect(
      (
        await handlePublicPostStatsRequest(request({ url: instagram }), env, {
          trustedMcpWorkspaceId: "owned",
          fetcher,
          cache: null,
        })
      )?.status,
    ).toBe(429);
    expect(fetcher).not.toHaveBeenCalled();
    expect(limit).toHaveBeenCalledWith({ key: "public-stats:workspace:owned" });
    limit.mockResolvedValue({ success: true });
    const reserve = vi.fn().mockRejectedValue(new ProviderBudgetError("mcp_media_resolutions"));
    expect(
      (
        await handlePublicPostStatsRequest(request({ url: instagram }), env, {
          trustedMcpWorkspaceId: "owned",
          fetcher,
          reserve,
          cache: null,
        })
      )?.status,
    ).toBe(429);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
