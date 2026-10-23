/* eslint-disable @typescript-eslint/no-explicit-any -- Scheduler tables precede generated types. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requirePlanEntitlement } from "./plan.server";
import { enforceRequestRateLimit } from "./request-security.server";
import { mcpAnalyticsWindow } from "./mcp-analytics-window.server";
import type { CreatorMcpContext } from "./mcp.creator-ops.server";
import { sanitizeMcpReadData } from "./mcp-read-results";
import {
  decodeSchedulerCursor,
  encodeSchedulerCursor,
  getSocialPostInputSchema,
  schedulerReadFiltersSchema,
  validateSchedulerDates,
  type GetSocialPostInput,
  type SchedulerReadFilters,
} from "./mcp-scheduler-read";

const POST_FIELDS =
  "id,body,title,media,settings,scheduled_at,timezone,status,published_at,cancelled_at,created_at,updated_at";
const TARGET_FIELDS =
  "id,connection_id,provider,status,remote_post_id,remote_post_url,last_error_code,last_error_message,published_at,provider_settings,attempt_count,next_attempt_at,retry_started_at,processing_started_at,upload_byte_offset,last_reconcile_at,created_at,updated_at";
const METRIC_FIELDS =
  "id,connection_id,provider,remote_post_id,remote_post_url,caption,content_type,thumbnail_url,views,impressions,reach,engagements,likes,comments,shares,saves,published_at,fetched_at";
const ATTEMPT_FIELDS =
  "id,target_id,attempt,outcome,response_status,error_code,error_message,duration_ms,created_at";

type Target = {
  id: string;
  connection_id: string;
  provider: string;
  remote_post_id: string | null;
  remote_post_url: string | null;
} & Record<string, unknown>;
type Post = {
  id: string;
  created_at: string;
  targets: Target[];
  body?: string;
  title?: string | null;
  media?: unknown[];
} & Record<string, unknown>;

async function authorize(userId: string) {
  await requirePlanEntitlement(
    userId,
    "mcpSocialAutomation",
    "MCP social automation is not available for this plan.",
  );
  await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "mcp-scheduler-read", userId);
}

export async function listSchedulerPosts(
  userId: string,
  status: string | undefined,
  limit: number,
  rawFilters: SchedulerReadFilters = {},
) {
  await authorize(userId);
  const filters = schedulerReadFiltersSchema.parse(rawFilters);
  validateSchedulerDates(filters);
  const pageSize = Math.min(100, Math.max(1, limit));
  const filterTargets = Boolean(
    filters.provider ||
    filters.connectionId ||
    filters.targetStatus ||
    (filters.dateField === "published_at" && (filters.dateFrom || filters.dateTo)),
  );
  let query = (supabaseAdmin as any)
    .from("social_posts")
    .select(
      `${POST_FIELDS},targets:social_post_targets${filterTargets ? "!inner" : ""}(${TARGET_FIELDS})`,
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(pageSize + 1);
  if (status) query = query.eq("status", status);
  if (filters.connectionId) query = query.eq("targets.connection_id", filters.connectionId);
  if (filters.query) query = query.ilike("body", `%${filters.query.replace(/[\\%_]/g, "\\$&")}%`);
  if (filters.provider) query = query.eq("targets.provider", filters.provider);
  if (filters.targetStatus) query = query.eq("targets.status", filters.targetStatus);
  const dateColumn =
    filters.dateField === "published_at" ? "targets.published_at" : filters.dateField;
  if (filters.dateFrom) query = query.gte(dateColumn, filters.dateFrom);
  if (filters.dateTo) query = query.lt(dateColumn, filters.dateTo);
  if (filters.cursor) {
    const cursor = decodeSchedulerCursor(filters.cursor);
    query = query.or(
      `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
    );
  }
  const { data, error } = await query;
  if (error) throw new Error("Scheduler posts could not be loaded.");
  const rows = (data || []) as unknown as Post[];
  const posts = rows.slice(0, pageSize);
  return sanitizeMcpReadData({
    posts,
    pagination: {
      limit: pageSize,
      hasMore: rows.length > pageSize,
      nextCursor:
        rows.length > pageSize && posts.length
          ? encodeSchedulerCursor(posts[posts.length - 1])
          : null,
    },
    filters: { status: status || null, ...filters, cursor: undefined },
    provenance: {
      source: "stored_scheduler",
      observedAt: new Date().toISOString(),
      dateSemantics:
        filters.dateField === "published_at"
          ? "Destination published_at; dateFrom inclusive, dateTo exclusive."
          : `${filters.dateField}; dateFrom inclusive, dateTo exclusive.`,
      targets: filterTargets
        ? "Only matching destinations are listed; get_social_post returns all destinations."
        : "All stored destinations.",
      metrics:
        "Call get_social_post for stored analytics and their fetched_at timestamps. This read does not refresh providers.",
    },
  });
}

export async function getSchedulerPost(userId: string, raw: GetSocialPostInput) {
  await authorize(userId);
  const input = getSocialPostInputSchema.parse(raw);
  const admin = supabaseAdmin as any;
  const { data, error } = await admin
    .from("social_posts")
    .select(`${POST_FIELDS},targets:social_post_targets(${TARGET_FIELDS})`)
    .eq("user_id", userId)
    .eq("id", input.id)
    .maybeSingle();
  if (error) throw new Error("Scheduler posts could not be loaded.");
  if (!data) throw new Error("Scheduler post not found.");
  const post = data as unknown as Post;
  const analyticsWindow = await mcpAnalyticsWindow(
    { userId, supabase: supabaseAdmin } as CreatorMcpContext,
    "all",
  );
  // Join each metric through the owned post's exact connection + platform + remote ID.
  const targets = await Promise.all(
    (post.targets || []).map(async (target) => {
      if (!target.remote_post_id)
        return {
          ...target,
          metrics: null,
          metricsAvailability: "no_remote_post_id",
          resolvedRemotePostUrl: target.remote_post_url,
          remotePostUrlSource: target.remote_post_url ? "scheduler_target" : null,
        };
      if (
        analyticsWindow.startTimestamp &&
        typeof target.published_at === "string" &&
        Date.parse(target.published_at) < Date.parse(analyticsWindow.startTimestamp)
      ) {
        return {
          ...target,
          metrics: null,
          metricsAvailability: "outside_plan_history_window",
          resolvedRemotePostUrl: target.remote_post_url,
          remotePostUrlSource: target.remote_post_url ? "scheduler_target" : null,
        };
      }
      let metricQuery = admin
        .from("social_content_insights")
        .select(METRIC_FIELDS)
        .eq("user_id", userId)
        .eq("connection_id", target.connection_id)
        .eq("provider", target.provider)
        .eq("remote_post_id", target.remote_post_id);
      if (analyticsWindow.startTimestamp)
        metricQuery = metricQuery.gte("published_at", analyticsWindow.startTimestamp);
      const result = await metricQuery
        .order("fetched_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (result.error) throw new Error("Stored post details could not be loaded.");
      return {
        ...target,
        metrics: result.data,
        metricsAvailability: result.data ? "available" : "no_stored_match_in_plan_history_window",
        resolvedRemotePostUrl: target.remote_post_url || result.data?.remote_post_url || null,
        remotePostUrlSource: target.remote_post_url
          ? "scheduler_target"
          : result.data?.remote_post_url
            ? "owned_stored_insight"
            : null,
      };
    }),
  );
  let attempts: Record<string, unknown>[] = [];
  if (targets.length) {
    let query = admin
      .from("social_publish_attempts")
      .select(ATTEMPT_FIELDS)
      .in(
        "target_id",
        targets.map((target) => target.id),
      )
      .order("id", { ascending: false })
      .limit(input.attemptsLimit + 1);
    if (input.attemptsCursor) query = query.lt("id", input.attemptsCursor);
    const result = await query;
    if (result.error) throw new Error("Stored post details could not be loaded.");
    attempts = result.data || [];
  }
  const hasMore = attempts.length > input.attemptsLimit;
  attempts = attempts.slice(0, input.attemptsLimit);
  return sanitizeMcpReadData({
    post: { ...post, targets },
    attempts,
    attemptsPagination: {
      limit: input.attemptsLimit,
      hasMore,
      nextCursor: hasMore ? String(attempts[attempts.length - 1].id) : null,
    },
    provenance: {
      source: "stored_scheduler",
      observedAt: new Date().toISOString(),
      metricsSource: "stored_social_content_insights",
      analyticsWindow,
      metricsFreshness:
        "Each metric record includes fetched_at. No live provider refresh was performed.",
    },
  });
}
