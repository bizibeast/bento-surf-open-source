/* eslint-disable @typescript-eslint/no-explicit-any -- analytics rollup tables land before generated Supabase types */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { findPlatform } from "@/lib/platforms";
import { getPlan } from "@/lib/plan.server";
import { analyticsDays } from "@/lib/plans";
import { isValidTimeZone } from "@/lib/timezones";

type DimensionRow = {
  dimension: "device" | "browser" | "country" | "city" | "source";
  value: string;
  count: number | string;
};

type AnalyticsRollup = {
  totalViews?: number | string;
  totalClicks?: number | string;
  uniqueVisitors?: number | string;
  hourly?: Array<number | string>;
  daily?: Array<{
    date: string;
    views: number | string;
    clicks: number | string;
    uniqueVisitors?: number | string;
  }>;
  dimensions?: DimensionRow[];
  blockClicks?: Array<{ blockId: string; clicks: number | string }>;
};

const numberValue = (value: number | string | null | undefined) => Number(value ?? 0) || 0;

type AnalyticsTimeZoneSource = "saved" | "ip" | "browser" | "default";

type AnalyticsContext = {
  supabase: unknown;
  userId: string;
};

const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(isValidTimeZone, "Choose a valid timezone.");

export function dayInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function rangeStart(
  range: "today" | "3d" | "7d" | "30d" | "90d" | "all",
  timeZone: string,
  now = new Date(),
) {
  if (range === "all") return null;
  const days = range === "3d" ? 3 : range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return historyStart(range === "today" ? 1 : days, timeZone, now);
}

export function historyStart(days: number, timeZone: string, now = new Date()) {
  const localToday = dayInTimeZone(now, timeZone);
  const [year, month, day] = localToday.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day - Math.max(1, days) + 1));
  return date.toISOString().slice(0, 10);
}

function requestTimeZone() {
  const request = getRequest() as (Request & { cf?: { timezone?: string } }) | undefined;
  const candidate = request?.cf?.timezone || request?.headers.get("cf-timezone") || "";
  return candidate && isValidTimeZone(candidate) ? candidate : null;
}

async function resolveAnalyticsTimeZone(
  context: AnalyticsContext,
  browserTimeZone?: string,
): Promise<{ timeZone: string; source: AnalyticsTimeZoneSource }> {
  const { data: profile, error } = await (context.supabase as any)
    .from("profiles")
    .select("account_timezone,analytics_timezone")
    .eq("id", context.userId)
    .single();
  if (error) throw new Error(`Unable to load analytics timezone: ${error.message}`);

  const manual = String(profile?.account_timezone || "");
  if (manual && isValidTimeZone(manual)) return { timeZone: manual, source: "saved" };

  const fromBrowser = browserTimeZone && isValidTimeZone(browserTimeZone) ? browserTimeZone : null;
  const saved = String(profile?.analytics_timezone || "");
  if (fromBrowser === saved) return { timeZone: saved, source: "saved" };

  const fromSaved = saved && isValidTimeZone(saved) ? saved : null;
  if (!fromBrowser && fromSaved) return { timeZone: fromSaved, source: "saved" };
  const fromIp = requestTimeZone();
  const timeZone = fromBrowser || fromSaved || fromIp || "UTC";
  const source: AnalyticsTimeZoneSource = fromBrowser
    ? "browser"
    : fromSaved
      ? "saved"
      : fromIp
        ? "ip"
        : "default";

  // Do not turn a missing location signal into a permanent UTC preference.
  // The analytics page can still supply the browser zone on a later request.
  if (source === "default") return { timeZone, source };

  const { error: updateError } = await (context.supabase as any)
    .from("profiles")
    .update({ analytics_timezone: timeZone })
    .eq("id", context.userId);
  if (updateError) throw new Error(`Unable to save analytics timezone: ${updateError.message}`);

  return { timeZone, source };
}

async function loadRollup(
  supabase: unknown,
  startDate: string | null,
  timeZone: string,
): Promise<AnalyticsRollup> {
  const { data, error } = await (supabase as any).rpc("get_creator_analytics", {
    p_start_date: startDate,
    p_timezone: timeZone,
  });
  if (error) throw new Error(`Unable to load analytics: ${error.message}`);
  return (data ?? {}) as AnalyticsRollup;
}

function dimensions(rows: DimensionRow[], dimension: DimensionRow["dimension"], limit = 100) {
  return rows
    .filter((row) => row.dimension === dimension)
    .map((row) => ({ label: row.value, count: numberValue(row.count) }))
    .sort((left, right) => right.count - left.count)
    .slice(0, limit);
}

