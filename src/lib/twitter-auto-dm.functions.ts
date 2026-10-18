import { hasPlanEntitlement } from "./plan.server";
import { loadAutoDmMetrics } from "./auto-dm-metrics.server";
/* eslint-disable @typescript-eslint/no-explicit-any -- New service-role tables are typed after the migration is deployed. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { SOCIAL_CONNECTION_LIST_LIMIT } from "./large-table-columns";
import { enforceRequestRateLimit } from "./request-security.server";
import {
  getTwitterConnectionReadiness,
  twitterConnectionReadinessMessage,
  TWITTER_AUTO_DM_REQUIRED_SCOPES,
  twitterDmAutomationInputSchema,
  type TwitterDmActivity,
  type TwitterDmAutomation,
  type TwitterDmTriggerType,
} from "./twitter-auto-dm";
import { refreshTwitterAutoDmHealth, twitterWebhookAppConfigured } from "./twitter-auto-dm.server";
import { isServerSecretEncryptionKeyValid } from "./secret-crypto.server";
import { getPlan, requirePlanEntitlement } from "./plan.server";
import { planHasEntitlement, usesAdvancedAutoDm, type PlanId } from "./plans";

const requireAutoDm = (userId: string) =>
  requirePlanEntitlement(userId, "twitterAutoDM", "X Auto DMs are included with every Bento plan.");

type ConnectionRow = {
  id: string;
  provider_handle: string;
  provider_user_id: string;
  provider_display_name: string | null;
  access_token: string;
  refresh_token: string | null;
  scopes: string[] | null;
  status: string;
  connection_health: string;
  webhook_fields: string[] | null;
  last_verified_at: string | null;
  last_health_check_at: string | null;
  last_error: string | null;
  reauth_required: boolean;
  token_expires_at: string | null;
};

function scopeReady(scopes: string[] | null | undefined) {
  return TWITTER_AUTO_DM_REQUIRED_SCOPES.every((scope) => scopes?.includes(scope));
}

function connectionReady(
  connection: ConnectionRow | null | undefined,
  triggerType: TwitterDmTriggerType = "any_dm",
) {
  return getTwitterConnectionReadiness(connection, new Date(), triggerType).ready;
}

async function ownedConnections(userId: string): Promise<ConnectionRow[]> {
  const { data, error } = await (supabaseAdmin as any)
    .from("social_connections")
    .select(
      "id, provider_handle, provider_user_id, provider_display_name, access_token, refresh_token, scopes, status, connection_health, webhook_fields, last_verified_at, last_health_check_at, last_error, reauth_required, token_expires_at",
    )
    .eq("user_id", userId)
    .eq("provider", "twitter")
    .order("created_at", { ascending: true })
    .limit(SOCIAL_CONNECTION_LIST_LIMIT);
  if (error) throw new Error("Unable to load X connections.");
  return (data || []) as ConnectionRow[];
}

async function dashboard(userId: string, plan?: PlanId) {
  const connections = await ownedConnections(userId);
  const connectionIds = connections.map((connection) => connection.id);
  const [
    resolvedPlan,
    { data: automations, error: automationError },
    { data: events, error: eventError },
  ] = await Promise.all([
    plan ? Promise.resolve(plan) : getPlan(userId),
    connectionIds.length
      ? (supabaseAdmin as any)
          .from("twitter_dm_automations")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    connectionIds.length
      ? (supabaseAdmin as any)
          .from("twitter_dm_events")
          .select("*, automation:twitter_dm_automations(name)")
          .in("connection_id", connectionIds)
          .neq("status", "ignored")
          .order("created_at", { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (automationError || eventError) {
    throw new Error("Unable to load X automations.");
  }

  const metrics = await loadAutoDmMetrics(userId, "twitter");
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  return {
    locked: false,
    plan: resolvedPlan,
    webhookUrl: `${(process.env.VITE_APP_URL?.trim() || "http://localhost:8080").replace(/\/$/, "")}/api/webhooks/twitter`,
    configured: Boolean(
      process.env.X_CLIENT_ID &&
      process.env.X_CLIENT_SECRET &&
      twitterWebhookAppConfigured() &&
      isServerSecretEncryptionKeyValid(process.env.SOCIAL_CONNECTION_ENCRYPTION_KEY),
    ),
    connections: connections.map((connection) => {
      const readiness = getTwitterConnectionReadiness(connection);
      return {
        ready: readiness.ready,
        needsReconnect: readiness.needsReconnect,
        readinessIssues: readiness.issues,
        readinessMessage: twitterConnectionReadinessMessage(readiness.issues),
        id: connection.id,
        handle: connection.provider_handle,
        displayName: connection.provider_display_name || connection.provider_handle,
        status: connection.status,
        health: connection.connection_health,
        lastVerifiedAt: connection.last_verified_at,
        lastHealthCheckAt: connection.last_health_check_at,
        lastError: connection.last_error,
        webhookFields: connection.webhook_fields || [],
      };
    }),
    automations: (automations || []).map((row: any): TwitterDmAutomation => {
      const connection = byId.get(row.connection_id);
      const readiness = getTwitterConnectionReadiness(connection, new Date(), row.trigger_type);
      return {
        id: row.id,
        connectionId: row.connection_id,
        connectionHandle: connection?.provider_handle || "x",
        connectionReady: readiness.ready,
        connectionNeedsReconnect: readiness.needsReconnect,
        connectionReadinessMessage: twitterConnectionReadinessMessage(readiness.issues),
        connectionLastVerifiedAt: connection?.last_verified_at || null,
        metrics: metrics.get(row.id),
        name: row.name,
        sourcePostId: row.source_post_id || null,
        triggerType: row.trigger_type,
        keywords: row.keywords || [],
        excludedKeywords: row.excluded_keywords || [],
        matchType: row.match_type,
        replyMessage: row.reply_message,
        enabled: row.enabled,
        createdAt: row.created_at,
      };
    }),
    activity: (events || []).map((row: any): TwitterDmActivity => ({
      id: row.id,
      automationId: row.automation_id || null,
      automationName: row.automation?.name || null,
      eventType: row.event_type,
      senderLabel: row.sender_username ? `@${row.sender_username}` : "X user",
      matchedKeyword: row.matched_keyword,
      status: row.status,
      errorMessage: row.error_message,
      createdAt: row.created_at,
    })),
  };
}

export const getTwitterAutoDmDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const data = await dashboard(context.userId);
    return {
      ...data,
      locked: !planHasEntitlement(data.plan, "twitterAutoDM"),
      advancedAutoDm: await hasPlanEntitlement(context.userId, "advancedAutoDM"),
    };
  });

export const saveTwitterAutoDmAutomation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => twitterDmAutomationInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    await requireAutoDm(context.userId);
    if (
      usesAdvancedAutoDm({ excludedKeywords: data.excludedKeywords }) &&
      !(await hasPlanEntitlement(context.userId, "advancedAutoDM"))
    ) {
      throw new Error("Advanced Auto DMs are included with the Creator plan. Upgrade to continue.");
    }
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "twitter-auto-dm-save",
      context.userId,
    );
    const connections = await ownedConnections(context.userId);
    const connection = connections.find((item) => item.id === data.connectionId);
    if (!connection) throw new Error("Connect this X account first.");
    if (data.enabled && !connectionReady(connection, data.triggerType)) {
      throw new Error(
        connection.reauth_required || !scopeReady(connection.scopes)
          ? "Reconnect X to approve Direct Messages before enabling this."
          : "Repair and verify this X connection before enabling the automation.",
      );
    }
    if (data.id) {
      const { data: existing, error } = await (supabaseAdmin as any)
        .from("twitter_dm_automations")
        .select("source_post_id,connection_id")
        .eq("id", data.id)
        .eq("user_id", context.userId)
        .maybeSingle();
      if (error || !existing) throw new Error("This X automation no longer exists.");
      if (
        existing.source_post_id &&
        (data.connectionId !== existing.connection_id ||
          data.triggerType === "dm_keyword" ||
          data.triggerType === "any_dm")
      )
        throw new Error(
          "This automation belongs to its scheduled post and account. Choose replies, likes or reposts as its trigger.",
        );
    }
    const row = {
      user_id: context.userId,
      connection_id: data.connectionId,
      name: data.name,
      trigger_type: data.triggerType,
      keywords: data.keywords,
      excluded_keywords: data.excludedKeywords,
      match_type: data.matchType,
      reply_message: data.replyMessage,
      enabled: data.enabled,
    };
    const query = data.id
      ? (supabaseAdmin as any)
          .from("twitter_dm_automations")
          .update(row)
          .eq("id", data.id)
          .eq("user_id", context.userId)
          .select("id")
          .maybeSingle()
      : (supabaseAdmin as any).from("twitter_dm_automations").insert(row);
    const { data: savedAutomation, error } = await query;
    if (error || (data.id && !savedAutomation)) {
      throw new Error(
        data.id ? "This X automation no longer exists." : "Unable to save this X automation.",
      );
    }
    return dashboard(context.userId);
  });

export const setTwitterAutoDmEnabled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid(), enabled: z.boolean() }).parse(input))
  .handler(async ({ data, context }) => {
    if (data.enabled) {
      await requireAutoDm(context.userId);
      const { data: automation, error: automationError } = await (supabaseAdmin as any)
        .from("twitter_dm_automations")
        .select("connection_id,trigger_type")
        .eq("id", data.id)
        .eq("user_id", context.userId)
        .maybeSingle();
      if (automationError || !automation) throw new Error("Automation not found.");
      const connection = (await ownedConnections(context.userId)).find(
        (item) => item.id === automation.connection_id,
      );
      if (!connectionReady(connection, automation.trigger_type)) {
        throw new Error(
          connection?.reauth_required || !scopeReady(connection?.scopes)
            ? "Reconnect X before enabling this automation."
            : "Repair and verify this X connection before enabling this automation.",
        );
      }
    }
    const { data: updatedAutomation, error } = await (supabaseAdmin as any)
      .from("twitter_dm_automations")
      .update({ enabled: data.enabled })
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error || !updatedAutomation) throw new Error("Automation not found.");
    return dashboard(context.userId);
  });

export const deleteTwitterAutoDmAutomation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: deletedAutomation, error } = await (supabaseAdmin as any)
      .from("twitter_dm_automations")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error || !deletedAutomation) throw new Error("Automation not found.");
    return dashboard(context.userId);
  });

export const enableTwitterAutoDmDelivery = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ connectionId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await requireAutoDm(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "twitter-auto-dm-subscribe",
      context.userId,
    );
    const connection = (await ownedConnections(context.userId)).find(
      (item) => item.id === data.connectionId,
    );
    if (!connection) throw new Error("X connection not found.");
    if (connection.reauth_required || !scopeReady(connection.scopes)) {
      throw new Error("Reconnect X to approve Direct Message access.");
    }
    await refreshTwitterAutoDmHealth(connection);
    return dashboard(context.userId);
  });

export const preflightTwitterAutoDmAutomation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await requireAutoDm(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "twitter-auto-dm-preflight",
      context.userId,
    );
    const { data: automation, error: automationError } = await (supabaseAdmin as any)
      .from("twitter_dm_automations")
      .select("*")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (automationError || !automation) throw new Error("Automation not found.");
    const connection = (await ownedConnections(context.userId)).find(
      (item) => item.id === automation.connection_id,
    );
    if (!connection) throw new Error("The connected X account is unavailable.");
    if (connection.reauth_required || !scopeReady(connection.scopes)) {
      throw new Error("Reconnect X to approve Direct Message access.");
    }
    const verification = await refreshTwitterAutoDmHealth(connection);
    return {
      dashboard: await dashboard(context.userId),
      checks: {
        officialApiAccess: true,
        requiredPermissions: true,
        connectionHealthy: true,
        verifiedAt: verification.verifiedAt,
      },
    };
  });
