import type {
  SocialAnalyticsAccount,
  SocialAnalyticsHistoryPoint,
} from "./social-analytics.functions";
import type { SocialContentInsight } from "./social-content-insights.server";
import {
  socialInsightsCutoff,
  type SocialDetailMetric,
  type SocialDetailMetrics,
  type SocialInsightsRange,
} from "./social-insights-metrics";
import type { SocialProvider } from "./social-scheduler";

export type SocialGrowthMetric = "views" | "impressions" | "reach" | "engagements" | "followers";

export function socialGrowthMetricsFor(provider: SocialProvider): SocialGrowthMetric[] {
  if (provider === "instagram") return ["views", "reach", "engagements", "followers"];
  if (["threads", "youtube", "tiktok"].includes(provider))
    return ["views", "engagements", "followers"];
  if (provider === "reddit") return ["engagements", "followers"];
  if (provider === "facebook") return ["views", "reach", "engagements", "followers"];
  return ["impressions", "engagements", "followers"];
}

export function selectedSocialAnalyticsAccount(
  accounts: SocialAnalyticsAccount[],
  selectedId: string | null,
  content: SocialContentInsight[],
) {
  return (
    accounts.find((account) => account.connectionId === selectedId) ||
    accounts.find((account) =>
      content.some((item) => item.connectionId === account.connectionId),
    ) ||
    accounts[0]
  );
}

export type DailySocialPerformance = {
  date: string;
  views: number;
  impressions: number;
  reach: number;
  engagements: number;
  posts: number;
};

export type DailySocialActivity = DailySocialPerformance & {
  items: SocialContentInsight[];
};

export function dailySocialPerformance(
  content: SocialContentInsight[],
  days = 366,
  now = new Date(),
) {
  const firstDay = new Date(now);
  firstDay.setHours(0, 0, 0, 0);
  firstDay.setDate(firstDay.getDate() - days + 1);
  const byDate = new Map<string, DailySocialActivity>();
  for (let index = 0; index < days; index += 1) {
    const date = new Date(firstDay);
    date.setDate(firstDay.getDate() + index);
    const key = localDateKey(date);
    byDate.set(key, {
      date: key,
      views: 0,
      impressions: 0,
      reach: 0,
      engagements: 0,
      posts: 0,
      items: [],
    });
  }
  for (const item of content) {
    const key = localDateKey(new Date(item.publishedAt));
    const day = byDate.get(key);
    if (!day) continue;
    day.views += item.views || 0;
    day.impressions += item.impressions || 0;
    day.reach += item.reach || 0;
    day.engagements += item.engagements || 0;
    day.posts += 1;
    day.items.push(item);
  }
  return [...byDate.values()];
}

export function dailyAnalyticsHistory(
  history: SocialAnalyticsHistoryPoint[],
  connectionId: string,
  days = 366,
  now = new Date(),
) {
  const firstDay = new Date(now);
  firstDay.setHours(0, 0, 0, 0);
  firstDay.setDate(firstDay.getDate() - days + 1);
  const byDate = new Map<string, DailySocialPerformance>();
  for (let index = 0; index < days; index += 1) {
    const date = new Date(firstDay);
    date.setDate(firstDay.getDate() + index);
    const key = localDateKey(date);
    byDate.set(key, {
      date: key,
      views: 0,
      impressions: 0,
      reach: 0,
      engagements: 0,
      posts: 0,
    });
  }
  for (const point of history) {
    if (point.connectionId !== connectionId) continue;
    const day = byDate.get(localDateKey(new Date(point.capturedAt)));
    if (!day) continue;
    if (point.views !== null) day.views = point.views;
    if (point.reach !== null) day.reach = point.reach;
    if (point.engagements !== null) day.engagements = point.engagements;
  }
  return [...byDate.values()];
}

export function socialImpressionSeries(
  history: SocialAnalyticsHistoryPoint[],
  connectionId: string,
  content: SocialContentInsight[],
  days = 366,
  now = new Date(),
) {
  return socialMetricSeries("impressions", history, connectionId, content, days, now);
}

