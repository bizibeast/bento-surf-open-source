import { describe, expect, it, vi } from "vitest";
import {
  fetchInstagramBrightDataSource,
  fetchLinkedInBrightDataPreview,
  fetchRedditPreview,
  normalizeSocialHandle,
  nextSocialPreviewRetry,
  shouldTryImmediateBrightFallback,
  shouldTryImmediateInstagramMediaFallback,
  parseBrightDataInstagramSource,
  parseBrightDataLinkedInFollowerCount,
  parseFxTwitterFollowerCount,
  parseGitHubContributions,
  parseInstagramPublicSource,
  preserveInstagramPreviewWhileMediaLoads,
  parseLinkedInPublicFollowerCount,
  parseRedditFollowerCount,
  parseRedditPublicFollowerCount,
  parseTikTokFollowerCount,
  parseTwitterTimelineFollowerCount,
  socialPreviewFailureWindow,
  socialPreviewRefreshWindow,
  fetchGitHubPreview,
  fetchTwitterPreview,
  fetchYouTubePreview,
} from "./social-preview.functions";

describe("social preview refresh leases", () => {
  it.each(["instagram", "linkedin", "twitter"] as const)(
    "keeps %s refresh leases inside the stale cache window",
    (platform) => {
      const now = Date.parse("2026-07-28T00:00:00.000Z");
      const window = socialPreviewRefreshWindow(platform, now);

      expect(Date.parse(window.expiresAt)).toBeGreaterThan(now);
      expect(Date.parse(window.staleUntil)).toBeGreaterThanOrEqual(Date.parse(window.expiresAt));
    },
  );

  it("schedules exactly three retries before paid fallback eligibility", () => {
    const now = Date.parse("2026-08-22T00:00:00.000Z");
    expect(nextSocialPreviewRetry(1, now)).toEqual({ nextAttempt: 2, nextRetryAt: now + 60_000 });
    expect(nextSocialPreviewRetry(2, now)).toEqual({
      nextAttempt: 3,
      nextRetryAt: now + 15 * 60_000,
    });
    expect(nextSocialPreviewRetry(3, now)).toEqual({
      nextAttempt: 4,
      nextRetryAt: now + 2 * 60 * 60_000,
    });
    expect(nextSocialPreviewRetry(4, now)).toBeNull();
  });

  it("uses capped Bright immediately only for a brand-new Instagram or LinkedIn preview", () => {
    expect(shouldTryImmediateBrightFallback("instagram", false, false, false)).toBe(true);
    expect(shouldTryImmediateBrightFallback("linkedin", false, false, false)).toBe(true);
    expect(shouldTryImmediateBrightFallback("github", false, false, false)).toBe(false);
    expect(shouldTryImmediateBrightFallback("instagram", true, false, false)).toBe(false);
    expect(shouldTryImmediateBrightFallback("instagram", false, true, false)).toBe(false);
    expect(shouldTryImmediateBrightFallback("instagram", false, false, true)).toBe(false);
  });

  it("fills missing Instagram media only during brand-new resolution", () => {
    expect(shouldTryImmediateInstagramMediaFallback("instagram", true, 0)).toBe(true);
    expect(shouldTryImmediateInstagramMediaFallback("instagram", true, 1)).toBe(false);
    expect(shouldTryImmediateInstagramMediaFallback("instagram", false, 0)).toBe(false);
    expect(shouldTryImmediateInstagramMediaFallback("linkedin", true, 0)).toBe(false);
  });

  it("keeps the free Instagram count while an async media snapshot runs", () => {
    const freePreview = {
      followerCount: 5_700,
      metricName: "followers" as const,
      recentPosts: [],
      contributions: [],
      latestVideo: null,
      available: true,
      refreshing: false,
    };
    expect(
      preserveInstagramPreviewWhileMediaLoads(freePreview, {
        ...freePreview,
        followerCount: null,
        available: false,
        refreshing: true,
      }),
    ).toEqual({ ...freePreview, refreshing: true });
  });

  it("never extends a successful stale count past its original deadline", () => {
    const now = Date.parse("2026-08-22T00:00:00.000Z");
    const staleUntil = now + 30_000;
    expect(socialPreviewFailureWindow(now, now + 60_000, staleUntil)).toEqual({
      expiresAt: staleUntil,
      staleUntil,
    });
  });
});

