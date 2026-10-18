import {
  reserveProviderUsage,
  reserveXRead,
  xBackgroundReadsEnabled,
  ProviderBudgetError,
} from "./provider-budget.server";
/* eslint-disable @typescript-eslint/no-explicit-any -- New service-role tables are typed after the migration is deployed. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptServerSecret } from "./secret-crypto.server";
import {
  getTwitterConnectionReadiness,
  matchTwitterAutomation,
  parseTwitterWebhook,
  twitterDmEventFromApi,
  twitterEngagementEvent,
  twitterMentionEventFromApi,
  TWITTER_AUTO_DM_WEBHOOK_FIELDS,
  TWITTER_AUTO_DM_REQUIRED_SCOPES,
  type MatchableTwitterAutomation,
  type TwitterWebhookEvent,
} from "./twitter-auto-dm";
import {
  readRequestText,
  readResponseText,
  RequestBodyTooLargeError,
} from "./request-security.server";
import { hasPlanEntitlement } from "./plan.server";
import { usesAdvancedAutoDm } from "./plans";
import { accessTokenForConnection, ProviderError } from "./social-publisher.server";
import { captureServerException } from "./posthog.server";

const encoder = new TextEncoder();
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const TWITTER_RECONCILE_LOOKBACK_MS = 72 * 60 * 60 * 1_000;
const TWITTER_RECONCILE_OVERLAP_MS = 15 * 60 * 1_000;

export type TwitterDmQueueMessage =
  | { kind: "twitter_dm_event"; event: TwitterWebhookEvent }
  | { kind: "twitter_dm_reconcile"; connectionId: string };

export class TwitterDeliveryError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "TwitterDeliveryError";
  }
}

export function shouldMockTwitterAutoDmProvider() {
  if (process.env.APP_ENV !== "staging") return false;
  const mode =
    process.env.TWITTER_AUTO_DM_PROVIDER_MODE?.trim().toLowerCase() ||
    process.env.SOCIAL_TWITTER_PROVIDER_MODE?.trim().toLowerCase() ||
    process.env.SOCIAL_PROVIDER_MODE?.trim().toLowerCase();
  return mode === "mock";
}

export function twitterAutoDmErrorNeedsReauth(error: unknown) {
  if (error instanceof TwitterDeliveryError) {
    return [
      "32",
      "89",
      "401",
      "invalid_grant",
      "refresh_token_missing",
      "token_revoked",
      "token_decryption_failed",
      "reconnect_required",
    ].includes(error.code);
  }
  if (error instanceof ProviderError) {
    return ["reconnect_required", "refresh_failed", "401"].includes(error.code);
  }
  return false;
}

export function getTwitterDmRetryDelaySeconds(error: unknown, attempts: number) {
  const exponentialDelay = Math.min(3_600, 15 * 2 ** Math.min(Math.max(0, attempts), 8));
  if (error instanceof TwitterDeliveryError && error.retryAfterSeconds) {
    return Math.min(3_600, Math.max(exponentialDelay, error.retryAfterSeconds));
  }
  return exponentialDelay;
}

function clientSecret() {
  const value = process.env.X_CLIENT_SECRET?.trim();
  if (!value) throw new Error("X Auto-DM signing is not configured.");
  return value;
}

function webhookSigningSecret() {
  // Current X v2 CRC supports the OAuth 2.0 secret. Keep OAuth 1.0 only
  // for validating the separate legacy delivery signature header.
  return clientSecret();
}

function webhookUrl() {
  return `${(process.env.VITE_APP_URL?.trim() || "http://localhost:8080").replace(/\/$/, "")}/api/webhooks/twitter`;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function hmacSha256(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function twitterWebhookCrcResponse(crcToken: string) {
  const digest = await hmacSha256(webhookSigningSecret(), crcToken);
  return { response_token: `sha256=${bytesToBase64(digest)}` };
}

export async function handleTwitterWebhookCrc(request: Request) {
  const crcToken = new URL(request.url).searchParams.get("crc_token") || "";
  // X challenges are opaque URL/base64-safe tokens. Reject JSON and whitespace
  // so this public endpoint cannot be used to sign a forged webhook body.
  if (!/^[A-Za-z0-9_+/=-]{1,1024}$/.test(crcToken)) {
    return new Response("Forbidden", { status: 403 });
  }
  try {
    return Response.json(await twitterWebhookCrcResponse(crcToken), {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return new Response("X webhook verification is not configured.", { status: 503 });
  }
}

export async function verifyTwitterWebhookSignature(
  rawBody: string,
  signature: string | null,
  oauth2Signature?: string | null,
) {
  // Never accept a legacy signature when a present OAuth 2.0 signature fails.
  const received = oauth2Signature ?? signature;
  const secret =
    oauth2Signature !== null && oauth2Signature !== undefined
      ? process.env.X_CLIENT_SECRET?.trim()
      : process.env.X_CONSUMER_SECRET?.trim();
  if (!secret || !received?.startsWith("sha256=")) return false;
  const expected = `sha256=${bytesToBase64(await hmacSha256(secret, rawBody))}`;
  return timingSafeEqual(encoder.encode(expected), encoder.encode(received));
}

async function senderHash(senderId: string | null) {
  if (!senderId) return null;
  const digest = await hmacSha256(clientSecret(), senderId);
  return Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function handleTwitterWebhook(request: Request, queue?: Queue<TwitterDmQueueMessage>) {
  try {
    const rawBody = await readRequestText(request, MAX_WEBHOOK_BYTES);
    if (
      !(await verifyTwitterWebhookSignature(
        rawBody,
        request.headers.get("x-twitter-webhooks-signature"),
        request.headers.get("x-twitter-webhooks-signature-oauth2"),
      ))
    ) {
      return new Response("Invalid signature", { status: 401 });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const events = parseTwitterWebhook(payload);
    if (events.length > 0 && !queue) return new Response("Queue unavailable", { status: 503 });
    if (events.length > 0) {
      for (let offset = 0; offset < events.length; offset += 100) {
        await queue!.sendBatch(
          events
            .slice(offset, offset + 100)
            .map((event) => ({ body: { kind: "twitter_dm_event" as const, event } })),
        );
      }
      const accountIds = Array.from(
        new Set(events.map((event) => event.twitterUserId).filter(Boolean)),
      );
      await Promise.allSettled(
        accountIds.map(async (accountId) => {
          await (supabaseAdmin as any)
            .from("social_connections")
            .update({ last_webhook_at: new Date().toISOString() })
            .eq("provider", "twitter")
            .eq("provider_user_id", accountId);
        }),
      );
    }
    return Response.json({ received: true }, { status: 200 });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return new Response("Payload too large", { status: 413 });
    }
    console.error("[twitter-auto-dm] webhook intake failed", error);
    return new Response("Webhook unavailable", { status: 503 });
  }
}

function parseRetryAfterSeconds(value: string | null, now = Date.now()) {
  if (!value) return undefined;
  const numericSeconds = Number(value);
  if (Number.isFinite(numericSeconds) && numericSeconds >= 0) {
    return Math.min(3_600, Math.max(1, Math.ceil(numericSeconds)));
  }
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.min(3_600, Math.max(1, Math.ceil((retryAt - now) / 1_000)));
}

function isRetryableTwitterStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function xRequest(
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<{ status: number; data: any; retryAfterSeconds?: number }> {
  if (!init.method || init.method === "GET") {
    try {
      await reserveXRead(url);
    } catch (error) {
      if (error instanceof ProviderBudgetError)
        throw new TwitterDeliveryError(error.message, "budget_exhausted", false);
      throw error;
    }
  }
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "bento-twitter-auto-dm",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await readResponseText(response, 256 * 1024);
  let data: any = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  return {
    status: response.status,
    data,
    retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after")),
  };
}

function twitterPayloadHasErrors(data: any) {
  const errors = data?.errors;
  if (Array.isArray(errors)) return errors.length > 0;
  return Boolean(errors);
}

export function twitterRequestFailed(status: number, data: any) {
  return status >= 400 || twitterPayloadHasErrors(data);
}

function twitterApiError(status: number, data: any, fallback: string, retryAfterSeconds?: number) {
  const providerCode = String(
    data.errors?.[0]?.code || data.status || data.title || status || "twitter_error",
  );
  const retryable = isRetryableTwitterStatus(status);
  const detail = String(data.detail || data.errors?.[0]?.message || data.title || "").toLowerCase();
  if (status === 402 || detail.includes("payment required") || detail.includes("credits")) {
    return new TwitterDeliveryError(
      "X Pay Per Use needs credits before Auto-DM can read or send Direct Messages.",
      "402",
      false,
      retryAfterSeconds,
    );
  }
  const cannotDm =
    detail.includes("cannot send") ||
    detail.includes("not allowed") ||
    detail.includes("blocked") ||
    status === 403;
  return new TwitterDeliveryError(
    retryable
      ? "X is temporarily unavailable. Bento will retry."
      : cannotDm
        ? "X could not send this DM. The recipient may have DMs closed."
        : fallback,
    providerCode,
    retryable,
    retryAfterSeconds,
  );
}

async function tokenForConnection(connection: any, forceRefresh = false) {
  try {
    connection.provider = "twitter";
    return await accessTokenForConnection(connection, { forceRefresh });
  } catch (error) {
    if (error instanceof ProviderError) {
      throw new TwitterDeliveryError(error.message, error.code, error.retryable);
    }
    throw new TwitterDeliveryError(
      "Bento could not read the saved X connection. Reconnect this account.",
      "token_decryption_failed",
      false,
    );
  }
}

type TwitterVerificationConnection = {
  id: string;
  user_id?: string;
  scopes?: string[] | null;
  provider_user_id: string;
  access_token: string;
  refresh_token?: string | null;
  token_expires_at?: string | null;
};

export function twitterWebhookAppConfigured() {
  return Boolean(
    process.env.X_CLIENT_SECRET?.trim() &&
    (process.env.X_APP_BEARER_TOKEN?.trim() ||
      (process.env.X_CONSUMER_KEY?.trim() && process.env.X_CONSUMER_SECRET?.trim())),
  );
}

function webhookApiError(
  stage: string,
  result: { status: number; data: any; retryAfterSeconds?: number },
  userContext = false,
) {
  const status = result.status;
  const detail = String(result.data?.detail || result.data?.errors?.[0]?.message || "");
  const reason = /crc/i.test(detail)
    ? "X could not validate the callback signature. Check that the webhook credentials belong to the same X app."
    : status === 401
      ? userContext
        ? "X rejected account subscription access even after renewing authorization. Check this app’s Account Activity access and Direct Message permissions."
        : "X rejected Bento's app Bearer Token. Update the server's X_APP_BEARER_TOKEN from the same X app."
      : status === 402
        ? "X requires API credits for this webhook operation. Check the app's access and spending cap in the X Developer Console."
        : status === 403
          ? "X denied webhook or Account Activity access. Check the app's product access and Direct Message permissions in the X Developer Console."
          : isRetryableTwitterStatus(status)
            ? "X is temporarily unavailable. Verification will retry later."
            : "X did not confirm the webhook operation. Check the app's webhook configuration and subscription limits.";
  return new TwitterDeliveryError(
    `${stage}: ${reason} (HTTP ${status})`,
    `webhook_${status}`,
    isRetryableTwitterStatus(status),
    result.retryAfterSeconds,
  );
}

async function webhookRequest(
  url: string,
  token: string,
  init: RequestInit = {},
  userContext = false,
) {
  let result: Awaited<ReturnType<typeof xRequest>>;
  try {
    result = await xRequest(url, token, init);
  } catch (error) {
    if (error instanceof TwitterDeliveryError) throw error;
    throw new TwitterDeliveryError(
      "X webhook verification timed out or could not connect. Try again later.",
      "webhook_network",
      true,
    );
  }
  if (twitterRequestFailed(result.status, result.data)) {
    throw webhookApiError("X webhook verification", result, userContext);
  }
  return result.data;
}

async function appOnlyToken() {
  const configured = process.env.X_APP_BEARER_TOKEN?.trim();
  if (configured) return configured;
  const key = process.env.X_CONSUMER_KEY?.trim();
  const secret = process.env.X_CONSUMER_SECRET?.trim();
  if (!key || !secret) {
    throw new TwitterDeliveryError(
      "Bento's X webhook needs the app Bearer Token. The administrator must set X_APP_BEARER_TOKEN from the same X app as X_CLIENT_ID. Your connected account does not need to be disconnected.",
      "webhook_not_configured",
      false,
    );
  }
  const data = await webhookRequest("https://api.x.com/oauth2/token", "", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${encodeURIComponent(key)}:${encodeURIComponent(secret)}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (data.token_type?.toLowerCase() !== "bearer" || !data.access_token) {
    throw new TwitterDeliveryError(
      "X did not return an app Bearer Token.",
      "webhook_app_token_missing",
      false,
    );
  }
  return String(data.access_token);
}

export async function verifyTwitterWebhookRegistration() {
  if (process.env.APP_ENV === "staging" && process.env.X_WEBHOOK_STAGING_APP_ISOLATED !== "true") {
    throw new TwitterDeliveryError(
      "Live X webhook registration is disabled on staging to preserve the production app’s webhook allowance. Use a separate X developer app and set X_WEBHOOK_STAGING_APP_ISOLATED=true, or use staging mock mode.",
      "webhook_staging_isolation",
      false,
    );
  }
  const appToken = await appOnlyToken();
  const url = webhookUrl();
  const listed = await webhookRequest("https://api.x.com/2/webhooks", appToken);
  if (!Array.isArray(listed.data)) {
    throw new TwitterDeliveryError(
      "X did not return a valid webhook list.",
      "webhook_invalid_response",
      true,
    );
  }
  let webhook = listed.data.find((item: any) => item.url === url);
  if (!webhook) {
    const created = await webhookRequest("https://api.x.com/2/webhooks", appToken, {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    webhook = created.data;
  }
  if (!webhook?.id || !/^\d+$/.test(String(webhook.id))) {
    throw new TwitterDeliveryError(
      "X did not confirm a webhook ID. Auto-DMs remain unverified.",
      "webhook_id_missing",
      false,
    );
  }
  if (webhook.valid !== true) {
    const validated = await webhookRequest(`https://api.x.com/2/webhooks/${webhook.id}`, appToken, {
      method: "PUT",
    });
    if (validated.data?.valid !== true) {
      throw new TwitterDeliveryError(
        "X has not passed the callback verification challenge. Auto-DMs remain unverified.",
        "webhook_crc_failed",
        false,
      );
    }
  }
  return { id: String(webhook.id), verifiedAt: new Date().toISOString() };
}

export async function verifyTwitterAutoDmConnection(connection: TwitterVerificationConnection) {
  if (shouldMockTwitterAutoDmProvider()) {
    return { fields: [...TWITTER_AUTO_DM_WEBHOOK_FIELDS], verifiedAt: new Date().toISOString() };
  }
  // Verification must not fetch paid timelines, profiles, mentions or DM histories.
  const webhook = await verifyTwitterWebhookRegistration();
  let token = await tokenForConnection(connection);
  const url = `https://api.x.com/2/account_activity/webhooks/${webhook.id}/subscriptions/all`;
  let checked = await xRequest(url, token);
  if (checked.status === 401) {
    token = await tokenForConnection(connection, true);
    checked = await xRequest(url, token);
  }
  if (
    !twitterRequestFailed(checked.status, checked.data) &&
    checked.data?.data?.subscribed === true
  ) {
    return { fields: [...TWITTER_AUTO_DM_WEBHOOK_FIELDS], verifiedAt: webhook.verifiedAt };
  }
  // A missing subscription is recoverable. Authentication, access, billing and
  // transient failures must never fall through to another registration attempt.
  if (twitterRequestFailed(checked.status, checked.data) && checked.status !== 404) {
    throw webhookApiError("X account subscription", checked, true);
  }
  if (checked.status !== 404 && checked.data?.data?.subscribed !== false) {
    throw new TwitterDeliveryError(
      "X returned an unrecognized subscription status. Auto-DMs remain unverified.",
      "webhook_invalid_response",
      true,
    );
  }
  if (process.env.X_ACCOUNT_ACTIVITY_ENABLED !== "true") {
    // Existing X Activity subscriptions can deliver DMs without creating a
    // second, legacy Account Activity feed. This is control-plane inspection.
    const activityUrl = `https://api.x.com/2/activity/subscriptions?user_id=${encodeURIComponent(connection.provider_user_id)}&max_results=100`;
    let activity = await xRequest(activityUrl, token);
    if (activity.status === 401) {
      token = await tokenForConnection(connection, true);
      activity = await xRequest(activityUrl, token);
    }
    if (twitterRequestFailed(activity.status, activity.data)) {
      throw webhookApiError("X activity subscriptions", activity, true);
    }
    if (!Array.isArray(activity.data?.data)) {
      throw new TwitterDeliveryError(
        "X did not return a valid Activity subscription list. Auto-DMs remain unverified.",
        "webhook_invalid_response",
        true,
      );
    }
    const fields = new Set<string>();
    for (const subscription of activity.data.data) {
      if (
        String(subscription?.webhook_id) !== webhook.id ||
        String(subscription?.filter?.user_id) !== connection.provider_user_id
      )
        continue;
      const field = {
        "dm.received": "direct_messages",
        "post.mention.create": "mentions",
        "like.create": "likes",
        "post.repost.create": "retweets",
      }[String(subscription?.event_type)] as string | undefined;
      if (field) fields.add(field);
    }
    if (fields.has("direct_messages")) {
      return { fields: [...fields], verifiedAt: webhook.verifiedAt };
    }
    throw new TwitterDeliveryError(
      "The X webhook passed verification, but no DM Received Activity subscription is attached to this account and webhook. Set a hard X Developer Console spending limit before enabling delivery. No paid polling or event feed was started.",
      "webhook_events_disabled",
      false,
    );
  }
  const subscribed = await webhookRequest(url, token, { method: "POST", body: "{}" }, true);
  if (subscribed.data?.subscribed !== true) {
    throw new TwitterDeliveryError(
      "X did not confirm the account subscription. Auto-DMs remain unverified.",
      "webhook_subscription_unconfirmed",
      false,
    );
  }
  return { fields: [...TWITTER_AUTO_DM_WEBHOOK_FIELDS], verifiedAt: webhook.verifiedAt };
}

/** Claim verification separately from OAuth renewal so frequent token refreshes
 * cannot starve the webhook audit. Compare-and-set also protects reconnects. */
