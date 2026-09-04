import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enforceRequestRateLimit, readResponseText } from "@/lib/request-security.server";
import { configuredAppOrigin } from "@/lib/application-urls";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  decryptServerSecret,
  encryptServerSecret,
  isServerSecretEncryptionKeyValid,
} from "@/lib/secret-crypto.server";
import {
  instagramMetaErrorNeedsReauth,
  fetchInstagramAccountProfile,
  MetaDeliveryError,
  subscribeInstagramAccountWebhooks,
  unsubscribeInstagramAccountWebhooks,
} from "@/lib/instagram-auto-dm.server";
import { instagramOAuthFailureMessage } from "@/lib/instagram-oauth-errors";
import { requirePlanEntitlement } from "@/lib/plan.server";
import { durableSocialAvatarUrl } from "@/lib/social-avatar.server";
import {
  getInstagramConnectionReadiness,
  INSTAGRAM_AUTO_DM_REQUIRED_SCOPES,
  INSTAGRAM_INSIGHTS_SCOPE,
} from "@/lib/instagram-auto-dm";

export type InstagramConnection = {
  id: string;
  handle: string;
  providerUserId: string;
  pageName: string | null;
  connectedAt: string;
  health: string;
  ready: boolean;
  lastVerifiedAt: string | null;
  lastHealthCheckAt: string | null;
  lastError: string | null;
};

const instagramConnectionIntentSchema = z.enum(["auto_dm", "scheduler"]);
type InstagramConnectionIntent = z.infer<typeof instagramConnectionIntentSchema>;

// One Instagram OAuth session unlocks the whole Bento ecosystem: Auto-DM,
// Social scheduler publishing, and Insights. Intent is kept only for return
// path / analytics metadata; the requested scopes never differ.
// Insights is deliberately not part of Auto-DM readiness: a read-only Insights
// failure must never stop comment or message automations.
export const INSTAGRAM_CONNECTION_SCOPES = [
  ...INSTAGRAM_AUTO_DM_REQUIRED_SCOPES,
  INSTAGRAM_INSIGHTS_SCOPE,
  "instagram_business_content_publish",
] as const;

export function instagramConnectionScopes(_intent?: InstagramConnectionIntent) {
  return [...INSTAGRAM_CONNECTION_SCOPES];
}

export const instagramRedirectUri = () =>
  process.env.META_INSTAGRAM_REDIRECT_URI?.trim() ||
  `${configuredAppOrigin(process.env.VITE_APP_URL)}/integrations/instagram/callback`;

const metaPayloadSchema = z
  .object({
    access_token: z.string().optional(),
    user_id: z.union([z.string(), z.number()]).optional(),
    id: z.union([z.string(), z.number()]).optional(),
    username: z.string().optional(),
    expires_in: z.number().optional(),
    permissions: z.array(z.string()).optional(),
    error: z
      .object({
        code: z.union([z.string(), z.number()]).optional(),
        type: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type SocialConnectionRow = Pick<
  Database["public"]["Tables"]["social_connections"]["Row"],
  "id" | "provider_user_id" | "provider_handle" | "metadata" | "created_at"
> & {
  connection_health?: string | null;
  last_verified_at?: string | null;
  last_health_check_at?: string | null;
  last_error?: string | null;
  status?: string | null;
  scopes?: string[] | null;
  webhook_fields?: string[] | null;
  token_expires_at?: string | null;
  reauth_required?: boolean | null;
};

function metadataPageName(metadata: Json): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  return typeof metadata.page_name === "string" ? metadata.page_name : null;
}

function metaConfig() {
  const appId = process.env.META_INSTAGRAM_APP_ID?.trim();
  const appSecret = process.env.META_INSTAGRAM_APP_SECRET?.trim();
  if (
    !appId ||
    !appSecret ||
    !isServerSecretEncryptionKeyValid(process.env.SOCIAL_CONNECTION_ENCRYPTION_KEY)
  ) {
    throw new Error("Instagram connections are not configured yet.");
  }
  return { appId, appSecret };
}

async function metaJson(url: URL, stage: string, failureMessage: string) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "bento.surf-instagram-connect" },
    signal: AbortSignal.timeout(10_000),
  });
  const data = metaPayloadSchema.parse(JSON.parse(await readResponseText(response, 256 * 1024)));
  if (!response.ok || data.error) {
    console.warn("Meta connection request failed", {
      stage,
      status: response.status,
      code: data.error?.code,
      type: data.error?.type,
    });
    throw new Error(failureMessage);
  }
  return data;
}

