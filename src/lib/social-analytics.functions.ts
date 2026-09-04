/* eslint-disable @typescript-eslint/no-explicit-any -- Provider payloads are normalized at this boundary. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { publicProfileUrl } from "./application-urls";
import {
  buildInstagramInsightsUrl,
  instagramInsightsResponseSchema,
  normalizeInstagramInsights,
} from "./instagram-insights";
import { getPlan } from "./plan.server";
import { planHasEntitlement } from "./plans";
import { enforceRequestRateLimit, readResponseText } from "./request-security.server";
import { socialApiErrorMessage, socialApiPayloadHasError } from "./social-provider-response";
import {
  fetchSocialContentInsightsPage,
  type SocialContentInsight,
} from "./social-content-insights.server";
import { accessTokenForConnection, ProviderError } from "./social-publisher.server";
import type { SocialProvider } from "./social-scheduler";

export const SOCIAL_INSIGHTS_LEASE_MS = 15 * 60_000;
export const SOCIAL_INSIGHTS_DISPLAY_PERIODS = [30, 90, 365] as const;
export type SocialInsightsDisplayPeriodDays = (typeof SOCIAL_INSIGHTS_DISPLAY_PERIODS)[number];

export function normalizeSocialInsightsDisplayPeriod(
  value: unknown,
): SocialInsightsDisplayPeriodDays {
  return SOCIAL_INSIGHTS_DISPLAY_PERIODS.includes(value as SocialInsightsDisplayPeriodDays)
    ? (value as SocialInsightsDisplayPeriodDays)
    : 30;
}

export function socialInsightsDisplayPeriodLabel(value: unknown) {
  const days = normalizeSocialInsightsDisplayPeriod(value);
  return days === 365 ? "Last year" : `Last ${days} days`;
}

export type SocialAnalyticsAccount = {
  connectionId: string;
  provider: SocialProvider;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  followers: number | null;
  following: number | null;
  posts: number | null;
  views: number | null;
  reach: number | null;
  engagements: number | null;
  status: "available" | "partial" | "unavailable" | "error";
  note: string | null;
  fetchedAt: string;
  refreshing: boolean;
  refreshStartedAt: string | null;
};

export type SocialInsightsBackfillMessage = {
  kind: "social_insights_backfill";
  userId: string;
  connectionId: string;
  jobId?: string;
  stage?: "account" | "content";
  cursor?: string | null;
  startedAt?: string;
};

export type NormalizedSocialInsightsBackfillMessage = SocialInsightsBackfillMessage & {
  jobId: string;
  stage: "account" | "content";
  cursor: string | null;
  startedAt: string;
};

type SocialInsightsSnapshotLease = {
  connection_id: string;
  refresh_job_id?: string | null;
  refresh_stage?: "account" | "content" | null;
  refresh_cursor?: string | null;
  refresh_processing_at?: string | null;
  refresh_started_at?: string | null;
  history_imported_at?: string | null;
};

type SocialInsightsCheckpoint = {
  refresh_job_id?: string | null;
  refresh_stage?: string | null;
  refresh_cursor?: string | null;
};

// Cloudflare `max_retries: 5` means one initial delivery plus five retries.
const SOCIAL_INSIGHTS_MAX_DELIVERY_ATTEMPTS = 6;

export function normalizeSocialInsightsBackfillMessage(
  message: SocialInsightsBackfillMessage,
  now = new Date(),
  createJobId: () => string = () => crypto.randomUUID(),
): NormalizedSocialInsightsBackfillMessage {
  const startedAt =
    message.startedAt && Number.isFinite(Date.parse(message.startedAt))
      ? new Date(message.startedAt).toISOString()
      : now.toISOString();
  return {
    ...message,
    jobId: message.jobId || createJobId(),
    stage: message.stage === "content" ? "content" : "account",
    cursor: typeof message.cursor === "string" && message.cursor ? message.cursor : null,
    startedAt,
  };
}

export function socialInsightsLeaseIsActive(
  snapshot: Pick<SocialInsightsSnapshotLease, "refresh_started_at"> | null | undefined,
  now = new Date(),
) {
  const started = snapshot?.refresh_started_at
    ? Date.parse(snapshot.refresh_started_at)
    : Number.NaN;
  return Number.isFinite(started) && started > now.getTime() - SOCIAL_INSIGHTS_LEASE_MS;
}

export function socialInsightsCheckpointMatches(
  checkpoint: SocialInsightsCheckpoint,
  message: NormalizedSocialInsightsBackfillMessage,
) {
  return (
    checkpoint.refresh_job_id === message.jobId &&
    checkpoint.refresh_stage === message.stage &&
    (checkpoint.refresh_cursor || null) === message.cursor
  );
}

export function isSocialInsightsCapabilityError(error: unknown) {
  return (
    error instanceof ProviderError &&
    !error.retryable &&
    error.code !== "connection_unavailable" &&
    (error.status === 400 || error.status === 403 || error.status === 404)
  );
}

export function socialInsightsDeliveryDisposition(error: unknown, attempts: number) {
  if (error instanceof ProviderError && !error.retryable) return "fail" as const;
  return attempts < SOCIAL_INSIGHTS_MAX_DELIVERY_ATTEMPTS
    ? ("retry" as const)
    : ("dead_letter" as const);
}

export function socialInsightsBackfillTargets<T extends { id: string }>(
  connections: T[],
  snapshots: SocialInsightsSnapshotLease[],
  { force, now = new Date() }: { force: boolean; now?: Date },
) {
  const byConnection = new Map(snapshots.map((snapshot) => [snapshot.connection_id, snapshot]));
  return connections.filter((connection) => {
    const snapshot = byConnection.get(connection.id);
    if (socialInsightsLeaseIsActive(snapshot, now)) return false;
    if (snapshot?.refresh_started_at) return true;
    return force || !snapshot?.history_imported_at;
  });
}

export function socialInsightsBackfillMessages(
  userId: string,
  connections: Array<{ id: string }>,
  now = new Date(),
  createJobId: () => string = () => crypto.randomUUID(),
): NormalizedSocialInsightsBackfillMessage[] {
  const startedAt = now.toISOString();
  return connections.map((connection) => ({
    kind: "social_insights_backfill",
    userId,
    connectionId: connection.id,
    jobId: createJobId(),
    stage: "account",
    cursor: null,
    startedAt,
  }));
}

export type SocialAnalyticsHistoryPoint = Pick<
  SocialAnalyticsAccount,
  "connectionId" | "followers" | "posts" | "views" | "reach" | "engagements" | "status"
> & {
  capturedAt: string;
};

type ProviderAnalytics = Pick<
  SocialAnalyticsAccount,
  "followers" | "following" | "posts" | "views" | "reach" | "engagements" | "status" | "note"
>;

const FACEBOOK_PAGE_INSIGHT_METRICS = [
  "page_media_view",
  "page_total_media_view_unique",
  "page_post_engagements",
] as const;
const LINKEDIN_DAILY_METRICS = ["IMPRESSION", "REACTION", "COMMENT", "RESHARE"] as const;
type LinkedInDailyMetric = (typeof LINKEDIN_DAILY_METRICS)[number];

export function socialAnalyticsNumber(...values: unknown[]) {
  for (const value of values) {
    const parsed = typeof value === "string" && value.trim() === "" ? NaN : Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  }
  return null;
}

export function buildFacebookPageInsightsUrl(pageId: string, apiVersion = "v25.0") {
  const url = new URL(
    `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(pageId)}/insights`,
  );
  url.searchParams.set("metric", FACEBOOK_PAGE_INSIGHT_METRICS.join(","));
  url.searchParams.set("period", "days_28");
  return url;
}

export function buildFacebookPageHistoryUrl(
  pageId: string,
  start: Date,
  end: Date,
  apiVersion = "v25.0",
) {
  const url = new URL(
    `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(pageId)}/insights`,
  );
  url.searchParams.set("metric", FACEBOOK_PAGE_INSIGHT_METRICS.join(","));
  url.searchParams.set("period", "day");
  url.searchParams.set("since", String(Math.floor(start.getTime() / 1_000)));
  url.searchParams.set("until", String(Math.floor(end.getTime() / 1_000)));
  return url;
}

export function normalizeFacebookPageInsights(payload: unknown) {
  const rows =
    payload && typeof payload === "object" && Array.isArray((payload as any).data)
      ? (payload as any).data
      : [];
  const metrics = new Map(
    rows.map((metric: any) => [
      metric?.name,
      metric?.total_value?.value ??
        (Array.isArray(metric?.values) ? metric.values.at(-1)?.value : undefined),
    ]),
  );
  return {
    views: socialAnalyticsNumber(metrics.get("page_media_view")),
    reach: socialAnalyticsNumber(metrics.get("page_total_media_view_unique")),
    engagements: socialAnalyticsNumber(metrics.get("page_post_engagements")),
  };
}

type DailyPerformancePoint = {
  capturedAt: string;
  followers?: number | null;
  views: number | null;
  reach: number | null;
  engagements: number | null;
};

const META_DAILY_METRIC_KIND: Record<string, "followers" | "views" | "reach" | "engagements"> = {
  follower_count: "followers",
  views: "views",
  page_media_view: "views",
  reach: "reach",
  page_total_media_view_unique: "reach",
  accounts_engaged: "engagements",
  total_interactions: "engagements",
  page_post_engagements: "engagements",
  likes: "engagements",
  replies: "engagements",
  reposts: "engagements",
  quotes: "engagements",
};

// Meta exposes reach as a time series. Views and total_interactions are totals,
// so requesting them as time_series makes the entire historical request invalid.
export const INSTAGRAM_DAILY_INSIGHT_METRICS = ["reach"] as const;

export function normalizeMetaDailyHistory(payload: any): DailyPerformancePoint[] {
  const byDate = new Map<string, DailyPerformancePoint>();
  for (const metric of Array.isArray(payload?.data) ? payload.data : []) {
    const kind = META_DAILY_METRIC_KIND[String(metric?.name || "")];
    if (!kind) continue;
    for (const value of Array.isArray(metric?.values) ? metric.values : []) {
      const intervalEnd = new Date(value?.end_time);
      if (!Number.isFinite(intervalEnd.getTime())) continue;
      intervalEnd.setUTCDate(intervalEnd.getUTCDate() - 1);
      intervalEnd.setUTCHours(0, 0, 0, 0);
      const capturedAt = intervalEnd.toISOString();
      const point = byDate.get(capturedAt) || {
        capturedAt,
        followers: null,
        views: null,
        reach: null,
        engagements: null,
      };
      const count = socialAnalyticsNumber(value?.value);
      if (kind === "engagements" && count !== null)
        point.engagements = (point.engagements || 0) + count;
      else point[kind] = count;
      byDate.set(capturedAt, point);
    }
  }
  return [...byDate.values()].sort((left, right) =>
    left.capturedAt.localeCompare(right.capturedAt),
  );
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function buildYouTubeAnalyticsUrl(start: Date, end: Date) {
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", isoDate(start));
  url.searchParams.set("endDate", isoDate(end));
  url.searchParams.set("dimensions", "day");
  url.searchParams.set("sort", "day");
  url.searchParams.set(
    "metrics",
    "views,likes,comments,shares,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost",
  );
  return url;
}

export function normalizeYouTubeAnalyticsHistory(
  payload: any,
  currentFollowers: number | null = null,
): DailyPerformancePoint[] {
  const columns = new Map(
    (Array.isArray(payload?.columnHeaders) ? payload.columnHeaders : []).map(
      (column: any, index: number) => [column?.name, index],
    ),
  );
  const at = (row: any[], name: string) =>
    columns.has(name) ? socialAnalyticsNumber(row[columns.get(name) as number]) : null;
  const rows: any[][] = Array.isArray(payload?.rows) ? payload.rows : [];
  const points: Array<DailyPerformancePoint & { followerChange: number | null }> = rows.flatMap(
    (row: any[]) => {
      const day = columns.has("day") ? String(row[columns.get("day") as number]) : "";
      const timestamp = new Date(`${day}T00:00:00.000Z`);
      if (!day || !Number.isFinite(timestamp.getTime())) return [];
      const likes = at(row, "likes");
      const comments = at(row, "comments");
      const shares = at(row, "shares");
      const gained = at(row, "subscribersGained");
      const lost = at(row, "subscribersLost");
      return [
        {
          capturedAt: timestamp.toISOString(),
          followerChange: gained === null && lost === null ? null : (gained || 0) - (lost || 0),
          views: at(row, "views"),
          reach: null,
          engagements:
            likes === null && comments === null && shares === null
              ? null
              : (likes || 0) + (comments || 0) + (shares || 0),
        },
      ];
    },
  );
  const changes = points.map((point) => point.followerChange);
  let followers =
    currentFollowers === null || changes.every((change) => change === null)
      ? null
      : Math.max(
          0,
          currentFollowers - changes.reduce<number>((total, change) => total + (change || 0), 0),
        );
  return points.map(({ followerChange, ...point }) => {
    if (followers === null) return point;
    followers = Math.max(0, followers + (followerChange || 0));
    return { ...point, followers };
  });
}

function linkedInDate(date: Date) {
  return `day:${date.getUTCDate()},month:${date.getUTCMonth() + 1},year:${date.getUTCFullYear()}`;
}

function linkedInAnalyticsUrl(metric: string, aggregation: "DAILY" | "TOTAL") {
  const url = new URL("https://api.linkedin.com/rest/memberCreatorPostAnalytics");
  url.searchParams.set("q", "me");
  url.searchParams.set("queryType", metric);
  url.searchParams.set("aggregation", aggregation);
  return url;
}

export function buildLinkedInDailyAnalyticsUrl(
  metric: LinkedInDailyMetric,
  start: Date,
  end: Date,
) {
  const url = linkedInAnalyticsUrl(metric, "DAILY");
  url.searchParams.set("dateRange", `(start:(${linkedInDate(start)}),end:(${linkedInDate(end)}))`);
  return url;
}

function linkedInMetricType(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return String(Object.values(value)[0] || "");
  return "";
}

export function normalizeLinkedInDailyAnalytics(rows: any[]) {
  const byDate = new Map<
    string,
    { capturedAt: string; views: number | null; engagements: number | null }
  >();
  for (const row of rows) {
    const start = row?.dateRange?.start;
    const timestamp = Date.UTC(Number(start?.year), Number(start?.month) - 1, Number(start?.day));
    if (!Number.isFinite(timestamp)) continue;
    const capturedAt = new Date(timestamp).toISOString();
    const point = byDate.get(capturedAt) || { capturedAt, views: null, engagements: null };
    const value = socialAnalyticsNumber(row?.count);
    const metric = linkedInMetricType(row?.metricType);
    if (metric === "IMPRESSION") point.views = value;
    else if (["REACTION", "COMMENT", "RESHARE"].includes(metric) && value !== null)
      point.engagements = (point.engagements || 0) + value;
    byDate.set(capturedAt, point);
  }
  return [...byDate.values()].sort((left, right) =>
    left.capturedAt.localeCompare(right.capturedAt),
  );
}

export function summarizeSocialAnalytics(accounts: readonly SocialAnalyticsAccount[]) {
  const sum = (key: "followers" | "views" | "reach" | "engagements" | "posts") => {
    const values = accounts.flatMap((account) =>
      typeof account[key] === "number" ? [account[key]] : [],
    );
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  return {
    totalFollowers: sum("followers"),
    totalViews: sum("views"),
    totalReach: sum("reach"),
    totalEngagements: sum("engagements"),
    totalPosts: sum("posts"),
    followerCoverage: accounts.filter((account) => account.followers !== null).length,
  };
}

export function socialAnalyticsAccountsForPeriod(
  accounts: readonly SocialAnalyticsAccount[],
  content: readonly SocialContentInsight[],
  periodDays: SocialInsightsDisplayPeriodDays,
  now = new Date(),
) {
  const cutoff = now.getTime() - periodDays * 24 * 60 * 60_000;
  return accounts.map((account) => {
    const imported = content.filter((item) => item.connectionId === account.connectionId);
    if (!imported.length)
      return { ...account, posts: null, views: null, reach: null, engagements: null };

    const selected = imported.filter((item) => {
      const publishedAt = Date.parse(item.publishedAt);
      return Number.isFinite(publishedAt) && publishedAt >= cutoff && publishedAt <= now.getTime();
    });
    const sum = (key: "views" | "reach" | "engagements") => {
      const values = selected.flatMap((item) => (typeof item[key] === "number" ? [item[key]] : []));
      return values.length
        ? values.reduce((total, value) => total + value, 0)
        : selected.length
          ? null
          : 0;
    };
    return {
      ...account,
      posts: selected.length,
      views: sum("views"),
      reach: sum("reach"),
      engagements: sum("engagements"),
    };
  });
}

async function providerJson(
  url: string | URL,
  token: string,
  extraHeaders: Record<string, string> = {},
) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "bento.surf-social-analytics",
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await readResponseText(response, 512 * 1024);
  const payload = body ? JSON.parse(body) : {};
  if (!response.ok || socialApiPayloadHasError(payload)) {
    throw new ProviderError(
      socialApiErrorMessage(payload, "Social analytics are temporarily unavailable."),
      String(
        (typeof payload.error === "object" && payload.error?.code) ||
          (typeof payload.error === "string" ? payload.error : undefined) ||
          response.status,
      ),
      response.status === 429 || response.status >= 500,
      response.status,
    );
  }
  return payload;
}

async function fetchFacebookPageInsightMetrics(
  pageId: string,
  token: string,
  options: { period: "day" | "days_28"; start?: Date; end?: Date },
) {
  const apiVersion = process.env.META_GRAPH_API_VERSION?.trim() || "v25.0";
  const payloads = await Promise.all(
    FACEBOOK_PAGE_INSIGHT_METRICS.map(async (metric) => {
      const url = new URL(
        `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(pageId)}/insights`,
      );
      url.searchParams.set("metric", metric);
      url.searchParams.set("period", options.period);
      if (options.start)
        url.searchParams.set("since", String(Math.floor(options.start.getTime() / 1_000)));
      if (options.end)
        url.searchParams.set("until", String(Math.floor(options.end.getTime() / 1_000)));
      try {
        return await providerJson(url, token);
      } catch (error) {
        if (!(error instanceof ProviderError) || error.retryable) throw error;
        return { data: [] };
      }
    }),
  );
  return {
    data: payloads.flatMap((payload) => (Array.isArray(payload.data) ? payload.data : [])),
  };
}

function unavailable(note: string): ProviderAnalytics {
  return {
    followers: null,
    following: null,
    posts: null,
    views: null,
    reach: null,
    engagements: null,
    status: "unavailable",
    note,
  };
}

function optionalProviderAnalytics(error: unknown) {
  if (!(error instanceof ProviderError) || error.retryable || error.status === 401) throw error;
  return null;
}

function linkedInHeaders() {
  return {
    "LinkedIn-Version": process.env.LINKEDIN_API_VERSION?.trim() || "202606",
    "X-Restli-Protocol-Version": "2.0.0",
    "X-RestLi-Method": "FINDER",
  };
}

async function linkedInTotalMetric(metric: string, token: string) {
  const data = await providerJson(linkedInAnalyticsUrl(metric, "TOTAL"), token, linkedInHeaders());
  return socialAnalyticsNumber(data.elements?.[0]?.count);
}

async function fetchProviderAnalytics(connection: any, token: string): Promise<ProviderAnalytics> {
  const provider = connection.provider as SocialProvider;
  const scopes = new Set<string>(connection.scopes || []);

  if (provider === "instagram") {
    const profileUrl = new URL(
      `https://graph.instagram.com/${process.env.META_GRAPH_API_VERSION?.trim() || "v25.0"}/${encodeURIComponent(connection.provider_user_id)}`,
    );
    profileUrl.searchParams.set("fields", "followers_count,media_count");
    const [profile, insightResult] = await Promise.all([
      providerJson(profileUrl, token),
      providerJson(
        buildInstagramInsightsUrl({
          accountId: connection.provider_user_id,
          apiVersion: process.env.META_GRAPH_API_VERSION?.trim() || "v25.0",
          rangeDays: 30,
        }),
        token,
      ).catch(optionalProviderAnalytics),
    ]);
    const parsedInsights = insightResult
      ? instagramInsightsResponseSchema.safeParse(insightResult)
      : null;
    const insights = parsedInsights?.success
      ? normalizeInstagramInsights(parsedInsights.data)
      : null;
    return {
      followers: socialAnalyticsNumber(profile.followers_count),
      following: null,
      posts: socialAnalyticsNumber(profile.media_count),
      views: socialAnalyticsNumber(insights?.views),
      reach: socialAnalyticsNumber(insights?.reach),
      engagements: socialAnalyticsNumber(insights?.total_interactions),
      status: insights ? "available" : "partial",
      note: insights
        ? "Instagram account metrics include the last 30 days."
        : "Audience totals are live; Meta Insights are not available for this connection.",
    };
  }

  if (provider === "facebook") {
    const apiVersion = process.env.META_GRAPH_API_VERSION?.trim() || "v25.0";
    const profilePromise = providerJson(
      `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(connection.provider_user_id)}?fields=followers_count,fan_count`,
      token,
    );
    if (!scopes.has("read_insights")) {
      const profile = await profilePromise;
      return {
        followers: socialAnalyticsNumber(profile.followers_count, profile.fan_count),
        following: null,
        posts: null,
        views: null,
        reach: null,
        engagements: null,
        status: "partial",
        note: "Facebook Page audience is live; reconnect after Page Insights approval.",
      };
    }
    const [profile, insightResult] = await Promise.all([
      profilePromise,
      fetchFacebookPageInsightMetrics(connection.provider_user_id, token, {
        period: "days_28",
      }),
    ]);
    const insights = insightResult ? normalizeFacebookPageInsights(insightResult) : null;
    const hasInsights =
      insights && Object.values(insights).some((value) => typeof value === "number");
    return {
      followers: socialAnalyticsNumber(profile.followers_count, profile.fan_count),
      following: null,
      posts: null,
      views: insights?.views ?? null,
      reach: insights?.reach ?? null,
      engagements: insights?.engagements ?? null,
      status: hasInsights ? "available" : "partial",
      note: hasInsights
        ? "Facebook Page views, reach, and engagements include the last 28 days."
        : "Facebook Page audience is live; Page Insights are temporarily unavailable.",
    };
  }

  if (provider === "threads") {
    if (!scopes.has("threads_manage_insights")) {
      return unavailable("Reconnect after Bento receives Threads Insights approval.");
    }
    const data = await providerJson(
      `https://graph.threads.net/v1.0/${encodeURIComponent(connection.provider_user_id)}/threads_insights?metric=views,likes,replies,reposts,quotes,followers_count`,
      token,
    );
    const metrics = new Map(
      (data.data || []).map((metric: any) => [
        metric.name,
        metric.total_value?.value ?? metric.values?.at(-1)?.value,
      ]),
    );
    return {
      followers: socialAnalyticsNumber(metrics.get("followers_count")),
      following: null,
      posts: null,
      views: socialAnalyticsNumber(metrics.get("views")),
      reach: null,
      engagements: ["likes", "replies", "reposts", "quotes"].reduce(
        (total, key) => total + (socialAnalyticsNumber(metrics.get(key)) || 0),
        0,
      ),
      status: "available",
      note: "Threads account insights from Meta.",
    };
  }

  if (provider === "tiktok") {
    if (!scopes.has("user.info.stats")) {
      return unavailable("Reconnect TikTok so Bento can read profile stats (user.info.stats).");
    }
    const data = await providerJson(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url,follower_count,following_count,likes_count,video_count",
      token,
    );
    const user = data.data?.user || {};
    return {
      followers: socialAnalyticsNumber(user.follower_count),
      following: socialAnalyticsNumber(user.following_count),
      posts: socialAnalyticsNumber(user.video_count),
      views: null,
      reach: null,
      engagements: socialAnalyticsNumber(user.likes_count),
      status: "available",
      note: "TikTok profile totals from Login Kit user.info.stats.",
    };
  }

  if (provider === "linkedin") {
    if (!scopes.has("r_member_profileAnalytics") || !scopes.has("r_member_postAnalytics")) {
      return unavailable(
        "Reconnect LinkedIn after Bento's Member Analytics and Member Post Analytics products are approved.",
      );
    }
    const [data, views, reach, reactions, comments, reshares] = await Promise.all([
      providerJson(
        "https://api.linkedin.com/rest/memberFollowersCount?q=me",
        token,
        linkedInHeaders(),
      ),
      linkedInTotalMetric("IMPRESSION", token),
      linkedInTotalMetric("MEMBERS_REACHED", token),
      linkedInTotalMetric("REACTION", token),
      linkedInTotalMetric("COMMENT", token),
      linkedInTotalMetric("RESHARE", token),
    ]);
    return {
      followers: socialAnalyticsNumber(data.elements?.[0]?.memberFollowersCount),
      following: null,
      posts: null,
      views,
      reach,
      engagements:
        reactions === null && comments === null && reshares === null
          ? null
          : (reactions || 0) + (comments || 0) + (reshares || 0),
      status: "available",
      note: "LinkedIn audience and lifetime member-post analytics from the official APIs.",
    };
  }

  if (provider === "twitter") {
    const data = await providerJson(
      "https://api.x.com/2/users/me?user.fields=public_metrics",
      token,
    );
    const metrics = data.data?.public_metrics || {};
    return {
      followers: socialAnalyticsNumber(metrics.followers_count),
      following: socialAnalyticsNumber(metrics.following_count),
      posts: socialAnalyticsNumber(metrics.tweet_count),
      views: null,
      reach: null,
      engagements: null,
      status: "partial",
      note: "X profile totals from the official API.",
    };
  }

  if (provider === "youtube") {
    const analyticsUrl = buildYouTubeAnalyticsUrl(
      new Date(Date.now() - 366 * 24 * 60 * 60_000),
      new Date(),
    );
    analyticsUrl.searchParams.delete("dimensions");
    analyticsUrl.searchParams.delete("sort");
    const [data, report] = await Promise.all([
      providerJson(
        "https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true",
        token,
      ),
      scopes.has("https://www.googleapis.com/auth/yt-analytics.readonly")
        ? providerJson(analyticsUrl, token)
        : Promise.resolve(null),
    ]);
    const statistics = data.items?.[0]?.statistics || {};
    const columns = new Map(
      (report?.columnHeaders || []).map((column: any, index: number) => [column.name, index]),
    );
    const totals = report?.rows?.[0] || [];
    const metric = (name: string) =>
      columns.has(name) ? socialAnalyticsNumber(totals[columns.get(name) as number]) : null;
    const likes = metric("likes");
    const comments = metric("comments");
    const shares = metric("shares");
    return {
      followers: statistics.hiddenSubscriberCount
        ? null
        : socialAnalyticsNumber(statistics.subscriberCount),
      following: null,
      posts: socialAnalyticsNumber(statistics.videoCount),
      views: socialAnalyticsNumber(statistics.viewCount),
      reach: null,
      engagements:
        likes === null && comments === null && shares === null
          ? null
          : (likes || 0) + (comments || 0) + (shares || 0),
      status: report ? "available" : "partial",
      note: statistics.hiddenSubscriberCount
        ? "This channel hides its subscriber count."
        : report
          ? "YouTube lifetime channel totals plus the last year of official Analytics data."
          : "Reconnect YouTube to add historical channel and per-video Analytics data.",
    };
  }

  if (provider === "reddit") {
    const data = await providerJson("https://oauth.reddit.com/api/v1/me", token, {
      "User-Agent": "web:bento.surf.social-analytics:v1.0 (by /u/bentosurf)",
    });
    return {
      followers: socialAnalyticsNumber(data.subreddit?.subscribers),
      following: null,
      posts: null,
      views: null,
      reach: null,
      engagements: socialAnalyticsNumber(data.total_karma),
      status: "partial",
      note: "Reddit profile followers and karma from the official API.",
    };
  }

  return unavailable("Analytics are not available for this platform.");
}

export function socialAnalyticsAvatarUrl(
  snapshotAvatarUrl: string | null | undefined,
  connectionAvatarUrl: string | null | undefined,
) {
  return connectionAvatarUrl || snapshotAvatarUrl || null;
}

function snapshotRow(row: any, connectionAvatarUrl?: string | null): SocialAnalyticsAccount {
  const refreshing = socialInsightsLeaseIsActive(row);
  return {
    connectionId: row.connection_id,
    provider: row.provider,
    handle: row.provider_handle,
    displayName: row.provider_display_name,
    avatarUrl: socialAnalyticsAvatarUrl(row.provider_avatar_url, connectionAvatarUrl),
    followers: socialAnalyticsNumber(row.followers),
    following: socialAnalyticsNumber(row.following),
    posts: socialAnalyticsNumber(row.posts),
    views: socialAnalyticsNumber(row.views),
    reach: socialAnalyticsNumber(row.reach),
    engagements: socialAnalyticsNumber(row.engagements),
    status: row.status,
    note: row.note || null,
    fetchedAt: row.fetched_at,
    refreshing,
    refreshStartedAt: refreshing ? row.refresh_started_at : null,
  };
}

function historyRow(row: any): SocialAnalyticsHistoryPoint {
  return {
    connectionId: row.connection_id,
    followers: socialAnalyticsNumber(row.followers),
    posts: socialAnalyticsNumber(row.posts),
    views: socialAnalyticsNumber(row.views),
    reach: socialAnalyticsNumber(row.reach),
    engagements: socialAnalyticsNumber(row.engagements),
    status: row.status,
    capturedAt: row.captured_at,
  };
}

function contentRow(row: any): SocialContentInsight {
  return {
    connectionId: row.connection_id,
    provider: row.provider,
    remotePostId: row.remote_post_id,
    remotePostUrl: row.remote_post_url || null,
    contentType: row.content_type,
    caption: row.caption || null,
    thumbnailUrl: row.thumbnail_url || null,
    publishedAt: row.published_at,
    views: socialAnalyticsNumber(row.views),
    impressions: socialAnalyticsNumber(row.impressions),
    reach: socialAnalyticsNumber(row.reach),
    engagements: socialAnalyticsNumber(row.engagements),
    likes: socialAnalyticsNumber(row.likes),
    comments: socialAnalyticsNumber(row.comments),
    shares: socialAnalyticsNumber(row.shares),
    saves: socialAnalyticsNumber(row.saves),
    fetchedAt: row.fetched_at,
  };
}

export function uniqueStorableSocialContent(content: SocialContentInsight[]) {
  const byPost = new Map<string, SocialContentInsight>();
  for (const item of content) {
    if (item.remotePostId && Number.isFinite(Date.parse(item.publishedAt)))
      byPost.set(item.remotePostId, item);
  }
  return [...byPost.values()];
}

async function fetchProviderDailyHistory(
  connection: any,
  token: string,
  currentFollowers: number | null,
): Promise<DailyPerformancePoint[]> {
  const scopes = new Set<string>(connection.scopes || []);
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(end);
  if (connection.provider === "linkedin" && scopes.has("r_member_postAnalytics")) {
    start.setUTCDate(start.getUTCDate() - 366);
    const payloads = await Promise.all(
      LINKEDIN_DAILY_METRICS.map((metric) =>
        providerJson(buildLinkedInDailyAnalyticsUrl(metric, start, end), token, linkedInHeaders()),
      ),
    );
    return normalizeLinkedInDailyAnalytics(
      payloads.flatMap((payload) => (Array.isArray(payload.elements) ? payload.elements : [])),
    ).map((point) => ({ ...point, reach: null }));
  }
  if (connection.provider === "facebook" && scopes.has("read_insights")) {
    const points: DailyPerformancePoint[] = [];
    let cursor = end;
    for (let chunk = 0; chunk < 5; chunk += 1) {
      const chunkStart = new Date(cursor);
      chunkStart.setUTCDate(chunkStart.getUTCDate() - (chunk === 4 ? 6 : 90));
      points.push(
        ...normalizeMetaDailyHistory(
          await fetchFacebookPageInsightMetrics(connection.provider_user_id, token, {
            period: "day",
            start: chunkStart,
            end: cursor,
          }),
        ),
      );
      cursor = chunkStart;
    }
    return points.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
  }
  if (connection.provider === "instagram" && scopes.has("instagram_business_manage_insights")) {
    const points: DailyPerformancePoint[] = [];
    let cursor = end;
    for (let chunk = 0; chunk < 3; chunk += 1) {
      const chunkStart = new Date(cursor);
      chunkStart.setUTCDate(chunkStart.getUTCDate() - 30);
      const payloads = await Promise.all(
        INSTAGRAM_DAILY_INSIGHT_METRICS.map(async (metric) => {
          const url = new URL(
            `https://graph.instagram.com/${process.env.META_GRAPH_API_VERSION?.trim() || "v25.0"}/${encodeURIComponent(connection.provider_user_id)}/insights`,
          );
          url.searchParams.set("metric", metric);
          url.searchParams.set("period", "day");
          url.searchParams.set("metric_type", "time_series");
          url.searchParams.set("since", String(Math.floor(chunkStart.getTime() / 1_000)));
          url.searchParams.set("until", String(Math.floor(cursor.getTime() / 1_000)));
          return providerJson(url, token);
        }),
      );
      points.push(
        ...normalizeMetaDailyHistory({
          data: payloads.flatMap((payload) => (Array.isArray(payload.data) ? payload.data : [])),
        }),
      );
      cursor = chunkStart;
    }
    return points.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
  }
  if (connection.provider === "threads" && scopes.has("threads_manage_insights")) {
    start.setUTCDate(start.getUTCDate() - 366);
    const url = new URL(
      `https://graph.threads.net/v1.0/${encodeURIComponent(connection.provider_user_id)}/threads_insights`,
    );
    url.searchParams.set("metric", "views");
    url.searchParams.set("since", String(Math.floor(start.getTime() / 1_000)));
    url.searchParams.set("until", String(Math.floor(end.getTime() / 1_000)));
    return normalizeMetaDailyHistory(await providerJson(url, token));
  }
  if (
    connection.provider === "youtube" &&
    scopes.has("https://www.googleapis.com/auth/yt-analytics.readonly")
  ) {
    start.setUTCDate(start.getUTCDate() - 366);
    return normalizeYouTubeAnalyticsHistory(
      await providerJson(buildYouTubeAnalyticsUrl(start, end), token),
      currentFollowers,
    );
  }
  return [];
}

type SocialInsightsQueue = Queue<SocialInsightsBackfillMessage>;

function snapshotSeed(connection: any) {
  return {
    connection_id: connection.id,
    user_id: connection.user_id,
    provider: connection.provider,
    provider_handle: connection.provider_handle,
    provider_display_name: connection.provider_display_name || connection.provider_handle,
    provider_avatar_url: connection.provider_avatar_url || null,
  };
}

async function claimSocialInsightsJobs(
  connections: any[],
  snapshots: SocialInsightsSnapshotLease[],
  now = new Date(),
) {
  const db = supabaseAdmin as any;
  const byConnection = new Map(snapshots.map((snapshot) => [snapshot.connection_id, snapshot]));
  const claimed: NormalizedSocialInsightsBackfillMessage[] = [];
  for (const connection of connections) {
    const existing = byConnection.get(connection.id);
    if (existing?.refresh_job_id) {
      const message = normalizeSocialInsightsBackfillMessage(
        {
          kind: "social_insights_backfill",
          userId: connection.user_id,
          connectionId: connection.id,
          jobId: existing.refresh_job_id,
          stage: existing.refresh_stage === "content" ? "content" : "account",
          cursor: existing.refresh_cursor || null,
          startedAt: now.toISOString(),
        },
        now,
      );
      let recovery = db
        .from("social_analytics_snapshots")
        .update({
          refresh_stage: message.stage,
          refresh_cursor: message.cursor,
          refresh_processing_at: null,
          refresh_started_at: now.toISOString(),
        })
        .eq("connection_id", connection.id)
        .eq("refresh_job_id", message.jobId)
        .or(
          `refresh_started_at.is.null,refresh_started_at.lte.${new Date(
            now.getTime() - SOCIAL_INSIGHTS_LEASE_MS,
          ).toISOString()}`,
        );
      recovery = existing.refresh_stage
        ? recovery.eq("refresh_stage", existing.refresh_stage)
        : recovery.is("refresh_stage", null);
      recovery = existing.refresh_cursor
        ? recovery.eq("refresh_cursor", existing.refresh_cursor)
        : recovery.is("refresh_cursor", null);
      const result = await recovery.select("connection_id").maybeSingle();
      if (result.error) throw new Error("Social analytics recovery could not be prepared.");
      if (result.data) claimed.push(message);
      continue;
    }

    const message = socialInsightsBackfillMessages(connection.user_id, [connection], now)[0];
    const values = {
      ...snapshotSeed(connection),
      refresh_job_id: message.jobId,
      refresh_stage: message.stage,
      refresh_cursor: message.cursor,
      refresh_processing_at: null,
      refresh_started_at: now.toISOString(),
      note: "Bento is importing historical posts and insights. This can take 10–15 minutes.",
    };
    let result: any;
    if (!existing) {
      result = await db
        .from("social_analytics_snapshots")
        .insert(values)
        .select("connection_id")
        .maybeSingle();
      if (result.error?.code === "23505") continue;
    } else {
      let query = db
        .from("social_analytics_snapshots")
        .update(values)
        .eq("connection_id", connection.id);
      query = query.is("refresh_job_id", null);
      if (existing.refresh_started_at) {
        query = query.lte(
          "refresh_started_at",
          new Date(now.getTime() - SOCIAL_INSIGHTS_LEASE_MS).toISOString(),
        );
      }
      result = await query.select("connection_id").maybeSingle();
    }
    if (result.error) throw new Error("Social analytics import could not be prepared.");
    if (result.data) claimed.push(message);
  }
  return claimed;
}

async function releaseUnqueuedSocialInsightsJob(message: NormalizedSocialInsightsBackfillMessage) {
  const staleAt = new Date(Date.now() - SOCIAL_INSIGHTS_LEASE_MS - 1).toISOString();
  let query = (supabaseAdmin as any)
    .from("social_analytics_snapshots")
    .update({
      refresh_processing_at: null,
      refresh_started_at: staleAt,
      note: "Bento is retrying the historical insights import.",
    })
    .eq("connection_id", message.connectionId)
    .eq("user_id", message.userId)
    .eq("refresh_job_id", message.jobId)
    .eq("refresh_stage", message.stage);
  query = message.cursor
    ? query.eq("refresh_cursor", message.cursor)
    : query.is("refresh_cursor", null);
  const { error } = await query;
  if (error) throw new Error("Social analytics import claim could not be released.");
}

async function dispatchSocialInsightsMessage(
  message: NormalizedSocialInsightsBackfillMessage,
  queue?: SocialInsightsQueue,
) {
  if (queue) await queue.send(message, { contentType: "json" });
  else await processSocialInsightsBackfillMessage(message);
}

function withSocialInsightsCursor(query: any, cursor: string | null) {
  return cursor ? query.eq("refresh_cursor", cursor) : query.is("refresh_cursor", null);
}

async function claimSocialInsightsCheckpoint(message: NormalizedSocialInsightsBackfillMessage) {
  const db = supabaseAdmin as any;
  const claimedAt = new Date().toISOString();
  const staleAt = new Date(Date.now() - SOCIAL_INSIGHTS_LEASE_MS).toISOString();
  let query = db
    .from("social_analytics_snapshots")
    .update({ refresh_processing_at: claimedAt, refresh_started_at: claimedAt })
    .eq("connection_id", message.connectionId)
    .eq("user_id", message.userId)
    .eq("refresh_job_id", message.jobId)
    .eq("refresh_stage", message.stage)
    .or(`refresh_processing_at.is.null,refresh_processing_at.lte.${staleAt}`);
  query = withSocialInsightsCursor(query, message.cursor);
  const result = await query.select("connection_id").maybeSingle();
  if (result.error) throw new Error("Social analytics checkpoint could not be claimed.");
  return result.data ? claimedAt : null;
}

async function advanceSocialInsightsCheckpoint(
  message: NormalizedSocialInsightsBackfillMessage,
  processingAt: string,
  next: Pick<NormalizedSocialInsightsBackfillMessage, "stage" | "cursor">,
) {
  const db = supabaseAdmin as any;
  let query = db
    .from("social_analytics_snapshots")
    .update({
      refresh_stage: next.stage,
      refresh_cursor: next.cursor,
      refresh_processing_at: null,
      refresh_started_at: new Date().toISOString(),
    })
    .eq("connection_id", message.connectionId)
    .eq("user_id", message.userId)
    .eq("refresh_job_id", message.jobId)
    .eq("refresh_stage", message.stage)
    .eq("refresh_processing_at", processingAt);
  query = withSocialInsightsCursor(query, message.cursor);
  const result = await query.select("connection_id").maybeSingle();
  if (result.error) throw new Error("Social analytics checkpoint could not advance.");
  return Boolean(result.data);
}

async function makeSocialInsightsCheckpointStale(message: NormalizedSocialInsightsBackfillMessage) {
  const staleAt = new Date(Date.now() - SOCIAL_INSIGHTS_LEASE_MS - 1).toISOString();
  let query = (supabaseAdmin as any)
    .from("social_analytics_snapshots")
    .update({ refresh_started_at: staleAt, refresh_processing_at: null })
    .eq("connection_id", message.connectionId)
    .eq("user_id", message.userId)
    .eq("refresh_job_id", message.jobId)
    .eq("refresh_stage", message.stage);
  query = withSocialInsightsCursor(query, message.cursor);
  const result = await query.select("connection_id").maybeSingle();
  if (result.error) throw new Error("Social analytics checkpoint could not be recovered.");
}

async function dispatchSocialInsightsSuccessor(
  message: NormalizedSocialInsightsBackfillMessage,
  queue?: SocialInsightsQueue,
) {
  try {
    await dispatchSocialInsightsMessage(message, queue);
  } catch (error) {
    await makeSocialInsightsCheckpointStale(message);
    throw error;
  }
}

async function persistSocialInsightsContentPage(connection: any, content: SocialContentInsight[]) {
  const storable = uniqueStorableSocialContent(content);
  if (!storable.length) return;
  const { error } = await (supabaseAdmin as any).from("social_content_insights").upsert(
    storable.map((item) => ({
      connection_id: connection.id,
      user_id: connection.user_id,
      provider: connection.provider,
      remote_post_id: item.remotePostId,
      remote_post_url: item.remotePostUrl,
      content_type: item.contentType,
      caption: item.caption,
      thumbnail_url: item.thumbnailUrl,
      published_at: item.publishedAt,
      views: item.views,
      impressions: item.impressions,
      reach: item.reach,
      engagements: item.engagements,
      likes: item.likes,
      comments: item.comments,
      shares: item.shares,
      saves: item.saves,
      fetched_at: item.fetchedAt,
    })),
    { onConflict: "connection_id,remote_post_id" },
  );
  if (error) throw new Error("Historical social content could not be stored.");
}

async function processSocialInsightsAccountStage(
  connection: any,
  message: NormalizedSocialInsightsBackfillMessage,
  processingAt: string,
  queue?: SocialInsightsQueue,
) {
  const db = supabaseAdmin as any;
  const token = await accessTokenForConnection(connection);
  const analytics = await fetchProviderAnalytics(connection, token);
  const warnings: string[] = [];
  let dailyHistory: DailyPerformancePoint[] = [];
  try {
    dailyHistory = await fetchProviderDailyHistory(connection, token, analytics.followers);
  } catch (error) {
    warnings.push(
      error instanceof Error ? error.message : "Historical account analytics could not import.",
    );
  }
  let snapshotQuery = db
    .from("social_analytics_snapshots")
    .update({
      ...analytics,
      ...(warnings.length
        ? {
            status: analytics.status === "available" ? "partial" : analytics.status,
            note: [analytics.note, ...warnings].filter(Boolean).join(" "),
          }
        : {}),
      fetched_at: new Date().toISOString(),
      refresh_started_at: new Date().toISOString(),
    })
    .eq("connection_id", connection.id)
    .eq("user_id", message.userId)
    .eq("refresh_job_id", message.jobId)
    .eq("refresh_stage", message.stage)
    .eq("refresh_processing_at", processingAt);
  snapshotQuery = withSocialInsightsCursor(snapshotQuery, message.cursor);
  const snapshot = await snapshotQuery.select("connection_id").maybeSingle();
  if (snapshot.error) throw new Error("Social analytics snapshot could not be stored.");
  if (!snapshot.data) return;
  const currentHistory = await db.from("social_analytics_history").upsert(
    {
      connection_id: connection.id,
      user_id: connection.user_id,
      provider: connection.provider,
      followers: analytics.followers,
      following: analytics.following,
      posts: analytics.posts,
      views: dailyHistory.length ? null : analytics.views,
      reach: dailyHistory.length ? null : analytics.reach,
      engagements: dailyHistory.length ? null : analytics.engagements,
      status: analytics.status,
      captured_at: message.startedAt,
    },
    { onConflict: "connection_id,captured_at" },
  );
  if (currentHistory.error) throw new Error("Social analytics history could not be stored.");
  if (dailyHistory.length) {
    const history = await db.from("social_analytics_history").upsert(
      dailyHistory.map((point) => ({
        connection_id: connection.id,
        user_id: connection.user_id,
        provider: connection.provider,
        followers: point.followers ?? null,
        following: null,
        posts: null,
        views: point.views,
        reach: point.reach,
        engagements: point.engagements,
        status: "available",
        captured_at: point.capturedAt,
      })),
      { onConflict: "connection_id,captured_at" },
    );
    if (history.error) throw new Error("Daily social analytics history could not be stored.");
  }
  const successor = { ...message, stage: "content" as const, cursor: null };
  if (!(await advanceSocialInsightsCheckpoint(message, processingAt, successor))) return;
  await dispatchSocialInsightsSuccessor(successor, queue);
}

async function processSocialInsightsContentStage(
  connection: any,
  message: NormalizedSocialInsightsBackfillMessage,
  processingAt: string,
  queue?: SocialInsightsQueue,
) {
  const db = supabaseAdmin as any;
  const page = await fetchSocialContentInsightsPage(
    connection,
    await accessTokenForConnection(connection),
    message.cursor,
  );
  await persistSocialInsightsContentPage(connection, page.content);
  if (page.nextCursor) {
    const successor = { ...message, cursor: page.nextCursor };
    if (!(await advanceSocialInsightsCheckpoint(message, processingAt, successor))) return;
    await dispatchSocialInsightsSuccessor(successor, queue);
    return;
  }
  let completionQuery = db
    .from("social_analytics_snapshots")
    .update({
      refresh_job_id: null,
      refresh_stage: null,
      refresh_cursor: null,
      refresh_processing_at: null,
      refresh_started_at: null,
      history_imported_at: new Date().toISOString(),
    })
    .eq("connection_id", connection.id)
    .eq("user_id", message.userId)
    .eq("refresh_job_id", message.jobId)
    .eq("refresh_stage", message.stage)
    .eq("refresh_processing_at", processingAt);
  completionQuery = withSocialInsightsCursor(completionQuery, message.cursor);
  const completed = await completionQuery.select("connection_id").maybeSingle();
  if (completed.error) throw new Error("Social analytics completion could not be stored.");
}

async function queueSocialInsightsBackfill(userId: string, force: boolean) {
  const db = supabaseAdmin as any;
  const now = new Date();
  const [{ data: connections, error: connectionError }, { data: snapshots, error: snapshotError }] =
    await Promise.all([
      db
        .from("social_connections")
        .select("*")
        .eq("user_id", userId)
        .eq("status", "active")
        .order("created_at", { ascending: true }),
      db
        .from("social_analytics_snapshots")
        .select(
          "connection_id,refresh_job_id,refresh_stage,refresh_cursor,refresh_processing_at,refresh_started_at,history_imported_at",
        )
        .eq("user_id", userId),
    ]);
  if (connectionError || snapshotError) throw new Error("Social analytics import could not start.");
  const targets = socialInsightsBackfillTargets(connections || [], snapshots || [], { force, now });
  if (!targets.length) return false;
  const messages = await claimSocialInsightsJobs(targets, snapshots || [], now);
  if (!messages.length) return false;
  const queue = (
    globalThis.__env__ as
      (Env & { SOCIAL_INSIGHTS_QUEUE?: Queue<SocialInsightsBackfillMessage> }) | undefined
  )?.SOCIAL_INSIGHTS_QUEUE;
  for (const message of messages) {
    try {
      await dispatchSocialInsightsMessage(message, queue);
    } catch (error) {
      await releaseUnqueuedSocialInsightsJob(message);
      throw error;
    }
  }
  return true;
}

export async function processSocialInsightsBackfillMessage(
  input: SocialInsightsBackfillMessage,
  queue?: SocialInsightsQueue,
) {
  const message = normalizeSocialInsightsBackfillMessage(input);
  const db = supabaseAdmin as any;
  const [{ data: connection, error }, { data: initialSnapshot, error: snapshotError }] =
    await Promise.all([
      db
        .from("social_connections")
        .select("*")
        .eq("id", message.connectionId)
        .eq("user_id", message.userId)
        .eq("status", "active")
        .maybeSingle(),
      db
        .from("social_analytics_snapshots")
        .select("refresh_job_id,refresh_stage,refresh_cursor,refresh_processing_at")
        .eq("connection_id", message.connectionId)
        .eq("user_id", message.userId)
        .maybeSingle(),
    ]);
  if (error || !connection)
    throw new ProviderError(
      "This social connection is no longer available.",
      "connection_unavailable",
      false,
      404,
    );
  if (snapshotError || !initialSnapshot)
    throw new Error("Social analytics import state could not be loaded.");
  let checkpoint: SocialInsightsCheckpoint = initialSnapshot;
  if (!checkpoint.refresh_job_id) {
    const claimed = await db
      .from("social_analytics_snapshots")
      .update({
        refresh_job_id: message.jobId,
        refresh_stage: message.stage,
        refresh_cursor: message.cursor,
        refresh_processing_at: null,
        refresh_started_at: message.startedAt,
      })
      .eq("connection_id", message.connectionId)
      .eq("user_id", message.userId)
      .is("refresh_job_id", null)
      .select("refresh_job_id,refresh_stage,refresh_cursor")
      .maybeSingle();
    if (claimed.error) throw new Error("Legacy social analytics import could not be claimed.");
    if (!claimed.data) return;
    checkpoint = claimed.data;
  } else if (checkpoint.refresh_job_id === message.jobId && !checkpoint.refresh_stage) {
    const upgraded = await db
      .from("social_analytics_snapshots")
      .update({
        refresh_stage: message.stage,
        refresh_cursor: message.cursor,
        refresh_processing_at: null,
      })
      .eq("connection_id", message.connectionId)
      .eq("user_id", message.userId)
      .eq("refresh_job_id", message.jobId)
      .is("refresh_stage", null)
      .select("refresh_job_id,refresh_stage,refresh_cursor")
      .maybeSingle();
    if (upgraded.error)
      throw new Error("Legacy social analytics checkpoint could not be upgraded.");
    if (!upgraded.data) return;
    checkpoint = upgraded.data;
  }
  if (!socialInsightsCheckpointMatches(checkpoint, message)) return;
  const processingAt = await claimSocialInsightsCheckpoint(message);
  if (!processingAt) return;
  if (message.stage === "account")
    await processSocialInsightsAccountStage(connection, message, processingAt, queue);
  else await processSocialInsightsContentStage(connection, message, processingAt, queue);
}

export async function failSocialInsightsBackfillMessage(
  input: SocialInsightsBackfillMessage,
  error: unknown,
) {
  const message = normalizeSocialInsightsBackfillMessage(input);
  const capabilityLimited = message.stage === "content" && isSocialInsightsCapabilityError(error);
  const terminalProviderError = error instanceof ProviderError && !error.retryable;
  if (error instanceof ProviderError && error.status === 401) {
    const connection = await (supabaseAdmin as any)
      .from("social_connections")
      .update({ status: "expired", last_error: "Reconnect to refresh social analytics." })
      .eq("id", message.connectionId)
      .eq("user_id", message.userId);
    if (connection.error) throw new Error("Expired social connection could not be stored.");
  }
  let query = (supabaseAdmin as any)
    .from("social_analytics_snapshots")
    .update({
      status: capabilityLimited ? "partial" : "error",
      note: capabilityLimited
        ? "Account insights are ready. This platform did not provide access to older post insights."
        : "Historical insights could not import. Reconnect the account or try refreshing again.",
      refresh_job_id: null,
      refresh_stage: null,
      refresh_cursor: null,
      refresh_processing_at: null,
      refresh_started_at: null,
      ...(capabilityLimited || terminalProviderError
        ? { history_imported_at: new Date().toISOString() }
        : {}),
      fetched_at: new Date().toISOString(),
    })
    .eq("connection_id", message.connectionId)
    .eq("user_id", message.userId)
    .eq("refresh_job_id", message.jobId)
    .eq("refresh_stage", message.stage);
  query = withSocialInsightsCursor(query, message.cursor);
  const result = await query;
  if (result.error) throw new Error("Social analytics failure state could not be stored.");
}

export async function releaseSocialInsightsBackfillMessage(input: SocialInsightsBackfillMessage) {
  const message = normalizeSocialInsightsBackfillMessage(input);
  let query = (supabaseAdmin as any)
    .from("social_analytics_snapshots")
    .update({ refresh_processing_at: null })
    .eq("connection_id", message.connectionId)
    .eq("user_id", message.userId)
    .eq("refresh_job_id", message.jobId)
    .eq("refresh_stage", message.stage);
  query = withSocialInsightsCursor(query, message.cursor);
  const result = await query;
  if (result.error) throw new Error("Social analytics delivery lease could not be released.");
}

export async function requeueStaleSocialInsightsBackfills(queue?: SocialInsightsQueue) {
  if (!queue) return { queued: 0 };
  const db = supabaseAdmin as any;
  const now = new Date();
  const { data: snapshots, error } = await db
    .from("social_analytics_snapshots")
    .select(
      "connection_id,refresh_job_id,refresh_stage,refresh_cursor,refresh_processing_at,refresh_started_at,history_imported_at",
    )
    .not("refresh_started_at", "is", null)
    .lte("refresh_started_at", new Date(now.getTime() - SOCIAL_INSIGHTS_LEASE_MS).toISOString())
    .limit(25);
  if (error) throw new Error("Stale social analytics imports could not be loaded.");
  if (!snapshots?.length) return { queued: 0 };
  const { data: connections, error: connectionError } = await db
    .from("social_connections")
    .select("*")
    .in(
      "id",
      snapshots.map((snapshot: SocialInsightsSnapshotLease) => snapshot.connection_id),
    )
    .eq("status", "active");
  if (connectionError) throw new Error("Stale social analytics connections could not be loaded.");
  const messages = await claimSocialInsightsJobs(connections || [], snapshots, now);
  for (const message of messages) {
    try {
      await dispatchSocialInsightsMessage(message, queue);
    } catch (sendError) {
      const staleAt = new Date(now.getTime() - SOCIAL_INSIGHTS_LEASE_MS - 1).toISOString();
      const { error: heartbeatError } = await db
        .from("social_analytics_snapshots")
        .update({ refresh_started_at: staleAt })
        .eq("connection_id", message.connectionId)
        .eq("refresh_job_id", message.jobId);
      if (heartbeatError) throw new Error("Stale social analytics import could not be released.");
      throw sendError;
    }
  }
  return { queued: messages.length };
}

async function loadSocialAnalytics(userId: string) {
  const db = supabaseAdmin as any;
  let profileResult = await db
    .from("profiles")
    .select("username,social_insights_enabled,social_insights_period_days")
    .eq("id", userId)
    .maybeSingle();
  if (profileResult.error?.code === "42703") {
    profileResult = await db
      .from("profiles")
      .select("username,social_insights_enabled")
      .eq("id", userId)
      .maybeSingle();
  }
  const { data: profile, error: profileError } = profileResult;
  if (profileError) throw new Error("Social analytics could not be loaded.");

  const { data: rows, error } = await db
    .from("social_analytics_snapshots")
    .select("*")
    .eq("user_id", userId)
    .order("provider", { ascending: true });
  if (error) throw new Error("Social analytics could not be loaded.");
  const connectionResult = await db
    .from("social_connections")
    .select("id,provider_avatar_url")
    .eq("user_id", userId)
    .eq("status", "active");
  if (connectionResult.error) throw new Error("Social analytics could not be loaded.");
  const connectionAvatars = new Map<string, string | null>(
    (connectionResult.data || []).map(
      (connection: any) =>
        [connection.id, connection.provider_avatar_url] as [string, string | null],
    ),
  );
  const accounts = (rows || []).map((row: any) =>
    snapshotRow(row, connectionAvatars.get(row.connection_id)),
  );
  const historyResult = await db
    .from("social_analytics_history")
    .select("connection_id,followers,posts,views,reach,engagements,status,captured_at")
    .eq("user_id", userId)
    .gte("captured_at", new Date(Date.now() - 366 * 24 * 60 * 60_000).toISOString())
    .order("captured_at", { ascending: true })
    .limit(2_000);
  const contentResult = await db
    .from("social_content_insights")
    .select("*")
    .eq("user_id", userId)
    .gte("published_at", new Date(Date.now() - 366 * 24 * 60 * 60_000).toISOString())
    .order("published_at", { ascending: false })
    .limit(2_000);
  if (historyResult.error || contentResult.error)
    throw new Error("Historical social analytics could not be loaded.");
  const content = (contentResult.data || []).map(contentRow);
  return {
    accounts,
    history: (historyResult.data || []).map(historyRow),
    content,
    summary: summarizeSocialAnalytics(accounts),
    shareEnabled: Boolean(profile?.social_insights_enabled),
    displayPeriodDays: normalizeSocialInsightsDisplayPeriod(profile?.social_insights_period_days),
    username: profile?.username || null,
    publicUrl: profile?.username ? publicProfileUrl(profile.username, "insights") : null,
    generatedAt: new Date().toISOString(),
  };
}

export async function loadPublicSocialAnalytics(userId: string) {
  const analytics = await loadSocialAnalytics(userId);
  const accounts = socialAnalyticsAccountsForPeriod(
    analytics.accounts,
    analytics.content,
    analytics.displayPeriodDays,
  );
  return { ...analytics, accounts, summary: summarizeSocialAnalytics(accounts) };
}

export const getSocialAnalytics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const plan = await getPlan(context.userId);
    if (!planHasEntitlement(plan, "socialAnalytics")) {
      return { locked: true as const, ...(await loadSocialAnalytics(context.userId)) };
    }
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "social-analytics", context.userId);
    await queueSocialInsightsBackfill(context.userId, false);
    return { locked: false as const, ...(await loadSocialAnalytics(context.userId)) };
  });

export const refreshSocialAnalytics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const plan = await getPlan(context.userId);
    if (!planHasEntitlement(plan, "socialAnalytics"))
      throw new Error("Upgrade for social analytics.");
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "social-analytics-refresh",
      context.userId,
    );
    await queueSocialInsightsBackfill(context.userId, true);
    return loadSocialAnalytics(context.userId);
  });

export const setPublicSocialInsights = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ enabled: z.boolean() }).parse(input))
  .handler(async ({ context, data }) => {
    const plan = await getPlan(context.userId);
    if (!planHasEntitlement(plan, "socialAnalytics"))
      throw new Error("Upgrade to share social insights.");
    if (data.enabled) {
      const { data: conflict } = await supabaseAdmin
        .from("pages")
        .select("id")
        .eq("user_id", context.userId)
        .eq("slug", "insights")
        .maybeSingle();
      if (conflict)
        throw new Error('Rename your existing "insights" page before enabling live stats.');
    }
    const { data: profile, error } = await (supabaseAdmin as any)
      .from("profiles")
      .update({ social_insights_enabled: data.enabled })
      .eq("id", context.userId)
      .select("username,social_insights_enabled")
      .single();
    if (error) throw new Error("The public Insights page could not be updated.");
    return {
      enabled: Boolean(profile.social_insights_enabled),
      publicUrl: profile.username ? publicProfileUrl(profile.username, "insights") : null,
    };
  });

export const setPublicSocialInsightsPeriod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ days: z.union([z.literal(30), z.literal(90), z.literal(365)]) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const plan = await getPlan(context.userId);
    if (!planHasEntitlement(plan, "socialAnalytics"))
      throw new Error("Upgrade to customize public social insights.");
    const { error } = await (supabaseAdmin as any)
      .from("profiles")
      .update({ social_insights_period_days: data.days })
      .eq("id", context.userId);
    if (error) throw new Error("The public Insights period could not be updated.");
    return { displayPeriodDays: data.days };
  });
