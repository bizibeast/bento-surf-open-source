export const SOCIAL_INSIGHTS_RANGES = [7, 30, 90, 366, "all"] as const;
export type SocialInsightsRange = (typeof SOCIAL_INSIGHTS_RANGES)[number];

export const SOCIAL_DETAIL_METRICS = {
  views: "Views",
  impressions: "Impressions",
  reach: "Reach",
  engagements: "Engagements",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  saves: "Saves",
  reposts: "Reposts",
  quotes: "Quotes",
  follows: "Followers gained",
  unfollows: "Followers lost",
  profileVisits: "Profile visits",
  clicks: "Link clicks",
  skipRate: "Skip rate (first 3 seconds)",
  averageWatchSeconds: "Average watch time",
  watchSeconds: "Total watch time",
  averageViewedPercent: "Average percentage viewed",
  qualifiedViews: "30-second video views",
  durationSeconds: "Video duration",
  engagedAccounts: "Accounts engaged",
  playlistAdds: "Playlist adds",
} as const;

export type SocialDetailMetric = keyof typeof SOCIAL_DETAIL_METRICS;
export type SocialDetailMetrics = Partial<Record<SocialDetailMetric, number>>;
export type SocialAccountPeriods = Partial<Record<7 | 30 | 90 | 366, SocialDetailMetrics>>;

export function socialMetricValue(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

export function socialDetailMetrics(values: Partial<Record<SocialDetailMetric, unknown>>) {
  const metrics: SocialDetailMetrics = {};
  for (const key of Object.keys(SOCIAL_DETAIL_METRICS) as SocialDetailMetric[]) {
    const value = socialMetricValue(values[key]);
    if (value !== undefined) metrics[key] = value;
  }
  return metrics;
}

export function socialInsightsCutoff(range: SocialInsightsRange, now: Date) {
  if (range === "all") return -Infinity;
  const cutoff = new Date(now);
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - range + 1);
  return cutoff.getTime();
}
