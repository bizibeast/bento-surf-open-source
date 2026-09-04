/* eslint-disable @typescript-eslint/no-explicit-any -- Email tables are introduced by the lifecycle migration. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { Webhook, WebhookVerificationError } from "standardwebhooks";

const MAX_WEBHOOK_BYTES = 512 * 1024;

export type ResendWebhookEvent = {
  type: string;
  created_at: string;
  data?: {
    email_id?: string;
    to?: string[];
    reason?: string;
    error?: string | { message?: string };
  };
};

export function recipientStatusForResendEvent(eventType: string) {
  if (eventType === "email.sent") return "sent";
  if (eventType === "email.delivered") return "delivered";
  if (eventType === "email.bounced") return "bounced";
  if (eventType === "email.complained") return "complained";
  if (eventType === "email.failed") return "failed";
  if (eventType === "email.suppressed") return "suppressed";
  return null;
}

export function failureReasonForResendEvent(event: ResendWebhookEvent) {
  const error = event.data?.error;
  const reason =
    typeof error === "string"
      ? error
      : typeof error?.message === "string"
        ? error.message
        : event.data?.reason;
  return reason?.trim().slice(0, 1_000) || null;
}

function webhookSecret() {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) throw new Error("Resend webhook verification is not configured.");
  return secret;
}

export function verifyResendWebhook(
  rawBody: string,
  headers: Pick<Headers, "get">,
): ResendWebhookEvent {
  const id = headers.get("svix-id")?.trim();
  const timestamp = headers.get("svix-timestamp")?.trim();
  const signature = headers.get("svix-signature")?.trim();
  if (!id || !timestamp || !signature) {
    throw new WebhookVerificationError("Missing Resend webhook signature headers.");
  }
  return new Webhook(webhookSecret()).verify(rawBody, {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": signature,
  }) as ResendWebhookEvent;
}

async function claimEvent(eventId: string, event: ResendWebhookEvent) {
  const db = supabaseAdmin as any;
  const occurredAt = new Date(event.created_at);
  if (!Number.isFinite(occurredAt.getTime())) throw new Error("Invalid webhook timestamp.");
  const row = {
    event_id: eventId,
    event_type: event.type,
    provider_email_id: event.data?.email_id?.trim() || null,
    occurred_at: occurredAt.toISOString(),
    payload: event,
  };
  const { error } = await db.from("email_provider_events").insert(row);
  if (!error) return { claimed: true, occurredAt, providerEmailId: row.provider_email_id };
  if (error.code !== "23505") throw new Error(error.message);

  const { data: existing, error: readError } = await db
    .from("email_provider_events")
    .select("status, attempts, updated_at")
    .eq("event_id", eventId)
    .single();
  if (readError) throw new Error(readError.message);
  if (existing.status === "processed") {
    return { claimed: false, occurredAt, providerEmailId: row.provider_email_id };
  }
  const stale = Date.parse(existing.updated_at) < Date.now() - 10 * 60_000;
  if (existing.status === "processing" && !stale) {
    throw new Error("Webhook event is already being processed.");
  }
  const { error: reclaimError } = await db
    .from("email_provider_events")
    .update({
      ...row,
      status: "processing",
      attempts: Math.min(Number(existing.attempts || 1) + 1, 20),
      last_error: null,
    })
    .eq("event_id", eventId);
  if (reclaimError) throw new Error(reclaimError.message);
  return { claimed: true, occurredAt, providerEmailId: row.provider_email_id };
}

async function markEvent(eventId: string, status: "processed" | "failed", error?: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  const { error: updateError } = await (supabaseAdmin as any)
    .from("email_provider_events")
    .update({
      status,
      processed_at: status === "processed" ? new Date().toISOString() : null,
      last_error: status === "failed" ? message.slice(0, 1_000) : null,
    })
    .eq("event_id", eventId);
  if (updateError) console.error("[email] could not update Resend webhook state", updateError);
}

async function applyDeliveryEvent(
  event: ResendWebhookEvent,
  providerEmailId: string | null,
  occurredAt: Date,
) {
  if (!providerEmailId) return;
  const db = supabaseAdmin as any;
  const timestamp = occurredAt.toISOString();
  const patch: Record<string, string> = {};
  if (event.type === "email.delivered") patch.delivered_at = timestamp;
  if (event.type === "email.bounced") patch.bounced_at = timestamp;
  if (event.type === "email.complained") patch.complained_at = timestamp;
  const failureReason = failureReasonForResendEvent(event);
  if (event.type === "email.failed" || event.type === "email.suppressed") {
    patch.status = event.type === "email.failed" ? "failed" : "suppressed";
    patch.last_error = failureReason || `Resend reported ${event.type}.`;
  }
  if (Object.keys(patch).length > 0) {
    let update = db.from("email_outbox").update(patch).eq("provider_email_id", providerEmailId);
    if (event.type === "email.failed" || event.type === "email.suppressed") {
      update = update.is("bounced_at", null).is("complained_at", null);
    }
    const { error } = await update;
    if (error) throw new Error(error.message);
  }
  const recipientStatus = recipientStatusForResendEvent(event.type);
  if (recipientStatus) {
    const { data: outbox, error: outboxError } = await db
      .from("email_outbox")
      .select("id")
      .eq("provider_email_id", providerEmailId)
      .maybeSingle();
    if (outboxError) throw new Error(outboxError.message);
    if (outbox?.id) {
      const { error: recipientError } = await db.rpc("update_audience_campaign_recipient_status", {
        p_email_outbox_id: outbox.id,
        p_status: recipientStatus,
        p_skip_reason: failureReason,
      });
      if (recipientError) throw new Error(recipientError.message);
    }
  }

  if (
    !["email.bounced", "email.complained"].includes(event.type) ||
    (process.env.EMAIL_DELIVERY_MODE || "disabled") !== "production"
  ) {
    return;
  }

  const reason = event.type === "email.bounced" ? "bounce" : "complaint";
  const recipients = Array.from(
    new Set((event.data?.to ?? []).map((email) => email.trim().toLowerCase()).filter(Boolean)),
  );
  for (const email of recipients) {
    if (email.length > 254) continue;
    const { error: suppressionError } = await db.from("email_suppressions").upsert({
      email,
      reason,
      provider: "resend",
      provider_email_id: providerEmailId,
      updated_at: timestamp,
    });
    if (suppressionError) throw new Error(suppressionError.message);
  }

  const { data: outbox, error: outboxError } = await db
    .from("email_outbox")
    .select("user_id")
    .eq("provider_email_id", providerEmailId)
    .maybeSingle();
  if (outboxError) throw new Error(outboxError.message);
  if (outbox?.user_id) {
    const { error } = await db
      .from("email_preferences")
      .update({
        product_updates: false,
        weekly_digest: false,
        marketing_unsubscribed_at: timestamp,
      })
      .eq("user_id", outbox.user_id);
    if (error) throw new Error(error.message);
  }
}

export async function handleResendWebhook(request: Request) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const eventId = request.headers.get("svix-id")?.trim();
  if (!eventId || eventId.length > 255) return new Response("Invalid event id", { status: 400 });
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_WEBHOOK_BYTES) return new Response("Payload too large", { status: 413 });

  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_WEBHOOK_BYTES) {
      return new Response("Payload too large", { status: 413 });
    }
    const event = verifyResendWebhook(rawBody, request.headers);
    const claim = await claimEvent(eventId, event);
    if (!claim.claimed) return Response.json({ received: true, duplicate: true });
    try {
      await applyDeliveryEvent(event, claim.providerEmailId, claim.occurredAt);
      await markEvent(eventId, "processed");
      return Response.json({ received: true });
    } catch (error) {
      await markEvent(eventId, "failed", error);
      throw error;
    }
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      return new Response("Invalid signature", { status: 400 });
    }
    console.error("[email] Resend webhook failed", error);
    return new Response("Webhook processing failed", { status: 500 });
  }
}