function blockLabel(block: any) {
  const type = block.type ?? "block";
  const content = (block.content ?? {}) as Record<string, any>;
  const platformLabel = content.platform ? findPlatform(content.platform)?.label : undefined;
  const fallback = type
    .split("_")
    .map((part: string) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return content.title || content.label || platformLabel || fallback;
}

export const getAnalyticsSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { timeZone } = await resolveAnalyticsTimeZone(context);
    const [rollup, blocks] = await Promise.all([
      loadRollup(context.supabase, rangeStart("today", timeZone), timeZone),
      context.supabase.from("blocks").select("id, type, content").eq("user_id", context.userId),
    ]);
    if (blocks.error) throw new Error(blocks.error.message);

    const clicks = new Map(
      (rollup.blockClicks ?? []).map((row) => [row.blockId, numberValue(row.clicks)]),
    );
    const topBlock =
      (blocks.data ?? [])
        .map((block) => ({
          id: block.id,
          label: blockLabel(block),
          clicks: clicks.get(block.id) ?? 0,
        }))
        .sort((left, right) => right.clicks - left.clicks)[0] ?? null;

    return {
      visitsToday: numberValue(rollup.totalViews),
      uniqueVisitorsToday: numberValue(rollup.uniqueVisitors),
      clicksToday: numberValue(rollup.totalClicks),
      hourly: Array.from({ length: 24 }, (_, hour) => numberValue(rollup.hourly?.[hour])),
      topBlock,
      timeZone,
    };
  });

export const getMyAnalytics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        range: z.enum(["today", "3d", "7d", "30d", "90d", "all"]).default("30d"),
        browserTimeZone: timeZoneSchema.optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ context, data }) => {
    const { timeZone, source: timeZoneSource } = await resolveAnalyticsTimeZone(
      context,
      data.browserTimeZone,
    );
    let start = rangeStart(data.range, timeZone);
    const plan = await getPlan(context.userId);
    const historyDays = analyticsDays(plan);
    if (historyDays !== null) {
      const floorDay = historyStart(historyDays, timeZone);
      if (!start || start < floorDay) start = floorDay;
    }

    const [rollup, blocks] = await Promise.all([
      loadRollup(context.supabase, start, timeZone),
      context.supabase.from("blocks").select("id, type, content").eq("user_id", context.userId),
    ]);
    if (blocks.error) throw new Error(blocks.error.message);

    const dimensionRows = rollup.dimensions ?? [];
    const devices = dimensions(dimensionRows, "device");
    const browsers = dimensions(dimensionRows, "browser");
    const countries = dimensions(dimensionRows, "country", 20);
    const cities = dimensions(dimensionRows, "city", 20);
    const sources = dimensions(dimensionRows, "source", 20);
    const deviceMap = new Map(devices.map((item) => [item.label, item.count]));
    const mobileDesktop = {
      mobile: deviceMap.get("mobile") ?? 0,
      desktop: deviceMap.get("desktop") ?? 0,
      tablet: deviceMap.get("tablet") ?? 0,
    };
    const socialMap = new Map(sources.map((source) => [source.label, source.count]));
    const social = [
      "Instagram",
      "Twitter",
      "Reddit",
      "TikTok",
      "YouTube",
      "Facebook",
      "LinkedIn",
      "Threads",
      "Pinterest",
    ].map((label) => ({ label, count: socialMap.get(label) ?? 0 }));

    const clickByBlock = new Map(
      (rollup.blockClicks ?? []).map((row) => [row.blockId, numberValue(row.clicks)]),
    );
    const topBlocks = (blocks.data ?? [])
      .map((block) => ({
        id: block.id,
        type: block.type ?? "block",
        label: blockLabel(block),
        clicks: clickByBlock.get(block.id) ?? 0,
      }))
      .sort((left, right) => right.clicks - left.clicks)
      .slice(0, 10);

    return {
      range: data.range,
      timeZone,
      timeZoneSource,
      totalViews: numberValue(rollup.totalViews),
      totalClicks: numberValue(rollup.totalClicks),
      uniqueVisitors: numberValue(rollup.uniqueVisitors),
      hourly: Array.from({ length: 24 }, (_, hour) => numberValue(rollup.hourly?.[hour])),
      daily: (rollup.daily ?? []).map((row) => ({
        date: row.date,
        views: numberValue(row.views),
        clicks: numberValue(row.clicks),
      })),
      devices,
      browsers,
      mobileDesktop,
      countries,
      cities,
      sources,
      social,
      topBlocks,
    };
  });
