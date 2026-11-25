import { describe, it, expect, vi } from "vitest";
import { extractPublicPostStats } from "./public-post-extractors";
describe("native public post metadata", () => {
  it("retains canonical-page extraction when the Instagram embed is blocked", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("invalid-instagram-redirect")));
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () =>
          new Response(
            '<script type="application/json">{"shortcode":"ExactPost","like_count":12,"comment_count":3,"owner":{"username":"creator"}}</script>',
          ),
      );
    try {
      const result = await extractPublicPostStats(
        "https://instagram.com/reel/ExactPost",
        {},
        { fetcher },
      );
      expect(result.counts).toMatchObject({ likes: 12, comments: 3 });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("returns every X public counter and never borrows quoted counters", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        code: 200,
        tweet: {
          id: "123",
          url: "https://x.com/owner/status/123",
          views: 100,
          likes: 0,
          replies: 3,
          retweets: 4,
          quotes: 5,
          bookmarks: 6,
          quote: { id: "999", likes: 999999 },
        },
      }),
    );
    const result = await extractPublicPostStats("https://x.com/owner/status/123", {}, { fetcher });
    expect(result.counts).toEqual({
      views: 100,
      likes: 0,
      comments: 3,
      reposts: 4,
      quotes: 5,
      saves: 6,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("handles a verified repost resolution without claiming the repost has the original views", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        code: 200,
        tweet: {
          id: "456",
          url: "https://x.com/original/status/456",
          likes: 12,
          reposted_by: { id: "owner" },
          quote: { id: "999", likes: 10000 },
        },
      }),
    );
    expect(
      await extractPublicPostStats("https://x.com/reposter/status/123", {}, { fetcher }),
    ).toMatchObject({
      sourceUrl: "https://x.com/original/status/456",
      resolvedFromRepost: true,
      counts: { likes: 12 },
    });
    fetcher.mockResolvedValue(
      Response.json({
        code: 200,
        tweet: { id: "456", url: "https://x.com/original/status/456", likes: 12 },
      }),
    );
    await expect(
      extractPublicPostStats("https://x.com/reposter/status/123", {}, { fetcher }),
    ).rejects.toThrow("requested post");
  });
  it("uses the private download engine for video metadata without resolving or transferring media", async () => {
    const fetchPrivate = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/stats");
      expect(request.headers.get("authorization")).toBe("Bearer private-service-token");
      return Response.json({
        platform: "youtube",
        id: "dQw4w9WgXcQ",
        counts: { views: 100, likes: 20, comments: 4, cookie: "must-not-return" },
      });
    });
    const result = await extractPublicPostStats("https://youtu.be/dQw4w9WgXcQ", {
      BASIC_MEDIA_RESOLVER: { fetch: fetchPrivate },
      BASIC_MEDIA_TOKEN: "private-service-token",
    });
    expect(result.counts).toEqual({ views: 100, likes: 20, comments: 4 });
    expect(fetchPrivate).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("private-service-token");
  });
  it("preserves backpressure and rejects mismatched video metadata", async () => {
    const fetchPrivate = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ code: "error.api.basic_media.limit" }, { status: 429 }),
      )
      .mockResolvedValueOnce(
        Response.json({ platform: "youtube", id: "foreign", counts: { views: 999 } }),
      );
    const env = {
      BASIC_MEDIA_RESOLVER: { fetch: fetchPrivate },
      BASIC_MEDIA_TOKEN: "private-service-token",
    };
    await expect(extractPublicPostStats("https://youtu.be/dQw4w9WgXcQ", env)).rejects.toMatchObject(
      { status: 429 },
    );
    await expect(extractPublicPostStats("https://youtu.be/dQw4w9WgXcQ", env)).rejects.toThrow(
      "did not match",
    );
  });
});