export function socialViewSeries(
  history: SocialAnalyticsHistoryPoint[],
  connectionId: string,
  content: SocialContentInsight[],
  days = 366,
  now = new Date(),
) {
  return socialMetricSeries("views", history, connectionId, content, days, now);
}

export function socialReachSeries(
  history: SocialAnalyticsHistoryPoint[],
  connectionId: string,
  content: SocialContentInsight[],
  days = 366,
  now = new Date(),
) {
  return socialMetricSeries("reach", history, connectionId, content, days, now);
}

export function socialEngagementSeries(
  history: SocialAnalyticsHistoryPoint[],
  connectionId: string,
  content: SocialContentInsight[],
  days = 366,
  now = new Date(),
) {
  return socialMetricSeries("engagements", history, connectionId, content, days, now);
}

function socialMetricSeries(
  metric: "views" | "impressions" | "reach" | "engagements",
  history: SocialAnalyticsHistoryPoint[],
  connectionId: string,
  content: SocialContentInsight[],
  days: number,
  now: Date,
) {
  const historyMetric =
    metric === "reach" ? "reach" : metric === "engagements" ? "engagements" : "views";
  const imported = history
    .filter((point) => point.connectionId === connectionId && point[historyMetric] !== null)
    .map((point) => ({ date: point.capturedAt, value: point[historyMetric] as number }));
  const fromContent = dailySocialPerformance(content, days, now).map(
    ({ date, views, impressions, reach, engagements, posts }) => ({
      date,
      views,
      impressions,
      reach,
      engagements,
      posts,
    }),
  );
  if (imported.some((point) => point.value > 0)) {
    const importedByDate = new Map(
      imported.map((point) => [localDateKey(new Date(point.date)), point.value]),
    );
    return fromContent.map((day) => {
      const value = importedByDate.get(day.date);
      return value === undefined ? day : { ...day, [metric]: value };
    });
  }

  if (content.some((item) => (item[metric] || 0) > 0)) return fromContent;

  return fromContent;
}

export function socialContentTypePerformance(content: SocialContentInsight[]) {
  const groups = new Map<
    SocialContentInsight["contentType"],
    {
      type: SocialContentInsight["contentType"];
      posts: number;
      views: number;
      impressions: number;
      engagements: number;
    }
  >();
  for (const item of content) {
    const group = groups.get(item.contentType) || {
      type: item.contentType,
      posts: 0,
      views: 0,
      impressions: 0,
      engagements: 0,
    };
    group.posts += 1;
    group.views += item.views || 0;
    group.impressions += item.impressions || 0;
    group.engagements += item.engagements || 0;
    groups.set(item.contentType, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      averageViews: group.posts ? Math.round(group.views / group.posts) : 0,
      averageImpressions: group.posts ? Math.round(group.impressions / group.posts) : 0,
      averageEngagements: group.posts ? Math.round(group.engagements / group.posts) : 0,
      engagementRate:
        group.views || group.impressions
          ? (group.engagements / (group.views || group.impressions)) * 100
          : null,
    }))
    .sort(
      (left, right) =>
        Math.max(right.averageViews, right.averageImpressions, right.averageEngagements) -
        Math.max(left.averageViews, left.averageImpressions, left.averageEngagements),
    );
}

export type BestContentMetric =
  | "views"
  | "impressions"
  | "reach"
  | "engagements"
  | "likes"
  | "comments"
  | "shares"
  | "saves"
  | "reposts"
  | "quotes"
  | "follows"
  | "watchSeconds";

export function socialContentExposureMetric(
  content: SocialContentInsight[],
): Extract<BestContentMetric, "views" | "impressions" | "engagements"> {
  const metrics = ["views", "impressions", "engagements"] as const;
  return (
    metrics.find((metric) => content.some((item) => (item[metric] || 0) > 0)) ||
    metrics.find((metric) => content.some((item) => item[metric] !== null)) ||
    "engagements"
  );
}

