import { configuredAppOrigin } from "@/lib/application-urls";
/* eslint-disable @typescript-eslint/no-explicit-any -- New service-role tables are typed after the migration is deployed. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enforceRequestRateLimit, readResponseText } from "./request-security.server";
import {
  FACEBOOK_AUTO_DM_REQUIRED_SCOPES,
  facebookDmAutomationInputSchema,
  facebookConnectionReadinessMessage,
  getFacebookConnectionReadiness,
  type FacebookDmActivity,
  type FacebookDmAutomation,
  type FacebookDmWorkflow,
  type FacebookMedia,
} from "./facebook-auto-dm";
import {
  decryptFacebookConnectionAccessToken,
  facebookMetaAccessLevel,
  facebookMetaErrorNeedsReauth,
  MetaDeliveryError,
  shouldMockFacebookAutoDmProvider,
  subscribeFacebookPageWebhooks,
} from "./facebook-auto-dm.server";
import { isServerSecretEncryptionKeyValid } from "./secret-crypto.server";
import { getPlan, requirePlanEntitlement } from "./plan.server";
import { planHasEntitlement, usesAdvancedAutoDm, type PlanId } from "./plans";

const requireAutoDm = (userId: string) =>
  requirePlanEntitlement(
    userId,
    "facebookAutoDM",
    "Facebook Auto DMs are included with every Bento plan.",
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
  return FACEBOOK_AUTO_DM_REQUIRED_SCOPES.every((scope) => scopes?.includes(scope));
}

function connectionReady(connection: ConnectionRow | null | undefined) {
  return getFacebookConnectionReadiness(connection).ready;
}

async function ownedConnections(userId: string): Promise<ConnectionRow[]> {
  const { data, error } = await (supabaseAdmin as any)
    .from("social_connections")
    .select(
      "id, provider_handle, provider_user_id, provider_display_name, access_token, scopes, status, connection_health, webhook_fields, last_verified_at, last_health_check_at, last_error, reauth_required, token_expires_at, metadata",
    )
    .eq("user_id", userId)
    .eq("provider", "facebook")
    .order("created_at", { ascending: true });
  if (error) throw new Error("Unable to load Facebook connections.");
  return (data || []) as ConnectionRow[];
}

function facebookCredentialsConfigured() {
  return Boolean(
    (process.env.META_FACEBOOK_APP_ID && process.env.META_FACEBOOK_APP_SECRET) ||
    (process.env.META_INSTAGRAM_APP_ID && process.env.META_INSTAGRAM_APP_SECRET),
  );
}

async function dashboard(userId: string, plan?: PlanId) {
  const connections = await ownedConnections(userId);
  const connectionIds = connections.map((connection) => connection.id);
  const metaAccessLevel = facebookMetaAccessLevel();
  const [
    resolvedPlan,
    { data: automations, error: automationError },
    { data: events, error: eventError },
    { data: runs, error: runError },
  ] = await Promise.all([
    plan ? Promise.resolve(plan) : getPlan(userId),
    connectionIds.length
      ? (supabaseAdmin as any)
          .from("facebook_dm_automations")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    connectionIds.length
      ? (supabaseAdmin as any)
          .from("facebook_dm_events")
          .select("*, automation:facebook_dm_automations(name)")
          .in("connection_id", connectionIds)
          .neq("status", "ignored")
          .order("created_at", { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [], error: null }),
    connectionIds.length
      ? (supabaseAdmin as any)
          .from("facebook_dm_runs")
          .select(
            "id, automation_id, sender_username, status, captured_email, error_message, created_at, completed_at, automation:facebook_dm_automations(name, email_marketing_consent_enabled)",
          )
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (automationError || eventError || runError) {
    throw new Error("Unable to load Facebook automations.");
  }

  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  return {
    locked: false,
    plan: resolvedPlan,
    metaAccessLevel,
    generalCustomerAccess: metaAccessLevel === "advanced_access",
    webhookUrl: `${configuredAppOrigin(process.env.VITE_APP_URL)}/api/webhooks/facebook`,
    configured: Boolean(
      facebookCredentialsConfigured() &&
      (process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN || process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN) &&
      isServerSecretEncryptionKeyValid(process.env.SOCIAL_CONNECTION_ENCRYPTION_KEY),
    ),
    connections: connections.map((connection) => {
      const readiness = getFacebookConnectionReadiness(connection);
      return {
        ready: readiness.ready,
        needsReconnect: readiness.needsReconnect,
        readinessIssues: readiness.issues,
        readinessMessage: facebookConnectionReadinessMessage(readiness.issues),
        id: connection.id,
        handle: connection.provider_display_name || connection.provider_handle,
        displayName: connection.provider_display_name || connection.provider_handle,
        status: connection.status,
        health: connection.connection_health,
        lastVerifiedAt: connection.last_verified_at,
        lastHealthCheckAt: connection.last_health_check_at,
        lastError: connection.last_error,
        webhookFields: connection.webhook_fields || [],
      };
    }),
    automations: (automations || []).map((row: any): FacebookDmAutomation => {
      const connection = byId.get(row.connection_id);
      const readiness = getFacebookConnectionReadiness(connection);
      return {
        id: row.id,
        connectionId: row.connection_id,
        connectionHandle:
          connection?.provider_display_name || connection?.provider_handle || "facebook",
        connectionReady: readiness.ready,
        connectionNeedsReconnect: readiness.needsReconnect,
        connectionReadinessMessage: facebookConnectionReadinessMessage(readiness.issues),
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
        replyButtonLabel: row.reply_button_label,
        replyButtonUrl: row.reply_button_url,
        enabled: row.enabled,
        createdAt: row.created_at,
      };
    }),
    activity: (events || []).map((row: any): FacebookDmActivity => ({
      id: row.id,
      automationName: row.automation?.name || null,
      eventType: row.event_type,
      eventContext: row.event_context || (row.event_type === "comment" ? "comment" : "dm"),
      senderLabel: row.sender_username || "Facebook user",
      matchedKeyword: row.matched_keyword,
      status: row.status,
      errorMessage: row.error_message,
      createdAt: row.created_at,
    })),
    workflows: (runs || []).map((row: any): FacebookDmWorkflow => ({
      id: row.id,
      automationName: row.automation?.name || null,
      senderLabel: row.sender_username || "Facebook user",
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

export const getFacebookAutoDmDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const data = await dashboard(context.userId);
    return {
      ...data,
      locked: !planHasEntitlement(data.plan, "facebookAutoDM"),
      advancedAutoDm: planHasEntitlement(data.plan, "advancedAutoDM"),
    };
  });

export const saveFacebookAutoDmAutomation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => facebookDmAutomationInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const plan = await requireAutoDm(context.userId);
    if (usesAdvancedAutoDm(data) && !planHasEntitlement(plan, "advancedAutoDM")) {
      throw new Error("Advanced Auto DMs are included with the Store plan. Upgrade to continue.");
    }
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "facebook-auto-dm-save",
      context.userId,
    );
    const connections = await ownedConnections(context.userId);
    const connection = connections.find((item) => item.id === data.connectionId);
    if (!connection) throw new Error("Connect this Facebook Page first.");
    if (data.enabled && !connectionReady(connection)) {
      throw new Error(
        connection.reauth_required
          ? "Reconnect Facebook to approve comments and messages before enabling this."
          : "Repair and verify this Facebook connection before enabling the automation.",
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
      reply_button_label: data.replyButtonLabel,
      reply_button_url: data.replyButtonUrl,
      enabled: data.enabled,
    };
    const query = data.id
      ? (supabaseAdmin as any)
          .from("facebook_dm_automations")
          .update(row)
          .eq("id", data.id)
          .eq("user_id", context.userId)
          .select("id")
          .maybeSingle()
      : (supabaseAdmin as any).from("facebook_dm_automations").insert(row);
    const { data: savedAutomation, error } = await query;
    if (error || (data.id && !savedAutomation)) {
      throw new Error(
        data.id
          ? "This Facebook automation no longer exists."
          : "Unable to save this Facebook automation.",
      );
    }
    return dashboard(context.userId);
  });

export const setFacebookAutoDmEnabled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid(), enabled: z.boolean() }).parse(input))
  .handler(async ({ data, context }) => {
    if (data.enabled) {
      await requireAutoDm(context.userId);
      const { data: automation, error: automationError } = await (supabaseAdmin as any)
        .from("facebook_dm_automations")
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
            ? "Reconnect Facebook before enabling this automation."
            : "Repair and verify this Facebook connection before enabling this automation.",
        );
      }
    }
    const { data: updatedAutomation, error } = await (supabaseAdmin as any)
      .from("facebook_dm_automations")
      .update({ enabled: data.enabled })
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error || !updatedAutomation) throw new Error("Automation not found.");
    return dashboard(context.userId);
  });

export const deleteFacebookAutoDmAutomation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: deletedAutomation, error } = await (supabaseAdmin as any)
      .from("facebook_dm_automations")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error || !deletedAutomation) throw new Error("Automation not found.");
    return dashboard(context.userId);
  });

async function markConnectionHealthy(connection: ConnectionRow, userId: string, fields: string[]) {
  const healthCheckedAt = new Date().toISOString();
  await (supabaseAdmin as any)
    .from("social_connections")
    .update({
      connection_health: "healthy",
      webhook_fields: fields,
      last_verified_at: healthCheckedAt,
      last_health_check_at: healthCheckedAt,
      reauth_required: false,
      provider_error_code: null,
      last_error: null,
    })
    .eq("id", connection.id)
    .eq("user_id", userId);
  return healthCheckedAt;
}

async function markConnectionFailed(
  connection: ConnectionRow,
  userId: string,
  error: unknown,
  lastError: string,
) {
  const healthCheckedAt = new Date().toISOString();
  const reauthRequired = facebookMetaErrorNeedsReauth(error);
  await (supabaseAdmin as any)
    .from("social_connections")
    .update({
      connection_health: "action_required",
      webhook_fields: [],
      last_verified_at: null,
      last_health_check_at: healthCheckedAt,
      reauth_required: reauthRequired,
      provider_error_code: error instanceof MetaDeliveryError ? error.code : null,
      last_error: reauthRequired ? "Facebook permissions expired or were revoked." : lastError,
    })
    .eq("id", connection.id)
    .eq("user_id", userId);
  return reauthRequired;
}

export const enableFacebookAutoDmWebhooks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ connectionId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await requireAutoDm(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "facebook-auto-dm-subscribe",
      context.userId,
    );
    const connection = (await ownedConnections(context.userId)).find(
      (item) => item.id === data.connectionId,
    );
    if (!connection) throw new Error("Facebook connection not found.");
    if (connection.reauth_required || !scopeReady(connection.scopes)) {
      throw new Error("Reconnect Facebook to approve comment and message access.");
    }
    try {
      const token = await decryptFacebookConnectionAccessToken(connection.access_token);
      const verification = await subscribeFacebookPageWebhooks(connection.provider_user_id, token);
      await markConnectionHealthy(connection, context.userId, verification.fields);
    } catch (error) {
      const reauthRequired = await markConnectionFailed(
        connection,
        context.userId,
        error,
        "Facebook webhook verification failed.",
      );
      throw new Error(
        reauthRequired
          ? "Facebook needs to be reconnected before Auto-DMs can run."
          : "Meta did not confirm all required webhook fields. Try again in a moment.",
      );
    }
    return dashboard(context.userId);
  });

export const preflightFacebookAutoDmAutomation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await requireAutoDm(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "facebook-auto-dm-preflight",
      context.userId,
    );
    const { data: automation, error: automationError } = await (supabaseAdmin as any)
      .from("facebook_dm_automations")
      .select("*")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (automationError || !automation) throw new Error("Automation not found.");
    const connection = (await ownedConnections(context.userId)).find(
      (item) => item.id === automation.connection_id,
    );
    if (!connection) throw new Error("The connected Facebook Page is unavailable.");
    if (connection.reauth_required || !scopeReady(connection.scopes)) {
      throw new Error("Reconnect Facebook to approve comment and message access.");
    }
    if (
      automation.email_capture_enabled &&
      (!automation.opening_message ||
        !automation.confirmation_button_label ||
        !automation.email_prompt_message)
    ) {
      throw new Error("Finish the confirmation and email-capture messages before publishing.");
    }
    try {
      const token = await decryptFacebookConnectionAccessToken(connection.access_token);
      const verification = await subscribeFacebookPageWebhooks(connection.provider_user_id, token);
      const verifiedAt = await markConnectionHealthy(
        connection,
        context.userId,
        verification.fields,
      );
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
      const reauthRequired = await markConnectionFailed(
        connection,
        context.userId,
        error,
        "Facebook webhook preflight failed.",
      );
      throw new Error(
        reauthRequired
          ? "Reconnect Facebook before publishing this automation."
          : "Meta did not confirm the official webhook subscription.",
      );
    }
  });

export const getFacebookAutoDmMedia = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ connectionId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await requireAutoDm(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "facebook-auto-dm-media",
      context.userId,
    );
    const connection = (await ownedConnections(context.userId)).find(
      (item) => item.id === data.connectionId,
    );
    if (!connection) throw new Error("Facebook connection not found.");
    if (shouldMockFacebookAutoDmProvider()) {
      return Array.from({ length: 9 }, (_, index): FacebookMedia => ({
        id: `staging-post-${index + 1}`,
        caption: `Sample Facebook post ${index + 1}`,
        mediaType: index % 2 ? "VIDEO" : "PHOTO",
        imageUrl: null,
        permalink: `https://www.facebook.com/staging-${index + 1}`,
        timestamp: new Date(Date.now() - index * 86_400_000).toISOString(),
      }));
    }
    const healthCheckedAt = new Date().toISOString();
    try {
      const token = await decryptFacebookConnectionAccessToken(connection.access_token);
      const version = process.env.META_GRAPH_API_VERSION?.trim() || "v25.0";
      const url = new URL(
        `https://graph.facebook.com/${version}/${encodeURIComponent(connection.provider_user_id)}/posts`,
      );
      url.searchParams.set(
        "fields",
        "id,message,full_picture,permalink_url,created_time,status_type",
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
          payload.error?.message || "Facebook posts could not be loaded.",
          String(payload.error?.code || response.status),
          response.status === 429 || response.status >= 500,
        );
      }
      return payload.data.slice(0, 50).flatMap((item): FacebookMedia[] => {
        const id = typeof item.id === "string" ? item.id : "";
        const permalink = typeof item.permalink_url === "string" ? item.permalink_url : "";
        if (!id) return [];
        return [
          {
            id,
            caption:
              typeof item.message === "string" ? item.message.slice(0, 500) : "Facebook post",
            mediaType: typeof item.status_type === "string" ? item.status_type : "PHOTO",
            imageUrl: typeof item.full_picture === "string" ? item.full_picture : null,
            permalink: permalink || `https://www.facebook.com/${id}`,
            timestamp: typeof item.created_time === "string" ? item.created_time : null,
          },
        ];
      });
    } catch (error) {
      const reauthRequired = facebookMetaErrorNeedsReauth(error);
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
                last_error: "Facebook access expired or could not be read. Reconnect this Page.",
              }
            : {}),
        })
        .eq("id", connection.id)
        .eq("user_id", context.userId);
      throw new Error(
        reauthRequired
          ? "Reconnect Facebook before choosing posts."
          : "Facebook posts could not be loaded. Try again in a moment.",
      );
    }
  });
