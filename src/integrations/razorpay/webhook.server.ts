/* eslint-disable @typescript-eslint/no-explicit-any -- Webhook payload is HMAC-verified before use. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  applyCommerceDispute,
  applyCommerceRefund,
  type CommerceDisputeOutcome,
} from "@/lib/commerce-order-lifecycle.server";
import { readRequestText, RequestBodyTooLargeError } from "@/lib/request-security.server";
import { decryptServerSecret } from "@/lib/secret-crypto.server";
import {
  claimCommerceWebhookEvent,
  completeCommerceWebhookEvent,
  failCommerceWebhookEvent,
} from "@/lib/commerce-webhook-receipts.server";
import { finalizeRazorpayPayment, type RazorpayPayment } from "./checkout.functions";
import {
  getRazorpayPaymentAccountById,
  razorpayCredentialsForAccount,
  razorpayRequest,
  verifyRazorpayWebhookSignature,
} from "./client.server";

const MAX_WEBHOOK_BYTES = 1024 * 1024;

function response(status: number, body = "") {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function capturedPayment(event: any, connection: any) {
  const eventPayment = event.payload?.payment?.entity;
  const orderId = String(eventPayment?.order_id || "");
  const paymentId = String(eventPayment?.id || "");
  if (!/^order_[A-Za-z0-9]+$/.test(orderId) || !/^pay_[A-Za-z0-9]+$/.test(paymentId)) {
    throw new Error("Razorpay captured event is missing its payment or Order ID.");
  }
  const db = supabaseAdmin as any;
  const { data: session, error } = await db
    .from("commerce_payment_sessions")
    .select("*")
    .eq("provider", "razorpay")
    .eq("connection_id", connection.id)
    .eq("provider_checkout_id", orderId)
    .maybeSingle();
  if (error || !session) {
    throw new Error(error?.message || "Razorpay payment session was not found.");
  }
  const credentials = await razorpayCredentialsForAccount(connection);
  const payment = await razorpayRequest<RazorpayPayment>(
    credentials,
    `/v1/payments/${encodeURIComponent(paymentId)}`,
  );
  await finalizeRazorpayPayment({ account: connection, session, payment });
}

async function failedPayment(event: any, connectionId: string) {
  const orderId = String(event.payload?.payment?.entity?.order_id || "");
  if (!orderId) return;
  const { error } = await (supabaseAdmin as any)
    .from("commerce_payment_sessions")
    .update({ status: "failed" })
    .eq("provider", "razorpay")
    .eq("connection_id", connectionId)
    .eq("provider_checkout_id", orderId)
    .eq("status", "pending");
  if (error) throw new Error(error.message);
}

async function processedRefund(event: any, connection: any, eventId: string) {
  const paymentId = String(event.payload?.refund?.entity?.payment_id || "");
  if (!/^pay_[A-Za-z0-9]+$/.test(paymentId)) return;
  const payment = await razorpayRequest<RazorpayPayment>(
    await razorpayCredentialsForAccount(connection),
    `/v1/payments/${encodeURIComponent(paymentId)}`,
  );
  const refundedAmount = Math.max(0, Number(payment.amount_refunded || 0));
  await applyCommerceRefund({
    provider: "razorpay",
    providerAccountId: connection.provider_account_id,
    providerPaymentId: paymentId,
    providerEventId: eventId,
    refundAmount: refundedAmount,
    amountIsCumulative: true,
    metadata: { razorpay_order_id: payment.order_id || null },
  });
}

async function processDispute(event: any, connection: any, eventId: string) {
  const dispute = event.payload?.dispute?.entity || {};
  const payment = event.payload?.payment?.entity || {};
  const paymentId = String(payment.id || dispute.payment_id || "");
  const disputeId = String(dispute.id || "");
  if (!/^pay_[A-Za-z0-9]+$/.test(paymentId) || !disputeId) return;
  const outcomeByEvent: Record<string, CommerceDisputeOutcome> = {
    "payment.dispute.created": "open",
    "payment.dispute.under_review": "under_review",
    "payment.dispute.action_required": "under_review",
    "payment.dispute.won": "won",
    "payment.dispute.lost": "lost",
    "payment.dispute.closed": dispute.status === "won" ? "won" : "lost",
  };
  await applyCommerceDispute({
    provider: "razorpay",
    providerAccountId: connection.provider_account_id,
    providerPaymentId: paymentId,
    providerEventId: eventId,
    disputeId,
    outcome: outcomeByEvent[event.event] || "under_review",
    disputedAmount: Number(dispute.amount || 0),
    reason: dispute.reason_code || dispute.reason_description || null,
    metadata: { provider_status: dispute.status || null, phase: dispute.phase || null },
    occurredAt: event.created_at ? new Date(Number(event.created_at) * 1_000).toISOString() : null,
  });
}

export async function handleRazorpayWebhook(request: Request, connectionId: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(connectionId)
  ) {
    return response(404, "Not found");
  }
  const connection = await getRazorpayPaymentAccountById(connectionId);
  if (!connection?.webhook_secret_ciphertext) return response(404, "Not found");
  let body: string;
  try {
    body = await readRequestText(request, MAX_WEBHOOK_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return response(413, "Payload too large");
    return response(400, "Unable to read payload");
  }
  const signature = request.headers.get("x-razorpay-signature") || "";
  if (
    !(await verifyRazorpayWebhookSignature(
      body,
      signature,
      await decryptServerSecret(connection.webhook_secret_ciphertext),
    ))
  ) {
    return response(403, "Invalid signature");
  }
  let event: any;
  try {
    event = JSON.parse(body);
  } catch {
    return response(400, "Invalid JSON");
  }
  if (!event?.event || event.entity !== "event") return response(400, "Invalid Razorpay event");
  const entity =
    event.payload?.payment?.entity ||
    event.payload?.refund?.entity ||
    event.payload?.dispute?.entity ||
    {};
  const eventId =
    request.headers.get("x-razorpay-event-id") ||
    `${event.event}:${String(entity.id || "unknown")}:${String(event.created_at || "0")}`;
  let claim;
  try {
    claim = await claimCommerceWebhookEvent({
      provider: "razorpay",
      eventId,
      eventType: event.event,
      payload: event,
    });
  } catch {
    return response(500, "Webhook receipt could not be recorded");
  }
  if (claim === "processed") return response(202);
  if (claim === "busy") return response(409, "Webhook is already being processed");
  try {
    if (event.event === "payment.captured") await capturedPayment(event, connection);
    if (event.event === "payment.failed") await failedPayment(event, connection.id);
    if (event.event === "refund.processed") {
      await processedRefund(event, connection, eventId);
    }
    if (event.event.startsWith("payment.dispute.")) {
      await processDispute(event, connection, eventId);
    }
    await completeCommerceWebhookEvent("razorpay", eventId);
    return response(202);
  } catch (error) {
    try {
      await failCommerceWebhookEvent("razorpay", eventId, error);
    } catch (receiptError) {
      console.error("Razorpay webhook failure could not be recorded", receiptError);
    }
    console.error("Razorpay webhook processing failed", error);
    return response(500, "Webhook processing failed");
  }
}
