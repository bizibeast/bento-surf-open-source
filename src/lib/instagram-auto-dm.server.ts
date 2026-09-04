/* eslint-disable @typescript-eslint/no-explicit-any -- Meta payloads and newly migrated service tables are normalized at the boundary. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptServerSecret, encryptServerSecret } from "./secret-crypto.server";
import {
  extractInstagramEmailAddress,
  getInstagramConnectionReadiness,
  INSTAGRAM_AUTO_DM_WEBHOOK_FIELDS,
  matchInstagramAutomation,
  parseInstagramWebhook,
  type InstagramWebhookEvent,
  type MatchableInstagramAutomation,
} from "./instagram-auto-dm";
export { INSTAGRAM_AUTO_DM_WEBHOOK_FIELDS } from "./instagram-auto-dm";
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
const INSTAGRAM_ACCOUNT_MIN_DELIVERY_INTERVAL_MS = 500;
const META_RATE_LIMIT_CODES = new Set(["4", "17", "32", "429", "613"]);
const INSTAGRAM_COMMENT_RECONCILE_LOOKBACK_MS = 72 * 60 * 60 * 1_000;
const INSTAGRAM_COMMENT_RECONCILE_OVERLAP_MS = 15 * 60 * 1_000;
const INSTAGRAM_COMMENT_RECONCILE_MEDIA_LIMIT = 20;
const INSTAGRAM_COMMENT_RECONCILE_PAGE_LIMIT = 2;
const INSTAGRAM_COMMENT_RECONCILE_EVENT_LIMIT = 100;

export type InstagramDmQueueMessage =
  | {
      kind: "instagram_dm_event";
      event: InstagramWebhookEvent;
    }
  | {
      kind: "instagram_comment_reconcile";
      connectionId: string;
    };

export class MetaDeliveryError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "MetaDeliveryError";
  }
}

export function parseMetaRetryAfterSeconds(value: string | null, now = Date.now()) {
  if (!value) return undefined;
  const numericSeconds = Number(value);
  if (Number.isFinite(numericSeconds) && numericSeconds >= 0) {
    return Math.min(3_600, Math.max(1, Math.ceil(numericSeconds)));
  }
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.min(3_600, Math.max(1, Math.ceil((retryAt - now) / 1_000)));
}

export function getInstagramDmRetryDelaySeconds(error: unknown, attempts: number) {
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

export function getInstagramAccountBackoffSeconds(error: unknown) {
  if (!(error instanceof MetaDeliveryError) || !error.retryable) return undefined;
  if (error.code === "account_paced") return undefined;
  if (error.retryAfterSeconds) return Math.min(3_600, Math.max(1, error.retryAfterSeconds));
  return META_RATE_LIMIT_CODES.has(error.code) ? 60 : undefined;
}

function readInstagramDeliveryWaitMs(data: unknown) {
  const candidate = Array.isArray(data)
    ? data[0]?.wait_ms
    : typeof data === "object" && data !== null && "wait_ms" in data
      ? (data as { wait_ms?: unknown }).wait_ms
      : data;
  const waitMs = Number(candidate);
  return Number.isFinite(waitMs) && waitMs > 0 ? Math.ceil(waitMs) : 0;
}

export async function claimInstagramDeliverySlot(connectionId: string) {
  const { data, error } = await (supabaseAdmin as any).rpc("claim_instagram_delivery_slot", {
    p_connection_id: connectionId,
    p_min_interval_ms: INSTAGRAM_ACCOUNT_MIN_DELIVERY_INTERVAL_MS,
  });
  if (error) throw new Error("Unable to coordinate Instagram account delivery.");
  const waitMs = readInstagramDeliveryWaitMs(data);
  if (waitMs > 0) {
    throw new MetaDeliveryError(
      "Another Instagram reply for this account is already being delivered. Bento will retry.",
      "account_paced",
      true,
      Math.max(1, Math.ceil(waitMs / 1_000)),
    );
  }
}

async function deferInstagramDeliverySlot(connectionId: string, retryAfterSeconds: number) {
  const { error } = await (supabaseAdmin as any).rpc("defer_instagram_delivery_slot", {
    p_connection_id: connectionId,
    p_retry_after_seconds: retryAfterSeconds,
  });
  if (error) throw new Error("Unable to save Instagram provider backoff.");
}

export function instagramMetaErrorNeedsReauth(error: unknown) {
  if (!(error instanceof MetaDeliveryError)) return false;
  return ["10", "102", "190", "200", "2500", "token_decryption_failed"].includes(error.code);
}

export async function decryptInstagramConnectionAccessToken(encryptedToken: string) {
  try {
    return await decryptServerSecret(encryptedToken, "social");
  } catch {
    throw new MetaDeliveryError(
      "Bento could not read the saved Instagram connection. Reconnect this account.",
      "token_decryption_failed",
      false,
    );
  }
}

export function isRetryableMetaResponse(status: number, data: unknown) {
  const providerMarkedTransient =
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof data.error === "object" &&
    data.error !== null &&
    "is_transient" in data.error &&
    data.error.is_transient === true;
  return (
    status === 408 || status === 425 || status === 429 || status >= 500 || providerMarkedTransient
  );
}

export function shouldFailInstagramRunAfterError(
  runStep: "opening" | "confirmation_prompt" | "confirmation" | "follow" | "email" | null,
  error: unknown,
) {
  if (
    runStep === "confirmation_prompt" ||
    runStep === "confirmation" ||
    runStep === "follow" ||
    runStep === "email"
  ) {
    return true;
  }
  return runStep === "opening" && error instanceof MetaDeliveryError && !error.retryable;
}

function graphVersion() {
  return process.env.META_GRAPH_API_VERSION?.trim() || "v25.0";
}

export function getInstagramAutoDmPolicyWindowFailure(
  event: InstagramWebhookEvent,
  now = Date.now(),
) {
  if (!event.occurredAt) return null;
  const occurredAt = Date.parse(event.occurredAt);
  if (!Number.isFinite(occurredAt)) {
    return {
      code: "invalid_event_time",
      message: "Instagram supplied an invalid event timestamp.",
    };
  }
  const age = Math.max(0, now - occurredAt);
  if (
    event.eventType === "comment" &&
    event.eventContext !== "live_comment" &&
    age > META_PRIVATE_REPLY_WINDOW_MS
  ) {
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

export function shouldMockInstagramAutoDmProvider() {
  if (process.env.APP_ENV !== "staging") return false;
  const mode =
    process.env.INSTAGRAM_AUTO_DM_PROVIDER_MODE?.trim().toLowerCase() ||
    process.env.SOCIAL_PROVIDER_MODE?.trim().toLowerCase();
  return mode === "mock";
}

export type InstagramMetaAccessLevel = "testing" | "advanced_access";

export function instagramMetaAccessLevel(): InstagramMetaAccessLevel {
  return process.env.META_INSTAGRAM_ACCESS_LEVEL?.trim().toLowerCase() === "advanced_access"
    ? "advanced_access"
    : "testing";
}

function webhookVerifyToken() {
  const value = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN?.trim();
  if (!value) throw new Error("Instagram webhook verification is not configured.");
  return value;
}

function appSecret() {
  const value = process.env.META_INSTAGRAM_APP_SECRET?.trim();
  if (!value) throw new Error("Instagram webhook signing is not configured.");
  return value;
}

function webhookSigningSecrets() {
  const secrets = [
    process.env.META_INSTAGRAM_APP_SECRET?.trim(),
    process.env.META_FACEBOOK_APP_SECRET?.trim(),
  ].filter((value): value is string => Boolean(value));
  const uniqueSecrets = [...new Set(secrets)];
  if (!uniqueSecrets.length) {
    throw new Error("Instagram webhook signing is not configured.");
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

export async function verifyInstagramWebhookSignature(rawBody: string, signature: string | null) {
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

async function instagramRunActionSignature(
  runId: string,
  connectionId: string,
  senderIdHash: string,
  action: "confirm" | "follow_recheck",
) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const value = `instagram-dm-run:v2:${action}:${runId}:${connectionId}:${senderIdHash}`;
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function legacyInstagramRunActionSignature(
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
  const value = `instagram-dm-run:v1:${runId}:${connectionId}:${senderIdHash}`;
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createInstagramRunActionPayload(
  runId: string,
  connectionId: string,
  senderIdHash: string,
  action: "confirm" | "follow_recheck" = "confirm",
) {
  const signature = await instagramRunActionSignature(runId, connectionId, senderIdHash, action);
  return `bento:run:${action}:${runId}:${signature}`;
}

export async function readInstagramRunActionPayload(
  payload: string | null,
  connectionId: string,
  senderIdHash: string | null,
  expectedAction: "confirm" | "follow_recheck" = "confirm",
) {
  if (!payload || !senderIdHash) return null;
  const match =
    /^bento:run:(confirm|follow_recheck):([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([0-9a-f]{32})$/i.exec(
      payload,
    );
  if (!match) {
    if (expectedAction !== "confirm") return null;
    const legacy =
      /^bento:run:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([0-9a-f]{32})$/i.exec(
        payload,
      );
    if (!legacy) return null;
    const expected = await legacyInstagramRunActionSignature(legacy[1], connectionId, senderIdHash);
    return timingSafeEqual(encoder.encode(expected), encoder.encode(legacy[2].toLowerCase()))
      ? legacy[1].toLowerCase()
      : null;
  }
  if (match[1].toLowerCase() !== expectedAction) return null;
  const expected = await instagramRunActionSignature(
    match[2],
    connectionId,
    senderIdHash,
    expectedAction,
  );
  return timingSafeEqual(encoder.encode(expected), encoder.encode(match[3].toLowerCase()))
    ? match[2].toLowerCase()
    : null;
}

export async function handleInstagramWebhookVerification(request: Request) {
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

export async function handleInstagramWebhook(
  request: Request,
  queue?: Queue<InstagramDmQueueMessage>,
) {
  try {
    const rawBody = await readRequestText(request, MAX_WEBHOOK_BYTES);
    if (
      !(await verifyInstagramWebhookSignature(rawBody, request.headers.get("x-hub-signature-256")))
    ) {
      return new Response("Invalid signature", { status: 401 });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const events = parseInstagramWebhook(payload);
    if (events.length > 0 && !queue) return new Response("Queue unavailable", { status: 503 });
    if (events.length > 0) {
      // Cloudflare Queues accepts at most 100 messages per sendBatch call.
      // Meta may legitimately deliver more than that in one signed webhook,
      // especially during a comment burst, so keep the whole delivery
      // enqueueable instead of turning a valid webhook into a 503 retry loop.
      for (let offset = 0; offset < events.length; offset += 100) {
        await queue!.sendBatch(
          events
            .slice(offset, offset + 100)
            .map((event) => ({ body: { kind: "instagram_dm_event" as const, event } })),
        );
      }
      const accountIds = Array.from(
        new Set(events.map((event) => event.instagramAccountId).filter(Boolean)),
      );
      await Promise.allSettled(
        accountIds.map(async (accountId) => {
          await (supabaseAdmin as any)
            .from("social_connections")
            .update({ last_webhook_at: new Date().toISOString() })
            .eq("provider", "instagram")
            .eq("provider_user_id", accountId);
        }),
      );
    }
    return Response.json({ received: true }, { status: 200 });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return new Response("Payload too large", { status: 413 });
    }
    console.error("[instagram-auto-dm] webhook intake failed", error);
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
      "User-Agent": "bento.surf-instagram-auto-dm",
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
        ? "Instagram is temporarily unavailable. Bento will retry."
        : "Instagram rejected this automated reply.",
      providerCode,
      retryable,
      parseMetaRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }
  return data;
}

export async function getInstagramUserFollowState(
  connection: { access_token: string },
  senderId: string | null,
) {
  if (!senderId) {
    throw new MetaDeliveryError(
      "Instagram did not identify the person requesting this message.",
      "recipient_missing",
      false,
    );
  }
  if (shouldMockInstagramAutoDmProvider()) return true;
  const token = await decryptInstagramConnectionAccessToken(connection.access_token);
  const url = new URL(
    `https://graph.instagram.com/${graphVersion()}/${encodeURIComponent(senderId)}`,
  );
  url.searchParams.set("fields", "is_user_follow_business");
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "bento.surf-instagram-auto-dm",
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
    const retryable = isRetryableMetaResponse(response.status, data);
    throw new MetaDeliveryError(
      retryable
        ? "Instagram follower verification is temporarily unavailable."
        : "Instagram rejected follower verification.",
      String(data.error?.code || response.status || "meta_error"),
      retryable,
      parseMetaRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }
  if (typeof data.is_user_follow_business !== "boolean") {
    throw new MetaDeliveryError(
      "Instagram did not return follower status.",
      "follow_state_unavailable",
      false,
    );
  }
  return data.is_user_follow_business;
}

async function metaFormRequest(url: string, token: string, fields: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "bento.surf-instagram-auto-dm",
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
        ? "Instagram is temporarily unavailable. Bento will retry."
        : "Instagram rejected this webhook subscription.",
      providerCode,
      retryable,
      parseMetaRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }
  return data;
}

async function metaSubscriptionRequest(
  method: "GET" | "DELETE",
  url: string,
  token: string,
  timeoutMs = 20_000,
) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "bento.surf-instagram-auto-dm",
    },
    signal: AbortSignal.timeout(timeoutMs),
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
        ? "Instagram is temporarily unavailable. Bento will retry."
        : "Instagram rejected this webhook request.",
      providerCode,
      retryable,
      parseMetaRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }
  return data;
}

export async function fetchInstagramAccountProfile(
  token: string,
  accountId = "me",
  timeoutMs = 20_000,
) {
  const url = new URL(
    `https://graph.instagram.com/${graphVersion()}/${encodeURIComponent(accountId)}`,
  );
  url.searchParams.set("fields", "user_id,username,profile_picture_url");
  const data = await metaSubscriptionRequest("GET", url.toString(), token, timeoutMs);
  return {
    id: String(data.user_id ?? data.id ?? ""),
    username: typeof data.username === "string" ? data.username : "",
    profilePictureUrl:
      typeof data.profile_picture_url === "string" ? data.profile_picture_url : null,
  };
}

type MetaPage<T> = {
  data?: T[];
  paging?: { cursors?: { after?: string } };
  error?: { code?: string | number; message?: string; is_transient?: boolean };
};

async function metaGetPage<T>(url: URL, token: string) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "bento.surf-instagram-auto-dm",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await readResponseText(response, 512 * 1024);
  let data: MetaPage<T> = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  if (!response.ok || data.error || !Array.isArray(data.data)) {
    const providerCode = String(data.error?.code || response.status || "meta_error");
    const retryable = isRetryableMetaResponse(response.status, data);
    throw new MetaDeliveryError(
      retryable
        ? "Instagram is temporarily unavailable. Bento will retry."
        : "Instagram rejected the missed-comment safety check.",
      providerCode,
      retryable,
      parseMetaRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }
  return data;
}

type ReconciledInstagramMedia = { id?: string; timestamp?: string };
type ReconciledInstagramComment = {
  id?: string;
  text?: string;
  timestamp?: string;
  from?: { id?: string; username?: string };
  replies?: { data?: Array<{ from?: { id?: string } }> };
};

async function getRecentInstagramMediaForReconciliation(accountId: string, token: string) {
  const url = new URL(
    `https://graph.instagram.com/${graphVersion()}/${encodeURIComponent(accountId)}/media`,
  );
  url.searchParams.set("fields", "id,timestamp");
  url.searchParams.set("limit", "10");
  const page = await metaGetPage<ReconciledInstagramMedia>(url, token);
  return (page.data || []).flatMap((media) =>
    typeof media.id === "string" && media.id ? [media.id] : [],
  );
}

async function getRecentInstagramCommentsForReconciliation(
  mediaId: string,
  token: string,
  since: Date,
) {
  const comments: ReconciledInstagramComment[] = [];
  let after: string | null = null;
  for (let pageIndex = 0; pageIndex < INSTAGRAM_COMMENT_RECONCILE_PAGE_LIMIT; pageIndex += 1) {
    const url = new URL(
      `https://graph.instagram.com/${graphVersion()}/${encodeURIComponent(mediaId)}/comments`,
    );
    url.searchParams.set("fields", "id,text,timestamp,from,replies.limit(100){from}");
    url.searchParams.set("order", "reverse_chronological");
    url.searchParams.set("limit", "50");
    url.searchParams.set("since", String(Math.floor(since.getTime() / 1_000)));
    if (after) url.searchParams.set("after", after);
    const page = await metaGetPage<ReconciledInstagramComment>(url, token);
    const pageComments = page.data || [];
    comments.push(...pageComments);
    const oldestTimestamp = pageComments.at(-1)?.timestamp;
    if (
      pageComments.length < 50 ||
      (oldestTimestamp && Date.parse(oldestTimestamp) < since.getTime())
    ) {
      break;
    }
    after = page.paging?.cursors?.after || null;
    if (!after) break;
  }
  return comments.filter((comment) => {
    if (!comment.timestamp) return true;
    const timestamp = Date.parse(comment.timestamp);
    return Number.isFinite(timestamp) && timestamp >= since.getTime();
  });
}

export async function enqueueInstagramCommentReconciliations(
  queue?: Queue<InstagramDmQueueMessage>,
) {
  if (!queue) return { claimed: 0, queued: 0 };
  const { data, error } = await (supabaseAdmin as any).rpc(
    "claim_instagram_comment_reconciliations",
    { p_batch_size: 25, p_min_interval_seconds: 300 },
  );
  if (error) throw new Error("Unable to claim Instagram missed-comment checks.");
  const connectionIds = (Array.isArray(data) ? data : []).flatMap((row: any) =>
    typeof row?.connection_id === "string" ? [row.connection_id] : [],
  );
  if (!connectionIds.length) return { claimed: 0, queued: 0 };
  for (let offset = 0; offset < connectionIds.length; offset += 100) {
    await queue.sendBatch(
      connectionIds.slice(offset, offset + 100).map((connectionId) => ({
        body: { kind: "instagram_comment_reconcile" as const, connectionId },
      })),
    );
  }
  return { claimed: connectionIds.length, queued: connectionIds.length };
}

async function updateInstagramCommentReconcileState(
  connectionId: string,
  values: Record<string, unknown>,
) {
  const { error } = await (supabaseAdmin as any)
    .from("social_connections")
    .update(values)
    .eq("id", connectionId);
  if (error) throw new Error("Unable to save Instagram missed-comment check state.");
}

async function processInstagramCommentReconciliation(
  connectionId: string,
  queue?: Queue<InstagramDmQueueMessage>,
) {
  if (!queue) throw new Error("Instagram automation queue is unavailable.");
  const { data: connection, error: connectionError } = await (supabaseAdmin as any)
    .from("social_connections")
    .select(
      "id,user_id,provider_user_id,access_token,status,connection_health,scopes,webhook_fields,token_expires_at,last_verified_at,reauth_required,last_comment_reconcile_completed_at",
    )
    .eq("id", connectionId)
    .eq("provider", "instagram")
    .maybeSingle();
  if (connectionError) throw new Error("Unable to load the Instagram account for reconciliation.");
  if (!connection || !getInstagramConnectionReadiness(connection).ready) {
    return { skipped: true, reason: "connection_not_ready" };
  }
  if (!planHasEntitlement(await getPlan(String(connection.user_id)), "instagramAutoDM")) {
    await updateInstagramCommentReconcileState(connectionId, {
      last_comment_reconcile_completed_at: new Date().toISOString(),
      last_comment_reconcile_error: "plan_unavailable",
    });
    return { skipped: true, reason: "plan_unavailable" };
  }

  const { data: automationRows, error: automationError } = await (supabaseAdmin as any)
    .from("instagram_dm_automations")
    .select(
      "id,trigger_type,keywords,excluded_keywords,match_type,media_scope,media_ids,created_at",
    )
    .eq("connection_id", connectionId)
    .eq("enabled", true)
    .in("trigger_type", ["comment_keyword", "any_comment"])
    .order("created_at", { ascending: true });
  if (automationError) throw new Error("Unable to load Instagram comment automations.");
  const automations = (automationRows || []) as Array<
    MatchableInstagramAutomation & { created_at: string }
  >;
  if (!automations.length) {
    await updateInstagramCommentReconcileState(connectionId, {
      last_comment_reconcile_completed_at: new Date().toISOString(),
      last_comment_reconcile_error: null,
    });
    return { scanned: 0, queued: 0 };
  }

  try {
    const token = await decryptInstagramConnectionAccessToken(connection.access_token);
    const now = new Date();
    const earliestAutomation = Math.min(
      ...automations.map((automation) => Date.parse(automation.created_at)).filter(Number.isFinite),
    );
    const lastCompletedAt = Date.parse(
      typeof connection.last_comment_reconcile_completed_at === "string"
        ? connection.last_comment_reconcile_completed_at
        : "",
    );
    const since = new Date(
      Math.max(
        now.getTime() - INSTAGRAM_COMMENT_RECONCILE_LOOKBACK_MS,
        Number.isFinite(earliestAutomation) ? earliestAutomation : now.getTime(),
        Number.isFinite(lastCompletedAt)
          ? lastCompletedAt - INSTAGRAM_COMMENT_RECONCILE_OVERLAP_MS
          : Number.NEGATIVE_INFINITY,
      ),
    );
    const recentMediaIds = await getRecentInstagramMediaForReconciliation(
      connection.provider_user_id,
      token,
    );
    const specificMediaIds = automations.flatMap((automation) => automation.media_ids || []);
    const mediaIds = [...new Set([...recentMediaIds, ...specificMediaIds])].slice(
      0,
      INSTAGRAM_COMMENT_RECONCILE_MEDIA_LIMIT,
    );
    const candidates: InstagramWebhookEvent[] = [];

    for (const mediaId of mediaIds) {
      if (candidates.length >= INSTAGRAM_COMMENT_RECONCILE_EVENT_LIMIT) break;
      const comments = await getRecentInstagramCommentsForReconciliation(mediaId, token, since);
      for (const comment of comments) {
        if (candidates.length >= INSTAGRAM_COMMENT_RECONCILE_EVENT_LIMIT) break;
        const commentId = typeof comment.id === "string" ? comment.id : null;
        const senderId = typeof comment.from?.id === "string" ? comment.from.id : null;
        if (!commentId || !senderId || senderId === connection.provider_user_id) continue;
        const occurredAt = typeof comment.timestamp === "string" ? comment.timestamp : null;
        const occurredAtMs = occurredAt ? Date.parse(occurredAt) : now.getTime();
        const eligibleAutomations = automations.filter((automation) => {
          const createdAt = Date.parse(automation.created_at);
          return !Number.isFinite(createdAt) || createdAt <= occurredAtMs;
        });
        const event: InstagramWebhookEvent = {
          externalEventId: `comment:${commentId}`,
          instagramAccountId: connection.provider_user_id,
          eventType: "comment",
          eventContext: "comment",
          sourceId: commentId,
          senderId,
          senderUsername: typeof comment.from?.username === "string" ? comment.from.username : null,
          mediaId,
          text: typeof comment.text === "string" ? comment.text : "",
          actionPayload: null,
          occurredAt,
        };
        if (!matchInstagramAutomation(event, eligibleAutomations)) continue;
        const creatorAlreadyReplied = (comment.replies?.data || []).some(
          (reply) => reply.from?.id === connection.provider_user_id,
        );
        if (creatorAlreadyReplied) continue;
        candidates.push(event);
      }
    }

    let freshCandidates = candidates;
    if (candidates.length) {
      const { data: existingEvents, error: existingError } = await (supabaseAdmin as any)
        .from("instagram_dm_events")
        .select("external_event_id")
        .in(
          "external_event_id",
          candidates.map((event) => event.externalEventId),
        );
      if (existingError) throw new Error("Unable to deduplicate reconciled Instagram comments.");
      const existingIds = new Set(
        (existingEvents || []).map((event: any) => String(event.external_event_id)),
      );
      freshCandidates = candidates.filter((event) => !existingIds.has(event.externalEventId));
    }
    for (let offset = 0; offset < freshCandidates.length; offset += 100) {
      await queue.sendBatch(
        freshCandidates.slice(offset, offset + 100).map((event) => ({
          body: { kind: "instagram_dm_event" as const, event },
        })),
      );
    }
    await updateInstagramCommentReconcileState(connectionId, {
      last_comment_reconcile_completed_at: now.toISOString(),
      last_comment_reconcile_error: null,
    });
    if (freshCandidates.length) {
      await captureServerEvent(
        String(connection.user_id),
        "instagram_auto_dm_comments_reconciled",
        {
          connection_id: connectionId,
          comments_queued: freshCandidates.length,
          media_scanned: mediaIds.length,
        },
      );
    }
    return {
      scanned: candidates.length,
      queued: freshCandidates.length,
      mediaScanned: mediaIds.length,
    };
  } catch (error) {
    const deliveryError = error instanceof MetaDeliveryError ? error : null;
    const errorCode = deliveryError?.code || "reconcile_failed";
    await updateInstagramCommentReconcileState(connectionId, {
      last_comment_reconcile_error: errorCode.slice(0, 255),
    }).catch(() => undefined);
    if (instagramMetaErrorNeedsReauth(error)) {
      await (supabaseAdmin as any)
        .from("social_connections")
        .update({
          connection_health: "action_required",
          webhook_fields: [],
          reauth_required: true,
          provider_error_code: errorCode,
          last_error: "Instagram access expired or was revoked. Reconnect this account.",
        })
        .eq("id", connectionId);
    }
    await captureServerException(error, "instagram-comment-reconciler", {
      connection_id: connectionId,
      provider_error_code: errorCode,
      retryable: deliveryError?.retryable ?? true,
    });
    if (!deliveryError || deliveryError.retryable) throw error;
    return { failed: true, retryable: false };
  }
}

export async function getInstagramAccountWebhookFields(accountId: string, token: string) {
  const url = `https://graph.instagram.com/${graphVersion()}/${encodeURIComponent(accountId)}/subscribed_apps`;
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

export async function verifyInstagramAccountWebhooks(accountId: string, token: string) {
  const fields = await getInstagramAccountWebhookFields(accountId, token);
  const missingFields = INSTAGRAM_AUTO_DM_WEBHOOK_FIELDS.filter((field) => !fields.includes(field));
  return {
    ok: missingFields.length === 0,
    fields,
    missingFields,
  };
}

export async function subscribeInstagramAccountWebhooks(accountId: string, token: string) {
  const url = `https://graph.instagram.com/${graphVersion()}/${encodeURIComponent(accountId)}/subscribed_apps`;
  const data = await metaFormRequest(url, token, {
    subscribed_fields: INSTAGRAM_AUTO_DM_WEBHOOK_FIELDS.join(","),
  });
  if (data.success !== true) {
    throw new MetaDeliveryError(
      "Instagram did not enable webhooks for this account.",
      "subscribe",
      false,
    );
  }
  const verification = await verifyInstagramAccountWebhooks(accountId, token);
  if (!verification.ok) {
    throw new MetaDeliveryError(
      `Instagram did not confirm the required webhook fields: ${verification.missingFields.join(", ")}.`,
      "subscription_not_verified",
      false,
    );
  }
  return verification;
}

export async function unsubscribeInstagramAccountWebhooks(accountId: string, token: string) {
  const url = `https://graph.instagram.com/${graphVersion()}/${encodeURIComponent(accountId)}/subscribed_apps`;
  const data = await metaSubscriptionRequest("DELETE", url, token);
  if (data.success !== true) {
    throw new MetaDeliveryError(
      "Instagram did not remove the webhook subscription.",
      "unsubscribe",
      false,
    );
  }
  return { ok: true };
}

export async function refreshInstagramLongLivedToken(token: string) {
  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", token);
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "bento.surf-instagram-auto-dm",
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
  if (!response.ok || data.error || !data.access_token) {
    const providerCode = String(data.error?.code || response.status || "token_refresh_failed");
    const retryable = isRetryableMetaResponse(response.status, data);
    throw new MetaDeliveryError(
      retryable
        ? "Instagram token refresh is temporarily unavailable."
        : "Instagram access has expired. Reconnect this account.",
      providerCode,
      retryable,
      parseMetaRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }
  return {
    accessToken: String(data.access_token),
    expiresIn: Math.max(60, Number(data.expires_in) || 60 * 24 * 60 * 60),
  };
}

type InstagramConnectionAuditRow = {
  id: string;
  user_id: string;
  provider_user_id: string;
  access_token: string;
  token_expires_at: string | null;
  last_health_check_at: string | null;
  provider_avatar_url: string | null;
};

export async function auditInstagramConnections(now = new Date()) {
  const verificationCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
  const refreshCutoff = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1_000).toISOString();
  const retryCutoff = new Date(now.getTime() - 15 * 60 * 1_000).toISOString();
  const { data, error } = await (supabaseAdmin as any)
    .from("social_connections")
    .select(
      "id, user_id, provider_user_id, access_token, token_expires_at, last_health_check_at, provider_avatar_url",
    )
    .eq("provider", "instagram")
    .eq("status", "active")
    .or(
      `last_verified_at.is.null,last_verified_at.lt.${verificationCutoff},token_expires_at.lt.${refreshCutoff},provider_avatar_url.is.null`,
    )
    .or(`last_health_check_at.is.null,last_health_check_at.lt.${retryCutoff}`)
    .order("last_health_check_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .limit(50);
  if (error) throw new Error("Unable to load Instagram connections for health verification.");

  const result = {
    checked: 0,
    healthy: 0,
    refreshed: 0,
    repaired: 0,
    actionRequired: 0,
    transientFailures: 0,
  };
  for (const connection of (data || []) as InstagramConnectionAuditRow[]) {
    result.checked += 1;
    const { error: attemptError } = await (supabaseAdmin as any)
      .from("social_connections")
      .update({ last_health_check_at: now.toISOString() })
      .eq("id", connection.id);
    if (attemptError) throw new Error("Unable to rotate Instagram connection health checks.");

    let token: string;
    try {
      token = await decryptServerSecret(connection.access_token, "social");
    } catch {
      await (supabaseAdmin as any)
        .from("social_connections")
        .update({
          connection_health: "action_required",
          reauth_required: true,
          provider_error_code: "token_decryption_failed",
          last_error: "Bento could not read the saved Instagram connection. Reconnect it.",
        })
        .eq("id", connection.id);
      result.actionRequired += 1;
      continue;
    }

    try {
      const expiresAt = connection.token_expires_at
        ? new Date(connection.token_expires_at).getTime()
        : 0;
      let refreshedExpiresAt = connection.token_expires_at;
      let encryptedToken = connection.access_token;
      if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
        throw new MetaDeliveryError(
          "Instagram access has expired. Reconnect this account.",
          "token_expired",
          false,
        );
      }
      if (expiresAt <= new Date(refreshCutoff).getTime()) {
        const refreshed = await refreshInstagramLongLivedToken(token);
        token = refreshed.accessToken;
        encryptedToken = await encryptServerSecret(token, "social");
        refreshedExpiresAt = new Date(now.getTime() + refreshed.expiresIn * 1_000).toISOString();
        result.refreshed += 1;
      }

      let avatarUrl = connection.provider_avatar_url;
      try {
        const profile = await fetchInstagramAccountProfile(token, connection.provider_user_id);
        avatarUrl = profile.profilePictureUrl || avatarUrl;
      } catch (profileError) {
        console.warn("Instagram profile refresh failed during connection audit", {
          connectionId: connection.id,
          code: profileError instanceof MetaDeliveryError ? profileError.code : undefined,
        });
      }

      let verification = await verifyInstagramAccountWebhooks(connection.provider_user_id, token);
      if (!verification.ok) {
        verification = await subscribeInstagramAccountWebhooks(connection.provider_user_id, token);
        result.repaired += 1;
      }
      const { error: updateError } = await (supabaseAdmin as any)
        .from("social_connections")
        .update({
          access_token: encryptedToken,
          token_expires_at: refreshedExpiresAt,
          provider_avatar_url: avatarUrl,
          connection_health: "healthy",
          webhook_fields: verification.fields,
          last_verified_at: now.toISOString(),
          last_health_check_at: now.toISOString(),
          reauth_required: false,
          provider_error_code: null,
          last_error: null,
        })
        .eq("id", connection.id);
      if (updateError) throw new Error("Unable to save Instagram connection health.");
      result.healthy += 1;
    } catch (auditError) {
      if (auditError instanceof MetaDeliveryError && auditError.retryable) {
        result.transientFailures += 1;
        continue;
      }
      const requiresReconnect =
        instagramMetaErrorNeedsReauth(auditError) ||
        (auditError instanceof MetaDeliveryError && auditError.code === "token_expired");
      await (supabaseAdmin as any)
        .from("social_connections")
        .update({
          connection_health: "action_required",
          webhook_fields: [],
          reauth_required: requiresReconnect,
          provider_error_code:
            auditError instanceof MetaDeliveryError ? auditError.code : "health_check_failed",
          last_error: requiresReconnect
            ? "Instagram access expired or was revoked. Reconnect this account."
            : "Bento could not verify Instagram webhooks. Use Repair connection.",
        })
        .eq("id", connection.id);
      result.actionRequired += 1;
    }
  }
  return result;
}

async function sendPrivateReply(
  connection: { provider_user_id: string; access_token: string },
  event: InstagramWebhookEvent,
  automation: {
    id: string;
    opening_message?: string | null;
    confirmation_button_label?: string | null;
    email_capture_enabled?: boolean;
    email_prompt_message?: string | null;
    email_marketing_consent_enabled?: boolean;
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
  if (shouldMockInstagramAutoDmProvider()) {
    return { message_id: `staging-dm-${event.sourceId}`, recipient_id: "staging-recipient" };
  }
  const token = await decryptInstagramConnectionAccessToken(connection.access_token);
  const url = `https://graph.instagram.com/${graphVersion()}/${encodeURIComponent(connection.provider_user_id)}/messages`;
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
        "Instagram confirmation state could not be created.",
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

async function sendInstagramTextMessage(
  connection: { provider_user_id: string; access_token: string },
  senderId: string | null,
  text: string,
) {
  if (!senderId) {
    throw new MetaDeliveryError(
      "Instagram did not provide a recipient for this message.",
      "recipient_missing",
      false,
    );
  }
  if (shouldMockInstagramAutoDmProvider()) {
    return { message_id: `staging-dm-${crypto.randomUUID()}`, recipient_id: "staging-recipient" };
  }
  const token = await decryptInstagramConnectionAccessToken(connection.access_token);
  const url = `https://graph.instagram.com/${graphVersion()}/${encodeURIComponent(connection.provider_user_id)}/messages`;
  return metaRequest(url, token, {
    recipient: { id: senderId },
    messaging_type: "RESPONSE",
    message: { text },
  });
}

async function sendInstagramQuickReplyMessage(
  connection: { provider_user_id: string; access_token: string },
  senderId: string | null,
  text: string,
  title: string,
  payload: string,
) {
  if (!senderId) {
    throw new MetaDeliveryError(
      "Instagram did not provide a recipient for this message.",
      "recipient_missing",
      false,
    );
  }
  if (shouldMockInstagramAutoDmProvider()) {
    return { message_id: `staging-dm-${crypto.randomUUID()}`, recipient_id: "staging-recipient" };
  }
  const token = await decryptInstagramConnectionAccessToken(connection.access_token);
  const url = `https://graph.instagram.com/${graphVersion()}/${encodeURIComponent(connection.provider_user_id)}/messages`;
  return metaRequest(url, token, {
    recipient: { id: senderId },
    messaging_type: "RESPONSE",
    message: {
      text,
      quick_replies: [{ content_type: "text", title, payload }],
    },
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
    ? `By replying, you agree to receive this resource and future emails from @${connectionHandle}. You can unsubscribe anytime.`
    : `Your email will be shared with @${connectionHandle} only to deliver this request, not for marketing.`;
  return `${prompt}\n\n${disclosure}`;
}

async function captureInstagramEmailAudience(input: {
  runId: string;
  email: string;
  senderUsername: string | null;
  marketingConsent: boolean;
}) {
  const { data, error } = await (supabaseAdmin as any).rpc("capture_instagram_dm_email_audience", {
    p_run_id: input.runId,
    p_email: input.email,
    p_sender_username: input.senderUsername,
    p_marketing_consent: input.marketingConsent,
  });
  if (error || !data) throw new Error("Unable to add this Instagram contact to Audience.");
  return String(data);
}

async function sendPublicCommentReply(
  connection: { access_token: string },
  commentId: string,
  message: string,
) {
  if (shouldMockInstagramAutoDmProvider()) {
    return { id: `staging-comment-${commentId}` };
  }
  const token = await decryptInstagramConnectionAccessToken(connection.access_token);
  const url = `https://graph.instagram.com/${graphVersion()}/${encodeURIComponent(commentId)}/replies`;
  return metaRequest(url, token, { message });
}

async function updateEvent(id: string, update: Record<string, unknown>) {
  const { error } = await (supabaseAdmin as any)
    .from("instagram_dm_events")
    .update(update)
    .eq("id", id);
  if (error) throw new Error("Unable to update Instagram automation activity.");
}

async function updateRun(id: string, update: Record<string, unknown>) {
  const { error } = await (supabaseAdmin as any)
    .from("instagram_dm_runs")
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error("Unable to update Instagram automation workflow state.");
}

export async function processInstagramDmQueueMessage(
  message: InstagramDmQueueMessage,
  queue?: Queue<InstagramDmQueueMessage>,
) {
  if (message.kind === "instagram_comment_reconcile") {
    return processInstagramCommentReconciliation(message.connectionId, queue);
  }
  const event = message.event;
  const eventSenderHash = await senderHash(event.senderId);
  const { data: claimed, error: claimError } = await (supabaseAdmin as any).rpc(
    "claim_instagram_dm_event",
    {
      p_external_event_id: event.externalEventId,
      p_instagram_account_id: event.instagramAccountId,
      p_event_type: event.eventType,
      p_event_context: event.eventContext,
      p_source_id: event.sourceId,
      p_media_id: event.mediaId,
      p_sender_username: event.senderUsername,
      p_sender_id_hash: eventSenderHash,
      p_occurred_at: event.occurredAt,
    },
  );
  if (claimError) throw new Error("Unable to claim Instagram webhook event.");
  const claim = Array.isArray(claimed) ? claimed[0] : claimed;
  if (!claim?.event_id || !claim.should_process) return { duplicate: true };
  const eventId = claim.event_id as string;
  const policyWindowFailure = getInstagramAutoDmPolicyWindowFailure(event);
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
  let runStep: "opening" | "confirmation" | "follow" | "email" | null = null;
  let capturedEmail: string | null = null;
  let followRecheckCount = 0;
  let runFollowSettings: {
    enabled: boolean;
    prompt: string;
    maxRechecks: number;
    failAction: "send_anyway" | "withhold";
  } | null = null;

  try {
    const { data: connections, error: connectionError } = await (supabaseAdmin as any)
      .from("social_connections")
      .select(
        "id, provider_user_id, provider_handle, access_token, user_id, status, connection_health, scopes, webhook_fields, token_expires_at, last_verified_at, reauth_required",
      )
      .eq("provider", "instagram")
      .eq("provider_user_id", event.instagramAccountId)
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .limit(10);
    if (connectionError) throw new Error("Unable to load the Instagram account.");
    if (!connections?.length) {
      await updateEvent(eventId, {
        status: "ignored",
        error_code: "connection_missing",
        error_message: "No active Bento connection owns this Instagram account.",
        processed_at: new Date().toISOString(),
      });
      return { ignored: true };
    }
    const eligibleUserIds = new Set<string>();
    await Promise.all(
      [...new Set<string>(connections.map((connection: any) => String(connection.user_id)))].map(
        async (userId) => {
          if (planHasEntitlement(await getPlan(userId), "instagramAutoDM")) {
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
        error_message: "The creator's plan no longer includes Instagram Auto-DM.",
        processed_at: new Date().toISOString(),
      });
      return { ignored: true };
    }
    const readyConnections = eligibleConnections.filter(
      (connection: any) => getInstagramConnectionReadiness(connection).ready,
    );
    if (!readyConnections.length) {
      await updateEvent(eventId, {
        connection_id: eligibleConnections[0].id,
        status: "ignored",
        error_code: "connection_not_ready",
        error_message: "The Instagram connection needs to be repaired or reconnected.",
        processed_at: new Date().toISOString(),
      });
      return { ignored: true };
    }
    if (event.senderId === event.instagramAccountId) {
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
      .from("instagram_dm_automations")
      .select("*")
      .in("connection_id", connectionIds)
      .eq("enabled", true)
      .order("created_at", { ascending: true });
    if (automationError) throw new Error("Unable to load Instagram automation rules.");
    let match: ReturnType<typeof matchInstagramAutomation> = null;
    let confirmationFlow = false;
    let emailCaptureFlow = false;
    let emailWorkflowIntercepted = false;
    let actionConnection: any | null = null;
    if (event.eventContext === "dm" && eventSenderHash && !event.actionPayload) {
      const { data: candidateRuns, error: candidateRunError } = await (supabaseAdmin as any)
        .from("instagram_dm_runs")
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
        throw new Error("Unable to load Instagram email workflow state.");
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
          const email = extractInstagramEmailAddress(event.text);
          if (!email) {
            claimedConnectionId = String(candidate.id);
            claimedUserId = String(candidate.user_id);
            claimedAutomationId = String(selected.id);
            await claimInstagramDeliverySlot(claimedConnectionId);
            const response = await sendInstagramTextMessage(
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
            await captureServerEvent(String(candidate.user_id), "instagram_auto_dm_email_invalid", {
              automation_id: selected.id,
              connection_id: candidate.id,
              workflow_run_id: candidateRun.id,
            });
            return { sent: true };
          }
          const { data: claimedEmailRun, error: emailRunClaimError } = await (
            supabaseAdmin as any
          ).rpc("claim_instagram_dm_email_run", {
            p_connection_id: candidate.id,
            p_sender_id_hash: eventSenderHash,
            p_email_event_id: eventId,
            p_email: email,
          });
          if (emailRunClaimError) {
            throw new Error("Unable to claim Instagram email workflow state.");
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
    if (!match && event.eventContext === "quick_reply" && eventSenderHash) {
      for (const candidate of readyConnections) {
        const runId = await readInstagramRunActionPayload(
          event.actionPayload,
          String(candidate.id),
          eventSenderHash,
          "follow_recheck",
        );
        if (!runId) continue;
        const { data: claimedRun, error: runClaimError } = await (supabaseAdmin as any).rpc(
          "claim_instagram_dm_follow_recheck",
          {
            p_run_id: runId,
            p_connection_id: candidate.id,
            p_sender_id_hash: eventSenderHash,
            p_follow_event_id: eventId,
          },
        );
        if (runClaimError) throw new Error("Unable to claim Instagram follower recheck.");
        const runClaim = Array.isArray(claimedRun) ? claimedRun[0] : claimedRun;
        if (!runClaim?.should_process || !runClaim.automation_id) continue;
        const selected = (automations || []).find(
          (item: any) => item.id === runClaim.automation_id,
        );
        if (!selected) {
          await updateRun(runId, {
            status: "failed",
            error_code: "automation_unavailable",
            error_message: "This automation was disabled or removed during follower verification.",
            processing_started_at: null,
          });
          break;
        }
        actionConnection = candidate;
        activeRunId = runId;
        runStep = "follow";
        match = { automation: selected, matchedKeyword: null };
        confirmationFlow = true;
        followRecheckCount = Number(runClaim.follow_recheck_count || 0);
        break;
      }
    }
    if (!match && event.eventContext === "quick_reply") {
      if (!eventSenderHash) {
        await updateEvent(eventId, {
          connection_id: readyConnections[0].id,
          status: "ignored",
          error_code: "action_sender_missing",
          error_message: "Instagram did not identify the sender for this action.",
          processed_at: new Date().toISOString(),
        });
        return { ignored: true };
      }
      for (const candidate of readyConnections) {
        const runId = await readInstagramRunActionPayload(
          event.actionPayload,
          String(candidate.id),
          eventSenderHash,
        );
        if (!runId) continue;
        const { data: claimedRun, error: runClaimError } = await (supabaseAdmin as any).rpc(
          "claim_instagram_dm_run",
          {
            p_run_id: runId,
            p_connection_id: candidate.id,
            p_sender_id_hash: eventSenderHash,
            p_confirmation_event_id: eventId,
          },
        );
        if (runClaimError) throw new Error("Unable to claim Instagram workflow state.");
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
          "claim_instagram_dm_run_for_quick_reply_prompt",
          {
            p_connection_id: candidate.id,
            p_sender_id_hash: eventSenderHash,
            p_confirmation_event_id: eventId,
            p_reply_text: event.text,
          },
        );
        if (runClaimError) throw new Error("Unable to claim Instagram workflow reply.");
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
      match = matchInstagramAutomation(
        event,
        (automations || []) as MatchableInstagramAutomation[],
      );
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
    if (!connection) throw new Error("The matching Instagram connection is unavailable.");
    claimedConnectionId = String(connection.id);
    claimedUserId = String(connection.user_id);
    claimedAutomationId = String(automation.id);
    if (activeRunId && confirmationFlow) {
      const { data: run, error: runError } = await (supabaseAdmin as any)
        .from("instagram_dm_runs")
        .select(
          "follow_gate_enabled, follow_prompt_message, follow_max_rechecks, follow_fail_action, follow_recheck_count",
        )
        .eq("id", activeRunId)
        .maybeSingle();
      if (runError || !run) throw new Error("Unable to load Instagram follower workflow state.");
      runFollowSettings = {
        enabled: Boolean(run.follow_gate_enabled),
        prompt: String(run.follow_prompt_message || "Follow this account, then tap I’ve followed."),
        maxRechecks: Math.min(3, Math.max(1, Number(run.follow_max_rechecks || 3))),
        failAction: run.follow_fail_action === "withhold" ? "withhold" : "send_anyway",
      };
      followRecheckCount = Math.max(followRecheckCount, Number(run.follow_recheck_count || 0));
    }
    await claimInstagramDeliverySlot(claimedConnectionId);
    const emailPromptFlow = Boolean(confirmationFlow && automation.email_capture_enabled);
    let confirmationPayload: string | null = null;
    const usesOpeningStep = Boolean(
      !confirmationFlow && automation.opening_message && automation.confirmation_button_label,
    );
    if (usesOpeningStep) {
      if (!eventSenderHash) {
        throw new MetaDeliveryError(
          "Instagram did not provide a sender identity for this confirmation flow.",
          "sender_missing",
          false,
        );
      }
      const { data: createdRun, error: createRunError } = await (supabaseAdmin as any).rpc(
        "create_instagram_dm_run",
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
        throw new Error("Unable to create Instagram confirmation workflow state.");
      }
      activeRunId = String(createdRun);
      runStep = "opening";
      confirmationPayload = await createInstagramRunActionPayload(
        activeRunId,
        String(connection.id),
        eventSenderHash,
      );
    }

    if (confirmationFlow && activeRunId && runFollowSettings?.enabled) {
      let follows = true;
      try {
        follows = await getInstagramUserFollowState(connection, event.senderId);
      } catch (error) {
        // Follower verification is an enrichment gate, not a reason to strand a
        // valid Meta interaction. Provider failures fail open and are observable.
        console.error("[instagram-auto-dm] follower verification unavailable", {
          runId: activeRunId,
          error: error instanceof Error ? error.message : "Unknown follower verification error",
        });
      }
      if (follows) {
        await updateRun(activeRunId, { follow_verified_at: new Date().toISOString() });
      } else if (followRecheckCount >= runFollowSettings.maxRechecks) {
        if (runFollowSettings.failAction === "withhold") {
          const response = await sendInstagramTextMessage(
            connection,
            event.senderId,
            "We couldn’t verify the follow yet, so the link has not been sent.",
          );
          const responseId = String(response.message_id || response.id || "") || null;
          await updateRun(activeRunId, {
            status: "blocked",
            final_response_id: responseId,
            processing_started_at: null,
            completed_at: new Date().toISOString(),
            error_code: "follow_required",
            error_message: null,
          });
          await updateEvent(eventId, {
            connection_id: connection.id,
            automation_id: automation.id,
            status: "sent",
            response_id: responseId,
            error_code: "follow_required",
            error_message: null,
            processed_at: new Date().toISOString(),
          });
          return { sent: true };
        }
      } else {
        const payload = await createInstagramRunActionPayload(
          activeRunId,
          String(connection.id),
          eventSenderHash!,
          "follow_recheck",
        );
        const response = await sendInstagramQuickReplyMessage(
          connection,
          event.senderId,
          runFollowSettings.prompt,
          "I’ve followed",
          payload,
        );
        const responseId = String(response.message_id || response.id || "") || null;
        await updateRun(activeRunId, {
          status: "awaiting_follow",
          follow_prompt_response_id: responseId,
          processing_started_at: null,
          error_code: null,
          error_message: null,
        });
        await updateEvent(eventId, {
          connection_id: connection.id,
          automation_id: automation.id,
          status: "sent",
          response_id: responseId,
          error_code: null,
          error_message: null,
          processed_at: new Date().toISOString(),
        });
        return { sent: true };
      }
    }

    await updateEvent(eventId, {
      connection_id: connection.id,
      automation_id: automation.id,
      matched_keyword: match.matchedKeyword,
    });
    if (emailCaptureFlow && activeRunId && capturedEmail) {
      await captureInstagramEmailAudience({
        runId: activeRunId,
        email: capturedEmail,
        senderUsername: event.senderUsername,
        marketingConsent: Boolean(automation.email_marketing_consent_enabled),
      });
    }
    const response = emailPromptFlow
      ? await sendInstagramTextMessage(
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
    if (activeRunId && (runStep === "confirmation" || runStep === "follow")) {
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
          error instanceof Error ? error.message : "Instagram rejected the public reply.";
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
    await captureServerEvent(claimedUserId, "instagram_auto_dm_sent", {
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
    const accountBackoffSeconds = getInstagramAccountBackoffSeconds(error);
    if (claimedConnectionId && accountBackoffSeconds) {
      await deferInstagramDeliverySlot(claimedConnectionId, accountBackoffSeconds).catch(
        (backoffError) => {
          console.error("[instagram-auto-dm] failed to persist provider backoff", {
            connectionId: claimedConnectionId,
            retryAfterSeconds: accountBackoffSeconds,
            error: backoffError instanceof Error ? backoffError.message : "Unknown backoff error",
          });
        },
      );
    }
    if (activeRunId) {
      await updateRun(activeRunId, {
        ...(shouldFailInstagramRunAfterError(runStep, error)
          ? { status: "failed", processing_started_at: null }
          : {}),
        error_code: deliveryError?.code || "processing_failed",
        error_message: error instanceof Error ? error.message.slice(0, 500) : "Automation failed.",
      }).catch(() => undefined);
    }
    if (claimedConnectionId && instagramMetaErrorNeedsReauth(error)) {
      await (supabaseAdmin as any)
        .from("social_connections")
        .update({
          connection_health: "action_required",
          webhook_fields: [],
          reauth_required: true,
          provider_error_code: deliveryError?.code || "meta_auth_failed",
          last_error: "Instagram access expired or was revoked. Reconnect this account.",
        })
        .eq("id", claimedConnectionId);
    }
    await updateEvent(eventId, {
      status: "failed",
      // Permanent Meta rejections must stay deduplicated if Meta later redelivers
      // the same webhook. Retryable failures remain below the queue's nine-attempt cap.
      ...(deliveryError && !deliveryError.retryable ? { attempt_count: 9 } : {}),
      error_code: deliveryError?.code || "processing_failed",
      error_message: error instanceof Error ? error.message.slice(0, 500) : "Automation failed.",
      processed_at: new Date().toISOString(),
    }).catch(() => undefined);
    if (claimedUserId) {
      await captureServerEvent(claimedUserId, "instagram_auto_dm_failed", {
        automation_id: claimedAutomationId,
        connection_id: claimedConnectionId,
        event_context: event.eventContext,
        provider_error_code: deliveryError?.code || "processing_failed",
        retryable: deliveryError?.retryable ?? true,
        account_backoff_seconds: accountBackoffSeconds || null,
      });
    }
    await captureServerException(error, "instagram-auto-dm-worker", {
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