export function bestSocialContent(
  content: SocialContentInsight[],
  limit = Infinity,
  metric: BestContentMetric = "engagements",
) {
  return [...content]
    .sort(
      (left, right) =>
        (socialPostMetric(right, metric) ?? -1) - (socialPostMetric(left, metric) ?? -1) ||
        right.publishedAt.localeCompare(left.publishedAt),
    )
    .slice(0, limit);
}

export const SOCIAL_POST_METRICS = [
  "views",
  "impressions",
  "reach",
  "engagements",
  "likes",
  "comments",
  "shares",
  "saves",
] as const;

export function socialPostMetric(item: SocialContentInsight, metric: SocialDetailMetric) {
  if (metric === "shares" && ["threads", "twitter"].includes(item.provider)) return undefined;
  if (SOCIAL_POST_METRICS.some((key) => key === metric))
    return item[metric as (typeof SOCIAL_POST_METRICS)[number]] ?? undefined;
  return item.detailMetrics?.[metric];
}

export function socialContentForRange(
  content: SocialContentInsight[],
  range: SocialInsightsRange,
  now: Date,
) {
  if (range === "all") return content;
  const cutoff = socialInsightsCutoff(range, now);
  return content.filter((item) => {
    const published = Date.parse(item.publishedAt);
    return published >= cutoff && published <= now.getTime();
  });
}

export function socialAccountActivity(
  accounts: SocialAnalyticsAccount[],
  history: SocialAnalyticsHistoryPoint[],
  content: SocialContentInsight[],
  range: SocialInsightsRange,
  now: Date,
) {
  const cutoff = socialInsightsCutoff(range, now);
  const accountMetrics: SocialDetailMetrics = {};
  const postMetrics: SocialDetailMetrics = {};
  const postMetricKeys = [...SOCIAL_POST_METRICS, "reposts", "quotes"] as const;
  let followerChange: number | null = null;
  let partialFollowerHistory = false;
  for (const account of accounts) {
    const accountHistory = history.filter((point) => point.connectionId === account.connectionId);
    const metrics: SocialDetailMetrics =
      range === "all" ? {} : { ...account.periodMetrics?.[range] };
    const dailyKeys = [
      "views",
      "engagements",
      "likes",
      "comments",
      "shares",
      "follows",
      "unfollows",
      "watchSeconds",
      "clicks",
    ] as const;
    for (const key of dailyKeys) {
      if (metrics[key] !== undefined) continue;
      const byDay = new Map<string, number>();
      for (const point of accountHistory) {
        const timestamp = Date.parse(point.capturedAt);
        // Threads' daily history contains profile views. X history uses impressions.
        const value =
          key === "views"
            ? ["facebook", "instagram", "youtube", "tiktok"].includes(account.provider)
              ? point.views
              : null
            : key === "engagements"
              ? point.engagements
              : point.detailMetrics?.[key];
        if (value != null && timestamp >= cutoff && timestamp <= now.getTime())
          byDay.set(point.capturedAt.slice(0, 10), value);
      }
      if (byDay.size) metrics[key] = [...byDay.values()].reduce((total, value) => total + value, 0);
    }
    for (const key of Object.keys(metrics) as SocialDetailMetric[]) {
      const value = metrics[key];
      // Unique audiences cannot be deduplicated across accounts.
      if (
        value !== undefined &&
        (accounts.length === 1 || (key !== "reach" && key !== "engagedAccounts"))
      )
        accountMetrics[key] = (accountMetrics[key] ?? 0) + value;
    }
    if (metrics.follows !== undefined && metrics.unfollows !== undefined) {
      followerChange = (followerChange ?? 0) + metrics.follows - metrics.unfollows;
      continue;
    }
    const series = followerGrowthSeries(accountHistory, account.connectionId).filter(
      (point) => Date.parse(point.date) <= now.getTime(),
    );
    const latest = series.at(-1);
    const baselineAt = Number.isFinite(cutoff) ? cutoff : -Infinity;
    const baseline =
      [...series].reverse().find((point) => Date.parse(point.date) <= baselineAt) || series[0];
    if (baseline && latest && baseline.date !== latest.date && Date.parse(latest.date) >= cutoff) {
      followerChange = (followerChange ?? 0) + latest.value - baseline.value;
      if (range !== "all" && Date.parse(baseline.date) > cutoff) partialFollowerHistory = true;
    } else {
      partialFollowerHistory = true;
    }
  }
  for (const item of content) {
    for (const key of postMetricKeys) {
      if (key === "reach") continue;
      const value = socialPostMetric(item, key);
      if (value !== undefined) postMetrics[key] = (postMetrics[key] ?? 0) + value;
    }
  }
  return { accountMetrics, postMetrics, followerChange, partialFollowerHistory };
}

