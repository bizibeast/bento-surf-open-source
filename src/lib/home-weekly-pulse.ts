import { z } from "zod";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const comparison = z.object({ current: count, previous: count });
const schema = z.object({
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }),
  followers: comparison,
  leads: comparison,
  revenue: z.array(comparison.extend({ currency: z.string().regex(/^[a-z]{3}$/) })),
});
export type WeeklyComparison = z.infer<typeof comparison>;
export type HomeWeeklyPulse = z.infer<typeof schema>;

export function parseHomeWeeklyPulse(value: unknown): HomeWeeklyPulse | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

export function weeklyChange(metric: WeeklyComparison | null | undefined) {
  if (!metric) return { text: "Not available", direction: "neutral" as const };
  if (metric.current === metric.previous)
    return { text: "No change vs last week", direction: "neutral" as const };
  if (!metric.previous) return { text: "New this week", direction: "up" as const };
  const change = ((metric.current - metric.previous) / metric.previous) * 100;
  const value = new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(change);
  return {
    text: `${change > 0 ? "+" : ""}${value}% vs last week`,
    direction: change > 0 ? ("up" as const) : ("down" as const),
  };
}