export async function refreshTwitterAutoDmHealth(connection: TwitterVerificationConnection) {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + 180_000).toISOString();
  const { data: claimed, error: claimError } = await (supabaseAdmin as any)
    .from("social_connections")
    .update({ twitter_webhook_check_lease_until: leaseUntil })
    .eq("id", connection.id)
    .eq("provider", "twitter")
    .eq("status", "active")
    .eq("reauth_required", false)
    .or(
      `twitter_webhook_check_lease_until.is.null,twitter_webhook_check_lease_until.lt.${now.toISOString()}`,
    )
    .select("id")
    .maybeSingle();
  if (claimError) throw new Error("Unable to start X webhook verification.");
  if (!claimed)
    throw new TwitterDeliveryError(
      "X webhook verification is already running, or the account needs reconnecting.",
      "webhook_check_busy",
      true,
    );
  let verification: Awaited<ReturnType<typeof verifyTwitterAutoDmConnection>> | undefined;
  let failure: unknown;
  try {
    if (!TWITTER_AUTO_DM_REQUIRED_SCOPES.every((scope) => connection.scopes?.includes(scope))) {
      throw new TwitterDeliveryError(
        "Reconnect X and approve Direct Message access before verifying Auto-DMs.",
        "webhook_missing_scope",
        false,
      );
    }
    verification = await verifyTwitterAutoDmConnection(connection);
  } catch (error) {
    failure = error;
  }
  const reauth = failure ? twitterAutoDmErrorNeedsReauth(failure) : false;
  const retryable =
    Boolean(failure) && (!(failure instanceof TwitterDeliveryError) || failure.retryable);
  const message =
    failure instanceof TwitterDeliveryError
      ? failure.message
      : "X webhook verification could not finish. Try again later.";
  const { data: saved, error } = await (supabaseAdmin as any)
    .from("social_connections")
    .update({
      connection_health: verification ? "healthy" : "action_required",
      webhook_fields: verification?.fields || [],
      last_verified_at: verification?.verifiedAt || null,
      last_health_check_at: now.toISOString(),
      last_error: verification ? null : message,
      ...(reauth ? { reauth_required: true } : {}),
      twitter_webhook_check_after: new Date(
        now.getTime() + (retryable ? 30 * 60_000 : 24 * 60 * 60_000),
      ).toISOString(),
      twitter_webhook_check_lease_until: null,
    })
    .eq("id", connection.id)
    .eq("access_token", connection.access_token)
    .eq("status", "active")
    .eq("reauth_required", false)
    .eq("twitter_webhook_check_lease_until", leaseUntil)
    .select("id")
    .maybeSingle();
  if (error || !saved)
    throw new Error("X connection changed during verification. Please recheck it.");
  if (failure) throw failure instanceof TwitterDeliveryError ? failure : new Error(message);
  return verification!;
}

