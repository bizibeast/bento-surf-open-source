import { socialContentExposureMetric, type BestContentMetric } from "./social-insights-dashboard";
import type { SocialContentInsight } from "./social-content-insights.server";

type ExposureMetric = Extract<BestContentMetric, "views" | "impressions" | "engagements">;

export type ContentWinner = SocialContentInsight & {
  metric: ExposureMetric | null;
  value: number | null;
  outlierScore: number | null;
};

export type ContentPattern = {
  provider: SocialContentInsight["provider"];
  contentType: SocialContentInsight["contentType"];
  metric: ExposureMetric;
  posts: number;
  averageValue: number;
};

function groupKey(item: SocialContentInsight) {
  return `${item.provider}:${item.contentType}`;
}

function grouped(items: SocialContentInsight[]) {
  const groups = new Map<string, SocialContentInsight[]>();
  for (const item of items) {
    const key = groupKey(item);
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  return groups;
}

function metricFor(items: SocialContentInsight[]): ExposureMetric | null {
  if (
    !items.some((item) => [item.views, item.impressions, item.engagements].some((v) => v !== null))
  ) {
    return null;
  }
  return socialContentExposureMetric(items);
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function rankCreatorPosts(items: SocialContentInsight[], limit = 9): ContentWinner[] {
  const groups = grouped(items);
  const ranked = items.map((item): ContentWinner => {
    const group = groups.get(groupKey(item)) || [item];
    const metric = metricFor(group);
    if (!metric) return { ...item, metric: null, value: null, outlierScore: null };
    const value = item[metric];
    const baseline = median(
      group
        .map((candidate) => candidate[metric])
        .filter((candidate): candidate is number => candidate !== null && candidate > 0),
    );
    return {
      ...item,
      metric,
      value,
      outlierScore: value !== null && baseline && baseline > 0 ? value / baseline : null,
    };
  });
  return ranked
    .sort((left, right) => {
      if (left.outlierScore === null) return right.outlierScore === null ? 0 : 1;
      if (right.outlierScore === null) return -1;
      return right.outlierScore - left.outlierScore;
    })
    .slice(0, Math.max(0, limit));
}

export function creatorPerformancePatterns(items: SocialContentInsight[]): ContentPattern[] {
  return [...grouped(items).values()].flatMap((group): ContentPattern[] => {
    const metric = metricFor(group);
    if (!metric) return [];
    const values = group
      .map((item) => item[metric])
      .filter((value): value is number => value !== null && value >= 0);
    if (values.length < 3) return [];
    return [
      {
        provider: group[0].provider,
        contentType: group[0].contentType,
        metric,
        posts: values.length,
        averageValue: Math.round(values.reduce((total, value) => total + value, 0) / values.length),
      },
    ];
  });
}
