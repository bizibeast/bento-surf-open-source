import { z } from "zod";

export const INSTAGRAM_ACCOUNT_INSIGHT_METRICS = [
  "views",
  "reach",
  "accounts_engaged",
  "total_interactions",
] as const;

export type InstagramAccountInsightMetric = (typeof INSTAGRAM_ACCOUNT_INSIGHT_METRICS)[number];

export type InstagramAccountInsights = {
  connectionId: string;
  handle: string;
  rangeDays: 7 | 30;
  metrics: Record<InstagramAccountInsightMetric, number | null>;
  generatedAt: string;
  dataMayBeDelayed: true;
};

const metricSchema = z.object({
  name: z.string(),
  total_value: z.object({ value: z.number() }).optional(),
});

export const instagramInsightsResponseSchema = z.object({
  data: z.array(metricSchema).default([]),
  error: z
    .object({
      code: z.union([z.string(), z.number()]).optional(),
      message: z.string().optional(),
      type: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

export function buildInstagramInsightsUrl({
  accountId,
  apiVersion,
  rangeDays,
  now = new Date(),
}: {
  accountId: string;
  apiVersion: string;
  rangeDays: 7 | 30;
  now?: Date;
}) {
  const url = new URL(
    `https://graph.instagram.com/${apiVersion}/${encodeURIComponent(accountId)}/insights`,
  );
  const until = Math.floor(now.getTime() / 1_000);
  url.searchParams.set("metric", INSTAGRAM_ACCOUNT_INSIGHT_METRICS.join(","));
  url.searchParams.set("period", "day");
  url.searchParams.set("metric_type", "total_value");
  url.searchParams.set("since", String(until - rangeDays * 24 * 60 * 60));
  url.searchParams.set("until", String(until));
  return url;
}

export function normalizeInstagramInsights(
  payload: z.infer<typeof instagramInsightsResponseSchema>,
): Record<InstagramAccountInsightMetric, number | null> {
  const values = new Map(
    payload.data.map((metric) => [metric.name, metric.total_value?.value ?? null]),
  );
  return Object.fromEntries(
    INSTAGRAM_ACCOUNT_INSIGHT_METRICS.map((metric) => [metric, values.get(metric) ?? null]),
  ) as Record<InstagramAccountInsightMetric, number | null>;
}