export async function auditTwitterWebhookConnections() {
  // No paid content reads; bounded control-plane checks, at most once per day
  // per account (30 minutes for transient errors). No user/customer messages.
  const { data, error } = await (supabaseAdmin as any)
    .from("social_connections")
    .select("id, user_id, provider_user_id, access_token, refresh_token, token_expires_at, scopes")
    .eq("provider", "twitter")
    .eq("status", "active")
    .eq("reauth_required", false)
    .lte("twitter_webhook_check_after", new Date().toISOString())
    .order("twitter_webhook_check_after", { ascending: true })
    .limit(5);
  if (error) throw new Error("Unable to load X webhook checks.");
  let verified = 0;
  for (const connection of data || []) {
    try {
      await refreshTwitterAutoDmHealth(connection);
      verified += 1;
    } catch {
      // The safe, actionable reason is stored on the owned connection.
    }
  }
  return { checked: data?.length || 0, verified };
}

export async function sendTwitterDm(connection: any, senderId: string | null, text: string) {
  if (!senderId) {
    throw new TwitterDeliveryError(
      "X did not provide a recipient for this message.",
      "recipient_missing",
      false,
    );
  }
  if (shouldMockTwitterAutoDmProvider()) {
    return { id: `staging-dm-${crypto.randomUUID()}` };
  }
  const token = await tokenForConnection(connection);
  await reserveProviderUsage("x_dm_deliveries", 1, { workspaceId: connection.user_id });
  await reserveProviderUsage("x_write_actions", 1, { workspaceId: connection.user_id });
  const result = await xRequest(
    `https://api.x.com/2/dm_conversations/with/${encodeURIComponent(senderId)}/messages`,
    token,
    { method: "POST", body: JSON.stringify({ text }) },
  );
  if (twitterRequestFailed(result.status, result.data)) {
    throw twitterApiError(
      result.status,
      result.data,
      "X rejected this automated reply.",
      result.retryAfterSeconds,
    );
  }
  return {
    id: String(result.data?.data?.dm_event_id || result.data?.data?.id || result.data?.id || ""),
  };
}

