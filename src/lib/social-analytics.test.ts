import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFacebookPageInsightsUrl,
  buildFacebookPageHistoryUrl,
  buildLinkedInDailyAnalyticsUrl,
  buildYouTubeAnalyticsUrl,
  INSTAGRAM_DAILY_INSIGHT_METRICS,
  normalizeMetaDailyHistory,
  normalizeLinkedInDailyAnalytics,
  normalizeFacebookPageInsights,
  normalizeYouTubeAnalyticsHistory,
  normalizeSocialInsightsBackfillMessage,
  normalizeSocialInsightsDisplayPeriod,
  isSocialInsightsCapabilityError,
  socialAnalyticsNumber,
  socialAnalyticsAvatarUrl,
  socialInsightsBackfillTargets,
  socialInsightsBackfillMessages,
  socialInsightsCheckpointMatches,
  socialInsightsDeliveryDisposition,
  socialInsightsLeaseIsActive,
  socialAnalyticsAccountsForPeriod,
  summarizeSocialAnalytics,
  uniqueStorableSocialContent,
  type SocialAnalyticsAccount,
} from "./social-analytics.functions";
import type { SocialContentInsight } from "./social-content-insights.server";
import { ProviderError } from "./social-publisher.server";
import { socialApiPayloadHasError } from "./social-provider-response";

const account = (followers: number | null, views: number | null): SocialAnalyticsAccount => ({
  connectionId: crypto.randomUUID(),
  provider: "instagram",
  handle: "creator",
  displayName: "Creator",
  avatarUrl: null,
  followers,
  following: null,
  posts: 2,
  views,
  reach: views === null ? null : Math.floor(views / 2),
  engagements: 3,
  status: "available",
  note: null,
  fetchedAt: "2026-08-10T00:00:00.000Z",
  refreshing: false,
  refreshStartedAt: null,
});

const content = (
  connectionId: string,
  daysAgo: number,
  metrics: Partial<Pick<SocialContentInsight, "views" | "reach" | "engagements">> = {},
): SocialContentInsight => ({
  connectionId,
  provider: "instagram",
  remotePostId: String(daysAgo),
  remotePostUrl: null,
  contentType: "image",
  caption: null,
  thumbnailUrl: null,
  publishedAt: new Date(Date.UTC(2026, 7, 20) - daysAgo * 24 * 60 * 60_000).toISOString(),
  views: null,
  impressions: null,
  reach: null,
  engagements: null,
  likes: null,
  comments: null,
  shares: null,
  saves: null,
  fetchedAt: "2026-08-20T00:00:00.000Z",
  ...metrics,
});