export function socialMilestones(account: SocialAnalyticsAccount, content: SocialContentInsight[]) {
  const usesViews = ["instagram", "facebook", "threads", "tiktok", "youtube"].includes(
    account.provider,
  );
  const preferredMetric = usesViews ? "views" : "impressions";
  const preferredExposure = content.reduce(
    (total, item) => total + (item[preferredMetric] || 0),
    0,
  );
  const exposureMetric =
    preferredExposure || account.views ? preferredMetric : socialContentExposureMetric(content);
  const exposure = Math.max(
    exposureMetric === "engagements" ? account.engagements || 0 : account.views || 0,
    content.reduce((total, item) => total + (item[exposureMetric] || 0), 0),
  );
  const followerMilestones = [100, 200, 500, 1_000, 5_000, 10_000, 25_000, 50_000].map(
    (target) => ({
      label: `${compactMilestone(target)} followers`,
      reached: (account.followers || 0) >= target,
    }),
  );
  const exposureMilestones = [10_000, 100_000, 1_000_000].map((target) => ({
    label: `${compactMilestone(target)} ${exposureMetric}`,
    reached: exposure >= target,
  }));
  return [...followerMilestones, ...exposureMilestones].slice(0, 9);
}

export function socialProviderEmptyStateMessage(provider: SocialProvider) {
  if (provider === "facebook")
    return "Facebook history requires Page Insights permission for an eligible Page. Reconnect and approve read_insights and pages_read_engagement.";
  if (provider === "linkedin")
    return "LinkedIn member-post history requires approved analytics scopes and LinkedIn product approval. Reconnect after approval is active.";
  if (provider === "tiktok")
    return "TikTok's official API does not provide historical follower or reach data. Bento records followers from the connection date and imports available video activity.";
  if (provider === "twitter")
    return "X's official API does not provide historical follower or reach data. Bento records followers from the connection date and imports metrics allowed by the account's API tier.";
  if (provider === "reddit")
    return "Reddit's official API does not provide historical follower or reach data. Bento records available profile totals and imports post scores and comments.";
  if (provider === "instagram" || provider === "threads")
    return `${provider === "instagram" ? "Instagram" : "Threads"} does not provide historical follower totals. Bento records followers from the connection date and imports the history its official API exposes.`;
  return "Refresh to import older platform content and the metrics exposed by this connection.";
}

export function followerGrowthSeries(history: SocialAnalyticsHistoryPoint[], connectionId: string) {
  const byDate = new Map<string, { date: string; value: number }>();
  for (const point of history) {
    if (point.connectionId !== connectionId || point.followers === null) continue;
    byDate.set(localDateKey(new Date(point.capturedAt)), {
      date: point.capturedAt,
      value: point.followers,
    });
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export function impressionHistorySeries(
  history: SocialAnalyticsHistoryPoint[],
  connectionId: string,
) {
  return history
    .filter((point) => point.connectionId === connectionId && point.views !== null)
    .map((point) => ({ date: point.capturedAt, value: point.views as number }));
}

function compactMilestone(value: number) {
  return value >= 1_000_000
    ? `${value / 1_000_000}M`
    : value >= 1_000
      ? `${value / 1_000}K`
      : String(value);
}

function localDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