async function updateEvent(id: string, update: Record<string, unknown>) {
  const { error } = await (supabaseAdmin as any)
    .from("twitter_dm_events")
    .update(update)
    .eq("id", id);
  if (error) throw new Error("Unable to update X automation activity.");
}

async function collectRecentTweetEngagement({
  token,
  accountId,
  sinceMs,
  wantsLikes,
  wantsRetweets,
}: {
  token: string;
  accountId: string;
  sinceMs: number;
  wantsLikes: boolean;
  wantsRetweets: boolean;
}) {
  const tweetsResult = await xRequest(
    `https://api.x.com/2/users/${encodeURIComponent(accountId)}/tweets?exclude=replies&tweet.fields=created_at,author_id&max_results=10`,
    token,
  );
  if (twitterRequestFailed(tweetsResult.status, tweetsResult.data)) {
    if (isRetryableTwitterStatus(tweetsResult.status)) {
      throw twitterApiError(
        tweetsResult.status,
        tweetsResult.data,
        "X could not load recent posts for Auto-DM.",
        tweetsResult.retryAfterSeconds,
      );
    }
    return [];
  }
  const events: TwitterWebhookEvent[] = [];
  const recentTweets = (tweetsResult.data.data || [])
    .map((tweet: any) => ({
      id: String(tweet.id || ""),
      createdAt: Date.parse(String(tweet.created_at || "")),
    }))
    .filter((tweet: { id: string; createdAt: number }) => tweet.id)
    .filter(
      (tweet: { id: string; createdAt: number }) =>
        !Number.isFinite(tweet.createdAt) || tweet.createdAt >= sinceMs,
    )
    .slice(0, 5);

  for (const tweet of recentTweets) {
    if (wantsLikes) {
      events.push(
        ...(await collectTweetActorEvents({
          token,
          accountId,
          tweetId: tweet.id,
          eventType: "like",
          path: "liking_users",
        })),
      );
    }
    if (wantsRetweets) {
      events.push(
        ...(await collectTweetActorEvents({
          token,
          accountId,
          tweetId: tweet.id,
          eventType: "retweet",
          path: "retweeted_by",
        })),
      );
    }
  }
  return events;
}

