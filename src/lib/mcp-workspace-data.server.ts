/* eslint-disable @typescript-eslint/no-explicit-any -- Analytics and content tables precede generated types. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getPlan } from "./plan.server";
import { analyticsDays } from "./plans";
import { sourcePresentation, type ContentSourcePresentation } from "./content-source-media";
import { zonedDateTimeToUtc } from "./booking";
import { historyStart, rangeStart } from "./analytics.functions";
import { requireContentWorkspace } from "./content-access.server";
import { enforceRequestRateLimit } from "./request-security.server";
import { readWorkspaceDataSchema, type ReadWorkspaceDataInput } from "./mcp-workspace-data";
import type { CreatorMcpContext } from "./mcp.creator-ops.server";

export const SOCIAL_ACCOUNT_FIELDS =
  "connection_id,provider,provider_handle,provider_display_name,provider_avatar_url,followers,following,posts,views,reach,engagements,status,note,fetched_at";
export const SOCIAL_POST_FIELDS =
  "id,connection_id,provider,remote_post_id,remote_post_url,caption,content_type,thumbnail_url,views,impressions,reach,engagements,likes,comments,shares,saves,published_at,fetched_at";

const collections = {
  brain_items: {
    table: "creator_brain_items",
    fields:
      "id,kind,title,content,provenance,source_url,source_ref,status,locked,tags,created_at,updated_at",
    key: "id",
    text: "content",
    search: "title",
  },
  brain_sources: {
    table: "content_source_records",
    fields:
      "id,connection_id,provider,record_type,title,body,canonical_source_url,occurred_at,retrieved_at,updated_at",
    key: "id",
    text: "body",
    search: "title",
  },
  routines: {
    table: "content_routines",
    fields: "id,template,enabled,schedule,timezone,platforms,next_run_at,last_run_at",
    key: "id",
  },
  routine_runs: {
    table: "content_routine_runs",
    fields: "id,routine_id,status,result_count,error_message,scheduled_for",
    key: "id",
  },
  discover_items: {
    table: "creator_content_recommendations",
    fields:
      "id,kind,title,summary,source_url,source_name,source_published_at,source_retrieved_at,reason,angles,metric_name,metric_value,outlier_score,feedback,metadata,created_at,updated_at",
    key: "id",
    text: "summary",
    search: "title",
  },
  social_accounts: {
    table: "social_analytics_snapshots",
    fields: SOCIAL_ACCOUNT_FIELDS,
    key: "connection_id",
  },
  social_posts: {
    table: "social_content_insights",
    fields: SOCIAL_POST_FIELDS,
    key: "id",
    text: "caption",
    search: "caption",
    date: "published_at",
  },
  social_history: {
    table: "social_analytics_history",
    fields:
      "id,connection_id,provider,followers,following,posts,views,reach,engagements,status,captured_at",
    key: "id",
    date: "captured_at",
  },
} satisfies Record<
  string,
  { table: string; fields: string; key: string; text?: string; search?: string; date?: string }
>;

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

export async function readWorkspaceData(context: CreatorMcpContext, input: ReadWorkspaceDataInput) {
  const data = readWorkspaceDataSchema.parse(input);
  await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "mcp-workspace-read", context.userId);
  if (["brain_items", "brain_sources", "routines", "routine_runs"].includes(data.collection))
    await requireContentWorkspace(context.userId);
  if (data.collection === "discover_items")
    await requireContentWorkspace(context.userId, "discover");
  const config: {
    table: string;
    fields: string;
    key: string;
    text?: string;
    search?: string;
    date?: string;
  } = collections[data.collection];
  const window = data.collection.startsWith("social_")
    ? await mcpAnalyticsWindow(context, data.range)
    : null;
  let query = (supabaseAdmin as any)
    .from(config.table)
    .select(config.fields)
    .eq("user_id", context.userId);
  if (data.collection === "brain_sources") query = query.is("deleted_at", null);
  if (data.id) query = query.eq(config.key, data.id);
  if (data.cursor) query = query.gt(config.key, data.cursor);
  if (data.query && config.search)
    query = query.ilike(config.search, `%${data.query.replace(/[\\%_]/g, "\\$&")}%`);
  if (data.savedOnly) query = query.or("feedback.eq.saved,metadata->>saved.eq.true");
  if (window?.startTimestamp && config.date) query = query.gte(config.date, window.startTimestamp);
  const limit = data.id ? 1 : data.limit;
  const { data: rows, error } = await query.order(config.key, { ascending: true }).limit(limit + 1);
  if (error) throw new Error("Stored workspace data could not be loaded. Please try again.");
  const hasMore = !data.id && (rows?.length || 0) > limit;
  const items = (rows || []).slice(0, limit).map((row: Record<string, unknown>) => {
    // Explicit projection also protects against future DB/query changes and mock payloads.
    const item: Record<string, unknown> = Object.fromEntries(
      config.fields
        .split(",")
        .filter((key) => key !== "metadata")
        .map((key) => [key, row[key]]),
    );
    // PostgREST returns bigint history IDs as numbers; all tool IDs are strings.
    if (row[config.key] !== undefined && row[config.key] !== null)
      item[config.key] = String(row[config.key]);
    if (data.collection === "discover_items") {
      const metadata = row.metadata as Record<string, unknown> | null;
      item.saved = row.feedback === "saved" || metadata?.saved === true;
      Object.assign(item, sourcePresentation((metadata || {}) as ContentSourcePresentation));
      for (const key of ["platform", "author", "thumbnailUrl"])
        if (typeof metadata?.[key] === "string") item[key] = metadata[key];
      const stats = metadata?.stats as Record<string, unknown> | undefined;
      item.stats = Object.fromEntries(
        [
          "views",
          "impressions",
          "reach",
          "engagements",
          "likes",
          "comments",
          "shares",
          "saves",
          "followers",
        ].flatMap((key) => (typeof stats?.[key] === "number" ? [[key, stats[key]]] : [])),
      );
      const inspiration = metadata?.inspiration as Record<string, unknown> | undefined;
      if (inspiration)
        item.inspiration = {
          ...Object.fromEntries(
            ["hook", "format", "whyNow"].flatMap((key) =>
              typeof inspiration[key] === "string" ? [[key, inspiration[key]]] : [],
            ),
          ),
          outline: Array.isArray(inspiration.outline)
            ? inspiration.outline.filter((line) => typeof line === "string").slice(0, 20)
            : [],
        };
    }
    if (data.collection === "routines") {
      const schedule = row.schedule as Record<string, unknown> | null;
      item.schedule = Object.fromEntries(
        ["outputMode", "intervalMinutes", "time", "name", "instructions", "catalogKey"].flatMap(
          (key) => (schedule?.[key] !== undefined ? [[key, schedule[key]]] : []),
        ),
      );
    }
    if (config.text && typeof item[config.text] === "string") {
      const text = item[config.text] as string;
      item.contentTruncated = !data.id && text.length > 500;
      if (item.contentTruncated) item[config.text] = text.slice(0, 500);
    }
    return item;
  });
  return {
    collection: data.collection,
    items,
    hasMore,
    nextCursor: hasMore ? String(items.at(-1)?.[config.key]) : null,
    readFrom: "stored" as const,
    ...(window
      ? {
          range: data.range,
          effectiveStart: window.start,
          historyDays: window.historyDays,
          timeZone: window.timeZone,
        }
      : {}),
  };
}