describe("social analytics", () => {
  it("prefers the live connection avatar and retains the snapshot fallback", () => {
    expect(
      socialAnalyticsAvatarUrl("https://old.example/avatar.jpg", "https://new.example/avatar.jpg"),
    ).toBe("https://new.example/avatar.jpg");
    expect(socialAnalyticsAvatarUrl("https://old.example/avatar.jpg", null)).toBe(
      "https://old.example/avatar.jpg",
    );
  });

  it("binds Cloudflare crypto when generating background job ids", () => {
    expect(socialInsightsBackfillMessages("user", [{ id: "connection" }])[0].jobId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it("creates one background history-import message per connected account", () => {
    const ids = ["job-instagram", "job-threads"];
    expect(
      socialInsightsBackfillMessages(
        "user",
        [{ id: "instagram" }, { id: "threads" }],
        new Date("2026-08-20T00:00:00.000Z"),
        () => ids.shift()!,
      ),
    ).toEqual([
      {
        kind: "social_insights_backfill",
        userId: "user",
        connectionId: "instagram",
        jobId: "job-instagram",
        stage: "account",
        cursor: null,
        startedAt: "2026-08-20T00:00:00.000Z",
      },
      {
        kind: "social_insights_backfill",
        userId: "user",
        connectionId: "threads",
        jobId: "job-threads",
        stage: "account",
        cursor: null,
        startedAt: "2026-08-20T00:00:00.000Z",
      },
    ]);
  });

  it("upgrades legacy queue messages to a job-scoped account import", () => {
    expect(
      normalizeSocialInsightsBackfillMessage(
        { kind: "social_insights_backfill", userId: "user", connectionId: "connection" },
        new Date("2026-08-20T00:00:00.000Z"),
        () => "legacy-job",
      ),
    ).toEqual({
      kind: "social_insights_backfill",
      userId: "user",
      connectionId: "connection",
      jobId: "legacy-job",
      stage: "account",
      cursor: null,
      startedAt: "2026-08-20T00:00:00.000Z",
    });
  });

  it("keeps fresh imports exclusive even when refresh is forced and recovers stale imports", () => {
    const now = new Date("2026-08-20T00:20:00.000Z");
    const connections = [{ id: "fresh" }, { id: "stale" }, { id: "completed" }];
    const snapshots = [
      {
        connection_id: "fresh",
        refresh_job_id: "fresh-job",
        refresh_started_at: "2026-08-20T00:10:00.001Z",
        history_imported_at: null,
      },
      {
        connection_id: "stale",
        refresh_job_id: "stale-job",
        refresh_started_at: "2026-08-20T00:04:59.999Z",
        history_imported_at: null,
      },
      {
        connection_id: "completed",
        refresh_job_id: null,
        refresh_started_at: null,
        history_imported_at: "2026-08-19T00:00:00.000Z",
      },
    ];

    expect(socialInsightsLeaseIsActive(snapshots[0], now)).toBe(true);
    expect(socialInsightsLeaseIsActive(snapshots[1], now)).toBe(false);
    expect(
      socialInsightsBackfillTargets(connections, snapshots, { force: false, now }).map(
        (connection) => connection.id,
      ),
    ).toEqual(["stale"]);
    expect(
      socialInsightsBackfillTargets(connections, snapshots, { force: true, now }).map(
        (connection) => connection.id,
      ),
    ).toEqual(["stale", "completed"]);
  });

  it("adds job ownership to the social analytics snapshot schema", () => {
    const migrationName = readdirSync(join(process.cwd(), "supabase/migrations")).find((name) =>
      name.endsWith("_social_insights_chunked_imports.sql"),
    );
    expect(migrationName).toBeTruthy();
    const migration = readFileSync(
      join(process.cwd(), "supabase/migrations", migrationName!),
      "utf8",
    );
    expect(migration).toContain("add column if not exists refresh_job_id uuid");
    expect(migration).toContain("add column if not exists refresh_stage text");
    expect(migration).toContain("add column if not exists refresh_cursor text");
    expect(migration).toContain("add column if not exists refresh_processing_at timestamptz");
    expect(migration).toContain("where refresh_started_at is not null");
  });

  it("accepts only the active job checkpoint and rejects replayed cursors", () => {
    const checkpoint = {
      refresh_job_id: "job",
      refresh_stage: "content",
      refresh_cursor: "page-2",
    };
    const message = normalizeSocialInsightsBackfillMessage({
      kind: "social_insights_backfill",
      userId: "user",
      connectionId: "connection",
      jobId: "job",
      stage: "content",
      cursor: "page-2",
      startedAt: "2026-08-20T00:00:00.000Z",
    });

    expect(socialInsightsCheckpointMatches(checkpoint, message)).toBe(true);
    expect(socialInsightsCheckpointMatches(checkpoint, { ...message, cursor: "page-1" })).toBe(
      false,
    );
  });

  it("finishes limited provider imports and never retries an exhausted delivery", () => {
    const forbidden = new ProviderError("Missing scope", "scope", false, 403);
    expect(isSocialInsightsCapabilityError(forbidden)).toBe(true);
    expect(
      isSocialInsightsCapabilityError(new ProviderError("Expired", "expired", false, 401)),
    ).toBe(false);
    expect(socialInsightsDeliveryDisposition(forbidden, 1)).toBe("fail");
    expect(socialInsightsDeliveryDisposition(new ProviderError("Busy", "busy", true, 500), 4)).toBe(
      "retry",
    );
    expect(socialInsightsDeliveryDisposition(new ProviderError("Busy", "busy", true, 500), 5)).toBe(
      "retry",
    );
    expect(socialInsightsDeliveryDisposition(new ProviderError("Busy", "busy", true, 500), 6)).toBe(
      "dead_letter",
    );
  });

  it("does not treat Instagram daily follower gains as absolute follower totals", () => {
    expect(INSTAGRAM_DAILY_INSIGHT_METRICS).toEqual(["reach"]);
  });

  it("normalizes provider counters and only totals reported metrics", () => {
    expect(socialAnalyticsNumber("1,000", "42")).toBe(42);
    expect(socialAnalyticsNumber("1000")).toBe(1000);
    expect(socialAnalyticsNumber(-1, undefined)).toBeNull();
    expect(summarizeSocialAnalytics([account(100, 500), account(null, 250)])).toMatchObject({
      totalFollowers: 100,
      totalViews: 750,
      totalReach: 375,
      totalPosts: 4,
      followerCoverage: 1,
    });
  });

  it("uses the selected public content window while keeping followers current", () => {
    const current = { ...account(240, 9_999), connectionId: "instagram" };
    const posts = [
      content("instagram", 10, { views: 100, reach: 80, engagements: 20 }),
      content("instagram", 31, { views: 40, reach: 30, engagements: 10 }),
      content("instagram", 91, { views: 20, reach: 10, engagements: 5 }),
    ];
    const now = new Date("2026-08-20T00:00:00.000Z");

    expect(socialAnalyticsAccountsForPeriod([current], posts, 30, now)[0]).toMatchObject({
      followers: 240,
      posts: 1,
      views: 100,
      reach: 80,
      engagements: 20,
    });
    expect(socialAnalyticsAccountsForPeriod([current], posts, 90, now)[0]).toMatchObject({
      followers: 240,
      posts: 2,
      views: 140,
      reach: 110,
      engagements: 30,
    });
  });

  it("keeps unknown period metrics unknown and reports zero when no posts were published", () => {
    const current = { ...account(240, 9_999), connectionId: "instagram" };
    const now = new Date("2026-08-20T00:00:00.000Z");
    expect(
      socialAnalyticsAccountsForPeriod(
        [current],
        [content("instagram", 10, { reach: 12 })],
        30,
        now,
      )[0],
    ).toMatchObject({ posts: 1, views: null, reach: 12, engagements: null });
    expect(
      socialAnalyticsAccountsForPeriod(
        [current],
        [content("instagram", 31, { views: 10 })],
        30,
        now,
      )[0],
    ).toMatchObject({ posts: 0, views: 0, reach: 0, engagements: 0 });
  });

  it("defaults invalid public insight periods to 30 days and constrains the profile setting", () => {
    expect(normalizeSocialInsightsDisplayPeriod(null)).toBe(30);
    expect(normalizeSocialInsightsDisplayPeriod(90)).toBe(90);
    expect(normalizeSocialInsightsDisplayPeriod(60)).toBe(30);

    const migration = readFileSync(
      join(process.cwd(), "supabase/migrations/20260823120000_public_social_insights_period.sql"),
      "utf8",
    );
    expect(migration).toContain("social_insights_period_days smallint not null default 30");
    expect(migration).toContain("check (social_insights_period_days in (30, 90, 365))");
  });

  it("requests current 28-day Facebook Page Insights metrics", () => {
    const url = buildFacebookPageInsightsUrl("page/one", "v25.0");

    expect(url.pathname).toBe("/v25.0/page%2Fone/insights");
    expect(url.searchParams.get("period")).toBe("days_28");
    expect(url.searchParams.get("metric")?.split(",")).toEqual([
      "page_media_view",
      "page_total_media_view_unique",
      "page_post_engagements",
    ]);
  });

  it("normalizes Facebook Page views, reach, and engagements", () => {
    expect(
      normalizeFacebookPageInsights({
        data: [
          { name: "page_media_view", values: [{ value: 120 }, { value: 240 }] },
          { name: "page_total_media_view_unique", values: [{ value: 80 }] },
          { name: "page_post_engagements", values: [{ value: 32 }] },
        ],
      }),
    ).toEqual({ views: 240, reach: 80, engagements: 32 });
  });

  it("requests LinkedIn daily analytics over the requested history window", () => {
    const url = buildLinkedInDailyAnalyticsUrl(
      "IMPRESSION",
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-02-01T00:00:00.000Z"),
    );

    expect(url.pathname).toBe("/rest/memberCreatorPostAnalytics");
    expect(url.searchParams.get("q")).toBe("me");
    expect(url.searchParams.get("queryType")).toBe("IMPRESSION");
    expect(url.searchParams.get("aggregation")).toBe("DAILY");
    expect(url.searchParams.get("dateRange")).toBe(
      "(start:(day:1,month:1,year:2026),end:(day:1,month:2,year:2026))",
    );
  });

  it("merges LinkedIn daily metrics by date", () => {
    expect(
      normalizeLinkedInDailyAnalytics([
        {
          metricType: "IMPRESSION",
          count: 100,
          dateRange: { start: { year: 2026, month: 7, day: 1 } },
        },
        {
          metricType: "REACTION",
          count: 8,
          dateRange: { start: { year: 2026, month: 7, day: 1 } },
        },
        {
          metricType: "COMMENT",
          count: 2,
          dateRange: { start: { year: 2026, month: 7, day: 1 } },
        },
      ]),
    ).toEqual([
      {
        capturedAt: "2026-07-01T00:00:00.000Z",
        views: 100,
        engagements: 10,
      },
    ]);
  });

  it("requests and normalizes daily Meta history", () => {
    const url = buildFacebookPageHistoryUrl(
      "page/one",
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-02-01T00:00:00.000Z"),
      "v25.0",
    );
    expect(url.pathname).toBe("/v25.0/page%2Fone/insights");
    expect(url.searchParams.get("period")).toBe("day");
    expect(url.searchParams.get("since")).toBe("1767225600");
    expect(url.searchParams.get("until")).toBe("1769904000");
    expect(
      normalizeMetaDailyHistory({
        data: [
          {
            name: "page_media_view",
            values: [{ value: 120, end_time: "2026-01-02T00:00:00+0000" }],
          },
          {
            name: "page_total_media_view_unique",
            values: [{ value: 80, end_time: "2026-01-02T00:00:00+0000" }],
          },
          {
            name: "page_post_engagements",
            values: [{ value: 14, end_time: "2026-01-02T00:00:00+0000" }],
          },
          {
            name: "follower_count",
            values: [{ value: 1200, end_time: "2026-01-02T00:00:00+0000" }],
          },
        ],
      }),
    ).toEqual([
      {
        capturedAt: "2026-01-01T00:00:00.000Z",
        followers: 1200,
        views: 120,
        reach: 80,
        engagements: 14,
      },
    ]);
  });

  it("builds and normalizes YouTube daily channel analytics", () => {
    const url = buildYouTubeAnalyticsUrl(
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-02-01T00:00:00.000Z"),
    );
    expect(url.searchParams.get("dimensions")).toBe("day");
    expect(url.searchParams.get("metrics")).toContain("views");
    expect(
      normalizeYouTubeAnalyticsHistory(
        {
          columnHeaders: [
            { name: "day" },
            { name: "views" },
            { name: "likes" },
            { name: "comments" },
            { name: "shares" },
            { name: "subscribersGained" },
            { name: "subscribersLost" },
          ],
          rows: [
            ["2026-01-01", 500, 20, 3, 2, 6, 1],
            ["2026-01-02", 300, 12, 2, 1, 3, 1],
          ],
        },
        107,
      ),
    ).toEqual([
      {
        capturedAt: "2026-01-01T00:00:00.000Z",
        followers: 105,
        views: 500,
        reach: null,
        engagements: 25,
      },
      {
        capturedAt: "2026-01-02T00:00:00.000Z",
        followers: 107,
        views: 300,
        reach: null,
        engagements: 15,
      },
    ]);
  });

  it("does not treat TikTok analytics success envelopes as errors", () => {
    expect(
      socialApiPayloadHasError({
        data: {
          user: {
            follower_count: 12,
            following_count: 3,
            likes_count: 40,
            video_count: 2,
          },
        },
        error: { code: "ok", message: "" },
      }),
    ).toBe(false);
  });

  it("deduplicates provider content before a database upsert", () => {
    const content = (id: string, publishedAt: string): SocialContentInsight => ({
      connectionId: "connection",
      provider: "youtube",
      remotePostId: id,
      remotePostUrl: null,
      contentType: "video",
      caption: null,
      thumbnailUrl: null,
      publishedAt,
      views: null,
      impressions: 10,
      reach: null,
      engagements: 1,
      likes: 1,
      comments: 0,
      shares: 0,
      saves: null,
      fetchedAt: "2026-08-19T00:00:00.000Z",
    });

    expect(
      uniqueStorableSocialContent([
        content("same-video", "2026-08-01T00:00:00.000Z"),
        content("same-video", "2026-08-01T00:00:00.000Z"),
        content("invalid-date", ""),
      ]).map((item) => item.remotePostId),
    ).toEqual(["same-video"]);
  });
});