async function collectTweetActorEvents({
  token,
  accountId,
  tweetId,
  eventType,
  path,
}: {
  token: string;
  accountId: string;
  tweetId: string;
  eventType: "like" | "retweet";
  path: "liking_users" | "retweeted_by";
}) {
  const result = await xRequest(
    `https://api.x.com/2/tweets/${encodeURIComponent(tweetId)}/${path}?user.fields=username&max_results=100`,
    token,
  );
  if (twitterRequestFailed(result.status, result.data)) {
    if (isRetryableTwitterStatus(result.status)) {
      throw twitterApiError(
        result.status,
        result.data,
        eventType === "like"
          ? "X could not load recent likes for Auto-DM."
          : "X could not load recent reposts for Auto-DM.",
        result.retryAfterSeconds,
      );
    }
    return [];
  }
  return (result.data.data || []).flatMap((user: any) => {
    const event = twitterEngagementEvent({
      eventType,
      tweetId,
      accountId,
      senderId: String(user.id || ""),
      senderUsername: typeof user.username === "string" ? user.username : null,
    });
    return event ? [event] : [];
  });
}

export async function enqueueTwitterDmReconciliations(queue?: Queue<TwitterDmQueueMessage>) {
  if (!queue || !xBackgroundReadsEnabled()) return { claimed: 0, queued: 0 };
  const { data, error } = await (supabaseAdmin as any).rpc("claim_twitter_dm_reconciliations", {
    p_batch_size: 25,
    p_min_interval_seconds: 86400,
  });
  if (error) throw new Error("Unable to claim X missed-event checks.");
  const connectionIds = (Array.isArray(data) ? data : []).flatMap((row: any) =>
    typeof row?.connection_id === "string"
      ? [row.connection_id]
      : typeof row === "string"
        ? [row]
        : [],
  );
  if (!connectionIds.length) return { claimed: 0, queued: 0 };
  for (let offset = 0; offset < connectionIds.length; offset += 100) {
    await queue.sendBatch(
      connectionIds.slice(offset, offset + 100).map((connectionId) => ({
        body: { kind: "twitter_dm_reconcile" as const, connectionId },
      })),
    );
  }
  return { claimed: connectionIds.length, queued: connectionIds.length };
}