async function metaForm(
  url: string,
  fields: Record<string, string>,
  stage: string,
  failureMessage: string,
) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "bento.surf-instagram-connect",
    },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(10_000),
  });
  const data = metaPayloadSchema.parse(JSON.parse(await readResponseText(response, 256 * 1024)));
  if (!response.ok || data.error) {
    console.warn("Meta connection request failed", {
      stage,
      status: response.status,
      code: data.error?.code,
      type: data.error?.type,
    });
    throw new Error(failureMessage);
  }
  return data;
}

export function missingInstagramConnectionScopes(
  grantedScopes: readonly string[],
  requestedScopes: readonly string[],
) {
  const granted = new Set(grantedScopes);
  return requestedScopes.filter((scope) => !granted.has(scope));
}

export function instagramPermissionFailureMessage(_requestedScopes?: readonly string[]) {
  return "Instagram did not grant all publishing, Auto-DM, and insights permissions. Reconnect from Settings → Integrations and approve every requested permission.";
}

function sanitized(row: SocialConnectionRow): InstagramConnection {
  const readiness = getInstagramConnectionReadiness(row);
  return {
    id: row.id,
    handle: row.provider_handle,
    providerUserId: row.provider_user_id,
    pageName: metadataPageName(row.metadata),
    connectedAt: row.created_at,
    health: row.connection_health || "action_required",
    ready: readiness.ready,
    lastVerifiedAt: row.last_verified_at || null,
    lastHealthCheckAt: row.last_health_check_at || null,
    lastError: row.last_error || null,
  };
}

async function listConnections(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("social_connections" as never)
    .select(
      "id, provider_user_id, provider_handle, metadata, created_at, status, scopes, connection_health, webhook_fields, token_expires_at, last_verified_at, last_health_check_at, last_error, reauth_required" as never,
    )
    .eq("user_id", userId)
    .eq("provider", "instagram")
    .order("created_at", { ascending: true });
  if (error) throw new Error("Unable to read Instagram connections.");
  return ((data ?? []) as unknown as SocialConnectionRow[]).map(sanitized);
}

export const getInstagramConnections = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) => listConnections(context.userId));

export const beginInstagramConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({ intent: instagramConnectionIntentSchema })
      .default({ intent: "scheduler" })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    if (data.intent === "scheduler") {
      await requirePlanEntitlement(
        context.userId,
        "socialConnections",
        "Creator social account connections are included with the Creator plan.",
      );
    }
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "instagram-connect-start",
      context.userId,
    );
    const { appId } = metaConfig();
    const state = crypto.randomUUID();
    const { error } = await supabaseAdmin.from("social_oauth_states").insert({
      id: state,
      user_id: context.userId,
      provider: "instagram",
      metadata: {
        intent: data.intent,
        requested_scopes: instagramConnectionScopes(data.intent),
      },
    });
    if (error) throw new Error("Unable to start the Instagram connection.");

    const url = new URL("https://www.instagram.com/oauth/authorize");
    url.searchParams.set("client_id", appId);
    url.searchParams.set("redirect_uri", instagramRedirectUri());
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", instagramConnectionScopes(data.intent).join(","));
    return { url: url.toString() };
  });