describe("GitHub contribution parsing", () => {
  it("extracts public contribution dates and levels", () => {
    const html = `
      <td data-date="2026-07-14" data-level="1"></td>
      <td class="ContributionCalendar-day" data-level="4" data-date="2026-07-15"></td>
    `;
    expect(parseGitHubContributions(html)).toEqual([
      { date: "2026-07-14", level: 1 },
      { date: "2026-07-15", level: 4 },
    ]);
  });

  it("returns the latest dates in chronological order for GitHub's row-major HTML", () => {
    const html = `
      <td data-date="2026-07-12" data-level="2"></td>
      <td data-date="2026-07-05" data-level="1"></td>
      <td data-date="2026-07-13" data-level="4"></td>
    `;
    expect(parseGitHubContributions(html)).toEqual([
      { date: "2026-07-05", level: 1 },
      { date: "2026-07-12", level: 2 },
      { date: "2026-07-13", level: 4 },
    ]);
  });

  it("keeps a full contribution year and deduplicates repeated calendar cells", () => {
    const html = Array.from({ length: 380 }, (_, index) => {
      const date = new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10);
      return `<td data-date="${date}" data-level="${index % 5}"></td>`;
    }).join("");
    const duplicate = '<td data-date="2025-12-31" data-level="4"></td>';
    const contributions = parseGitHubContributions(`${html}${duplicate}`);

    expect(contributions).toHaveLength(371);
    expect(new Set(contributions.map((cell) => cell.date)).size).toBe(371);
    expect(contributions.at(-1)?.date).toBe("2026-01-15");
    expect(contributions.find((cell) => cell.date === "2025-12-31")?.level).toBe(4);
  });

  it("keeps contribution activity available when GitHub's profile API is rate-limited", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/users/octocat/contributions")) {
        return new Response(
          '<td data-date="2026-07-15" data-level="2"></td><td data-date="2026-07-16" data-level="4"></td>',
          { status: 200 },
        );
      }
      if (url.includes("api.github.com/users/octocat")) {
        return new Response('{"message":"API rate limit exceeded"}', { status: 403 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    try {
      await expect(fetchGitHubPreview("octocat")).resolves.toMatchObject({
        available: true,
        followerCount: null,
        contributions: [
          { date: "2026-07-15", level: 2 },
          { date: "2026-07-16", level: 4 },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects invalid GitHub usernames before requesting upstream data", async () => {
    await expect(fetchGitHubPreview("not/a/profile")).rejects.toThrow("Invalid GitHub username");
  });
});

describe("social handle normalization", () => {
  it.each([
    ["instagram", "https://www.instagram.com/bizibeast/", "bizibeast"],
    ["twitter", "https://x.com/bentosurf", "bentosurf"],
    ["youtube", "https://youtube.com/@GoogleDevelopers/videos", "GoogleDevelopers"],
    ["youtube", "https://youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw", "UC_x5XG1OV2P6uZZ5FSM9Ttw"],
    ["github", "https://github.com/torvalds?tab=repositories", "torvalds"],
    ["linkedin", "https://www.linkedin.com/in/satyanadella/", "satyanadella"],
    ["linkedin", "https://www.linkedin.com/company/bento-surf/", "bento-surf"],
    ["reddit", "https://www.reddit.com/user/spez/", "spez"],
  ])("normalizes %s profile inputs", (platform, input, expected) => {
    expect(normalizeSocialHandle(platform, input)).toBe(expected);
  });
});

describe("LinkedIn follower counts", () => {
  it("parses exact and compact public follower counts", () => {
    expect(
      parseLinkedInPublicFollowerCount(
        '<h2 class="top-card-layout__headline">Sunnyvale, CA 34,073,930 followers</h2>',
      ),
    ).toBe(34_073_930);
    expect(
      parseLinkedInPublicFollowerCount(
        '<meta name="description" content="Creator · 1.5K followers · 500+ connections">',
      ),
    ).toBe(1_500);
  });

  it("accepts current Bright Data profile envelopes", () => {
    expect(
      parseBrightDataLinkedInFollowerCount({
        result: { data: [{ name: "Satya Nadella", followers: "10,842,560" }] },
      }),
    ).toBe(10_842_560);
  });

  it("keeps Bright Data available only as an explicit fallback", async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.BRIGHT_DATA_API_KEY;
    process.env.BRIGHT_DATA_API_KEY = "test-key";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json([{ name: "Satya Nadella", followers: 10_842_560 }]));
    globalThis.fetch = fetchMock;

    try {
      await expect(fetchLinkedInBrightDataPreview("satyanadella")).resolves.toMatchObject({
        available: true,
        followerCount: 10_842_560,
      });
      expect(String(fetchMock.mock.calls[0][0])).toContain("dataset_id=gd_l1viktl72bvl7bjuj0");
      expect(fetchMock.mock.calls[0][1]?.body).toBe(
        JSON.stringify({
          input: [{ url: "https://www.linkedin.com/in/satyanadella" }],
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.BRIGHT_DATA_API_KEY;
      else process.env.BRIGHT_DATA_API_KEY = originalKey;
    }
  });
});

describe("Reddit follower counts", () => {
  it("reads the profile community subscriber field and preserves zero", () => {
    expect(parseRedditFollowerCount({ data: { subreddit: { subscribers: 42 } } })).toBe(42);
    expect(parseRedditFollowerCount({ data: { subreddit: { subscribers: 0 } } })).toBe(0);
  });

  it("retries Reddit's alternate public hostname with a descriptive user agent", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; userAgent: string | null }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({ url: String(input), userAgent: headers.get("User-Agent") });
      if (String(input).startsWith("https://www.reddit.com/")) {
        return new Response("blocked", { status: 403 });
      }
      return new Response(
        '<script type="application/json">{"data":{"subreddit":{"subscribers":73}}}</script>',
        { headers: { "Content-Type": "text/html" } },
      );
    }) as typeof fetch;

    try {
      await expect(fetchRedditPreview("spez")).resolves.toMatchObject({
        available: true,
        followerCount: 73,
      });
      expect(requests).toHaveLength(2);
      expect(requests[1].url).toContain("old.reddit.com/user/spez/");
      expect(requests[1].userAgent).toBe("web:bento.surf.social-preview:v1.0 (by /u/bentosurf)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parses follower counts from signed-out Reddit HTML", () => {
    expect(
      parseRedditPublicFollowerCount(
        '<script type="application/json">{"data":{"subreddit":{"subscribers":73}}}</script>',
      ),
    ).toBe(73);
  });
});

describe("Instagram and TikTok public HTML", () => {
  it("parses Instagram embedded JSON and description metadata", () => {
    expect(
      parseInstagramPublicSource(
        '<script type="application/json">{"profile":{"edge_followed_by":{"count":1250}}}</script>',
      )?.followerCount,
    ).toBe(1_250);
    expect(
      parseInstagramPublicSource(
        '<meta property="og:description" content="104M Followers, 10 Following, 1,000 Posts">',
      )?.followerCount,
    ).toBe(104_000_000);
  });

  it("validates the requested TikTok user before accepting embedded stats", () => {
    const html =
      '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">' +
      '{"userInfo":{"user":{"uniqueId":"bentosurf"},"stats":{"followerCount":5197}}}' +
      "</script>";
    expect(parseTikTokFollowerCount(html, "bentosurf")).toBe(5_197);
    expect(parseTikTokFollowerCount(html, "another-user")).toBeNull();
  });
});

describe("X follower counts", () => {
  it("reads the requested profile from X's public embedded timeline", () => {
    const html = `
      <script id="__NEXT_DATA__" type="application/json">
        {"props":{"pageProps":{"timeline":{"entries":[
          {"content":{"tweet":{"user":{"screen_name":"someone_else","followers_count":999}}}},
          {"content":{"tweet":{"user":{"screen_name":"BentoSurf","followers_count":42}}}}
        ]}}}}
      </script>
    `;
    expect(parseTwitterTimelineFollowerCount(html, "bentosurf")).toBe(42);
  });

  it("validates the matching user in the open-source profile fallback", () => {
    expect(
      parseFxTwitterFollowerCount(
        { user: { screen_name: "BentoSurf", followers: 0 } },
        "bentosurf",
      ),
    ).toBe(0);
    expect(
      parseFxTwitterFollowerCount(
        { user: { screen_name: "another_user", followers: 100 } },
        "bentosurf",
      ),
    ).toBeNull();
  });

  it("uses X's public timeline without requesting the fallback", async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("syndication.twitter.com")) {
        return new Response(
          '<script id="__NEXT_DATA__" type="application/json">{"user":{"screen_name":"OpenAI","followers_count":5060399}}</script>',
          { status: 200 },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    try {
      await expect(fetchTwitterPreview("OpenAI")).resolves.toMatchObject({
        available: true,
        followerCount: 5_060_399,
      });
      expect(requests).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("supports profiles without posts through the free open-source fallback", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("syndication.twitter.com")) {
        return new Response(
          '<script id="__NEXT_DATA__" type="application/json">{"timeline":{"entries":[]}}</script>',
          { status: 200 },
        );
      }
      if (url === "https://api.fxtwitter.com/bentosurf") {
        return Response.json({
          code: 200,
          user: { screen_name: "bentosurf", followers: 0 },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    try {
      await expect(fetchTwitterPreview("bentosurf")).resolves.toMatchObject({
        available: true,
        followerCount: 0,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects invalid usernames before requesting upstream data", async () => {
    await expect(fetchTwitterPreview("not/a/profile")).rejects.toThrow("Invalid X username");
  });
});

describe("latest YouTube video", () => {
  it("resolves a channel handle to its newest public upload", async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.YOUTUBE_API_KEY;
    process.env.YOUTUBE_API_KEY = "test-key";
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/channels")) {
        expect(url.searchParams.get("forHandle")).toBe("GoogleDevelopers");
        expect(url.searchParams.get("part")).toBe("statistics,contentDetails");
        return Response.json({
          items: [
            {
              statistics: { subscriberCount: "1234", hiddenSubscriberCount: false },
              contentDetails: { relatedPlaylists: { uploads: "UU_latest" } },
            },
          ],
        });
      }
      if (url.pathname.endsWith("/playlistItems")) {
        expect(url.searchParams.get("playlistId")).toBe("UU_latest");
        expect(url.searchParams.get("maxResults")).toBe("1");
        return Response.json({
          items: [
            {
              snippet: {
                title: "A new upload",
                resourceId: { videoId: "M7lc1UVf-VE" },
                thumbnails: { high: { url: "https://i.ytimg.com/latest.jpg" } },
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    try {
      await expect(fetchYouTubePreview("GoogleDevelopers")).resolves.toMatchObject({
        available: true,
        followerCount: 1234,
        metricName: "subscribers",
        latestVideo: {
          id: "M7lc1UVf-VE",
          title: "A new upload",
          thumbnailUrl: "https://i.ytimg.com/latest.jpg",
          permalink: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.YOUTUBE_API_KEY;
      else process.env.YOUTUBE_API_KEY = originalKey;
    }
  });
});

describe("Bright Data Instagram parsing", () => {
  it("returns live followers and the six newest valid post images", () => {
    const posts = Array.from({ length: 8 }, (_, index) => ({
      datetime: `2026-07-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
      image_url: `https://scontent.cdninstagram.com/post-${index}.jpg`,
      url: `https://www.instagram.com/p/POST_${index}/`,
    }));
    expect(parseBrightDataInstagramSource([{ followers: 5_197, posts }])).toEqual({
      followerCount: 5_197,
      recentPosts: [7, 6, 5, 4, 3, 2].map((index) => ({
        shortcode: `POST_${index}`,
        imageUrl: `https://scontent.cdninstagram.com/post-${index}.jpg`,
      })),
    });
  });

  it("normalizes numeric profile metrics and skips broken posts", () => {
    expect(parseBrightDataInstagramSource([{ followers: "5,197", posts: [] }])).toEqual({
      followerCount: 5_197,
      recentPosts: [],
    });
    expect(parseBrightDataInstagramSource([{ followers: "not-public", posts: [] }])).toBeNull();
    expect(
      parseBrightDataInstagramSource([
        {
          followers: 10,
          posts: [{ datetime: "2026-07-16", image_url: null, url: "not-a-post" }],
        },
      ]),
    ).toEqual({ followerCount: 10, recentPosts: [] });
  });

  it("accepts wrapped records and current alternate field names", () => {
    expect(
      parseBrightDataInstagramSource({
        data: [
          {
            followers_count: 42,
            recent_posts: [
              {
                date_posted: "2026-07-20T12:00:00.000Z",
                display_url: "https://scontent.cdninstagram.com/post.jpg",
                post_url: "https://www.instagram.com/p/WRAPPED_1/",
              },
            ],
          },
        ],
      }),
    ).toEqual({
      followerCount: 42,
      recentPosts: [
        {
          shortcode: "WRAPPED_1",
          imageUrl: "https://scontent.cdninstagram.com/post.jpg",
        },
      ],
    });
  });

  it("accepts profile records inside nested snapshot envelopes", () => {
    expect(
      parseBrightDataInstagramSource({
        result: {
          data: [
            {
              followers: 42,
              posts: [
                {
                  image_url: "https://scontent.cdninstagram.com/enveloped.jpg",
                  url: "https://www.instagram.com/p/ENVELOPED_1/",
                },
              ],
            },
          ],
        },
      }),
    ).toEqual({
      followerCount: 42,
      recentPosts: [
        {
          imageUrl: "https://scontent.cdninstagram.com/enveloped.jpg",
          shortcode: "ENVELOPED_1",
        },
      ],
    });
  });

  it("accepts nested follower and media fields returned by profile variants", () => {
    expect(
      parseBrightDataInstagramSource([
        {
          edge_followed_by: { count: "1,250" },
          latest_posts: [
            {
              timestamp: "2026-07-25T12:00:00.000Z",
              permalink: "https://www.instagram.com/reel/NESTED_1/",
              photos: [{ url: "https://scontent.cdninstagram.com/nested.jpg" }],
            },
          ],
        },
      ]),
    ).toEqual({
      followerCount: 1_250,
      recentPosts: [
        {
          shortcode: "NESTED_1",
          imageUrl: "https://scontent.cdninstagram.com/nested.jpg",
        },
      ],
    });
  });

  it("parses the flat records returned by recent-post profile discovery", () => {
    expect(
      parseBrightDataInstagramSource([
        {
          followers: 12_345,
          date_posted: "2026-07-25T12:00:00.000Z",
          url: "https://www.instagram.com/p/FLAT_2/",
          photos: ["https://scontent.cdninstagram.com/flat-2.jpg"],
        },
        {
          followers: 12_345,
          date_posted: "2026-07-24T12:00:00.000Z",
          url: "https://www.instagram.com/reel/FLAT_1/",
          thumbnail: "https://scontent.cdninstagram.com/flat-1.jpg",
        },
      ]),
    ).toEqual({
      followerCount: 12_345,
      recentPosts: [
        {
          shortcode: "FLAT_2",
          imageUrl: "https://scontent.cdninstagram.com/flat-2.jpg",
        },
        {
          shortcode: "FLAT_1",
          imageUrl: "https://scontent.cdninstagram.com/flat-1.jpg",
        },
      ],
    });
  });

  it("collects an exact profile URL and downloads its durable async snapshot", async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.BRIGHT_DATA_API_KEY;
    process.env.BRIGHT_DATA_API_KEY = "test-key";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ snapshot_id: "snapshot-instagram_test" }), { status: 202 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ready" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ followers: 12, posts: [] }]), { status: 200 }),
      );
    globalThis.fetch = fetchMock;

    try {
      await expect(fetchInstagramBrightDataSource("nasa")).resolves.toEqual({
        followerCount: 12,
        recentPosts: [],
      });
      const [requestUrl, requestInit] = fetchMock.mock.calls[0];
      expect(String(requestUrl)).toContain("/datasets/v3/trigger");
      expect(String(requestUrl)).toContain("dataset_id=gd_l1vikfch901nx3by4");
      expect(String(requestUrl)).not.toContain("type=discover_new");
      expect(String(requestUrl)).not.toContain("discover_by=url");
      expect(requestInit?.body).toBe(JSON.stringify([{ url: "https://www.instagram.com/nasa/" }]));
      expect(fetchMock.mock.calls[1][0]).toContain("/datasets/v3/progress/snapshot-instagram_test");
      expect(fetchMock.mock.calls[2][0]).toContain(
        "/datasets/v3/snapshot/snapshot-instagram_test?format=json",
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.BRIGHT_DATA_API_KEY;
      else process.env.BRIGHT_DATA_API_KEY = originalKey;
    }
  });
});
