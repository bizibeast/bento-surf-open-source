import { configuredAppOrigin } from "@/lib/application-urls";
/* eslint-disable @typescript-eslint/no-explicit-any -- New service-role tables are typed after the migration is deployed. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enforceRequestRateLimit } from "./request-security.server";
import { readResponseText } from "./request-security.server";
import {
  getInstagramConnectionReadiness,
  instagramConnectionReadinessMessage,
  INSTAGRAM_AUTO_DM_REQUIRED_SCOPES,
  INSTAGRAM_INSIGHTS_SCOPE,
  instagramDmAutomationInputSchema,
  type InstagramDmActivity,
  type InstagramDmAutomation,
  type InstagramDmWorkflow,
  type InstagramMedia,
} from "./instagram-auto-dm";
import {
  decryptInstagramConnectionAccessToken,
  instagramMetaAccessLevel,
  instagramMetaErrorNeedsReauth,
  MetaDeliveryError,
  shouldMockInstagramAutoDmProvider,
  subscribeInstagramAccountWebhooks,
} from "./instagram-auto-dm.server";
import { isServerSecretEncryptionKeyValid } from "./secret-crypto.server";
import { requirePlanEntitlement } from "./plan.server";
import { getPlan } from "./plan.server";
import { planHasEntitlement, usesAdvancedAutoDm, type PlanId } from "./plans";

const requireAutoDm = (userId: string) =>
  requirePlanEntitlement(
    userId,
    "instagramAutoDM",
    "Instagram Auto DMs are included with every Bento plan.",
  );

type ConnectionRow = {
  id: string;
  provider_handle: string;
  provider_user_id: string;
  provider_display_name: string | null;
  access_token: string;
  scopes: string[] | null;
  status: string;
  connection_health: string;
  webhook_fields: string[] | null;
  last_verified_at: string | null;
  last_health_check_at: string | null;
  last_error: string | null;
  reauth_required: boolean;
  token_expires_at: string | null;
  metadata: unknown;
};

function scopeReady(scopes: string[] | null | undefined) {
  return INSTAGRAM_AUTO_DM_REQUIRED_SCOPES.every((scope) => scopes?.includes(scope));
}

function connectionReady(connection: ConnectionRow | null | undefined) {
  return getInstagramConnectionReadiness(connection).ready;
}

async function ownedConnections(userId: string): Promise<ConnectionRow[]> {
  const { data, error } = await (supabaseAdmin as any)
    .from("social_connections")
    .select(
      "id, provider_handle, provider_user_id, provider_display_name, access_token, scopes, status, connection_health, webhook_fields, last_verified_at, last_health_check_at, last_error, reauth_required, token_expires_at, metadata",
    )
    .eq("user_id", userId)
    .eq("provider", "instagram")
    .order("created_at", { ascending: true });
  if (error) throw new Error("Unable to load Instagram connections.");
  return (data || []) as ConnectionRow[];
}

async function dashboard(userId: string, plan?: PlanId) {
  const connections = await ownedConnections(userId);
  const connectionIds = connections.map((connection) => connection.id);
  const metaAccessLevel = instagramMetaAccessLevel();
  const [
    resolvedPlan,
    { data: automations, error: automationError },
    { data: events, error: eventError },
    { data: runs, error: runError },
  ] = await Promise.all([
    plan ? Promise.resolve(plan) : getPlan(userId),
    connectionIds.length
      ? (supabaseAdmin as any)
          .from("instagram_dm_automations")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    connectionIds.length
      ? (supabaseAdmin as any)
          .from("instagram_dm_events")
          .select("*, automation:instagram_dm_automations(name)")
          .in("connection_id", connectionIds)
          .neq("status", "ignored")
          .order("created_at", { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [], error: null }),
    connectionIds.length
      ? (supabaseAdmin as any)
          .from("instagram_dm_runs")
          .select(
            "id, automation_id, sender_username, status, captured_email, error_message, created_at, completed_at, automation:instagram_dm_automations(name, email_marketing_consent_enabled)",
          )
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (automationError || eventError || runError) {
    throw new Error("Unable to load Instagram automations.");
  }

  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  return {
    locked: false,
    plan: resolvedPlan,
    metaAccessLevel,
    generalCustomerAccess: metaAccessLevel === "advanced_access",
    webhookUrl: `${configuredAppOrigin(process.env.VITE_APP_URL)}/api/webhooks/instagram`,
    configured: Boolean(
      process.env.META_INSTAGRAM_APP_ID &&
      process.env.META_INSTAGRAM_APP_SECRET &&
      process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN &&
      isServerSecretEncryptionKeyValid(process.env.SOCIAL_CONNECTION_ENCRYPTION_KEY),
    ),
    connections: connections.map((connection) => {
      const readiness = getInstagramConnectionReadiness(connection);
      return {
        ready: readiness.ready,
        needsReconnect: readiness.needsReconnect,
        readinessIssues: readiness.issues,
        readinessMessage: instagramConnectionReadinessMessage(readiness.issues),
        id: connection.id,
        handle: connection.provider_handle,
        displayName: connection.provider_display_name || connection.provider_handle,
        status: connection.status,
        health: connection.connection_health,
        lastVerifiedAt: connection.last_verified_at,
        lastHealthCheckAt: connection.last_health_check_at,
        lastError: connection.last_error,
        webhookFields: connection.webhook_fields || [],
        insightsReady: Boolean(connection.scopes?.includes(INSTAGRAM_INSIGHTS_SCOPE)),
      };
    }),
    automations: (automations || []).map((row: any): InstagramDmAutomation => {
      const connection = byId.get(row.connection_id);
      const readiness = getInstagramConnectionReadiness(connection);
      return {
        id: row.id,
        connectionId: row.connection_id,
        connectionHandle: connection?.provider_handle || "instagram",
        connectionReady: readiness.ready,
        connectionNeedsReconnect: readiness.needsReconnect,
        connectionReadinessMessage: instagramConnectionReadinessMessage(readiness.issues),
        connectionLastVerifiedAt: connection?.last_verified_at || null,
        name: row.name,
        triggerType: row.trigger_type,
        keywords: row.keywords || [],
        excludedKeywords: row.excluded_keywords || [],
        matchType: row.match_type,
        mediaScope: row.media_scope || (row.media_ids?.length ? "specific" : "any"),
        mediaIds: row.media_ids || [],
        replyMessage: row.reply_message,
        publicReplyEnabled: row.public_reply_enabled,
        publicReplyMessages:
          row.public_reply_messages?.length > 0
            ? row.public_reply_messages
            : row.public_reply_message
              ? [row.public_reply_message]
              : [],
        openingMessage: row.opening_message,
        confirmationButtonLabel: row.confirmation_button_label,
        emailCaptureEnabled: row.email_capture_enabled,
        emailPromptMessage: row.email_prompt_message,
        emailMarketingConsentEnabled: row.email_marketing_consent_enabled,
        followGateEnabled: row.follow_gate_enabled,
        followPromptMessage: row.follow_prompt_message,
        followMaxRechecks: row.follow_max_rechecks,
        followFailAction: row.follow_fail_action,
        replyButtonLabel: row.reply_button_label,
        replyButtonUrl: row.reply_button_url,
        enabled: row.enabled,
        createdAt: row.created_at,
      };
    }),
    activity: (events || []).map((row: any): InstagramDmActivity => ({
      id: row.id,
      automationName: row.automation?.name || null,
      eventType: row.event_type,
      eventContext: row.event_context || (row.event_type === "comment" ? "comment" : "dm"),
      senderLabel: row.sender_username ? `@${row.sender_username}` : "Instagram user",
      matchedKeyword: row.matched_keyword,
      status: row.status,
      errorMessage: row.error_message,
      createdAt: row.created_at,
    })),
    workflows: (runs || []).map((row: any): InstagramDmWorkflow => ({
      id: row.id,
      automationName: row.automation?.name || null,
      senderLabel: row.sender_username ? `@${row.sender_username}` : "Instagram user",
      status: row.status,
      emailCaptured: Boolean(row.captured_email),
      marketingConsent: Boolean(
        row.captured_email && row.automation?.email_marketing_consent_enabled,
      ),
      errorMessage: row.error_message,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    })),
  };
}

export const getInstagramAutoDmDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const data = await dashboard(context.userId);
    return {
      ...data,
      locked: !planHasEntitlement(data.plan, "instagramAutoDM"),
      advancedAutoDm: planHasEntitlement(data.plan, "advancedAutoDM"),
    };
  });

export const saveInstagramAutoDmAutomation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => instagramDmAutomationInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const plan = await requireAutoDm(context.userId);
    if (usesAdvancedAutoDm(data) && !planHasEntitlement(plan, "advancedAutoDM")) {
      throw new Error("Advanced Auto DMs are included with the Store plan. Upgrade to continue.");
    }
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "instagram-auto-dm-save",
      context.userId,
    );
    const connections = await ownedConnections(context.userId);
    const connection = connections.find((item) => item.id === data.connectionId);
    if (!connection) throw new Error("Connect this Instagram account first.");
    if (data.enabled && !connectionReady(connection)) {
      throw new Error(
        connection.reauth_required
          ? "Reconnect Instagram to approve comments and messages before enabling this."
          : "Repair and verify this Instagram connection before enabling the automation.",
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
      media_scope: data.mediaScope,
      media_ids: data.mediaIds,
      reply_message: data.replyMessage,
      public_reply_enabled: data.publicReplyEnabled,
      public_reply_message: data.publicReplyMessages[0] || null,
      public_reply_messages: data.publicReplyMessages,
      opening_message: data.openingMessage,
      confirmation_button_label: data.confirmationButtonLabel,
      email_capture_enabled: data.emailCaptureEnabled,
      email_prompt_message: data.emailPromptMessage,
      email_marketing_consent_enabled: data.emailMarketingConsentEnabled,
      follow_gate_enabled: data.followGateEnabled,
      follow_prompt_message: data.followPromptMessage,
      follow_max_rechecks: data.followMaxRechecks,
      follow_fail_action: data.followFailAction,
      reply_button_label: data.replyButtonLabel,
      reply_button_url: data.replyButtonUrl,
      enabled: data.enabled,
    };
    const query = data.id
      ? (supabaseAdmin as any)
          .from("instagram_dm_automations")
          .update(row)
          .eq("id", data.id)
          .eq("user_id", context.userId)
          .select("id")
          .maybeSingle()
      : (supabaseAdmin as any).from("instagram_dm_automations").insert(row);
    const { data: savedAutomation, error } = await query;
    if (error || (data.id && !savedAutomation)) {
      throw new Error(
        data.id
          ? "This Instagram automation no longer exists."
          : "Unable to save this Instagram automation.",
      );
    }
    return dashboard(context.userId);
  });

export const setInstagramAutoDmEnabled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid(), enabled: z.boolean() }).parse(input))
  .handler(async ({ data, context }) => {
    if (data.enabled) {
      await requireAutoDm(context.userId);
      const { data: automation, error: automationError } = await (supabaseAdmin as any)
        .from("instagram_dm_automations")
        .select("connection_id")
        .eq("id", data.id)
        .eq("user_id", context.userId)
        .maybeSingle();
      if (automationError || !automation) throw new Error("Automation not found.");
      const connection = (await ownedConnections(context.userId)).find(
        (item) => item.id === automation.connection_id,
      );
      if (!connectionReady(connection)) {
        throw new Error(
          connection?.reauth_required
            ? "Reconnect Instagram before enabling this automation."
            : "Repair and verify this Instagram connection before enabling this automation.",
        );
      }
    }
    const { data: updatedAutomation, error } = await (supabaseAdmin as any)
      .from("instagram_dm_automations")
      .update({ enabled: data.enabled })
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error || !updatedAutomation) throw new Error("Automation not found.");
    return dashboard(context.userId);
  });

export const deleteInstagramAutoDmAutomation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: deletedAutomation, error } = await (supabaseAdmin as any)
      .from("instagram_dm_automations")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error || !deletedAutomation) throw new Error("Automation not found.");
    return dashboard(context.userId);
  });

export const enableInstagramAutoDmWebhooks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ connectionId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await requireAutoDm(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "instagram-auto-dm-subscribe",
      context.userId,
    );
    const connection = (await ownedConnections(context.userId)).find(
      (item) => item.id === data.connectionId,
    );
    if (!connection) throw new Error("Instagram connection not found.");
    if (connection.reauth_required || !scopeReady(connection.scopes)) {
      throw new Error("Reconnect Instagram to approve comment and message access.");
    }
    const healthCheckedAt = new Date().toISOString();
    try {
      const token = await decryptInstagramConnectionAccessToken(connection.access_token);
      const verification = await subscribeInstagramAccountWebhooks(
        connection.provider_user_id,
        token,
      );
      await (supabaseAdmin as any)
        .from("social_connections")
        .update({
          connection_health: "healthy",
          webhook_fields: verification.fields,
          last_verified_at: healthCheckedAt,
          last_health_check_at: healthCheckedAt,
          reauth_required: false,
          provider_error_code: null,
          metadata: {
            ...(connection.metadata && typeof connection.metadata === "object"
              ? connection.metadata
              : {}),
            auto_dm_webhooks_subscribed_at: new Date().toISOString(),
          },
          last_error: null,
        })
        .eq("id", connection.id)
        .eq("user_id", context.userId);
    } catch (error) {
      const reauthRequired = instagramMetaErrorNeedsReauth(error);
      await (supabaseAdmin as any)
        .from("social_connections")
        .update({
          connection_health: "action_required",
          webhook_fields: [],
          last_verified_at: null,
          last_health_check_at: healthCheckedAt,
          reauth_required: reauthRequired,
          provider_error_code: error instanceof MetaDeliveryError ? error.code : null,
          last_error: reauthRequired
            ? "Instagram permissions expired or were revoked."
            : "Instagram webhook verification failed.",
        })
        .eq("id", connection.id)
        .eq("user_id", context.userId);
      throw new Error(
        reauthRequired
          ? "Instagram needs to be reconnected before Auto-DMs can run."
          : "Meta did not confirm all required webhook fields. Try again in a moment.",
      );
    }
    return dashboard(context.userId);
  });

export const preflightInstagramAutoDmAutomation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await requireAutoDm(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "instagram-auto-dm-preflight",
      context.userId,
    );
    const { data: automation, error: automationError } = await (supabaseAdmin as any)
      .from("instagram_dm_automations")
      .select("*")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (automationError || !automation) throw new Error("Automation not found.");
    const connection = (await ownedConnections(context.userId)).find(
      (item) => item.id === automation.connection_id,
    );
    if (!connection) throw new Error("The connected Instagram account is unavailable.");
    if (connection.reauth_required || !scopeReady(connection.scopes)) {
      throw new Error("Reconnect Instagram to approve comment and message access.");
    }
    if (
      automation.email_capture_enabled &&
      (!automation.opening_message ||
        !automation.confirmation_button_label ||
        !automation.email_prompt_message)
    ) {
      throw new Error("Finish the confirmation and email-capture messages before publishing.");
    }
    const healthCheckedAt = new Date().toISOString();
    try {
      const token = await decryptInstagramConnectionAccessToken(connection.access_token);
      const verification = await subscribeInstagramAccountWebhooks(
        connection.provider_user_id,
        token,
      );
      const verifiedAt = healthCheckedAt;
      const { error: updateError } = await (supabaseAdmin as any)
        .from("social_connections")
        .update({
          connection_health: "healthy",
          webhook_fields: verification.fields,
          last_verified_at: verifiedAt,
          last_health_check_at: healthCheckedAt,
          reauth_required: false,
          provider_error_code: null,
          last_error: null,
        })
        .eq("id", connection.id)
        .eq("user_id", context.userId);
      if (updateError) throw new Error("Unable to store Instagram preflight health.");
      return {
        dashboard: await dashboard(context.userId),
        checks: {
          officialMetaSubscription: true,
          requiredPermissions: true,
          connectionHealthy: true,
          workflowValid: true,
          verifiedAt,
        },
      };
    } catch (error) {
      const reauthRequired = instagramMetaErrorNeedsReauth(error);
      await (supabaseAdmin as any)
        .from("social_connections")
        .update({
          connection_health: "action_required",
          webhook_fields: [],
          last_verified_at: null,
          last_health_check_at: healthCheckedAt,
          reauth_required: reauthRequired,
          provider_error_code: error instanceof MetaDeliveryError ? error.code : null,
          last_error: reauthRequired
            ? "Instagram permissions expired or were revoked."
            : "Instagram webhook preflight failed.",
        })
        .eq("id", connection.id)
        .eq("user_id", context.userId);
      throw new Error(
        reauthRequired
          ? "Reconnect Instagram before publishing this automation."
          : "Meta did not confirm the official webhook subscription.",
      );
    }
  });

export const getInstagramAutoDmMedia = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ connectionId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await requireAutoDm(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "instagram-auto-dm-media",
      context.userId,
    );
    const connection = (await ownedConnections(context.userId)).find(
      (item) => item.id === data.connectionId,
    );
    if (!connection) throw new Error("Instagram connection not found.");
    if (shouldMockInstagramAutoDmProvider()) {
      return Array.from({ length: 9 }, (_, index): InstagramMedia => ({
        id: `staging-media-${index + 1}`,
        caption: `Sample Instagram post ${index + 1}`,
        mediaType: index % 2 ? "VIDEO" : "IMAGE",
        imageUrl: null,
        permalink: `https://www.instagram.com/p/staging-${index + 1}/`,
        timestamp: new Date(Date.now() - index * 86_400_000).toISOString(),
      }));
    }
    const healthCheckedAt = new Date().toISOString();
    try {
      const token = await decryptInstagramConnectionAccessToken(connection.access_token);
      const version = process.env.META_GRAPH_API_VERSION?.trim() || "v25.0";
      const url = new URL(
        `https://graph.instagram.com/${version}/${encodeURIComponent(connection.provider_user_id)}/media`,
      );
      url.searchParams.set(
        "fields",
        "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp",
      );
      url.searchParams.set("limit", "50");
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "bento.surf-auto-dm",
        },
        signal: AbortSignal.timeout(10_000),
      });
      const raw = await readResponseText(response, 512 * 1024);
      let payload: {
        data?: Array<Record<string, unknown>>;
        error?: { code?: string | number; message?: string };
      } = {};
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        payload = {};
      }
      if (!response.ok || !Array.isArray(payload.data)) {
        throw new MetaDeliveryError(
          payload.error?.message || "Instagram posts could not be loaded.",
          String(payload.error?.code || response.status),
          response.status === 429 || response.status >= 500,
        );
      }
      return payload.data.slice(0, 50).flatMap((item): InstagramMedia[] => {
        const id = typeof item.id === "string" ? item.id : "";
        const permalink = typeof item.permalink === "string" ? item.permalink : "";
        if (!id || !permalink) return [];
        return [
          {
            id,
            caption:
              typeof item.caption === "string" ? item.caption.slice(0, 500) : "Instagram post",
            mediaType: typeof item.media_type === "string" ? item.media_type : "IMAGE",
            imageUrl:
              typeof item.thumbnail_url === "string"
                ? item.thumbnail_url
                : typeof item.media_url === "string"
                  ? item.media_url
                  : null,
            permalink,
            timestamp: typeof item.timestamp === "string" ? item.timestamp : null,
          },
        ];
      });
    } catch (error) {
      const reauthRequired = instagramMetaErrorNeedsReauth(error);
      await (supabaseAdmin as any)
        .from("social_connections")
        .update({
          last_health_check_at: healthCheckedAt,
          ...(reauthRequired
            ? {
                connection_health: "action_required",
                webhook_fields: [],
                last_verified_at: null,
                reauth_required: true,
                provider_error_code:
                  error instanceof MetaDeliveryError ? error.code : "media_load_failed",
                last_error:
                  "Instagram access expired or could not be read. Reconnect this account.",
              }
            : {}),
        })
        .eq("id", connection.id)
        .eq("user_id", context.userId);
      throw new Error(
        reauthRequired
          ? "Reconnect Instagram before choosing posts."
          : "Instagram posts could not be loaded. Try again in a moment.",
      );
    }
  });
