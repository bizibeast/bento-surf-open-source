import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLinkedInMemberPostAnalyticsUrl,
  buildLinkedInPostsUrl,
  fetchSocialContentInsights,
  fetchSocialContentInsightsPage,
  normalizeLinkedInPostAnalytics,
} from "./social-content-insights.server";

afterEach(() => vi.unstubAllGlobals());

describe("LinkedIn content insights", () => {
  it("builds the official member posts finder URL", () => {
    const url = buildLinkedInPostsUrl("urn:li:person:abc/123");

    expect(url.pathname).toBe("/rest/posts");
    expect(url.searchParams.get("author")).toBe("urn:li:person:abc/123");
    expect(url.searchParams.get("q")).toBe("author");
    expect(url.searchParams.get("sortBy")).toBe("LAST_MODIFIED");
    expect(url.searchParams.get("count")).toBe("6");
  });

  it("builds a per-post TOTAL analytics query", () => {
    const url = buildLinkedInMemberPostAnalyticsUrl("urn:li:share:123", "IMPRESSION");

    expect(url.pathname).toBe("/rest/memberCreatorPostAnalytics");
    expect(url.searchParams.get("q")).toBe("entity");
    expect(url.searchParams.get("entity")).toBe("(share:urn:li:share:123)");
    expect(url.searchParams.get("queryType")).toBe("IMPRESSION");
    expect(url.searchParams.get("aggregation")).toBe("TOTAL");
  });

  it("normalizes LinkedIn metric counts without inventing missing data", () => {
    expect(
      normalizeLinkedInPostAnalytics([
        { metricType: "IMPRESSION", count: 1200 },
        { metricType: "MEMBERS_REACHED", count: 900 },
        { metricType: "REACTION", count: 40 },
        { metricType: "COMMENT", count: 5 },
        { metricType: "RESHARE", count: 3 },
        { metricType: "POST_SAVE", count: 7 },
      ]),
    ).toEqual({
      impressions: 1200,
      reach: 900,
      likes: 40,
      comments: 5,
      shares: 3,
      saves: 7,
      engagements: 55,
    });
  });

  it("imports every available Graph page instead of stopping after the first 100 posts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "first", created_time: "2026-01-01T00:00:00.000Z" }],
            paging: { cursors: { after: "page-2" } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "second", created_time: "2025-12-01T00:00:00.000Z" }],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const items = await fetchSocialContentInsights(
      {
        id: "connection",
        provider: "facebook",
        provider_user_id: "page",
        provider_handle: "creator",
        scopes: ["read_insights"],
      },
      "token",
    );

    expect(items.map((item) => item.remotePostId)).toEqual(["first", "second"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries Instagram history through the token owner when the stored account id returns no media", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "post-1",
                caption: "Older post",
                media_type: "IMAGE",
                permalink: "https://www.instagram.com/p/post-1/",
                timestamp: "2026-07-01T00:00:00.000Z",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ name: "views", total_value: { value: 1200 } }] }), {
          status: 200,
        }),
      )
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: 10, message: "Metric unavailable" } }), {
            status: 403,
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const items = await fetchSocialContentInsights(
      {
        id: "connection",
        provider: "instagram",
        provider_user_id: "stored-account-id",
        provider_handle: "creator",
      },
      "token",
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ remotePostId: "post-1", views: 1200 });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/v25.0/me/media");
  });

  it("keeps Instagram media when detailed insights are unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "post-1",
                caption: "Useful post",
                media_type: "IMAGE",
                permalink: "https://www.instagram.com/p/post-1/",
                timestamp: "2026-07-01T00:00:00.000Z",
                like_count: 45,
                comments_count: 7,
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 10, message: "Metric unavailable" } }), {
          status: 403,
        }),
      )
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: 10, message: "Metric unavailable" } }), {
            status: 403,
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const items = await fetchSocialContentInsights(
      {
        id: "connection",
        provider: "instagram",
        provider_user_id: "stored-account-id",
        provider_handle: "creator",
      },
      "token",
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      remotePostId: "post-1",
      likes: 45,
      comments: 7,
      engagements: 52,
    });
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("fields")).toContain(
      "like_count,comments_count",
    );
  });

  it("retries Instagram enrichment when a post metric is rate limited", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/media")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "post-1",
                media_type: "IMAGE",
                timestamp: "2026-07-01T00:00:00.000Z",
              },
            ],
          }),
          { status: 200 },
        );
      }
      const status = url.searchParams.get("metric") === "views" ? 429 : 403;
      return new Response(JSON.stringify({ error: { message: "Metric unavailable" } }), { status });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchSocialContentInsightsPage(
        {
          id: "connection",
          provider: "instagram",
          provider_user_id: "account",
          provider_handle: "creator",
        },
        "token",
      ),
    ).rejects.toMatchObject({ status: 429, retryable: true });
  });

  it("keeps Threads posts when detailed insights are unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "thread-1",
                text: "A thread worth revisiting",
                media_type: "TEXT_POST",
                permalink: "https://www.threads.net/@creator/post/thread-1",
                timestamp: "2026-07-01T00:00:00.000Z",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 10, message: "Metric unavailable" } }), {
          status: 403,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const items = await fetchSocialContentInsights(
      {
        id: "connection",
        provider: "threads",
        provider_user_id: "threads-user",
        provider_handle: "creator",
      },
      "token",
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      remotePostId: "thread-1",
      caption: "A thread worth revisiting",
    });
  });

  it("bounds Instagram enrichment and returns an opaque resumable cursor", async () => {
    const media = Array.from({ length: 7 }, (_, index) => ({
      id: `post-${index + 1}`,
      media_type: "IMAGE",
      timestamp: "2026-07-01T00:00:00.000Z",
    }));
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/media")) {
        return new Response(
          JSON.stringify({ data: media, paging: { cursors: { after: "page-2" } } }),
          { status: 200 },
        );
      }
      const metric = url.searchParams.get("metric");
      return new Response(JSON.stringify({ data: [{ name: metric, total_value: { value: 1 } }] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const page = await fetchSocialContentInsightsPage(
      {
        id: "connection",
        provider: "instagram",
        provider_user_id: "account",
        provider_handle: "creator",
      },
      "secret-access-token",
    );

    expect(page.content).toHaveLength(6);
    expect(fetchMock).toHaveBeenCalledTimes(31);
    expect(page.nextCursor).toBeTruthy();
    expect(page.nextCursor).not.toContain("secret-access-token");
    expect(page.nextCursor).not.toContain("graph.instagram.com");
  });

  it("requests current Facebook post metrics without deprecated fields", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const fields = url.searchParams.get("fields") || "";
      expect(fields).toContain("post_media_view");
      expect(fields).toContain("post_total_media_view_unique");
      expect(fields).not.toContain("post_impressions");
      expect(fields).not.toContain("post_engaged_users");
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "page_post",
              created_time: "2026-07-01T00:00:00.000Z",
              reactions: { summary: { total_count: 4 } },
              comments: { summary: { total_count: 2 } },
              shares: { count: 1 },
              insights: {
                data: [
                  { name: "post_media_view", values: [{ value: 80 }] },
                  { name: "post_total_media_view_unique", values: [{ value: 60 }] },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const page = await fetchSocialContentInsightsPage(
      {
        id: "connection",
        provider: "facebook",
        provider_user_id: "page",
        provider_handle: "creator",
        scopes: ["read_insights"],
      },
      "token",
    );

    expect(page.content[0]).toMatchObject({
      views: 80,
      reach: 60,
      impressions: null,
      engagements: 7,
      likes: 4,
    });
  });

  it("imports Facebook base post engagement without Page Insights scope", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const fields = new URL(String(input)).searchParams.get("fields") || "";
      expect(fields).not.toContain("insights");
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "page_post",
              created_time: "2026-07-01T00:00:00.000Z",
              reactions: { summary: { total_count: 4 } },
              comments: { summary: { total_count: 2 } },
              shares: { count: 1 },
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const page = await fetchSocialContentInsightsPage(
      {
        id: "connection",
        provider: "facebook",
        provider_user_id: "page",
        provider_handle: "creator",
        scopes: [],
      },
      "token",
    );

    expect(page.content[0]).toMatchObject({
      views: null,
      reach: null,
      engagements: 7,
      likes: 4,
      comments: 2,
      shares: 1,
    });
  });

  it("skips LinkedIn posts with missing dates before analytics fan-out", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/posts") {
        return new Response(
          JSON.stringify({
            elements: [
              { id: "missing-date", commentary: "Do not fabricate this date" },
              {
                id: "dated",
                commentary: "Keep this post",
                publishedAt: Date.parse("2026-07-01T00:00:00.000Z"),
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const page = await fetchSocialContentInsightsPage(
      {
        id: "connection",
        provider: "linkedin",
        provider_user_id: "urn:li:person:creator",
        provider_handle: "creator",
        scopes: ["r_member_social", "r_member_postAnalytics"],
      },
      "token",
    );

    expect(page.content.map((item) => item.remotePostId)).toEqual(["dated"]);
    expect(page.content[0]?.publishedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("ends LinkedIn content import cleanly when analytics scopes are unavailable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const page = await fetchSocialContentInsightsPage(
      {
        id: "connection",
        provider: "linkedin",
        provider_user_id: "urn:li:person:creator",
        provider_handle: "creator",
        scopes: ["openid", "profile"],
      },
      "token",
    );

    expect(page).toEqual({ content: [], nextCursor: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps X public metrics when optional owner metrics are restricted", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (input: string | URL) => {
        const url = new URL(String(input));
        expect(url.pathname).toContain("/users/x-user/tweets");
        expect(url.searchParams.get("tweet.fields")).toContain("public_metrics");
        expect(url.searchParams.get("tweet.fields")).not.toContain("organic_metrics");
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "tweet-1",
                text: "Public post",
                created_at: "2026-07-01T00:00:00.000Z",
                public_metrics: {
                  like_count: 4,
                  reply_count: 2,
                  retweet_count: 1,
                  quote_count: 1,
                  impression_count: 80,
                },
              },
            ],
          }),
          { status: 200 },
        );
      })
      .mockImplementationOnce(async (input: string | URL) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/2/tweets");
        expect(url.searchParams.get("tweet.fields")).toBe("organic_metrics");
        return new Response(JSON.stringify({ error: { message: "Tier does not allow this" } }), {
          status: 403,
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    const page = await fetchSocialContentInsightsPage(
      {
        id: "connection",
        provider: "twitter",
        provider_user_id: "x-user",
        provider_handle: "creator",
      },
      "token",
    );

    expect(page.content).toHaveLength(1);
    expect(page.content[0]).toMatchObject({
      impressions: 80,
      likes: 4,
      comments: 2,
      shares: 2,
      engagements: 8,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps Reddit score in engagements without labeling it as likes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              children: [
                {
                  data: {
                    name: "t3_post",
                    title: "A useful post",
                    created_utc: 1_783_036_800,
                    score: 12,
                    num_comments: 3,
                    is_self: true,
                  },
                },
              ],
              after: null,
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const page = await fetchSocialContentInsightsPage(
      {
        id: "connection",
        provider: "reddit",
        provider_user_id: "reddit-user",
        provider_handle: "creator",
      },
      "token",
    );

    expect(page.content[0]).toMatchObject({ likes: null, comments: 3, engagements: 15 });
  });
});
