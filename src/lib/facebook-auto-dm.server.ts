/* eslint-disable @typescript-eslint/no-explicit-any -- Meta payloads and newly migrated service tables are normalized at the boundary. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptServerSecret } from "./secret-crypto.server";
import {
  extractFacebookEmailAddress,
  getFacebookConnectionReadiness,
  FACEBOOK_AUTO_DM_WEBHOOK_FIELDS,
  matchFacebookAutomation,
  parseFacebookWebhook,
  type FacebookWebhookEvent,
  type MatchableFacebookAutomation,
} from "./facebook-auto-dm";
export { FACEBOOK_AUTO_DM_WEBHOOK_FIELDS } from "./facebook-auto-dm";
import {
  isRetryableMetaResponse,
  MetaDeliveryError,
  parseMetaRetryAfterSeconds,
} from "./instagram-auto-dm.server";
import {
  readRequestText,
  readResponseText,
  RequestBodyTooLargeError,
} from "./request-security.server";
import { getPlan } from "./plan.server";
import { planHasEntitlement } from "./plans";
import { captureServerEvent, captureServerException } from "./posthog.server";

const encoder = new TextEncoder();
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const META_PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const META_CONVERSATION_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const FACEBOOK_ACCOUNT_MIN_DELIVERY_INTERVAL_MS = 500;
const META_RATE_LIMIT_CODES = new Set(["4", "17", "32", "429", "613"]);

export type FacebookDmQueueMessage = {
  kind: "facebook_dm_event";
  event: FacebookWebhookEvent;
};

export { MetaDeliveryError };

export function getFacebookDmRetryDelaySeconds(error: unknown, attempts: number) {
  const exponentialDelay = Math.min(3_600, 15 * 2 ** Math.min(Math.max(0, attempts), 8));
  if (
    error instanceof MetaDeliveryError &&
    error.code === "account_paced" &&
    error.retryAfterSeconds
  ) {
    return Math.min(3_600, Math.max(1, error.retryAfterSeconds));
  }
  if (!(error instanceof MetaDeliveryError) || !error.retryAfterSeconds) {
    return exponentialDelay;
  }
  return Math.min(3_600, Math.max(exponentialDelay, error.retryAfterSeconds));
}

export function getFacebookAccountBackoffSeconds(error: unknown) {
  if (!(error instanceof MetaDeliveryError) || !error.retryable) return undefined;
  if (error.code === "account_paced") return undefined;
  if (error.retryAfterSeconds) return Math.min(3_600, Math.max(1, error.retryAfterSeconds));
  return META_RATE_LIMIT_CODES.has(error.code) ? 60 : undefined;
}

function readFacebookDeliveryWaitMs(data: unknown) {
  const candidate = Array.isArray(data)
    ? data[0]?.wait_ms
    : typeof data === "object" && data !== null && "wait_ms" in data
      ? (data as { wait_ms?: unknown }).wait_ms
      : data;
  const waitMs = Number(candidate);
  return Number.isFinite(waitMs) && waitMs > 0 ? Math.ceil(waitMs) : 0;
}

export async function claimFacebookDeliverySlot(connectionId: string) {
  const { data, error } = await (supabaseAdmin as any).rpc("claim_facebook_delivery_slot", {
    p_connection_id: connectionId,
    p_min_interval_ms: FACEBOOK_ACCOUNT_MIN_DELIVERY_INTERVAL_MS,
  });
  if (error) throw new Error("Unable to coordinate Facebook Page delivery.");
  const waitMs = readFacebookDeliveryWaitMs(data);
  if (waitMs > 0) {
    throw new MetaDeliveryError(
      "Another Facebook reply for this Page is already being delivered. Bento will retry.",
      "account_paced",
      true,
      Math.max(1, Math.ceil(waitMs / 1_000)),
    );
  }
}

async function deferFacebookDeliverySlot(connectionId: string, retryAfterSeconds: number) {
  const { error } = await (supabaseAdmin as any).rpc("defer_facebook_delivery_slot", {
    p_connection_id: connectionId,
    p_retry_after_seconds: retryAfterSeconds,
  });
  if (error) throw new Error("Unable to save Facebook provider backoff.");
}

export function facebookMetaErrorNeedsReauth(error: unknown) {
  if (!(error instanceof MetaDeliveryError)) return false;
  return ["10", "102", "190", "200", "2500", "token_decryption_failed"].includes(error.code);
}

export async function decryptFacebookConnectionAccessToken(encryptedToken: string) {
  try {
    return await decryptServerSecret(encryptedToken, "social");
  } catch {
    throw new MetaDeliveryError(
      "Bento could not read the saved Facebook connection. Reconnect this Page.",
      "token_decryption_failed",
      false,
    );
  }
}

export function shouldFailFacebookRunAfterError(
  runStep: "opening" | "confirmation_prompt" | "confirmation" | "email" | null,
  error: unknown,
) {
  if (runStep === "confirmation_prompt" || runStep === "confirmation" || runStep === "email") {
    return true;
  }
  return runStep === "opening" && error instanceof MetaDeliveryError && !error.retryable;
}

function graphVersion() {
  return process.env.META_GRAPH_API_VERSION?.trim() || "v25.0";
}

export function getFacebookAutoDmPolicyWindowFailure(
  event: FacebookWebhookEvent,
  now = Date.now(),
) {
  if (!event.occurredAt) return null;
  const occurredAt = Date.parse(event.occurredAt);
  if (!Number.isFinite(occurredAt)) {
    return {
      code: "invalid_event_time",
      message: "Facebook supplied an invalid event timestamp.",
    };
  }
  const age = Math.max(0, now - occurredAt);
  if (event.eventType === "comment" && age > META_PRIVATE_REPLY_WINDOW_MS) {
    return {
      code: "private_reply_window_expired",
      message: "Meta's seven-day private-reply window has expired.",
    };
  }
  if (event.eventType === "message" && age > META_CONVERSATION_REPLY_WINDOW_MS) {
    return {
      code: "conversation_window_expired",
      message: "Meta's 24-hour conversation-reply window has expired.",
    };
  }
  return null;
}

export function shouldMockFacebookAutoDmProvider() {
  if (process.env.APP_ENV !== "staging") return false;
  const mode =
    process.env.FACEBOOK_AUTO_DM_PROVIDER_MODE?.trim().toLowerCase() ||
    process.env.SOCIAL_PROVIDER_MODE?.trim().toLowerCase();
  return mode === "mock";
}

export type FacebookMetaAccessLevel = "testing" | "advanced_access";

export function facebookMetaAccessLevel(): FacebookMetaAccessLevel {
  const value =
    process.env.META_FACEBOOK_ACCESS_LEVEL?.trim().toLowerCase() ||
    process.env.META_INSTAGRAM_ACCESS_LEVEL?.trim().toLowerCase();
  return value === "advanced_access" ? "advanced_access" : "testing";
}

function webhookVerifyToken() {
  const value =
    process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN?.trim() ||
    process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN?.trim();
  if (!value) throw new Error("Facebook webhook verification is not configured.");
  return value;
}

function appSecret() {
  const value =
    process.env.META_FACEBOOK_APP_SECRET?.trim() || process.env.META_INSTAGRAM_APP_SECRET?.trim();
  if (!value) throw new Error("Facebook webhook signing is not configured.");
  return value;
}

function webhookSigningSecrets() {
  const secrets = [
    process.env.META_FACEBOOK_APP_SECRET?.trim(),
    process.env.META_INSTAGRAM_APP_SECRET?.trim(),
  ].filter((value): value is string => Boolean(value));
  const uniqueSecrets = [...new Set(secrets)];
  if (!uniqueSecrets.length) {
    throw new Error("Facebook webhook signing is not configured.");
  }
  return uniqueSecrets;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function hexBytes(value: string) {
  if (!/^[a-f0-9]+$/i.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyFacebookWebhookSignature(rawBody: string, signature: string | null) {
  if (!signature?.startsWith("sha256=")) return false;
  const received = hexBytes(signature.slice(7));
  if (!received || received.byteLength !== 32) return false;
  const body = encoder.encode(rawBody);
  for (const secret of webhookSigningSecrets()) {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
    if (timingSafeEqual(expected, received)) return true;
  }
  return false;
}

async function senderHash(senderId: string | null) {
  if (!senderId) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(senderId)));
  return Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function facebookRunActionSignature(
  runId: string,
  connectionId: string,
  senderIdHash: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const value = `facebook-dm-run:v1:${runId}:${connectionId}:${senderIdHash}`;
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createFacebookRunActionPayload(
  runId: string,
  connectionId: string,
  senderIdHash: string,
) {
  const signature = await facebookRunActionSignature(runId, connectionId, senderIdHash);
  return `bento:fb-run:${runId}:${signature}`;
}

export async function readFacebookRunActionPayload(
  payload: string | null,
  connectionId: string,
  senderIdHash: string | null,
) {
  if (!payload || !senderIdHash) return null;
  const match =
    /^bento:fb-run:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([0-9a-f]{32})$/i.exec(
      payload,
    );
  if (!match) return null;
  const expected = await facebookRunActionSignature(match[1], connectionId, senderIdHash);
  return timingSafeEqual(encoder.encode(expected), encoder.encode(match[2].toLowerCase()))
    ? match[1].toLowerCase()
    : null;
}

export async function handleFacebookWebhookVerification(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token") || "";
  const challenge = url.searchParams.get("hub.challenge") || "";
  if (
    mode !== "subscribe" ||
    challenge.length === 0 ||
    challenge.length > 1024 ||
    !timingSafeEqual(encoder.encode(token), encoder.encode(webhookVerifyToken()))
  ) {
    return new Response("Forbidden", { status: 403 });
  }
  return new Response(challenge, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleFacebookWebhook(
  request: Request,
  queue?: Queue<FacebookDmQueueMessage>,
) {
  try {
    const rawBody = await readRequestText(request, MAX_WEBHOOK_BYTES);
    if (
      !(await verifyFacebookWebhookSignature(rawBody, request.headers.get("x-hub-signature-256")))
    ) {
      return new Response("Invalid signature", { status: 401 });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const events = parseFacebookWebhook(payload);
    if (events.length > 0 && !queue) return new Response("Queue unavailable", { status: 503 });
    if (events.length > 0) {
      for (let offset = 0; offset < events.length; offset += 100) {
        await queue!.sendBatch(
          events
            .slice(offset, offset + 100)
            .map((event) => ({ body: { kind: "facebook_dm_event" as const, event } })),
        );
      }
      const pageIds = Array.from(
        new Set(events.map((event) => event.facebookPageId).filter(Boolean)),
      );
      await Promise.allSettled(
        pageIds.map(async (pageId) => {
          await (supabaseAdmin as any)
            .from("social_connections")
            .update({ last_webhook_at: new Date().toISOString() })
            .eq("provider", "facebook")
            .eq("provider_user_id", pageId);
        }),
      );
    }
    return Response.json({ received: true }, { status: 200 });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return new Response("Payload too large", { status: 413 });
    }
    console.error("[facebook-auto-dm] webhook intake failed", error);
    return new Response("Webhook unavailable", { status: 503 });
  }
}

async function metaRequest(url: string, token: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "bento.surf-facebook-auto-dm",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await readResponseText(response, 256 * 1024);
  let data: any = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  if (!response.ok || data.error) {
    const providerCode = String(data.error?.code || response.status || "meta_error");
    const retryable = isRetryableMetaResponse(response.status, data);
    throw new MetaDeliveryError(
      retryable
        ? "Facebook is temporarily unavailable. Bento will retry."
        : "Facebook rejected this automated reply.",
      providerCode,
      retryable,
      parseMetaRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }
  return data;
}

async function metaFormRequest(url: string, token: string, fields: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "bento.surf-facebook-auto-dm",
    },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await readResponseText(response, 256 * 1024);
  let data: any = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  if (!response.ok || data.error) {
    const providerCode = String(data.error?.code || response.status || "meta_error");
    const retryable = isRetryableMetaResponse(response.status, data);
    throw new MetaDeliveryError(
      retryable
        ? "Facebook is temporarily unavailable. Bento will retry."
        : "Facebook rejected this request.",
      providerCode,
      retryable,
      parseMetaRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }
  return data;
}

async function metaSubscriptionRequest(method: "GET" | "DELETE", url: string, token: string) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "bento.surf-facebook-auto-dm",
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
  if (!response.ok || data.error) {
    const providerCode = String(data.error?.code || response.status || "meta_error");
    throw new MetaDeliveryError(
      "Facebook webhook subscription could not be verified.",
      providerCode,
      isRetryableMetaResponse(response.status, data),
      parseMetaRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }
  return data;
}

export async function getFacebookPageWebhookFields(pageId: string, token: string) {
  const url = `https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(pageId)}/subscribed_apps`;
  const data = await metaSubscriptionRequest("GET", url, token);
  const fields = new Set<string>();
  if (Array.isArray(data.data)) {
    for (const subscription of data.data) {
      if (!subscription || !Array.isArray(subscription.subscribed_fields)) continue;
      for (const field of subscription.subscribed_fields) {
        if (typeof field === "string") fields.add(field);
      }
    }
  }
  return Array.from(fields).sort();
}

export async function verifyFacebookPageWebhooks(pageId: string, token: string) {
  const fields = await getFacebookPageWebhookFields(pageId, token);
  const missingFields = FACEBOOK_AUTO_DM_WEBHOOK_FIELDS.filter((field) => !fields.includes(field));
  return {
    ok: missingFields.length === 0,
    fields,
    missingFields,
  };
}

export async function subscribeFacebookPageWebhooks(pageId: string, token: string) {
  if (shouldMockFacebookAutoDmProvider()) {
    return {
      ok: true,
      fields: [...FACEBOOK_AUTO_DM_WEBHOOK_FIELDS],
      missingFields: [] as string[],
    };
  }
  const url = `https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(pageId)}/subscribed_apps`;
  await metaFormRequest(url, token, {
    subscribed_fields: FACEBOOK_AUTO_DM_WEBHOOK_FIELDS.join(","),
  });
  const verification = await verifyFacebookPageWebhooks(pageId, token);
  if (!verification.ok) {
    throw new MetaDeliveryError(
      `Facebook did not confirm the required webhook fields: ${verification.missingFields.join(", ")}.`,
      "subscription_not_verified",
      false,
    );
  }
  return verification;
}

type FacebookConnectionAuditRow = {
  id: string;
  user_id: string;
  provider_user_id: string;
  access_token: string;
  last_health_check_at: string | null;
};

export async function auditFacebookConnections(now = new Date()) {
  const verificationCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
  const retryCutoff = new Date(now.getTime() - 15 * 60 * 1_000).toISOString();
  const { data, error } = await (supabaseAdmin as any)
    .from("social_connections")
    .select("id, user_id, provider_user_id, access_token, last_health_check_at")
    .eq("provider", "facebook")
    .eq("status", "active")
    .or(`last_verified_at.is.null,last_verified_at.lt.${verificationCutoff}`)
    .or(`last_health_check_at.is.null,last_health_check_at.lt.${retryCutoff}`)
    .order("last_health_check_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .limit(50);
  if (error) throw new Error("Unable to load Facebook connections for health verification.");

  const result = {
    checked: 0,
    healthy: 0,
    repaired: 0,
    actionRequired: 0,
    transientFailures: 0,
  };
  for (const connection of (data || []) as FacebookConnectionAuditRow[]) {
    result.checked += 1;
    const healthCheckedAt = now.toISOString();
    try {
      const token = await decryptFacebookConnectionAccessToken(connection.access_token);
      const verification = await subscribeFacebookPageWebhooks(connection.provider_user_id, token);
      await (supabaseAdmin as any)
        .from("social_connections")
        .update({
          connection_health: "healthy",
          webhook_fields: verification.fields,
          last_verified_at: healthCheckedAt,
          last_health_check_at: healthCheckedAt,
          reauth_required: false,
          provider_error_code: null,
          last_error: null,
        })
        .eq("id", connection.id);
      result.healthy += 1;
      result.repaired += 1;
    } catch (caught) {
      const deliveryError = caught instanceof MetaDeliveryError ? caught : null;
      if (deliveryError?.retryable) {
        result.transientFailures += 1;
        await (supabaseAdmin as any)
          .from("social_connections")
          .update({ last_health_check_at: healthCheckedAt })
          .eq("id", connection.id);
        continue;
      }
      const reauthRequired = facebookMetaErrorNeedsReauth(caught);
      await (supabaseAdmin as any)
        .from("social_connections")
        .update({
          connection_health: "action_required",
          webhook_fields: [],
          last_health_check_at: healthCheckedAt,
          reauth_required: reauthRequired,
          provider_error_code: deliveryError?.code || "health_check_failed",
          last_error: reauthRequired
            ? "Facebook access expired or was revoked. Reconnect this Page."
            : "Facebook webhook verification failed.",
        })
        .eq("id", connection.id);
      result.actionRequired += 1;
    }
  }
  return result;
}

async function sendPrivateReply(
  connection: { provider_user_id: string; access_token: string },
  event: FacebookWebhookEvent,
  automation: {
    opening_message?: string | null;
    confirmation_button_label?: string | null;
    reply_message: string;
    reply_button_label?: string | null;
    reply_button_url?: string | null;
  },
  options: {
    final?: boolean;
    confirmationPayload?: string | null;
  } = {},
) {
  const final = options.final === true;
  if (shouldMockFacebookAutoDmProvider()) {
    return { message_id: `staging-dm-${event.sourceId}`, recipient_id: "staging-recipient" };
  }
  const token = await decryptFacebookConnectionAccessToken(connection.access_token);
  const url = `https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(connection.provider_user_id)}/messages`;
  const recipient =
    event.eventType === "comment" && !final
      ? { comment_id: event.sourceId }
      : { id: event.senderId };
  const usesOpeningStep =
    !final && automation.opening_message && automation.confirmation_button_label;
  let message: Record<string, unknown>;
  if (usesOpeningStep) {
    if (!options.confirmationPayload) {
      throw new MetaDeliveryError(
        "Facebook confirmation state could not be created.",
        "confirmation_state_missing",
        false,
      );
    }
    message = {
      text: `${automation.opening_message}\n\nTap ${automation.confirmation_button_label} below, or reply ${automation.confirmation_button_label}.`,
      quick_replies: [
        {
          content_type: "text",
          title: automation.confirmation_button_label,
          payload: options.confirmationPayload,
        },
      ],
    };
  } else if (
    automation.reply_button_label &&
    automation.reply_button_url &&
    event.eventType !== "comment"
  ) {
    message = {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: automation.reply_message,
          buttons: [
            {
              type: "web_url",
              url: automation.reply_button_url,
              title: automation.reply_button_label,
            },
          ],
        },
      },
    };
  } else {
    message = {
      text:
        automation.reply_button_url && event.eventType === "comment"
          ? `${automation.reply_message}\n\n${automation.reply_button_url}`
          : automation.reply_message,
    };
  }
  return metaRequest(url, token, {
    recipient,
    ...(event.eventType === "message" || final ? { messaging_type: "RESPONSE" } : {}),
    message,
  });
}

async function sendFacebookTextMessage(
  connection: { provider_user_id: string; access_token: string },
  senderId: string | null,
  text: string,
) {
  if (!senderId) {
    throw new MetaDeliveryError(
      "Facebook did not provide a recipient for this message.",
      "recipient_missing",
      false,
    );
  }
  if (shouldMockFacebookAutoDmProvider()) {
    return { message_id: `staging-dm-${crypto.randomUUID()}`, recipient_id: "staging-recipient" };
  }
  const token = await decryptFacebookConnectionAccessToken(connection.access_token);
  const url = `https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(connection.provider_user_id)}/messages`;
  return metaRequest(url, token, {
    recipient: { id: senderId },
    messaging_type: "RESPONSE",
    message: { text },
  });
}

function emailCapturePrompt(
  automation: {
    email_prompt_message?: string | null;
    email_marketing_consent_enabled?: boolean;
  },
  connectionHandle: string,
) {
  const prompt = automation.email_prompt_message?.trim() || "Reply with your email address.";
  const disclosure = automation.email_marketing_consent_enabled
    ? `By replying, you agree to receive this resource and future emails from ${connectionHandle}. You can unsubscribe anytime.`
    : `Your email will be shared with ${connectionHandle} only to deliver this request, not for marketing.`;
  return `${prompt}\n\n${disclosure}`;
}

async function captureFacebookEmailAudience(input: {
  runId: string;
  email: string;
  senderUsername: string | null;
  marketingConsent: boolean;
}) {
  const { data, error } = await (supabaseAdmin as any).rpc("capture_facebook_dm_email_audience", {
    p_run_id: input.runId,
    p_email: input.email,
    p_sender_username: input.senderUsername,
    p_marketing_consent: input.marketingConsent,
  });
  if (error || !data) throw new Error("Unable to add this Facebook contact to Audience.");
  return String(data);
}

async function sendPublicCommentReply(
  connection: { access_token: string },
  commentId: string,
  message: string,
) {
  if (shouldMockFacebookAutoDmProvider()) {
    return { id: `staging-comment-${commentId}` };
  }
  const token = await decryptFacebookConnectionAccessToken(connection.access_token);
  const url = `https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(commentId)}/comments`;
  return metaRequest(url, token, { message });
}

async function updateEvent(id: string, update: Record<string, unknown>) {
  const { error } = await (supabaseAdmin as any)
    .from("facebook_dm_events")
    .update(update)
    .eq("id", id);
  if (error) throw new Error("Unable to update Facebook automation activity.");
}

async function updateRun(id: string, update: Record<string, unknown>) {
  const { error } = await (supabaseAdmin as any)
    .from("facebook_dm_runs")
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error("Unable to update Facebook automation workflow state.");
}

export async function processFacebookDmQueueMessage(message: FacebookDmQueueMessage) {
  const event = message.event;
  const eventSenderHash = await senderHash(event.senderId);
  const { data: claimed, error: claimError } = await (supabaseAdmin as any).rpc(
    "claim_facebook_dm_event",
    {
      p_external_event_id: event.externalEventId,
      p_facebook_page_id: event.facebookPageId,
      p_event_type: event.eventType,
      p_event_context: event.eventContext,
      p_source_id: event.sourceId,
      p_media_id: event.mediaId,
      p_sender_username: event.senderUsername,
      p_sender_id_hash: eventSenderHash,
      p_occurred_at: event.occurredAt,
    },
  );
  if (claimError) throw new Error("Unable to claim Facebook webhook event.");
  const claim = Array.isArray(claimed) ? claimed[0] : claimed;
  if (!claim?.event_id || !claim.should_process) return { duplicate: true };
  const eventId = claim.event_id as string;
  const policyWindowFailure = getFacebookAutoDmPolicyWindowFailure(event);
  if (policyWindowFailure) {
    await updateEvent(eventId, {
      status: "ignored",
      error_code: policyWindowFailure.code,
      error_message: policyWindowFailure.message,
      processed_at: new Date().toISOString(),
    });
    return { ignored: true };
  }
  let claimedConnectionId: string | null = null;
  let claimedUserId: string | null = null;
  let claimedAutomationId: string | null = null;
  let activeRunId: string | null = null;
  let runStep: "opening" | "confirmation" | "email" | null = null;
  let capturedEmail: string | null = null;

  try {
    const { data: connections, error: connectionError } = await (supabaseAdmin as any)
      .from("social_connections")
      .select(
        "id, provider_user_id, provider_handle, access_token, user_id, status, connection_health, scopes, webhook_fields, token_expires_at, last_verified_at, reauth_required",
      )
      .eq("provider", "facebook")
      .eq("provider_user_id", event.facebookPageId)
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .limit(10);
    if (connectionError) throw new Error("Unable to load the Facebook Page.");
    if (!connections?.length) {
      await updateEvent(eventId, {
        status: "ignored",
        error_code: "connection_missing",
        error_message: "No active Bento connection owns this Facebook Page.",
        processed_at: new Date().toISOString(),
      });
      return { ignored: true };
    }
    const eligibleUserIds = new Set<string>();
    await Promise.all(
      [...new Set<string>(connections.map((connection: any) => String(connection.user_id)))].map(
        async (userId) => {
          if (planHasEntitlement(await getPlan(userId), "facebookAutoDM")) {
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
        error_message: "The creator's plan no longer includes Facebook Auto-DM.",
        processed_at: new Date().toISOString(),
      });
      return { ignored: true };
    }
    const readyConnections = eligibleConnections.filter(
      (connection: any) => getFacebookConnectionReadiness(connection).ready,
    );
    if (!readyConnections.length) {
      await updateEvent(eventId, {
        connection_id: eligibleConnections[0].id,
        status: "ignored",
        error_code: "connection_not_ready",
        error_message: "The Facebook connection needs to be repaired or reconnected.",
        processed_at: new Date().toISOString(),
      });
      return { ignored: true };
    }
    if (event.senderId === event.facebookPageId) {
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
      .from("facebook_dm_automations")
      .select("*")
      .in("connection_id", connectionIds)
      .eq("enabled", true)
      .order("created_at", { ascending: true });
    if (automationError) throw new Error("Unable to load Facebook automation rules.");
    let match: ReturnType<typeof matchFacebookAutomation> = null;
    let confirmationFlow = false;
    let emailCaptureFlow = false;
    let emailWorkflowIntercepted = false;
    let actionConnection: any | null = null;
    if (event.eventContext === "dm" && eventSenderHash && !event.actionPayload) {
      const { data: candidateRuns, error: candidateRunError } = await (supabaseAdmin as any)
        .from("facebook_dm_runs")
        .select(
          "id, automation_id, connection_id, status, email_event_id, action_expires_at, created_at",
        )
        .in("connection_id", connectionIds)
        .eq("sender_id_hash", eventSenderHash)
        .in("status", ["awaiting_email", "delivering", "failed"])
        .gt("action_expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(10);
      if (candidateRunError) {
        throw new Error("Unable to load Facebook email workflow state.");
      }
      const candidateRun = (candidateRuns || []).find(
        (run: any) =>
          run.status === "awaiting_email" ||
          (String(run.email_event_id || "") === eventId &&
            (run.status === "failed" || run.status === "delivering")),
      );
      if (candidateRun) {
        emailWorkflowIntercepted = true;
        const selected = (automations || []).find(
          (item: any) => item.id === candidateRun.automation_id && item.email_capture_enabled,
        );
        const candidate = readyConnections.find(
          (item: any) => item.id === candidateRun.connection_id,
        );
        if (!selected || !candidate) {
          await updateRun(String(candidateRun.id), {
            status: "failed",
            error_code: "automation_unavailable",
            error_message: "This email-capture automation is no longer available.",
            processing_started_at: null,
          });
        } else {
          const email = extractFacebookEmailAddress(event.text);
          if (!email) {
            claimedConnectionId = String(candidate.id);
            claimedUserId = String(candidate.user_id);
            claimedAutomationId = String(selected.id);
            await claimFacebookDeliverySlot(claimedConnectionId);
            const response = await sendFacebookTextMessage(
              candidate,
              event.senderId,
              "That doesn’t look like a valid email address. Please reply with an address like name@example.com.",
            );
            await updateEvent(eventId, {
              connection_id: candidate.id,
              automation_id: selected.id,
              status: "sent",
              response_id: String(response.message_id || response.id || "") || null,
              error_code: "invalid_email",
              error_message: null,
              processed_at: new Date().toISOString(),
            });
            await captureServerEvent(String(candidate.user_id), "facebook_auto_dm_email_invalid", {
              automation_id: selected.id,
              connection_id: candidate.id,
              workflow_run_id: candidateRun.id,
            });
            return { sent: true };
          }
          const { data: claimedEmailRun, error: emailRunClaimError } = await (
            supabaseAdmin as any
          ).rpc("claim_facebook_dm_email_run", {
            p_connection_id: candidate.id,
            p_sender_id_hash: eventSenderHash,
            p_email_event_id: eventId,
            p_email: email,
          });
          if (emailRunClaimError) {
            throw new Error("Unable to claim Facebook email workflow state.");
          }
          const emailRunClaim = Array.isArray(claimedEmailRun)
            ? claimedEmailRun[0]
            : claimedEmailRun;
          if (emailRunClaim?.should_process && emailRunClaim.run_id) {
            actionConnection = candidate;
            activeRunId = String(emailRunClaim.run_id);
            runStep = "email";
            match = { automation: selected, matchedKeyword: null };
            emailCaptureFlow = true;
            capturedEmail = email;
          }
        }
      }
    }
    if (!match && event.eventContext === "quick_reply") {
      if (!eventSenderHash) {
        await updateEvent(eventId, {
          connection_id: readyConnections[0].id,
          status: "ignored",
          error_code: "action_sender_missing",
          error_message: "Facebook did not identify the sender for this action.",
          processed_at: new Date().toISOString(),
        });
        return { ignored: true };
      }
      for (const candidate of readyConnections) {
        const runId = await readFacebookRunActionPayload(
          event.actionPayload,
          String(candidate.id),
          eventSenderHash,
        );
        if (!runId) continue;
        const { data: claimedRun, error: runClaimError } = await (supabaseAdmin as any).rpc(
          "claim_facebook_dm_run",
          {
            p_run_id: runId,
            p_connection_id: candidate.id,
            p_sender_id_hash: eventSenderHash,
            p_confirmation_event_id: eventId,
          },
        );
        if (runClaimError) throw new Error("Unable to claim Facebook workflow state.");
        const runClaim = Array.isArray(claimedRun) ? claimedRun[0] : claimedRun;
        if (!runClaim?.should_process || !runClaim.automation_id) continue;
        const selected = (automations || []).find(
          (item: any) => item.id === runClaim.automation_id,
        );
        if (!selected) {
          await updateRun(runId, {
            status: "failed",
            error_code: "automation_unavailable",
            error_message: "This automation was disabled or removed before confirmation.",
            processing_started_at: null,
          });
          break;
        }
        actionConnection = candidate;
        activeRunId = runId;
        runStep = "confirmation";
        match = { automation: selected, matchedKeyword: null };
        confirmationFlow = true;
        break;
      }
    }
    if (
      !match &&
      !emailWorkflowIntercepted &&
      event.eventContext === "dm" &&
      eventSenderHash &&
      !event.actionPayload &&
      event.text.trim()
    ) {
      for (const candidate of readyConnections) {
        const { data: claimedRun, error: runClaimError } = await (supabaseAdmin as any).rpc(
          "claim_facebook_dm_run_for_quick_reply_prompt",
          {
            p_connection_id: candidate.id,
            p_sender_id_hash: eventSenderHash,
            p_confirmation_event_id: eventId,
            p_reply_text: event.text,
          },
        );
        if (runClaimError) throw new Error("Unable to claim Facebook workflow reply.");
        const runClaim = Array.isArray(claimedRun) ? claimedRun[0] : claimedRun;
        if (!runClaim?.should_process || !runClaim.automation_id || !runClaim.run_id) continue;
        const selected = (automations || []).find(
          (item: any) => item.id === runClaim.automation_id,
        );
        if (!selected) {
          await updateRun(String(runClaim.run_id), {
            status: "failed",
            error_code: "automation_unavailable",
            error_message: "This automation was disabled or removed before confirmation.",
            processing_started_at: null,
          });
          break;
        }
        actionConnection = candidate;
        activeRunId = String(runClaim.run_id);
        runStep = "confirmation";
        match = { automation: selected, matchedKeyword: null };
        confirmationFlow = true;
        break;
      }
    }
    if (!match && !emailWorkflowIntercepted) {
      match = matchFacebookAutomation(event, (automations || []) as MatchableFacebookAutomation[]);
    }
    if (!match) {
      await updateEvent(eventId, {
        connection_id: readyConnections[0].id,
        status: "ignored",
        error_code:
          event.eventContext === "quick_reply" || emailWorkflowIntercepted
            ? "invalid_or_expired_action"
            : "no_match",
        error_message: null,
        processed_at: new Date().toISOString(),
      });
      return { ignored: true };
    }
    const automation = match.automation as any;
    const connection =
      actionConnection ||
      readyConnections.find((candidate: any) => candidate.id === automation.connection_id);
    if (!connection) throw new Error("The matching Facebook connection is unavailable.");
    claimedConnectionId = String(connection.id);
    claimedUserId = String(connection.user_id);
    claimedAutomationId = String(automation.id);
    await claimFacebookDeliverySlot(claimedConnectionId);
    const emailPromptFlow = Boolean(confirmationFlow && automation.email_capture_enabled);
    let confirmationPayload: string | null = null;
    const usesOpeningStep = Boolean(
      !confirmationFlow && automation.opening_message && automation.confirmation_button_label,
    );
    if (usesOpeningStep) {
      if (!eventSenderHash) {
        throw new MetaDeliveryError(
          "Facebook did not provide a sender identity for this confirmation flow.",
          "sender_missing",
          false,
        );
      }
      const { data: createdRun, error: createRunError } = await (supabaseAdmin as any).rpc(
        "create_facebook_dm_run",
        {
          p_automation_id: automation.id,
          p_connection_id: connection.id,
          p_user_id: connection.user_id,
          p_trigger_event_id: eventId,
          p_sender_id_hash: eventSenderHash,
          p_sender_username: event.senderUsername,
        },
      );
      if (createRunError || !createdRun) {
        throw new Error("Unable to create Facebook confirmation workflow state.");
      }
      activeRunId = String(createdRun);
      runStep = "opening";
      confirmationPayload = await createFacebookRunActionPayload(
        activeRunId,
        String(connection.id),
        eventSenderHash,
      );
    }

    await updateEvent(eventId, {
      connection_id: connection.id,
      automation_id: automation.id,
      matched_keyword: match.matchedKeyword,
    });
    if (emailCaptureFlow && activeRunId && capturedEmail) {
      await captureFacebookEmailAudience({
        runId: activeRunId,
        email: capturedEmail,
        senderUsername: event.senderUsername,
        marketingConsent: Boolean(automation.email_marketing_consent_enabled),
      });
    }
    const response = emailPromptFlow
      ? await sendFacebookTextMessage(
          connection,
          event.senderId,
          emailCapturePrompt(automation, connection.provider_handle),
        )
      : await sendPrivateReply(connection, event, automation, {
          final: confirmationFlow || emailCaptureFlow,
          confirmationPayload,
        });
    const responseId = String(response.message_id || response.id || "") || null;
    if (activeRunId && runStep === "opening") {
      await updateRun(activeRunId, {
        opening_response_id: responseId,
        error_code: null,
        error_message: null,
      });
    }
    if (activeRunId && runStep === "confirmation") {
      await updateRun(
        activeRunId,
        emailPromptFlow
          ? {
              status: "awaiting_email",
              email_prompt_response_id: responseId,
              processing_started_at: null,
              error_code: null,
              error_message: null,
            }
          : {
              status: "completed",
              final_response_id: responseId,
              processing_started_at: null,
              completed_at: new Date().toISOString(),
              error_code: null,
              error_message: null,
            },
      );
    }
    if (activeRunId && runStep === "email") {
      await updateRun(activeRunId, {
        status: "completed",
        final_response_id: responseId,
        processing_started_at: null,
        completed_at: new Date().toISOString(),
        error_code: null,
        error_message: null,
      });
    }
    let publicReplyId: string | null = null;
    let publicReplyError: string | null = null;
    if (
      event.eventType === "comment" &&
      automation.public_reply_enabled &&
      (automation.public_reply_messages?.length || automation.public_reply_message)
    ) {
      try {
        const replies: string[] = automation.public_reply_messages?.length
          ? automation.public_reply_messages
          : automation.public_reply_message
            ? [automation.public_reply_message]
            : [];
        const replyIndex = replies.length
          ? Array.from(event.sourceId).reduce(
              (sum, character) => sum + character.charCodeAt(0),
              0,
            ) % replies.length
          : 0;
        const publicReply = await sendPublicCommentReply(
          connection,
          event.sourceId,
          replies[replyIndex],
        );
        publicReplyId = String(publicReply.id || "") || null;
      } catch (error) {
        publicReplyError =
          error instanceof Error ? error.message : "Facebook rejected the public reply.";
      }
    }
    await updateEvent(eventId, {
      status: "sent",
      response_id: responseId,
      public_reply_id: publicReplyId,
      error_code: publicReplyError ? "public_reply_failed" : null,
      error_message: publicReplyError,
      processed_at: new Date().toISOString(),
    });
    await captureServerEvent(claimedUserId, "facebook_auto_dm_sent", {
      automation_id: claimedAutomationId,
      connection_id: claimedConnectionId,
      event_context: event.eventContext,
      opening_step: Boolean(automation.opening_message && !confirmationFlow),
      confirmation_step: confirmationFlow,
      email_prompt_step: emailPromptFlow,
      email_captured: emailCaptureFlow,
      marketing_consent: emailCaptureFlow
        ? Boolean(automation.email_marketing_consent_enabled)
        : false,
      workflow_run_id: activeRunId,
      public_reply_attempted: Boolean(
        event.eventType === "comment" && automation.public_reply_enabled,
      ),
      public_reply_succeeded: Boolean(publicReplyId),
    });
    return { sent: true };
  } catch (error) {
    const deliveryError = error instanceof MetaDeliveryError ? error : null;
    const accountBackoffSeconds = getFacebookAccountBackoffSeconds(error);
    if (claimedConnectionId && accountBackoffSeconds) {
      await deferFacebookDeliverySlot(claimedConnectionId, accountBackoffSeconds).catch(
        (backoffError) => {
          console.error("[facebook-auto-dm] failed to persist provider backoff", {
            connectionId: claimedConnectionId,
            retryAfterSeconds: accountBackoffSeconds,
            error: backoffError instanceof Error ? backoffError.message : "Unknown backoff error",
          });
        },
      );
    }
    if (activeRunId) {
      await updateRun(activeRunId, {
        ...(shouldFailFacebookRunAfterError(runStep, error)
          ? { status: "failed", processing_started_at: null }
          : {}),
        error_code: deliveryError?.code || "processing_failed",
        error_message: error instanceof Error ? error.message.slice(0, 500) : "Automation failed.",
      }).catch(() => undefined);
    }
    if (claimedConnectionId && facebookMetaErrorNeedsReauth(error)) {
      await (supabaseAdmin as any)
        .from("social_connections")
        .update({
          connection_health: "action_required",
          webhook_fields: [],
          reauth_required: true,
          provider_error_code: deliveryError?.code || "meta_auth_failed",
          last_error: "Facebook access expired or was revoked. Reconnect this Page.",
        })
        .eq("id", claimedConnectionId);
    }
    await updateEvent(eventId, {
      status: "failed",
      ...(deliveryError && !deliveryError.retryable ? { attempt_count: 9 } : {}),
      error_code: deliveryError?.code || "processing_failed",
      error_message: error instanceof Error ? error.message.slice(0, 500) : "Automation failed.",
      processed_at: new Date().toISOString(),
    }).catch(() => undefined);
    if (claimedUserId) {
      await captureServerEvent(claimedUserId, "facebook_auto_dm_failed", {
        automation_id: claimedAutomationId,
        connection_id: claimedConnectionId,
        event_context: event.eventContext,
        provider_error_code: deliveryError?.code || "processing_failed",
        retryable: deliveryError?.retryable ?? true,
        account_backoff_seconds: accountBackoffSeconds || null,
      });
    }
    await captureServerException(error, "facebook-auto-dm-worker", {
      event_id: eventId,
      event_context: event.eventContext,
      provider_error_code: deliveryError?.code || "processing_failed",
      retryable: deliveryError?.retryable ?? true,
      account_backoff_seconds: accountBackoffSeconds || null,
    });
    if (!deliveryError || deliveryError.retryable) throw error;
    return { failed: true };
  }
}