async function processTwitterDmReconciliation(
  connectionId: string,
  queue?: Queue<TwitterDmQueueMessage>,
) {
  if (!xBackgroundReadsEnabled()) return { skipped: true, reason: "paid_reads_disabled" };
  if (!queue) throw new Error("X automation queue is unavailable.");
  const { data: connection, error: connectionError } = await (supabaseAdmin as any)
    .from("social_connections")
    .select(
      "id,user_id,provider_user_id,access_token,refresh_token,status,connection_health,scopes,webhook_fields,token_expires_at,last_verified_at,reauth_required,last_twitter_dm_reconcile_completed_at",
    )
    .eq("id", connectionId)
    .eq("provider", "twitter")
    .maybeSingle();
  if (connectionError) throw new Error("Unable to load the X account for reconciliation.");
  if (connection?.status === "active" && connection.refresh_token)
    await tokenForConnection(connection);
  if (!connection || !getTwitterConnectionReadiness(connection).ready) {
    return { skipped: true, reason: "connection_not_ready" };
  }
  if (!(await hasPlanEntitlement(String(connection.user_id), "twitterAutoDM"))) {
    await (supabaseAdmin as any)
      .from("social_connections")
      .update({
        last_twitter_dm_reconcile_completed_at: new Date().toISOString(),
        last_twitter_dm_reconcile_error: "plan_unavailable",
      })
      .eq("id", connectionId);
    return { skipped: true, reason: "plan_unavailable" };
  }

  const { data: automationRows, error: automationError } = await (supabaseAdmin as any)
    .from("twitter_dm_automations")
    .select("id,trigger_type,keywords,excluded_keywords,match_type,created_at,source_post_id")
    .eq("connection_id", connectionId)
    .eq("enabled", true)
    .order("created_at", { ascending: true });
  if (automationError) throw new Error("Unable to load X automations.");
  const automations = (automationRows || []) as Array<
    MatchableTwitterAutomation & { created_at: string }
  >;
  if (!automations.length) {
    await (supabaseAdmin as any)
      .from("social_connections")
      .update({
        last_twitter_dm_reconcile_completed_at: new Date().toISOString(),
        last_twitter_dm_reconcile_error: null,
      })
      .eq("id", connectionId);
    return { scanned: 0, queued: 0 };
  }

  try {
    const token = shouldMockTwitterAutoDmProvider()
      ? "staging-token"
      : await tokenForConnection(connection);
    const now = Date.now();
    const lastCompletedAt = Date.parse(
      typeof connection.last_twitter_dm_reconcile_completed_at === "string"
        ? connection.last_twitter_dm_reconcile_completed_at
        : "",
    );
    const since = new Date(
      Math.max(
        now - TWITTER_RECONCILE_LOOKBACK_MS,
        Number.isFinite(lastCompletedAt)
          ? lastCompletedAt - TWITTER_RECONCILE_OVERLAP_MS
          : Number.NEGATIVE_INFINITY,
      ),
    );
    const events: TwitterWebhookEvent[] = [];
    if (!shouldMockTwitterAutoDmProvider()) {
      const dmResult = await xRequest(
        "https://api.x.com/2/dm_events?event_types=MessageCreate&dm_event.fields=id,text,event_type,sender_id,created_at&expansions=sender_id&user.fields=username&max_results=50",
        token,
      );
      if (twitterRequestFailed(dmResult.status, dmResult.data)) {
        throw twitterApiError(
          dmResult.status,
          dmResult.data,
          "X could not load recent Direct Messages.",
          dmResult.retryAfterSeconds,
        );
      }
      const usersById = new Map<string, { username?: string | null }>(
        (dmResult.data.includes?.users || []).map((user: any) => [
          String(user.id),
          { username: user.username },
        ]),
      );
      for (const item of dmResult.data.data || []) {
        const event = twitterDmEventFromApi(item, connection.provider_user_id, usersById);
        if (!event) continue;
        const occurred = event.occurredAt ? Date.parse(event.occurredAt) : NaN;
        if (Number.isFinite(occurred) && occurred < since.getTime()) continue;
        events.push(event);
      }

      const mentionResult = await xRequest(
        `https://api.x.com/2/users/${encodeURIComponent(connection.provider_user_id)}/mentions?tweet.fields=created_at,author_id,text,referenced_tweets&expansions=author_id&user.fields=username&max_results=50`,
        token,
      );
      if (twitterRequestFailed(mentionResult.status, mentionResult.data)) {
        throw twitterApiError(
          mentionResult.status,
          mentionResult.data,
          "X could not load recent mentions.",
          mentionResult.retryAfterSeconds,
        );
      }
      const mentionUsers = new Map<string, { username?: string | null }>(
        (mentionResult.data.includes?.users || []).map((user: any) => [
          String(user.id),
          { username: user.username },
        ]),
      );
      for (const item of mentionResult.data.data || []) {
        const event = twitterMentionEventFromApi(item, connection.provider_user_id, mentionUsers);
        if (!event) continue;
        const occurred = event.occurredAt ? Date.parse(event.occurredAt) : NaN;
        if (Number.isFinite(occurred) && occurred < since.getTime()) continue;
        events.push(event);
      }

      const wantsLikes = automations.some((automation) => automation.trigger_type === "any_like");
      const wantsRetweets = automations.some(
        (automation) => automation.trigger_type === "any_retweet",
      );
      if (wantsLikes || wantsRetweets) {
        events.push(
          ...(await collectRecentTweetEngagement({
            token,
            accountId: connection.provider_user_id,
            sinceMs: since.getTime(),
            wantsLikes,
            wantsRetweets,
          })),
        );
      }
    }

    if (events.length) {
      for (let offset = 0; offset < events.length; offset += 100) {
        await queue.sendBatch(
          events
            .slice(offset, offset + 100)
            .map((event) => ({ body: { kind: "twitter_dm_event" as const, event } })),
        );
      }
    }
    await (supabaseAdmin as any)
      .from("social_connections")
      .update({
        last_twitter_dm_reconcile_completed_at: new Date().toISOString(),
        last_twitter_dm_reconcile_error: null,
      })
      .eq("id", connectionId);
    return { scanned: events.length, queued: events.length };
  } catch (error) {
    await (supabaseAdmin as any)
      .from("social_connections")
      .update({
        last_twitter_dm_reconcile_error:
          error instanceof Error ? error.message.slice(0, 300) : "reconciliation_failed",
      })
      .eq("id", connectionId);
    throw error;
  }
}

