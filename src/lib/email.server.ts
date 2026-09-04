/* eslint-disable @typescript-eslint/no-explicit-any -- Email tables are introduced by the lifecycle migration. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { renderBentoEmail, type BentoEmailCategory, type BentoEmailEvent } from "./email-templates";
import {
  configuredAppOrigin,
  configuredPublicOrigin,
  publicNewsletterPath,
  publicProductPath,
  publicProductSuccessPath,
} from "./application-urls";
import { issueCustomerLibraryMagicLinkForEmail } from "./customer-library-magic-link.server";
import { normalizeEmailRecipient } from "./email-recipient";
import { newsletterContentSchema, type NewsletterContentBlock } from "./newsletter";
import { recordPriorityDmOrder } from "./priority-dm.server";
import { captureServerEvent } from "./posthog.server";

export { normalizeEmailRecipient } from "./email-recipient";

type EmailOutboxRow = {
  id: string;
  event_key: string;
  event_type: BentoEmailEvent;
  category: BentoEmailCategory;
  recipient_email: string;
  recipient_name: string | null;
  user_id: string | null;
  payload: Record<string, unknown> | null;
  attempts: number;
};

export type EmailQueueMessage =
  | { kind: "email_outbox_kick"; outboxId?: string }
  | { kind: "audience_campaign"; campaignId: string };

export class CampaignDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "CampaignDeliveryError";
  }
}

type AudienceCampaignQueueMessage = {
  body: Extract<EmailQueueMessage, { kind: "audience_campaign" }>;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
};

export async function processAudienceCampaignQueueMessage(
  message: AudienceCampaignQueueMessage,
  handlers: {
    process: typeof processAudienceCampaignDelivery;
    fail: typeof failAudienceCampaignDelivery;
  } = {
    process: processAudienceCampaignDelivery,
    fail: failAudienceCampaignDelivery,
  },
) {
  try {
    await handlers.process(message.body.campaignId);
    message.ack();
    return "acked" as const;
  } catch (error) {
    const retryable = !(error instanceof CampaignDeliveryError) || error.retryable;
    if (retryable && message.attempts < 8) {
      message.retry({ delaySeconds: Math.min(900, 30 * 2 ** Math.max(0, message.attempts - 1)) });
      return "retrying" as const;
    }
    await handlers.fail(message.body.campaignId, error);
    message.retry();
    return "failed" as const;
  }
}

const encoder = new TextEncoder();

function appUrl() {
  return configuredAppOrigin(process.env.VITE_APP_URL);
}

function base64UrlEncode(value: Uint8Array | string) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signingKey() {
  const secret = process.env.EMAIL_SIGNING_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("EMAIL_SIGNING_SECRET must contain at least 32 characters.");
  }
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createEmailPreferenceToken(input: { userId: string; email: string }) {
  const payload = base64UrlEncode(
    JSON.stringify({
      userId: input.userId,
      email: input.email.toLowerCase(),
      exp: Date.now() + 1000 * 60 * 60 * 24 * 365,
    }),
  );
  const signature = await crypto.subtle.sign("HMAC", await signingKey(), encoder.encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function createAudienceUnsubscribeToken(input: {
  creatorId: string;
  contactId: string;
  email: string;
}) {
  const payload = base64UrlEncode(
    JSON.stringify({
      creatorId: input.creatorId,
      contactId: input.contactId,
      email: input.email.toLowerCase(),
      exp: Date.now() + 1000 * 60 * 60 * 24 * 365,
    }),
  );
  const signature = await crypto.subtle.sign("HMAC", await signingKey(), encoder.encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function createNewsletterUnsubscribeToken(input: {
  publicationId: string;
  subscriptionId: string;
  email: string;
}) {
  const payload = base64UrlEncode(
    JSON.stringify({
      publicationId: input.publicationId,
      subscriptionId: input.subscriptionId,
      email: input.email.toLowerCase(),
      exp: Date.now() + 1000 * 60 * 60 * 24 * 365,
    }),
  );
  const signature = await crypto.subtle.sign("HMAC", await signingKey(), encoder.encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function createNewsletterConfirmationToken(input: {
  publicationId: string;
  subscriptionId: string;
  confirmationNonce: string;
  email: string;
}) {
  const payload = base64UrlEncode(
    JSON.stringify({
      publicationId: input.publicationId,
      subscriptionId: input.subscriptionId,
      confirmationNonce: input.confirmationNonce,
      email: input.email.toLowerCase(),
      exp: Date.now() + 1000 * 60 * 60 * 24 * 7,
    }),
  );
  const signature = await crypto.subtle.sign("HMAC", await signingKey(), encoder.encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyNewsletterConfirmationToken(token: string) {
  const parts = token.split(".");
  if (parts.length !== 2 || token.length > 2_048) return null;
  const [payload, signature] = parts;
  if (!payload || !signature) return null;
  try {
    const signatureBytes = base64UrlDecode(signature);
    const payloadBytes = base64UrlDecode(payload);
    if (base64UrlEncode(signatureBytes) !== signature || base64UrlEncode(payloadBytes) !== payload)
      return null;
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await signingKey(),
        signatureBytes,
        encoder.encode(payload),
      ))
    )
      return null;
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as {
      publicationId?: string;
      subscriptionId?: string;
      confirmationNonce?: string;
      email?: string;
      exp?: number;
    };
    if (
      !parsed.publicationId ||
      !/^[0-9a-f-]{36}$/i.test(parsed.publicationId) ||
      !parsed.subscriptionId ||
      !/^[0-9a-f-]{36}$/i.test(parsed.subscriptionId) ||
      !parsed.confirmationNonce ||
      !/^[0-9a-f-]{36}$/i.test(parsed.confirmationNonce) ||
      !parsed.email ||
      parsed.email.length > 254 ||
      !parsed.exp ||
      parsed.exp < Date.now()
    )
      return null;
    return {
      publicationId: parsed.publicationId,
      subscriptionId: parsed.subscriptionId,
      confirmationNonce: parsed.confirmationNonce,
      email: parsed.email.toLowerCase(),
    };
  } catch {
    return null;
  }
}

export async function prepareEmailPayloadForDelivery(input: {
  eventType: BentoEmailEvent;
  recipientEmail: string;
  payload: Record<string, unknown> | null;
}) {
  const payload = input.payload ?? {};
  if (input.eventType !== "newsletter_subscription_confirmation") return payload;
  const publicationId = String(payload.publicationId ?? "");
  const subscriptionId = String(payload.subscriptionId ?? "");
  const confirmationNonce = String(payload.confirmationNonce ?? "");
  const creatorUsername = String(payload.creatorUsername ?? "").trim();
  const email = normalizeEmailRecipient(String(payload.email ?? ""));
  if (
    !/^[0-9a-f-]{36}$/i.test(publicationId) ||
    !/^[0-9a-f-]{36}$/i.test(subscriptionId) ||
    !/^[0-9a-f-]{36}$/i.test(confirmationNonce) ||
    !creatorUsername ||
    creatorUsername.length > 64 ||
    !email ||
    email !== normalizeEmailRecipient(input.recipientEmail)
  )
    throw new Error("Newsletter confirmation payload is invalid.");
  const token = await createNewsletterConfirmationToken({
    publicationId,
    subscriptionId,
    confirmationNonce,
    email,
  });
  return {
    ...payload,
    confirmationUrl: `${appUrl()}${publicNewsletterPath(creatorUsername)}?confirm=${encodeURIComponent(token)}`,
  };
}

export async function verifyEmailPreferenceToken(token: string) {
  const parts = token.split(".");
  if (parts.length !== 2 || token.length > 2_048) return null;
  const [payload, signature] = parts;
  if (!payload || !signature) return null;
  try {
    const signatureBytes = base64UrlDecode(signature);
    const payloadBytes = base64UrlDecode(payload);
    // Reject alternate/non-canonical encodings so the signed token has exactly
    // one textual representation in links, logs, and abuse controls.
    if (base64UrlEncode(signatureBytes) !== signature || base64UrlEncode(payloadBytes) !== payload)
      return null;
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(),
      signatureBytes,
      encoder.encode(payload),
    );
    if (!valid) return null;
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as {
      userId?: string;
      creatorId?: string;
      contactId?: string;
      publicationId?: string;
      subscriptionId?: string;
      email?: string;
      exp?: number;
    };
    if (!parsed.email || !parsed.exp || parsed.exp < Date.now() || parsed.email.length > 254)
      return null;
    if (
      parsed.publicationId &&
      parsed.subscriptionId &&
      /^[0-9a-f-]{36}$/i.test(parsed.publicationId) &&
      /^[0-9a-f-]{36}$/i.test(parsed.subscriptionId)
    ) {
      return {
        kind: "newsletter" as const,
        publicationId: parsed.publicationId,
        subscriptionId: parsed.subscriptionId,
        email: parsed.email.toLowerCase(),
      };
    }
    if (
      parsed.creatorId &&
      parsed.contactId &&
      /^[0-9a-f-]{36}$/i.test(parsed.creatorId) &&
      /^[0-9a-f-]{36}$/i.test(parsed.contactId)
    ) {
      return {
        kind: "audience" as const,
        creatorId: parsed.creatorId,
        contactId: parsed.contactId,
        email: parsed.email.toLowerCase(),
      };
    }
    if (!parsed.userId || !/^[0-9a-f-]{36}$/i.test(parsed.userId)) return null;
    return { kind: "account" as const, userId: parsed.userId, email: parsed.email.toLowerCase() };
  } catch {
    return null;
  }
}

function resendReady() {
  const mode = process.env.EMAIL_DELIVERY_MODE || "disabled";
  return Boolean(
    mode !== "disabled" &&
    process.env.RESEND_API_KEY?.trim() &&
    process.env.RESEND_FROM_EMAIL?.trim() &&
    process.env.EMAIL_SIGNING_SECRET?.trim(),
  );
}

export function getEmailDeliveryReadiness() {
  return {
    ready: resendReady(),
    mode: process.env.EMAIL_DELIVERY_MODE || "disabled",
  };
}

export async function marketingAllowedForOutbox(row: EmailOutboxRow) {
  if (row.category !== "marketing") return true;
  if (row.event_key.startsWith("audience-campaign:")) return true;
  const db = supabaseAdmin as any;
  const { data: suppression, error: suppressionError } = await db
    .from("email_suppressions")
    .select("email")
    .eq("email", row.recipient_email.toLowerCase())
    .maybeSingle();
  if (suppressionError) throw new Error(suppressionError.message);
  if (suppression) return false;
  const audienceContactId =
    typeof row.payload?.audienceContactId === "string" ? row.payload.audienceContactId : null;
  const creatorId = typeof row.payload?.creatorId === "string" ? row.payload.creatorId : null;
  if (audienceContactId && creatorId) {
    const { data: contact, error: contactError } = await db
      .from("audience_contacts")
      .select("email_normalized, marketing_status")
      .eq("id", audienceContactId)
      .eq("creator_id", creatorId)
      .maybeSingle();
    if (contactError) throw new Error(contactError.message);
    if (
      !contact ||
      contact.marketing_status !== "subscribed" ||
      contact.email_normalized !== row.recipient_email.toLowerCase()
    ) {
      return false;
    }
    return true;
  }
  if (!row.user_id) return false;
  const { data, error } = await db
    .from("email_preferences")
    .select("product_updates, weekly_digest, marketing_unsubscribed_at")
    .eq("user_id", row.user_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return true;
  if (data.marketing_unsubscribed_at) return false;
  return row.event_type === "weekly_digest"
    ? Boolean(data.weekly_digest)
    : Boolean(data.product_updates);
}

async function audienceCampaignDeliveryAuthorized(row: EmailOutboxRow) {
  if (!row.event_key.startsWith("audience-campaign:")) return true;
  const { data, error } = await (supabaseAdmin as any).rpc("authorize_audience_campaign_delivery", {
    p_outbox_id: row.id,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

async function updateOutbox(id: string, patch: Record<string, unknown>) {
  const { error } = await (supabaseAdmin as any).from("email_outbox").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
}

async function updateCampaignRecipientForOutbox(id: string, patch: Record<string, unknown>) {
  const { error } = await (supabaseAdmin as any).rpc("update_audience_campaign_recipient_status", {
    p_email_outbox_id: id,
    p_status: String(patch.status || ""),
    p_skip_reason: typeof patch.skip_reason === "string" ? patch.skip_reason : null,
  });
  if (error) throw new Error(error.message);
}

export function resolveEmailDeliveryEnvelope(input: {
  mode: string;
  originalRecipient: string;
  testRecipient?: string;
  subject: string;
}) {
  if (input.mode === "sandbox" && !input.testRecipient) {
    throw new Error("RESEND_TEST_RECIPIENT is required in sandbox mode.");
  }
  const diagnosticHeaders: Record<string, string> =
    input.mode === "sandbox"
      ? {
          "X-Bento-Environment": "staging",
          "X-Bento-Original-Recipient": input.originalRecipient,
        }
      : {};
  return {
    recipient: input.mode === "sandbox" ? input.testRecipient! : input.originalRecipient,
    subject: input.subject,
    diagnosticHeaders,
  };
}

async function sendWithResend(row: EmailOutboxRow) {
  if (!(await marketingAllowedForOutbox(row))) {
    await updateOutbox(row.id, {
      status: "suppressed",
      last_error: "Marketing preference is off.",
    });
    await updateCampaignRecipientForOutbox(row.id, {
      status: "suppressed",
      skip_reason: "Marketing preference is off.",
    });
    return false;
  }
  const mode = process.env.EMAIL_DELIVERY_MODE || "disabled";
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM_EMAIL?.trim();
  if (!apiKey || !from || mode === "disabled")
    throw new Error("Resend delivery is not configured.");
  let unsubscribeUrl: string | undefined;
  if (row.category === "marketing") {
    const token =
      typeof row.payload?.newsletterPublicationId === "string" &&
      typeof row.payload?.newsletterSubscriptionId === "string"
        ? await createNewsletterUnsubscribeToken({
            publicationId: row.payload.newsletterPublicationId,
            subscriptionId: row.payload.newsletterSubscriptionId,
            email: row.recipient_email,
          })
        : typeof row.payload?.audienceContactId === "string" &&
            typeof row.payload?.creatorId === "string"
          ? await createAudienceUnsubscribeToken({
              contactId: row.payload.audienceContactId,
              creatorId: row.payload.creatorId,
              email: row.recipient_email,
            })
          : row.user_id
            ? await createEmailPreferenceToken({
                userId: row.user_id,
                email: row.recipient_email,
              })
            : "";
    unsubscribeUrl = `${appUrl()}/api/email/unsubscribe?token=${encodeURIComponent(token)}`;
  }
  const deliveryPayload = await prepareEmailPayloadForDelivery({
    eventType: row.event_type,
    recipientEmail: row.recipient_email,
    payload: row.payload,
  });
  const rendered = renderBentoEmail({
    eventType: row.event_type,
    category: row.category,
    recipientName: row.recipient_name,
    payload: deliveryPayload,
    appUrl: appUrl(),
    publicUrl: configuredPublicOrigin(process.env.VITE_PUBLIC_URL),
    unsubscribeUrl,
  });
  const testRecipient = process.env.RESEND_TEST_RECIPIENT?.trim();
  const delivery = resolveEmailDeliveryEnvelope({
    mode,
    originalRecipient: row.recipient_email,
    testRecipient,
    subject: rendered.subject,
  });
  const headers: Record<string, string> = { ...delivery.diagnosticHeaders };
  if (unsubscribeUrl) {
    headers["List-Unsubscribe"] = `<${unsubscribeUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  if (!(await audienceCampaignDeliveryAuthorized(row))) return false;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "idempotency-key": row.event_key,
    },
    body: JSON.stringify({
      from,
      to: [delivery.recipient],
      ...(normalizeEmailRecipient(String(row.payload?.replyTo || "")) ||
      process.env.RESEND_REPLY_TO?.trim()
        ? {
            reply_to:
              normalizeEmailRecipient(String(row.payload?.replyTo || "")) ||
              process.env.RESEND_REPLY_TO!.trim(),
          }
        : {}),
      subject: delivery.subject,
      html: rendered.html,
      text: rendered.text,
      headers,
      tags: rendered.tags,
    }),
  });
  const result = (await response.json().catch(() => ({}))) as {
    id?: string;
    message?: string;
    error?: { message?: string };
  };
  if (!response.ok || !result.id) {
    throw new Error(
      result.message || result.error?.message || `Resend returned ${response.status}.`,
    );
  }
  await updateOutbox(row.id, {
    status: "sent",
    provider_email_id: result.id,
    sent_at: new Date().toISOString(),
    last_error: null,
  });
  await updateCampaignRecipientForOutbox(row.id, { status: "sent", skip_reason: null });
  return true;
}

async function failDelivery(row: EmailOutboxRow, error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown email delivery error";
  const failed = row.attempts >= 5;
  const delayMinutes = Math.min(60, 2 ** Math.max(0, row.attempts - 1));
  await updateOutbox(row.id, {
    status: failed ? "failed" : "pending",
    available_at: new Date(Date.now() + delayMinutes * 60_000).toISOString(),
    last_error: message.slice(0, 1_000),
  });
  if (failed) {
    await updateCampaignRecipientForOutbox(row.id, { status: "failed", skip_reason: message });
  }
}

export async function processEmailOutbox(limit = 25) {
  if (!resendReady()) return { claimed: 0, sent: 0, configured: false };
  const db = supabaseAdmin as any;
  const { data, error } = await db.rpc("claim_email_outbox", { p_limit: limit });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as EmailOutboxRow[];
  let sent = 0;
  for (const row of rows) {
    try {
      if (await sendWithResend(row)) sent += 1;
    } catch (deliveryError) {
      console.error(`[email] failed ${row.event_key}`, deliveryError);
      await failDelivery(row, deliveryError);
    }
  }
  return { claimed: rows.length, sent, configured: true };
}

export async function enqueueLifecycleEmails() {
  const { data, error } = await (supabaseAdmin as any).rpc("enqueue_due_lifecycle_emails");
  if (error) throw new Error(error.message);
  return Number(data || 0);
}

export type EnqueueEmailInput = {
  eventKey: string;
  eventType: BentoEmailEvent;
  category?: BentoEmailCategory;
  recipientEmail: string;
  recipientName?: string | null;
  userId?: string | null;
  payload?: Record<string, unknown>;
  immediate?: boolean;
};

export async function enqueueEmail(input: EnqueueEmailInput) {
  const recipientEmail = normalizeEmailRecipient(input.recipientEmail);
  if (!recipientEmail) {
    console.warn(`[email] skipped invalid recipient for ${input.eventType}`);
    return null;
  }
  const db = supabaseAdmin as any;
  const eventKey = input.eventKey.slice(0, 240);
  const { data: inserted, error } = await db
    .from("email_outbox")
    .upsert(
      {
        event_key: eventKey,
        event_type: input.eventType,
        category: input.category ?? "transactional",
        recipient_email: recipientEmail,
        recipient_name: input.recipientName?.trim() || null,
        user_id: input.userId ?? null,
        payload: input.payload ?? {},
      },
      { onConflict: "event_key", ignoreDuplicates: true },
    )
    .select("id,event_key")
    .maybeSingle();
  if (error) throw new Error(error.message);
  let row = inserted;
  if (!row) {
    const { data, error: readError } = await db
      .from("email_outbox")
      .select("id,event_key")
      .eq("event_key", eventKey)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    row = data;
  }
  if (input.immediate && row?.id) {
    const queue = (globalThis.__env__ as { EMAIL_QUEUE?: Queue<EmailQueueMessage> } | undefined)
      ?.EMAIL_QUEUE;
    try {
      await queue?.send({ kind: "email_outbox_kick", outboxId: row.id });
    } catch (queueError) {
      // The minute cron remains the safety net when the queue is unavailable.
      console.error("[email] delivery kick deferred to scheduled retry", queueError);
    }
  }
  return row?.id ?? null;
}

export async function enqueueEmailBatch(inputs: EnqueueEmailInput[]) {
  if (!inputs.length) return { rows: [], skipped: 0 };
  const outboxInputs = inputs.flatMap((input) => {
    const recipientEmail = normalizeEmailRecipient(input.recipientEmail);
    if (!recipientEmail) return [];
    return [
      {
        event_key: input.eventKey.slice(0, 240),
        event_type: input.eventType,
        category: input.category ?? "transactional",
        recipient_email: recipientEmail,
        recipient_name: input.recipientName?.trim() || null,
        user_id: input.userId ?? null,
        payload: input.payload ?? {},
      },
    ];
  });
  if (!outboxInputs.length) return { rows: [], skipped: inputs.length };

  const db = supabaseAdmin as any;
  const selectedRows: Array<{ id: string; event_key: string }> = [];
  for (let offset = 0; offset < outboxInputs.length; offset += 50) {
    const chunk = outboxInputs.slice(offset, offset + 50);
    const { error } = await db
      .from("email_outbox")
      .upsert(chunk, {
        onConflict: "event_key",
        ignoreDuplicates: true,
      })
      .select("id,event_key");
    if (error) throw new Error(error.message);
    const { data, error: readError } = await db
      .from("email_outbox")
      .select("id,event_key")
      .in(
        "event_key",
        chunk.map((row) => row.event_key),
      );
    if (readError) throw new Error(readError.message);
    selectedRows.push(...(data ?? []));
  }

  const byEventKey = new Map(selectedRows.map((row) => [row.event_key, row.id]));
  const rows = outboxInputs.flatMap((row) => {
    const id = byEventKey.get(row.event_key);
    return id ? [{ id, eventKey: row.event_key }] : [];
  });
  if (rows[0] && inputs.some((input) => input.immediate)) {
    const queue = (globalThis.__env__ as { EMAIL_QUEUE?: Queue<EmailQueueMessage> } | undefined)
      ?.EMAIL_QUEUE;
    try {
      await queue?.send({ kind: "email_outbox_kick", outboxId: rows[0].id });
    } catch (queueError) {
      console.error("[email] batch delivery kick deferred to scheduled retry", queueError);
    }
  }
  return { rows, skipped: inputs.length - outboxInputs.length };
}

export async function getCreatorEmailCapacity(creatorId: string) {
  const { data, error } = await (supabaseAdmin as any).rpc("email_marketing_capacity", {
    p_creator_id: creatorId,
  });
  if (error) throw new Error(error.message);
  const plan = data?.plan;
  const limit = Number(data?.limit);
  const subscribed = Number(data?.subscribed);
  const remaining = Number(data?.remaining);
  if (
    !["free", "store", "creator"].includes(plan) ||
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    !Number.isSafeInteger(subscribed) ||
    subscribed < 0 ||
    !Number.isSafeInteger(remaining) ||
    remaining < 0
  ) {
    throw new Error("Email marketing contact capacity snapshot is invalid.");
  }
  return { plan, limit, subscribed, remaining, overLimit: subscribed > limit } as const;
}

type EmailMarketingCapacityBlockSource =
  | "public_capture"
  | "csv_import"
  | "newsletter_confirmation"
  | "lead_form_consent"
  | "schedule"
  | "delivery";

type EmailMarketingCapacityError = {
  code?: unknown;
  message?: unknown;
  details?: unknown;
};

export async function recordEmailMarketingCapacityBlock(input: {
  source: EmailMarketingCapacityBlockSource;
  creatorId?: string;
  subscribed?: number;
  limit?: number;
  error?: EmailMarketingCapacityError;
}) {
  let { creatorId, subscribed, limit } = input;
  if (input.error) {
    if (
      input.error.code !== "P0001" ||
      input.error.message !==
        "Email marketing contact allowance reached. Upgrade capacity or archive subscribed contacts."
    ) {
      return false;
    }
    try {
      const details =
        typeof input.error.details === "string"
          ? JSON.parse(input.error.details)
          : input.error.details;
      if (!details || typeof details !== "object" || Array.isArray(details)) return false;
      const capacity = details as Record<string, unknown>;
      creatorId ??= typeof capacity.creator_id === "string" ? capacity.creator_id : undefined;
      subscribed ??= Number(capacity.subscribed);
      limit ??= Number(capacity.limit);
    } catch {
      return false;
    }
  }
  if (
    !creatorId ||
    typeof subscribed !== "number" ||
    !Number.isSafeInteger(subscribed) ||
    subscribed < 0 ||
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 0
  ) {
    return false;
  }
  await captureServerEvent(creatorId, "email_marketing_contact_capacity_blocked", {
    source: input.source,
    subscribed_contacts: subscribed,
    contact_limit: limit,
  });
  return true;
}

async function requireCreatorEmailCapacity(creatorId: string, source: "schedule" | "delivery") {
  const capacity = await getCreatorEmailCapacity(creatorId);
  if (capacity.plan !== "creator") {
    throw new CampaignDeliveryError("Email Marketing requires the Creator plan.", false);
  }
  if (!capacity.overLimit) return capacity;
  await recordEmailMarketingCapacityBlock({
    creatorId,
    source,
    subscribed: capacity.subscribed,
    limit: capacity.limit,
  });
  throw new CampaignDeliveryError(
    `Your audience exceeds your contact allowance (${capacity.subscribed} of ${capacity.limit}). Upgrade capacity or archive subscribed contacts before sending.`,
    false,
  );
}

export async function enqueueDueAudienceCampaigns(
  queue = (globalThis.__env__ as { EMAIL_QUEUE?: Queue<EmailQueueMessage> } | undefined)
    ?.EMAIL_QUEUE,
  campaignId: string | null = null,
) {
  if (!queue) return { claimed: 0, queued: 0, configured: false };
  const { data, error } = await (supabaseAdmin as any).rpc("claim_due_audience_campaigns", {
    p_limit: 25,
    p_campaign_id: campaignId,
  });
  if (error) throw new Error(error.message);
  const campaigns = (data ?? []) as Array<{
    id: string;
    creator_id: string;
    publication_id: string | null;
    kind: "broadcast" | "newsletter";
    publish_on_delivery: boolean;
  }>;
  let queued = 0;
  let dispatchError: unknown = null;
  for (const campaign of campaigns) {
    try {
      await queue.send({ kind: "audience_campaign", campaignId: campaign.id });
      queued += 1;
    } catch (queueError) {
      const failure =
        queueError instanceof Error ? queueError : new Error("Queue dispatch failed.");
      const message = failure.message;
      const statusPatch =
        campaign.kind === "broadcast"
          ? { status: "failed" }
          : campaign.publish_on_delivery
            ? { status: "draft", published_at: null }
            : {};
      let reconciliation = (supabaseAdmin as any)
        .from("audience_campaigns")
        .update({
          delivery_status: "failed",
          delivery_error: message.slice(0, 500),
          ...statusPatch,
        })
        .eq("id", campaign.id)
        .eq("creator_id", campaign.creator_id)
        .eq("kind", campaign.kind)
        .eq("delivery_status", "sending");
      reconciliation = campaign.publication_id
        ? reconciliation.eq("publication_id", campaign.publication_id)
        : reconciliation.is("publication_id", null);
      const { data: reconciled, error: reconciliationError } = await reconciliation
        .select("id")
        .maybeSingle();
      if (reconciliationError || !reconciled) {
        dispatchError ??= new Error(
          `${message} Delivery reconciliation failed: ${reconciliationError?.message || "claimed campaign not found"}`,
        );
      } else {
        dispatchError ??= failure;
      }
    }
  }
  if (dispatchError) throw dispatchError;
  return { claimed: campaigns.length, queued, configured: true };
}

export async function scheduleAudienceCampaignForCreator(input: {
  creatorId: string;
  campaignId: string;
  publicationId?: string;
  kind: "broadcast" | "newsletter";
  scheduledAt: string | null;
  publish?: boolean;
}) {
  if (input.publish && !input.publicationId) throw new Error("Newsletter publication is required.");
  const scheduledDate = input.scheduledAt ? new Date(input.scheduledAt) : new Date();
  if (!Number.isFinite(scheduledDate.getTime())) throw new Error("Use a valid ISO schedule time.");
  if (input.scheduledAt && scheduledDate.getTime() <= Date.now()) {
    throw new Error("Scheduled delivery must be in the future.");
  }
  const scheduledAt = scheduledDate.toISOString();
  await requireCreatorEmailCapacity(input.creatorId, "schedule");
  const db = supabaseAdmin as any;
  let query = db
    .from("audience_campaigns")
    .update({
      delivery_status: "scheduled",
      delivery_error: null,
      scheduled_at: scheduledAt,
      publish_on_delivery: Boolean(input.publish),
      ...(input.kind === "broadcast" ? { status: "scheduled" } : {}),
    })
    .eq("id", input.campaignId)
    .eq("creator_id", input.creatorId)
    .eq("kind", input.kind);
  if (input.publicationId) query = query.eq("publication_id", input.publicationId);
  query =
    input.kind === "newsletter"
      ? query
          .eq("status", input.publish ? "draft" : "published")
          .in("delivery_status", ["draft", "failed"])
      : query.not("sender_postal_address", "is", null).in("status", ["draft", "failed"]);
  const { data: campaign, error } = await query.select("id").maybeSingle();
  if (error) throw new Error(error.message);
  if (!campaign) throw new Error("Campaign is not ready for delivery.");

  const failSchedule = async (message: string) => {
    let reconciliation = db
      .from("audience_campaigns")
      .update({
        delivery_status: "failed",
        delivery_error: message.slice(0, 500),
        ...(input.kind === "broadcast" ? { status: "failed" } : {}),
        ...(input.kind === "newsletter" && input.publish
          ? { status: "draft", published_at: null }
          : {}),
      })
      .eq("id", input.campaignId)
      .eq("creator_id", input.creatorId)
      .eq("kind", input.kind);
    if (input.publicationId)
      reconciliation = reconciliation.eq("publication_id", input.publicationId);
    const { error: reconciliationError } = await reconciliation
      .in("delivery_status", ["scheduled", "sending"])
      .select("id")
      .maybeSingle();
    if (reconciliationError)
      throw new Error(`${message} Delivery reconciliation failed: ${reconciliationError.message}`);
  };

  let result: { queued: number; scheduledAt: string | null };
  try {
    if (input.scheduledAt) {
      result = { queued: 0, scheduledAt };
    } else {
      const queued = await enqueueDueAudienceCampaigns(undefined, input.campaignId);
      if (!queued.configured) throw new Error("Email delivery queue is unavailable.");
      if (queued.queued !== 1) throw new Error("Campaign delivery claim was not accepted.");
      result = { queued: queued.queued, scheduledAt: null };
    }
  } catch (schedulerError) {
    const message =
      schedulerError instanceof Error ? schedulerError.message : "Delivery scheduling failed.";
    await failSchedule(message);
    throw schedulerError;
  }

  return result;
}

type AudienceCampaignDeliveryRow = {
  id: string;
  creator_id: string;
  name: string;
  kind: "broadcast" | "newsletter";
  publication_id: string | null;
  subject: string;
  preview_text: string;
  body_markdown: string;
  content: unknown;
  web_visibility: "private" | "public" | "paid";
  sender_postal_address: string | null;
  status: string;
  delivery_status: string;
  template_id: string | null;
};

export function validateCampaignDeliveryAccounting(input: {
  prepared: number;
  rows: number;
  skipped: number;
  linked: number;
}) {
  if (
    input.rows + input.skipped !== input.prepared ||
    input.linked + input.skipped !== input.prepared
  ) {
    throw new CampaignDeliveryError(
      "Every prepared recipient must be linked or explicitly skipped.",
      false,
    );
  }
  return input;
}

export async function processAudienceCampaignDelivery(campaignId: string) {
  const db = supabaseAdmin as any;
  const { data: campaign, error: campaignError } = await db
    .from("audience_campaigns")
    .select("*")
    .eq("id", campaignId)
    .eq("delivery_status", "sending")
    .maybeSingle();
  if (campaignError) throw new Error(campaignError.message);
  if (!campaign) {
    const { data: state, error: stateError } = await db
      .from("audience_campaigns")
      .select("delivery_status,delivery_error")
      .eq("id", campaignId)
      .maybeSingle();
    if (stateError) throw new Error(stateError.message);
    if (state?.delivery_status === "failed") {
      throw new CampaignDeliveryError(state.delivery_error || "Campaign delivery failed.", false);
    }
    if (state?.delivery_status === "scheduled" || state?.delivery_status === "sending") {
      throw new CampaignDeliveryError("Campaign delivery claim is not ready.");
    }
    return { recipients: 0, linked: 0 };
  }
  const delivery = campaign as AudienceCampaignDeliveryRow;
  if (delivery.kind === "newsletter" && delivery.status !== "published") {
    throw new CampaignDeliveryError("Newsletter campaign is not published.", false);
  }

  const { data: contacts, error: recipientError } = await db.rpc(
    "prepare_audience_campaign_recipients_with_capacity",
    { p_campaign_id: campaignId },
  );
  if (recipientError) {
    if (
      await recordEmailMarketingCapacityBlock({
        creatorId: delivery.creator_id,
        source: "delivery",
        error: recipientError,
      })
    ) {
      throw new CampaignDeliveryError(
        "Your audience exceeds your contact allowance. Upgrade capacity or archive subscribed contacts before sending.",
        false,
      );
    }
    if (recipientError.message === "Email Marketing requires the Creator plan.") {
      throw new CampaignDeliveryError(recipientError.message, false);
    }
    throw new Error(recipientError.message);
  }
  const recipients = (contacts ?? []) as Array<{
    contact_id: string;
    subscription_id: string | null;
    email: string;
    name: string | null;
  }>;
  if (!recipients.length) {
    const { data: aggregateStatus, error: aggregateError } = await db.rpc(
      "refresh_audience_campaign_delivery",
      { p_campaign_id: campaignId },
    );
    if (aggregateError) throw new Error(aggregateError.message);
    if (aggregateStatus !== "sending") return { recipients: 0, linked: 0 };
    throw new CampaignDeliveryError("There are no eligible subscribed recipients.", false);
  }

  const [{ data: profile, error: profileError }, publicationResult] = await Promise.all([
    db.from("profiles").select("username,display_name").eq("id", delivery.creator_id).maybeSingle(),
    delivery.kind === "newsletter" && delivery.publication_id
      ? db
          .from("newsletter_publications")
          .select("sender_name,reply_to_email,accent_color,logo_url,paid_product_id,postal_address")
          .eq("id", delivery.publication_id)
          .eq("creator_id", delivery.creator_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (profileError) throw new Error(profileError.message);
  if (publicationResult.error) throw new Error(publicationResult.error.message);
  if (!profile) throw new CampaignDeliveryError("Campaign creator profile was not found.", false);
  const postalAddress = String(
    delivery.kind === "newsletter"
      ? publicationResult.data?.postal_address || ""
      : delivery.sender_postal_address || "",
  ).trim();
  if (!postalAddress) {
    throw new CampaignDeliveryError("Add a sender postal address before sending.", false);
  }

  let newsletterContent: NewsletterContentBlock[] | null = null;
  let newsletterProducts: Array<{
    id: string;
    title: string;
    description: string | null;
    url: string;
    priceAmount: number;
    currency: string;
    billingInterval: string | null;
  }> = [];
  if (
    delivery.kind === "newsletter" ||
    (Array.isArray(delivery.content) && delivery.content.length > 0)
  ) {
    const parsed = newsletterContentSchema.safeParse(delivery.content);
    if (!parsed.success) throw new CampaignDeliveryError("Newsletter content is invalid.", false);
    newsletterContent = parsed.data;
    const productIds = Array.from(
      new Set(parsed.data.flatMap((block) => (block.type === "product" ? [block.productId] : []))),
    );
    if (productIds.length) {
      const { data: products, error: productError } = await db
        .from("commerce_products")
        .select("id,title,description,public_slug,price_amount,currency,billing_interval")
        .eq("creator_id", delivery.creator_id)
        .eq("status", "published")
        .in("id", productIds);
      if (productError) throw new Error(productError.message);
      newsletterProducts = (products ?? []).flatMap(
        (product: {
          id: string;
          title: string;
          description: string | null;
          public_slug: string | null;
          price_amount: number;
          currency: string;
          billing_interval: string | null;
        }) =>
          profile.username && product.public_slug
            ? [
                {
                  id: product.id,
                  title: product.title,
                  description: product.description,
                  url: new URL(
                    publicProductPath(profile.username, product.public_slug),
                    configuredPublicOrigin(process.env.VITE_PUBLIC_URL),
                  ).toString(),
                  priceAmount: product.price_amount,
                  currency: product.currency,
                  billingInterval: product.billing_interval,
                },
              ]
            : [],
      );
    }
  }

  const creatorName =
    publicationResult.data?.sender_name ||
    profile.display_name ||
    profile.username ||
    "A Bento creator";
  const publicOrigin = configuredPublicOrigin(process.env.VITE_PUBLIC_URL);
  const creatorUrl = profile.username
    ? `${publicOrigin}/@${encodeURIComponent(profile.username)}`
    : publicOrigin;
  const subscriptionByContact = new Map<string, string>();
  if (delivery.kind === "newsletter" && delivery.publication_id) {
    const { data: subscriptions, error: subscriptionsError } = await db
      .from("newsletter_subscriptions")
      .select("id,contact_id")
      .eq("publication_id", delivery.publication_id)
      .eq("status", "subscribed")
      .eq("email_enabled", true)
      .in(
        "contact_id",
        recipients.map((recipient) => recipient.contact_id),
      );
    if (subscriptionsError) throw new Error(subscriptionsError.message);
    for (const subscription of subscriptions ?? []) {
      subscriptionByContact.set(subscription.contact_id, subscription.id);
    }
    if (subscriptionByContact.size !== recipients.length) {
      throw new CampaignDeliveryError("Newsletter subscription linkage is incomplete.", false);
    }
  }
  const batch = await enqueueEmailBatch(
    recipients.map((contact) => ({
      eventKey: `audience-campaign:${campaignId}:${contact.contact_id}`,
      eventType: "creator_campaign",
      category: "marketing",
      recipientEmail: contact.email,
      recipientName: contact.name,
      payload: {
        audienceContactId: contact.contact_id,
        creatorId: delivery.creator_id,
        creatorName,
        creatorUrl,
        postTitle: delivery.name,
        subject: delivery.subject,
        previewText: delivery.preview_text,
        body: delivery.body_markdown,
        postalAddress,
        ...(publicationResult.data?.reply_to_email
          ? { replyTo: publicationResult.data.reply_to_email }
          : {}),
        ...(newsletterContent
          ? {
              newsletterContent,
              newsletterProducts,
              newsletterPublicationId: delivery.publication_id,
              newsletterTemplateId: delivery.template_id,
              newsletterLogoUrl: publicationResult.data?.logo_url || null,
              newsletterSubscriptionId: subscriptionByContact.get(contact.contact_id),
              newsletterVisibility: delivery.web_visibility,
              ...(delivery.web_visibility === "paid" && publicationResult.data?.paid_product_id
                ? { newsletterPaidProductId: publicationResult.data.paid_product_id }
                : {}),
            }
          : {}),
      },
    })),
  );
  const outboxByEventKey = new Map(batch.rows.map((row) => [row.eventKey, row.id]));
  const droppedContacts = recipients.filter(
    (contact) => !outboxByEventKey.has(`audience-campaign:${campaignId}:${contact.contact_id}`),
  );
  if (batch.skipped !== droppedContacts.length) {
    throw new CampaignDeliveryError(
      "Campaign outbox accounting did not match skipped recipients.",
      false,
    );
  }

  let explicitlySkipped = 0;
  if (droppedContacts.length) {
    const { data: skipped, error: skipError } = await db.rpc("skip_audience_campaign_recipients", {
      p_campaign_id: campaignId,
      p_contact_ids: droppedContacts.map((contact) => contact.contact_id),
      p_reason: "Recipient email was invalid at delivery time.",
    });
    if (skipError) throw new Error(skipError.message);
    explicitlySkipped = Number(skipped || 0);
  }

  const links = recipients.flatMap((contact) => {
    const eventKey = `audience-campaign:${campaignId}:${contact.contact_id}`;
    const outboxId = outboxByEventKey.get(eventKey);
    return outboxId
      ? [{ contact_id: contact.contact_id, event_key: eventKey, outbox_id: outboxId }]
      : [];
  });
  const { data: linked, error: linkError } = await db.rpc("link_audience_campaign_outbox", {
    p_campaign_id: campaignId,
    p_links: links,
  });
  if (linkError) throw new Error(linkError.message);
  validateCampaignDeliveryAccounting({
    prepared: recipients.length,
    rows: batch.rows.length,
    skipped: explicitlySkipped,
    linked: Number(linked || 0),
  });
  const linkedOutboxId = links[0]?.outbox_id;
  if (linkedOutboxId) {
    const queue = (globalThis.__env__ as { EMAIL_QUEUE?: Queue<EmailQueueMessage> } | undefined)
      ?.EMAIL_QUEUE;
    try {
      await queue?.send({ kind: "email_outbox_kick", outboxId: linkedOutboxId });
    } catch (queueError) {
      console.error("[email] campaign delivery kick deferred to scheduled retry", queueError);
    }
  }
  return { recipients: recipients.length, linked: Number(linked || 0) };
}

export async function failAudienceCampaignDelivery(campaignId: string, error: unknown) {
  const db = supabaseAdmin as any;
  const { data: campaign, error: readError } = await db
    .from("audience_campaigns")
    .select("kind")
    .eq("id", campaignId)
    .eq("delivery_status", "sending")
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!campaign) return;
  const message = error instanceof Error ? error.message : "Unknown campaign delivery error";
  const { error: updateError } = await db
    .from("audience_campaigns")
    .update({
      delivery_status: "failed",
      delivery_error: message.slice(0, 1_000),
      ...(campaign.kind === "broadcast" ? { status: "failed" } : {}),
    })
    .eq("id", campaignId)
    .eq("delivery_status", "sending");
  if (updateError) throw new Error(updateError.message);
}
async function creatorIdentity(userId: string) {
  const db = supabaseAdmin as any;
  const [{ data: auth }, { data: profile, error }] = await Promise.all([
    supabaseAdmin.auth.admin.getUserById(userId),
    db.from("profiles").select("username, display_name").eq("id", userId).maybeSingle(),
  ]);
  if (error) throw new Error(error.message);
  return {
    email: auth?.user?.email ?? null,
    name: profile?.display_name || profile?.username || null,
    username: profile?.username || "",
  };
}

export async function enqueueCreatorLeadEmail(input: {
  leadKey: string;
  creatorId: string;
  productTitle: string;
  buyerEmail: string;
  buyerName?: string | null;
}) {
  const creator = await creatorIdentity(input.creatorId);
  if (!creator.email) return null;
  return enqueueEmail({
    eventKey: `creator-lead:${input.leadKey}`,
    eventType: "creator_lead",
    recipientEmail: creator.email,
    recipientName: creator.name,
    userId: input.creatorId,
    payload: {
      productTitle: input.productTitle,
      buyerEmail: input.buyerEmail,
      buyerName: input.buyerName,
    },
    immediate: true,
  });
}

export async function enqueueCommerceOrderEmails(input: {
  orderId: string;
  accessToken?: string | null;
}) {
  const db = supabaseAdmin as any;
  const { data: order, error } = await db
    .from("commerce_orders")
    .select(
      "id, creator_id, buyer_email, buyer_name, provider, gross_amount, currency, product_id, metadata",
    )
    .eq("id", input.orderId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!order) return;
  const [{ data: product, error: productError }, creator] = await Promise.all([
    db
      .from("commerce_products")
      .select("id, title, slug, public_slug, kind, price_amount, currency, settings")
      .eq("id", order.product_id)
      .single(),
    creatorIdentity(order.creator_id),
  ]);
  if (productError || !product) throw new Error(productError?.message || "Product not found");
  const buyerAnswers = Array.isArray(order.metadata?.buyer_answers)
    ? order.metadata.buyer_answers
    : [];
  const priorityMessage =
    product.kind === "priority_dm"
      ? await recordPriorityDmOrder({ order, product, buyerAnswers })
      : null;
  const accessUrl = input.accessToken
    ? `${appUrl()}/access/${encodeURIComponent(input.accessToken)}`
    : `${appUrl()}${publicProductSuccessPath(
        creator.username,
        product.public_slug,
      )}?order=${encodeURIComponent(order.id)}`;
  await enqueueEmail({
    eventKey: `buyer-receipt:${order.id}`,
    eventType: "buyer_receipt",
    recipientEmail: order.buyer_email,
    recipientName: order.buyer_name,
    payload: {
      productTitle: product.title,
      creatorName: creator.name,
      amount: order.gross_amount,
      currency: order.currency,
      accessUrl,
    },
    immediate: true,
  });
  if (priorityMessage) {
    await enqueuePriorityDmMessageToCreatorEmail(priorityMessage);
    return;
  }
  if (creator.email) {
    await enqueueEmail({
      eventKey: `creator-sale:${order.id}`,
      eventType: "creator_sale",
      recipientEmail: creator.email,
      recipientName: creator.name,
      userId: order.creator_id,
      payload: {
        productTitle: product.title,
        buyerName: order.buyer_name,
        amount: order.gross_amount,
        currency: order.currency,
        provider: order.provider,
      },
      immediate: true,
    });
  }
}

async function priorityDmEmailContext(input: { requestId: string; messageId: string }) {
  const db = supabaseAdmin as any;
  const [{ data: message, error: messageError }, { data: request, error: requestError }] =
    await Promise.all([
      db
        .from("commerce_priority_dm_messages")
        .select("id, request_id, sender, body, notification_eligible")
        .eq("id", input.messageId)
        .eq("request_id", input.requestId)
        .maybeSingle(),
      db
        .from("commerce_priority_dm_requests")
        .select("id, product_id, creator_id, buyer_email, buyer_name")
        .eq("id", input.requestId)
        .maybeSingle(),
    ]);
  if (messageError || requestError) throw new Error(messageError?.message || requestError?.message);
  if (!message || !request) throw new Error("Saved Priority DM message not found.");
  if (message.notification_eligible === false) return null;
  const [{ data: product, error: productError }, creator] = await Promise.all([
    db.from("commerce_products").select("title").eq("id", request.product_id).single(),
    creatorIdentity(request.creator_id),
  ]);
  if (productError || !product) throw new Error(productError?.message || "Product not found.");
  return { message, request, product, creator };
}

export async function enqueuePriorityDmMessageToCreatorEmail(input: {
  requestId: string;
  messageId: string;
}) {
  const context = await priorityDmEmailContext(input);
  if (!context) return null;
  const { message, request, product, creator } = context;
  if (message.sender !== "buyer") throw new Error("Expected a saved buyer message.");
  if (!creator.email) return null;
  return enqueueEmail({
    eventKey: `priority-dm-message:${message.id}:creator`,
    eventType: "priority_dm_received",
    recipientEmail: creator.email,
    recipientName: creator.name,
    userId: request.creator_id,
    payload: {
      productTitle: product.title,
      buyerName: request.buyer_name,
      message: message.body,
      accessUrl: `${appUrl()}/priority-dm?thread=${encodeURIComponent(request.id)}`,
      replyTo: request.buyer_email,
    },
    immediate: true,
  });
}

export async function enqueuePriorityDmMessageToBuyerEmail(input: {
  requestId: string;
  messageId: string;
}) {
  const context = await priorityDmEmailContext(input);
  if (!context) return null;
  const { message, request, product, creator } = context;
  if (message.sender !== "creator") throw new Error("Expected a saved creator message.");
  const accessUrl = await issueCustomerLibraryMagicLinkForEmail({
    email: request.buyer_email,
    returnTo: `/library/priority-dm/${request.id}`,
  });
  if (!accessUrl) throw new Error("Priority DM buyer no longer has a customer identity.");
  return enqueueEmail({
    eventKey: `priority-dm-message:${message.id}:buyer`,
    eventType: "priority_dm_reply",
    recipientEmail: request.buyer_email,
    recipientName: request.buyer_name,
    payload: {
      creatorName: creator.name,
      productTitle: product.title,
      reply: message.body,
      accessUrl,
      replyTo: creator.email,
    },
    immediate: true,
  });
}

export async function reconcilePriorityDmNotifications(limit = 200) {
  const db = supabaseAdmin as any;
  const boundedLimit = Math.min(500, Math.max(1, Math.floor(limit)));
  const { data: messages, error } = await db.rpc("list_missing_priority_dm_notifications", {
    p_limit: boundedLimit,
  });
  if (error) throw new Error(error.message);
  if (!messages?.length) return { repaired: 0, failed: 0 };

  let repaired = 0;
  let failed = 0;
  for (const message of messages) {
    try {
      const input = { requestId: message.request_id, messageId: message.id };
      if (message.sender === "buyer") await enqueuePriorityDmMessageToCreatorEmail(input);
      else await enqueuePriorityDmMessageToBuyerEmail(input);
      repaired += 1;
    } catch (notificationError) {
      failed += 1;
      console.error(
        `[email] Priority DM notification repair failed for ${message.id}`,
        notificationError,
      );
    }
  }
  return { repaired, failed };
}

export async function enqueueBookingConfirmationEmails(input: { bookingId: string }) {
  const db = supabaseAdmin as any;
  const { data: booking, error } = await db
    .from("commerce_bookings")
    .select("id,creator_id,buyer_email,buyer_name,starts_at,timezone,meeting_url,product_id")
    .eq("id", input.bookingId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!booking) return;
  const [{ data: product }, creator] = await Promise.all([
    db.from("commerce_products").select("title").eq("id", booking.product_id).single(),
    creatorIdentity(booking.creator_id),
  ]);
  const bookingDate = new Intl.DateTimeFormat("en", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: booking.timezone,
  }).format(new Date(booking.starts_at));
  const common = {
    productTitle: product?.title || "session",
    creatorName: creator.name,
    buyerName: booking.buyer_name,
    bookingDate,
    meetingUrl: booking.meeting_url,
  };
  await enqueueEmail({
    eventKey: `booking-confirmed:buyer:${booking.id}`,
    eventType: "booking_confirmed",
    recipientEmail: booking.buyer_email,
    recipientName: booking.buyer_name,
    payload: common,
    immediate: true,
  });
  if (creator.email) {
    await enqueueEmail({
      eventKey: `booking-confirmed:creator:${booking.id}`,
      eventType: "booking_confirmed",
      recipientEmail: creator.email,
      recipientName: creator.name,
      userId: booking.creator_id,
      payload: common,
      immediate: true,
    });
  }
}

export async function enqueueBookingCancellationEmails(input: {
  bookingId: string;
  accessToken: string;
}) {
  const db = supabaseAdmin as any;
  const { data: booking, error } = await db
    .from("commerce_bookings")
    .select("id,creator_id,buyer_email,buyer_name,starts_at,timezone,product_id")
    .eq("id", input.bookingId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!booking) return;
  const [{ data: product }, creator] = await Promise.all([
    db.from("commerce_products").select("title").eq("id", booking.product_id).single(),
    creatorIdentity(booking.creator_id),
  ]);
  const bookingDate = new Intl.DateTimeFormat("en", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: booking.timezone,
  }).format(new Date(booking.starts_at));
  const common = {
    productTitle: product?.title || "session",
    creatorName: creator.name,
    buyerName: booking.buyer_name,
    bookingDate,
    accessUrl: `${appUrl()}/access/${encodeURIComponent(input.accessToken)}`,
  };
  await enqueueEmail({
    eventKey: `booking-canceled:buyer:${booking.id}`,
    eventType: "booking_canceled",
    recipientEmail: booking.buyer_email,
    recipientName: booking.buyer_name,
    payload: common,
    immediate: true,
  });
  if (creator.email) {
    await enqueueEmail({
      eventKey: `booking-canceled:creator:${booking.id}`,
      eventType: "booking_canceled",
      recipientEmail: creator.email,
      recipientName: creator.name,
      userId: booking.creator_id,
      payload: common,
      immediate: true,
    });
  }
}

export async function enqueueCommerceRefundEmails(input: {
  orderId: string;
  eventKey: string;
  amount?: number | null;
}) {
  const db = supabaseAdmin as any;
  const { data: order, error } = await db
    .from("commerce_orders")
    .select(
      "id, creator_id, buyer_email, buyer_name, refunded_amount, gross_amount, currency, product_id",
    )
    .eq("id", input.orderId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!order) return;
  const [{ data: product }, creator] = await Promise.all([
    db.from("commerce_products").select("title").eq("id", order.product_id).maybeSingle(),
    creatorIdentity(order.creator_id),
  ]);
  const payload = {
    productTitle: product?.title || "your purchase",
    amount: input.amount ?? order.refunded_amount ?? order.gross_amount,
    currency: order.currency,
  };
  await enqueueEmail({
    eventKey: `buyer-refund:${input.eventKey}`,
    eventType: "refund_processed",
    recipientEmail: order.buyer_email,
    recipientName: order.buyer_name,
    payload,
    immediate: true,
  });
  if (creator.email) {
    await enqueueEmail({
      eventKey: `creator-refund:${input.eventKey}`,
      eventType: "refund_processed",
      recipientEmail: creator.email,
      recipientName: creator.name,
      userId: order.creator_id,
      payload,
      immediate: true,
    });
  }
}

export async function enqueueBentoBillingEmail(input: {
  eventKey: string;
  eventType: "pro_activated" | "payment_failed" | "subscription_cancelled" | "refund_processed";
  userId: string;
  amount?: number | null;
  currency?: string | null;
}) {
  const creator = await creatorIdentity(input.userId);
  if (!creator.email) return null;
  return enqueueEmail({
    eventKey: `billing-email:${input.eventKey}`,
    eventType: input.eventType,
    recipientEmail: creator.email,
    recipientName: creator.name,
    userId: input.userId,
    payload: { amount: input.amount, currency: input.currency },
    immediate: true,
  });
}

function escapePageHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function preferencePage(message: string, success: boolean, confirmationToken?: string) {
  const confirmation = confirmationToken
    ? `<form method="post" action="/api/email/unsubscribe?token=${encodeURIComponent(confirmationToken)}"><button type="submit" style="border:0;margin-top:12px;padding:13px 18px;border-radius:14px;background:#3478f6;color:white;font:inherit;font-weight:700;cursor:pointer">Unsubscribe</button></form>`
    : `<a href="${appUrl()}" style="display:inline-block;margin-top:12px;padding:13px 18px;border-radius:14px;background:#3478f6;color:white;text-decoration:none;font-weight:700">Open Bento</a>`;
  return new Response(
    `<!doctype html><html><meta name="viewport" content="width=device-width"><title>Email preferences | bento.surf</title><body style="margin:0;display:grid;min-height:100vh;place-items:center;background:#f6f8fc;font-family:Inter,-apple-system,sans-serif;color:#17213a"><main style="max-width:520px;margin:24px;padding:34px;border:1px solid #e6eaf2;border-radius:30px;background:white;box-shadow:0 30px 80px -50px #17213a"><div style="font-weight:800;font-size:20px">bento.surf</div><div style="margin-top:28px;font-size:12px;font-weight:700;color:${success ? "#18895b" : "#d64b4b"}">${confirmationToken ? "EMAIL PREFERENCES" : success ? "PREFERENCES UPDATED" : "LINK NOT VALID"}</div><h1 style="font-size:32px;line-height:1.05;letter-spacing:-.04em">${escapePageHtml(message)}</h1><p style="color:#667085;line-height:1.6">You can also manage product updates and weekly summaries from Settings → Email.</p>${confirmation}</main></body></html>`,
    {
      status: success ? 200 : 400,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
}

export async function handleEmailUnsubscribeRequest(request: Request) {
  const token = new URL(request.url).searchParams.get("token") || "";
  const preference = await verifyEmailPreferenceToken(token);
  if (!preference) return preferencePage("This unsubscribe link has expired.", false);
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  // GET links are commonly opened by security scanners. Require an explicit
  // POST so merely checking the URL cannot change a creator's preferences.
  if (request.method === "GET") {
    return preferencePage("Stop receiving Bento marketing emails?", true, token);
  }
  const db = supabaseAdmin as any;
  const timestamp = new Date().toISOString();
  const mutation =
    preference.kind === "newsletter"
      ? await db.rpc("unsubscribe_public_newsletter_subscription", {
          p_publication_id: preference.publicationId,
          p_subscription_id: preference.subscriptionId,
          p_email: preference.email,
        })
      : preference.kind === "audience"
        ? await db.from("audience_consent_events").insert({
            creator_id: preference.creatorId,
            contact_id: preference.contactId,
            status: "unsubscribed",
            source: "email_unsubscribe",
            proof: { email: preference.email, request: "one_click" },
            occurred_at: timestamp,
          })
        : await db.from("email_preferences").upsert(
            {
              user_id: preference.userId,
              product_updates: false,
              weekly_digest: false,
              marketing_unsubscribed_at: timestamp,
            },
            { onConflict: "user_id" },
          );
  if (mutation.error || (preference.kind === "newsletter" && mutation.data !== true)) {
    return preferencePage("We couldn’t update your preferences.", false);
  }
  if (preference.kind !== "newsletter") {
    let suppressQuery = db
      .from("email_outbox")
      .update({ status: "suppressed", last_error: "Recipient unsubscribed." })
      .eq("recipient_email", preference.email)
      .eq("category", "marketing")
      .in("status", ["pending", "processing"]);
    if (preference.kind === "account")
      suppressQuery = suppressQuery.eq("user_id", preference.userId);
    await suppressQuery;
  }
  const isOneClick = request.headers
    .get("content-type")
    ?.toLowerCase()
    .startsWith("application/x-www-form-urlencoded");
  if (isOneClick && request.headers.get("list-unsubscribe") === "One-Click") {
    return new Response(null, { status: 204 });
  }
  return preferencePage("You’re unsubscribed from marketing emails.", true);
}
