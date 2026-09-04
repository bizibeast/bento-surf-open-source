import { describe, expect, it } from "vitest";
import {
  bestSocialContent,
  dailyAnalyticsHistory,
  dailySocialPerformance,
  impressionHistorySeries,
  followerGrowthSeries,
  selectedSocialAnalyticsAccount,
  socialContentExposureMetric,
  socialEngagementSeries,
  socialGrowthMetricsFor,
  socialImpressionSeries,
  socialMilestones,
  socialProviderEmptyStateMessage,
  socialReachSeries,
  socialContentTypePerformance,
} from "./social-insights-dashboard";
import type { SocialContentInsight } from "./social-content-insights.server";

const item = (overrides: Partial<SocialContentInsight>): SocialContentInsight => ({
  connectionId: "connection",
  provider: "twitter",
  remotePostId: crypto.randomUUID(),
  remotePostUrl: null,
  contentType: "text",
  caption: null,
  thumbnailUrl: null,
  publishedAt: "2026-08-17T12:00:00.000Z",
  views: null,
  impressions: 100,
  reach: null,
  engagements: 10,
  likes: 8,
  comments: 1,
  shares: 1,
  saves: null,
  fetchedAt: "2026-08-18T12:00:00.000Z",
  ...overrides,
});

describe("social insights dashboard model", () => {
  it("scopes historical importing state to the selected account", () => {
    const ready = {
      connectionId: "instagram",
      provider: "instagram" as const,
      handle: "ready",
      displayName: "Ready",
      avatarUrl: null,
      followers: 10,
      following: null,
      posts: 1,
      views: 20,
      reach: 15,
      engagements: 2,
      status: "available" as const,
      note: null,
      fetchedAt: "2026-08-19T00:00:00.000Z",
      refreshing: false,
      refreshStartedAt: null,
    };
    const importing = {
      ...ready,
      connectionId: "threads",
      provider: "threads" as const,
      handle: "importing",
      displayName: "Importing",
      refreshing: true,
      refreshStartedAt: "2026-08-19T00:01:00.000Z",
    };

    expect(selectedSocialAnalyticsAccount([ready, importing], "instagram", [])?.refreshing).toBe(
      false,
    );
    expect(selectedSocialAnalyticsAccount([ready, importing], "threads", [])?.refreshing).toBe(
      true,
    );
  });

  it("maps imported daily analytics into a complete date series", () => {
    expect(
      dailyAnalyticsHistory(
        [
          {
            connectionId: "facebook",
            followers: null,
            posts: null,
            views: 42,
            reach: 30,
            engagements: 4,
            status: "available",
            capturedAt: "2026-08-17T00:00:00.000Z",
          },
        ],
        "facebook",
        2,
        new Date("2026-08-18T12:00:00.000Z"),
      ),
    ).toEqual([
      { date: "2026-08-17", views: 42, impressions: 0, reach: 30, engagements: 4, posts: 0 },
      { date: "2026-08-18", views: 0, impressions: 0, reach: 0, engagements: 0, posts: 0 },
    ]);
  });

  it("uses imported daily impression history for a connected account", () => {
    expect(
      impressionHistorySeries(
        [
          {
            connectionId: "linkedin",
            followers: null,
            posts: null,
            views: 250,
            reach: null,
            engagements: 12,
            status: "available",
            capturedAt: "2026-08-17T00:00:00.000Z",
          },
        ],
        "linkedin",
      ),
    ).toEqual([{ date: "2026-08-17T00:00:00.000Z", value: 250 }]);
  });

  it("falls back from all-zero imported history to content without inventing daily totals", () => {
    const zeroHistory = [
      {
        connectionId: "connection",
        followers: null,
        posts: null,
        views: 0,
        reach: null,
        engagements: 0,
        status: "available" as const,
        capturedAt: "2026-08-17T00:00:00.000Z",
      },
    ];
    const now = new Date("2026-08-18T12:00:00.000Z");

    expect(
      socialImpressionSeries(zeroHistory, "connection", [item({ impressions: 500 })], 2, now),
    ).toEqual([
      { date: "2026-08-17", views: 0, impressions: 500, reach: 0, engagements: 10, posts: 1 },
      { date: "2026-08-18", views: 0, impressions: 0, reach: 0, engagements: 0, posts: 0 },
    ]);
    expect(socialImpressionSeries(zeroHistory, "connection", [], 2, now).at(-1)).toEqual({
      date: "2026-08-18",
      views: 0,
      impressions: 0,
      reach: 0,
      engagements: 0,
      posts: 0,
    });
  });

  it("keeps older content history outside a provider's shorter daily insights window", () => {
    const history = [
      {
        connectionId: "connection",
        followers: null,
        posts: null,
        views: 40,
        reach: null,
        engagements: 2,
        status: "available" as const,
        capturedAt: "2026-08-18T00:00:00.000Z",
      },
    ];
    expect(
      socialImpressionSeries(
        history,
        "connection",
        [item({ publishedAt: "2026-08-17T12:00:00.000Z", impressions: 500 })],
        2,
        new Date("2026-08-18T12:00:00.000Z"),
      ),
    ).toEqual([
      { date: "2026-08-17", views: 0, impressions: 500, reach: 0, engagements: 10, posts: 1 },
      { date: "2026-08-18", views: 0, impressions: 40, reach: 0, engagements: 0, posts: 0 },
    ]);
    expect(
      socialReachSeries(
        [{ ...history[0], views: null, reach: 25 }],
        "connection",
        [item({ publishedAt: "2026-08-17T12:00:00.000Z", reach: 300 })],
        2,
        new Date("2026-08-18T12:00:00.000Z"),
      ),
    ).toEqual([
      { date: "2026-08-17", views: 0, impressions: 100, reach: 300, engagements: 10, posts: 1 },
      { date: "2026-08-18", views: 0, impressions: 0, reach: 25, engagements: 0, posts: 0 },
    ]);
  });

  it("coalesces follower snapshots from the same day", () => {
    const history = [
      {
        connectionId: "connection",
        followers: 100,
        posts: null,
        views: null,
        reach: null,
        engagements: null,
        status: "available" as const,
        capturedAt: "2026-08-17T00:00:00.000Z",
      },
      {
        connectionId: "connection",
        followers: 105,
        posts: null,
        views: null,
        reach: null,
        engagements: null,
        status: "available" as const,
        capturedAt: "2026-08-17T12:00:00.000Z",
      },
    ];
    expect(followerGrowthSeries(history, "connection")).toEqual([
      { date: "2026-08-17T12:00:00.000Z", value: 105 },
    ]);
  });

  it("reconciles daily totals, content types, and best-content ranking", () => {
    const content = [
      item({ remotePostId: "text", impressions: 100 }),
      item({ remotePostId: "video", contentType: "video", impressions: 500, engagements: 40 }),
    ];
    const days = dailySocialPerformance(content, 2, new Date("2026-08-18T12:00:00.000Z"));
    expect(days[0]).toMatchObject({ date: "2026-08-17", impressions: 600, posts: 2 });
    expect(socialContentTypePerformance(content)[0]).toMatchObject({
      type: "video",
      averageImpressions: 500,
    });
    expect(bestSocialContent(content)[0].remotePostId).toBe("video");
  });

  it("ranks best content by the selected real metric", () => {
    const content = [
      item({ remotePostId: "most-viewed", views: 1_000, impressions: null, likes: 20 }),
      item({ remotePostId: "most-liked", views: 500, impressions: null, likes: 90 }),
    ];

    expect(bestSocialContent(content, 9, "views")[0].remotePostId).toBe("most-viewed");
    expect(bestSocialContent(content, 9, "likes")[0].remotePostId).toBe("most-liked");
  });

  it("offers only provider-backed growth metrics, including engagements", () => {
    expect(socialGrowthMetricsFor("instagram")).toEqual(["reach", "engagements", "followers"]);
    expect(socialGrowthMetricsFor("threads")).toEqual(["views", "engagements", "followers"]);
    expect(socialGrowthMetricsFor("youtube")).toEqual(["views", "engagements", "followers"]);
    expect(socialGrowthMetricsFor("tiktok")).toEqual(["views", "engagements", "followers"]);
    expect(socialGrowthMetricsFor("facebook")).toEqual([
      "impressions",
      "reach",
      "engagements",
      "followers",
    ]);
    expect(socialGrowthMetricsFor("linkedin")).toEqual(["impressions", "engagements", "followers"]);
    expect(socialGrowthMetricsFor("twitter")).toEqual(["impressions", "engagements", "followers"]);
    expect(socialGrowthMetricsFor("reddit")).toEqual(["engagements", "followers"]);
  });

  it("builds engagement growth from imported history and content fallback", () => {
    const history = [
      {
        connectionId: "connection",
        followers: null,
        posts: null,
        views: null,
        reach: null,
        engagements: 25,
        status: "available" as const,
        capturedAt: "2026-08-18T00:00:00.000Z",
      },
    ];

    expect(
      socialEngagementSeries(
        history,
        "connection",
        [item({ publishedAt: "2026-08-17T12:00:00.000Z", engagements: 12 })],
        2,
        new Date("2026-08-18T12:00:00.000Z"),
      ).map(({ date, engagements }) => ({ date, engagements })),
    ).toEqual([
      { date: "2026-08-17", engagements: 12 },
      { date: "2026-08-18", engagements: 25 },
    ]);
  });

  it("falls exposure back from views to impressions to engagements", () => {
    expect(socialContentExposureMetric([item({ views: 20, impressions: 40 })])).toBe("views");
    expect(socialContentExposureMetric([item({ views: null, impressions: 40 })])).toBe(
      "impressions",
    );
    expect(
      socialContentExposureMetric([
        item({ views: null, impressions: null, engagements: 30, likes: 20 }),
      ]),
    ).toBe("engagements");

    const performance = socialContentTypePerformance([
      item({ views: null, impressions: null, engagements: 30 }),
    ]);
    expect(performance[0]).toMatchObject({ averageEngagements: 30 });
    expect(
      socialMilestones(
        {
          connectionId: "reddit",
          provider: "reddit",
          handle: "creator",
          displayName: "Creator",
          avatarUrl: null,
          followers: 100,
          following: null,
          posts: 1,
          views: null,
          reach: null,
          engagements: 12_000,
          status: "partial",
          note: null,
          fetchedAt: "2026-08-18T12:00:00.000Z",
          refreshing: false,
          refreshStartedAt: null,
        },
        [item({ provider: "reddit", views: null, impressions: null, engagements: 12_000 })],
      ),
    ).toContainEqual({ label: "10K engagements", reached: true });
  });

  it("explains provider API limits instead of promising unavailable history", () => {
    expect(socialProviderEmptyStateMessage("facebook")).toContain("Page Insights permission");
    expect(socialProviderEmptyStateMessage("linkedin")).toContain("product approval");
    for (const provider of ["tiktok", "twitter", "reddit"] as const) {
      expect(socialProviderEmptyStateMessage(provider)).toContain("does not provide historical");
      expect(socialProviderEmptyStateMessage(provider)).toContain("Bento records");
    }
    expect(socialProviderEmptyStateMessage("instagram")).toContain(
      "does not provide historical follower totals",
    );
    expect(socialProviderEmptyStateMessage("threads")).toContain(
      "does not provide historical follower totals",
    );
    expect(socialProviderEmptyStateMessage("youtube")).toContain("Refresh to import");
  });

  it("keeps zero-valued exposure labels truthful when no positive metric exists", () => {
    expect(
      socialContentExposureMetric([
        item({ views: 0, impressions: null, engagements: null, likes: null }),
      ]),
    ).toBe("views");
    expect(socialContentExposureMetric([])).toBe("engagements");
  });

  it("uses provider-preferred exposure milestones before engagement fallback", () => {
    const account = {
      connectionId: "account",
      provider: "instagram" as const,
      handle: "creator",
      displayName: "Creator",
      avatarUrl: null,
      followers: null,
      following: null,
      posts: 1,
      views: 20_000,
      reach: null,
      engagements: 30_000,
      status: "available" as const,
      note: null,
      fetchedAt: "2026-08-18T12:00:00.000Z",
      refreshing: false,
      refreshStartedAt: null,
    };
    expect(
      socialMilestones(account, [item({ provider: "instagram", views: 15_000 })]),
    ).toContainEqual({ label: "10K views", reached: true });
    expect(
      socialMilestones({ ...account, provider: "facebook" as const }, [
        item({ provider: "facebook", views: null, impressions: 15_000 }),
      ]),
    ).toContainEqual({ label: "10K impressions", reached: true });
  });
});
