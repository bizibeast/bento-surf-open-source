import { analyticsDays } from "./plans";
import { historyStart, rangeStart } from "./analytics.functions";
import { zonedDateTimeToUtc } from "./booking";
import { getPlan } from "./plan.server";
import type { CreatorMcpContext } from "./mcp.creator-ops.server";

export async function mcpAnalyticsWindow(
  context: CreatorMcpContext,
  range: "today" | "3d" | "7d" | "30d" | "90d" | "all",
) {
  const { data, error } = await context.supabase
    .from("profiles")
    .select("account_timezone,analytics_timezone")
    .eq("id", context.userId)
    .single();
  if (error || !data) throw new Error("Analytics timezone could not be loaded.");
  const timeZone = data.account_timezone || data.analytics_timezone || "UTC";
  let start = rangeStart(range, timeZone);
  const historyDays = analyticsDays(await getPlan(context.userId));
  if (historyDays !== null) {
    const floor = historyStart(historyDays, timeZone);
    if (!start || start < floor) start = floor;
  }
  const startTimestamp = start
    ? zonedDateTimeToUtc(start, "00:00", timeZone)?.toISOString() || start
    : null;
  return { timeZone, start, startTimestamp, historyDays };
}