export async function processTwitterDmQueueMessage(
  message: TwitterDmQueueMessage,
  queue?: Queue<TwitterDmQueueMessage>,
) {
  if (message.kind === "twitter_dm_reconcile") {
    return processTwitterDmReconciliation(message.connectionId, queue);
  }
  const event = message.event;
  const eventSenderHash = await senderHash(event.senderId);
  const { data: claimed, error: claimError } = await (supabaseAdmin as any).rpc(
    "claim_twitter_dm_event",
    {
      p_external_event_id: event.externalEventId,
      p_twitter_user_id: event.twitterUserId,
      p_event_type: event.eventType,
      p_source_id: event.sourceId,
      p_sender_username: event.senderUsername,
      p_sender_id_hash: eventSenderHash,
      p_occurred_at: event.occurredAt,
    },
  );
  if (claimError) throw new Error("Unable to claim X webhook event.");
  const claim = Array.isArray(claimed) ? claimed[0] : claimed;
  if (!claim?.event_id || !claim.should_process) return { duplicate: true };
  const eventId = claim.event_id as string;

  try {
    const { data: connections, error: connectionError } = await (supabaseAdmin as any)
      .from("social_connections")
      .select(
        "id, provider_user_id, provider_handle, access_token, refresh_token, user_id, status, connection_health, scopes, webhook_fields, token_expires_at, last_verified_at, reauth_required",
      )
      .eq("provider", "twitter")
      .eq("provider_user_id", event.twitterUserId)
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .limit(10);
    if (connectionError) throw new Error("Unable to load the X account.");
    if (!connections?.length) {
      await updateEvent(eventId, {
        status: "ignored",
        error_code: "connection_missing",
        error_message: "No active Bento connection owns this X account.",
        processed_at: new Date().toISOString(),
      });
      return { ignored: true };
    }
    const eligibleUserIds = new Set<string>();
    await Promise.all(
      [...new Set<string>(connections.map((connection: any) => String(connection.user_id)))].map(
        async (userId) => {
          if (await hasPlanEntitlement(userId, "twitterAutoDM")) {
            eligibleUserIds.add(userId);
          }
        },
      ),
    );
    const eligibleConnections = connections.filter((connection: any) =>
      eligibleUserIds.has(String(connection.user_id)),
    );
    if (!eligibleConnections.length) {
      await updateEvent(eventId, {
        connection_id: connections[0].id,
        status: "ignored",
        error_code: "plan_unavailable",
        error_message: "The creator's plan no longer includes X Auto-DM.",
        processed_at: new Date().toISOString(),
      });
      return { ignored: true };
    }
    for (const connection of eligibleConnections) {
      if (connection.refresh_token) await tokenForConnection(connection);
    }
    const readyConnections = eligibleConnections.filter(
      (connection: any) => getTwitterConnectionReadiness(connection).ready,
    );
    if (!readyConnections.length) {
      await updateEvent(eventId, {
        connection_id: eligibleConnections[0].id,
        status: "ignored",
        error_code: "connection_not_ready",
        error_message: "The X connection needs to be repaired or reconnected.",
        processed_at: new Date().toISOString(),
      });
      return { ignored: true };
    }
    if (event.senderId && event.senderId === event.twitterUserId) {
      await updateEvent(eventId, {
        connection_id: readyConnections[0].id,
        status: "ignored",
        error_code: "self_event",
        error_message: null,
        processed_at: new Date().toISOString(),
      });
      return { ignored: true };
    }

    const connectionIds = readyConnections.map((connection: any) => connection.id);
    const { data: automations, error: automationError } = await (supabaseAdmin as any)
      .from("twitter_dm_automations")
      .select("*")
      .in("connection_id", connectionIds)
      .eq("enabled", true)
      .order("created_at", { ascending: true });
    if (automationError) throw new Error("Unable to load X automation rules.");
    const rules = (automations || []) as Array<
      MatchableTwitterAutomation & { connection_id: string; reply_message: string }
    >;
    const match = matchTwitterAutomation(event, rules);
    if (!match) {
      await updateEvent(eventId, {
        connection_id: readyConnections[0].id,
        status: "ignored",
        error_code: "no_match",
        error_message: null,
        processed_at: new Date().toISOString(),
      });
      return { ignored: true };
    }
    const connection = readyConnections.find(
      (item: any) => item.id === match.automation.connection_id,
    );
    if (!connection) {
      await updateEvent(eventId, {
        status: "ignored",
        error_code: "connection_missing",
        processed_at: new Date().toISOString(),
      });
      return { ignored: true };
    }
    if (
      !(await hasPlanEntitlement(String(connection.user_id), "twitterAutoDM")) ||
      (usesAdvancedAutoDm({ excludedKeywords: match.automation.excluded_keywords }) &&
        !(await hasPlanEntitlement(String(connection.user_id), "advancedAutoDM")))
    ) {
      await updateEvent(eventId, {
        status: "ignored",
        error_code: "plan_unavailable",
        processed_at: new Date().toISOString(),
      });
      return { ignored: true };
    }
    const response = await sendTwitterDm(
      connection,
      event.senderId,
      match.automation.reply_message,
    );
    await updateEvent(eventId, {
      connection_id: connection.id,
      automation_id: match.automation.id,
      matched_keyword: match.matchedKeyword,
      status: "sent",
      response_id: response.id || null,
      processed_at: new Date().toISOString(),
    });
    return { sent: true };
  } catch (error) {
    const retryable =
      error instanceof TwitterDeliveryError ? error.retryable : error instanceof ProviderError;
    await updateEvent(eventId, {
      status: retryable ? "failed" : "failed",
      error_code:
        error instanceof TwitterDeliveryError
          ? error.code
          : error instanceof ProviderError
            ? error.code
            : "delivery_failed",
      error_message: error instanceof Error ? error.message.slice(0, 300) : "Delivery failed.",
      processed_at: retryable ? null : new Date().toISOString(),
    });
    if (retryable) throw error;
    await captureServerException(error, "bento-twitter-auto-dm", {
      surface: "twitter_auto_dm_delivery",
      eventId,
    });
    return { failed: true };
  }
}

export async function decryptTwitterConnectionAccessToken(encryptedToken: string) {
  try {
    return await decryptServerSecret(encryptedToken, "social");
  } catch {
    throw new TwitterDeliveryError(
      "Bento could not read the saved X connection. Reconnect this account.",
      "token_decryption_failed",
      false,
    );
  }
}