export const completeInstagramConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ code: z.string().min(1).max(2_000), state: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    let completionStage = "rate_limit";
    return (async () => {
      await enforceRequestRateLimit(
        "EXPENSIVE_API_RATE_LIMITER",
        "instagram-connect-complete",
        context.userId,
      );
      completionStage = "configuration";
      const { appId, appSecret } = metaConfig();
      const nowIso = new Date().toISOString();
      completionStage = "oauth_state";
      const { data: oauthState, error: stateError } = await supabaseAdmin
        .from("social_oauth_states")
        .delete()
        .eq("id", data.state)
        .eq("provider", "instagram")
        .eq("user_id", context.userId)
        .gt("expires_at", nowIso)
        .select("id, user_id, expires_at, metadata")
        .maybeSingle();
      if (stateError || !oauthState) {
        throw new Error("This Instagram connection link expired. Please start again.");
      }
      const oauthMetadata =
        oauthState.metadata &&
        typeof oauthState.metadata === "object" &&
        !Array.isArray(oauthState.metadata)
          ? oauthState.metadata
          : {};
      if (
        instagramConnectionIntentSchema.catch("scheduler").parse(oauthMetadata.intent) ===
        "scheduler"
      ) {
        await requirePlanEntitlement(
          context.userId,
          "socialConnections",
          "Creator social account connections are included with the Creator plan.",
        );
      }
      const requestedScopes = z
        .array(z.string().min(1).max(100))
        .max(10)
        .parse(
          Array.isArray(oauthMetadata.requested_scopes)
            ? oauthMetadata.requested_scopes
            : instagramConnectionScopes(),
        );

      completionStage = "short_token_exchange";
      const shortToken = await metaForm(
        "https://api.instagram.com/oauth/access_token",
        {
          client_id: appId,
          client_secret: appSecret,
          grant_type: "authorization_code",
          redirect_uri: instagramRedirectUri(),
          code: data.code,
        },
        "short_token_exchange",
        "Instagram did not return an access token. Please reconnect and try again.",
      );
      if (!shortToken.access_token) {
        throw new Error("Instagram did not return an access token. Please try again.");
      }
      const grantedScopes = shortToken.permissions ?? [];
      const missingScopes = missingInstagramConnectionScopes(grantedScopes, requestedScopes);
      if (missingScopes.length > 0) {
        throw new Error(instagramPermissionFailureMessage(requestedScopes));
      }

      completionStage = "long_token_exchange";
      const longUrl = new URL("https://graph.instagram.com/access_token");
      longUrl.searchParams.set("grant_type", "ig_exchange_token");
      longUrl.searchParams.set("client_secret", appSecret);
      longUrl.searchParams.set("access_token", shortToken.access_token);
      const longToken = await metaJson(
        longUrl,
        "long_token_exchange",
        "Instagram did not return a long-lived access token. Please reconnect and try again.",
      );
      if (!longToken.access_token) {
        throw new Error("Instagram did not return a long-lived access token. Please try again.");
      }

      completionStage = "account_profile";
      const account = await fetchInstagramAccountProfile(longToken.access_token);
      const accountId = String(account.id || shortToken.user_id || "");
      const handle = String(account.username || "").toLowerCase();
      if (!accountId || !handle) throw new Error("Instagram did not return an account profile.");

      completionStage = "permission_verification";

      completionStage = "account_ownership";
      const { data: existingOwner, error: ownerError } = await supabaseAdmin
        .from("social_connections")
        .select("user_id")
        .eq("provider", "instagram")
        .eq("provider_user_id", accountId)
        .neq("user_id", context.userId)
        .maybeSingle();
      if (ownerError) throw new Error("Unable to verify this Instagram account.");
      if (existingOwner) {
        throw new Error(
          "This Instagram account is already connected to another Bento workspace. Disconnect it there first.",
        );
      }

      const { data: creatorInstagramAccounts, error: limitError } = await supabaseAdmin
        .from("social_connections")
        .select("provider_user_id")
        .eq("user_id", context.userId)
        .eq("provider", "instagram");
      if (limitError) throw new Error("Unable to verify the Instagram profile limit.");
      if (
        (creatorInstagramAccounts || []).length >= 2 &&
        !(creatorInstagramAccounts || []).some(
          (connection) => connection.provider_user_id === accountId,
        )
      ) {
        throw new Error("You can connect up to 2 Instagram profiles.");
      }

      completionStage = "token_encryption";
      const encryptedAccessToken = await encryptServerSecret(longToken.access_token, "social");
      const providerAvatarUrl = await durableSocialAvatarUrl({
        userId: context.userId,
        provider: "instagram",
        providerUserId: accountId,
        value: account.profilePictureUrl,
      });
      completionStage = "connection_storage";
      const { error } = await supabaseAdmin.from("social_connections" as never).upsert(
        {
          user_id: context.userId,
          provider: "instagram",
          provider_user_id: accountId,
          provider_handle: handle,
          access_token: encryptedAccessToken,
          token_expires_at: longToken.expires_in
            ? new Date(Date.now() + longToken.expires_in * 1_000).toISOString()
            : null,
          scopes: grantedScopes,
          status: "active",
          connection_health: missingScopes.length > 0 ? "action_required" : "verifying",
          webhook_fields: [],
          last_verified_at: null,
          last_health_check_at: missingScopes.length > 0 ? nowIso : null,
          reauth_required: missingScopes.length > 0,
          provider_error_code: null,
          provider_display_name: handle,
          provider_avatar_url: providerAvatarUrl,
          last_error:
            missingScopes.length > 0
              ? "Instagram did not grant every permission this feature needs."
              : null,
          metadata: {
            connection_intent:
              typeof oauthMetadata.intent === "string" ? oauthMetadata.intent : "auto_dm",
            requested_scopes: requestedScopes,
          },
        } as never,
        { onConflict: "user_id,provider,provider_user_id" } as never,
      );
      if (error) {
        console.warn("Instagram connection storage failed", {
          code: error.code,
          message: error.message,
        });
        // The ownership read above makes the common case friendly, while the
        // partial unique index remains the final authority if two Bento users
        // race to connect the same Instagram account. Surface the same safe
        // recovery path instead of leaking a generic persistence failure.
        if (error.code === "23505") {
          throw new Error(
            "This Instagram account is already connected to another Bento workspace. Disconnect it there first.",
          );
        }
        if (String(error.message || "").includes("up to 2 profiles")) {
          throw new Error("You can connect up to 2 Instagram profiles.");
        }
        throw new Error("Unable to save the Instagram connection.");
      }
      if (missingScopes.length > 0) {
        throw new Error(instagramPermissionFailureMessage(requestedScopes));
      }
      try {
        completionStage = "webhook_subscription";
        const verification = await subscribeInstagramAccountWebhooks(
          accountId,
          longToken.access_token,
        );
        const { error: healthError } = await supabaseAdmin
          .from("social_connections" as never)
          .update({
            scopes: grantedScopes,
            connection_health: "healthy",
            webhook_fields: verification.fields,
            last_verified_at: nowIso,
            last_health_check_at: nowIso,
            reauth_required: false,
            provider_error_code: null,
            last_error: null,
            metadata: {
              connection_intent:
                typeof oauthMetadata.intent === "string" ? oauthMetadata.intent : "auto_dm",
              requested_scopes: requestedScopes,
              auto_dm_webhooks_subscribed_at: new Date().toISOString(),
            },
          } as never)
          .eq("user_id", context.userId)
          .eq("provider", "instagram")
          .eq("provider_user_id", accountId);
        if (healthError) {
          throw new Error("Instagram connected, but Bento could not save the verified state.");
        }
      } catch (subscriptionError) {
        console.warn("Instagram connected, but webhook verification failed", {
          accountId,
          error:
            subscriptionError instanceof Error
              ? subscriptionError.message
              : "Webhook subscription failed",
        });
        await supabaseAdmin
          .from("social_connections" as never)
          .update({
            scopes: instagramMetaErrorNeedsReauth(subscriptionError) ? [] : grantedScopes,
            connection_health: "action_required",
            webhook_fields: [],
            last_verified_at: null,
            last_health_check_at: new Date().toISOString(),
            reauth_required: instagramMetaErrorNeedsReauth(subscriptionError),
            provider_error_code:
              subscriptionError instanceof MetaDeliveryError ? subscriptionError.code : null,
            last_error: "Instagram permissions or webhooks could not be verified.",
          } as never)
          .eq("user_id", context.userId)
          .eq("provider", "instagram")
          .eq("provider_user_id", accountId);
        throw new Error(
          instagramMetaErrorNeedsReauth(subscriptionError)
            ? "Instagram did not grant the permissions Bento needs. Reconnect and approve comments and messages."
            : "Instagram connected, but Meta did not confirm the Auto-DM webhook setup. Try Repair connection.",
        );
      }
      completionStage = "connection_list";
      return { ok: true as const, connections: await listConnections(context.userId) };
    })().catch((error: unknown) => {
      console.warn("Instagram OAuth completion failed", {
        stage: completionStage,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return {
        ok: false as const,
        failureMessage: instagramOAuthFailureMessage({
          failureMessage: error instanceof Error ? error.message : null,
        }),
      };
    });
  });

export const disconnectInstagram = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: rawConnection, error: connectionError } = await supabaseAdmin
      .from("social_connections" as never)
      .select("provider_user_id, access_token" as never)
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .eq("provider", "instagram")
      .maybeSingle();
    if (connectionError) throw new Error("Unable to read the Instagram connection.");
    const connection = rawConnection as unknown as {
      provider_user_id: string;
      access_token: string;
    } | null;
    if (connection) {
      try {
        await unsubscribeInstagramAccountWebhooks(
          connection.provider_user_id,
          await decryptServerSecret(connection.access_token, "social"),
        );
      } catch (error) {
        // Local disconnect must still succeed for revoked/expired tokens. The
        // provider will no longer be usable after the encrypted token is deleted.
        console.warn("Instagram webhook unsubscribe failed during disconnect", {
          connectionId: data.id,
          code: error instanceof MetaDeliveryError ? error.code : undefined,
        });
      }
    }
    const { error } = await supabaseAdmin
      .from("social_connections")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .eq("provider", "instagram");
    if (error) throw new Error("Unable to disconnect Instagram.");
    return { ok: true };
  });
