/* eslint-disable @typescript-eslint/no-explicit-any -- PayPal webhook payloads are validated before use. */
import {
  getPayPalPaymentAccountById,
  paypalRequest,
  paypalRequestForAccount,
  type PayPalPaymentAccount,
} from "./client.server";
import { paypalMinorUnits } from "./money";
import {
  applyCommerceDispute,
  applyCommerceRefund,
  type CommerceDisputeOutcome,
} from "@/lib/commerce-order-lifecycle.server";
import { readRequestText, RequestBodyTooLargeError } from "@/lib/request-security.server";
import {
  claimCommerceWebhookEvent,
  completeCommerceWebhookEvent,
  failCommerceWebhookEvent,
} from "@/lib/commerce-webhook-receipts.server";

const MAX_WEBHOOK_BYTES = 1024 * 1024;

function response(status: number, body = "") {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

async function verifyPayPalWebhook(
  request: Request,
  event: unknown,
  options: { account?: PayPalPaymentAccount; webhookId?: string } = {},
) {
  const webhookId = options.webhookId || process.env.PAYPAL_WEBHOOK_ID?.trim();
  if (!webhookId) throw new Error("PayPal webhook verification is not configured.");
  const transmissionId = request.headers.get("paypal-transmission-id");
  const transmissionTime = request.headers.get("paypal-transmission-time");
  const certUrl = request.headers.get("paypal-cert-url");
  const authAlgo = request.headers.get("paypal-auth-algo");
  const transmissionSig = request.headers.get("paypal-transmission-sig");
  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    return false;
  }
  const path = "/v1/notifications/verify-webhook-signature";
  const init = {
    method: "POST" as const,
    includePartnerAttribution: false,
    body: {
      transmission_id: transmissionId,
      transmission_time: transmissionTime,
      cert_url: certUrl,
      auth_algo: authAlgo,
      transmission_sig: transmissionSig,
      webhook_id: webhookId,
      webhook_event: event,
    },
  };
  const verification = options.account
    ? await paypalRequestForAccount<{ verification_status?: string }>(options.account, path, init)
    : await paypalRequest<{ verification_status?: string }>(path, init);
  return verification.verification_status === "SUCCESS";
}

type PayPalEventScope = {
  creatorId?: string;
  providerAccountId?: string;
};

async function processCaptureRefund(event: any, scope: PayPalEventScope = {}) {
  const resource = event.resource || {};
  const captureId = String(
    resource.supplementary_data?.related_ids?.capture_id || resource.capture_id || "",
  );
  if (!captureId) return;
  const currency = String(resource.amount?.currency_code || "").toLowerCase();
  const totalRefunded = resource.seller_payable_breakdown?.total_refunded_amount;
  const refundAmount = paypalMinorUnits(
    totalRefunded?.value ?? resource.amount?.value ?? 0,
    String(totalRefunded?.currency_code || currency),
  );
  await applyCommerceRefund({
    provider: "paypal",
    providerPaymentId: captureId,
    providerAccountId: scope.providerAccountId,
    providerEventId: String(event.id),
    refundAmount,
    amountIsCumulative: true,
    metadata: scope.creatorId ? { creator_id: scope.creatorId } : {},
    occurredAt: event.create_time || null,
  });
}

function paypalDisputeOutcome(event: any): CommerceDisputeOutcome {
  if (event.event_type === "CUSTOMER.DISPUTE.CREATED") return "open";
  const outcome = String(event.resource?.dispute_outcome?.outcome_code || "");
  if (outcome === "RESOLVED_SELLER_FAVOUR" || outcome === "RESOLVED_WITH_PAYOUT") {
    return "won";
  }
  if (outcome === "CANCELED_BY_BUYER") return "canceled";
  if (outcome === "RESOLVED_BUYER_FAVOUR" || outcome === "ACCEPTED") return "lost";
  return "under_review";
}

async function processCustomerDispute(event: any, scope: PayPalEventScope = {}) {
  const dispute = event.resource || {};
  const transaction = Array.isArray(dispute.disputed_transactions)
    ? dispute.disputed_transactions[0]
    : null;
  const paymentId = String(transaction?.seller_transaction_id || "");
  const disputeId = String(dispute.dispute_id || dispute.id || "");
  if (!paymentId || !disputeId) return;
  const amount = dispute.dispute_amount || transaction?.seller_transaction_amount;
  await applyCommerceDispute({
    provider: "paypal",
    providerPaymentId: paymentId,
    providerAccountId: scope.providerAccountId,
    providerEventId: String(event.id),
    disputeId,
    outcome: paypalDisputeOutcome(event),
    disputedAmount: paypalMinorUnits(amount?.value || 0, String(amount?.currency_code || "USD")),
    reason: dispute.reason || dispute.dispute_life_cycle_stage || null,
    metadata: {
      creator_id: scope.creatorId || null,
      provider_status: dispute.status || null,
      outcome_code: dispute.dispute_outcome?.outcome_code || null,
    },
    occurredAt: event.create_time || null,
  });
}

async function readPayPalEvent(request: Request) {
  let rawBody: string;
  try {
    rawBody = await readRequestText(request, MAX_WEBHOOK_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      return { response: response(413, "Payload too large") };
    return { response: response(400, "Unable to read payload") };
  }
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { response: response(400, "Invalid JSON") };
  }
  if (!event?.id || !event?.event_type) return { response: response(400, "Invalid event") };
  return { event };
}

async function processPayPalEvent(event: any, scope: PayPalEventScope = {}) {
  let claim;
  try {
    claim = await claimCommerceWebhookEvent({
      provider: "paypal",
      eventId: event.id,
      eventType: event.event_type,
      payload: event,
    });
  } catch {
    return response(500, "Webhook receipt could not be recorded");
  }
  if (claim === "processed") return response(202);
  if (claim === "busy") return response(409, "Webhook is already being processed");

  try {
    if (
      event.event_type === "PAYMENT.CAPTURE.REFUNDED" ||
      event.event_type === "PAYMENT.CAPTURE.REVERSED"
    ) {
      await processCaptureRefund(event, scope);
    }
    if (
      event.event_type === "CUSTOMER.DISPUTE.CREATED" ||
      event.event_type === "CUSTOMER.DISPUTE.RESOLVED"
    ) {
      await processCustomerDispute(event, scope);
    }
    await completeCommerceWebhookEvent("paypal", event.id);
    return response(202);
  } catch (error) {
    try {
      await failCommerceWebhookEvent("paypal", event.id, error);
    } catch (receiptError) {
      console.error("PayPal webhook failure could not be recorded", receiptError);
    }
    console.error("PayPal webhook processing failed", error);
    return response(500, "Webhook processing failed");
  }
}

export async function handlePayPalWebhook(request: Request) {
  const parsed = await readPayPalEvent(request);
  if (parsed.response) return parsed.response;
  if (!(await verifyPayPalWebhook(request, parsed.event)))
    return response(403, "Invalid signature");
  return processPayPalEvent(parsed.event);
}

export async function handleDirectPayPalWebhook(request: Request, connectionId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return response(404, "Not found");
  const parsed = await readPayPalEvent(request);
  if (parsed.response) return parsed.response;
  const account = await getPayPalPaymentAccountById(connectionId);
  if (!account || account.credential_mode !== "api_key" || !account.webhook_endpoint_id) {
    return response(404, "Connection not found");
  }
  if (
    !(await verifyPayPalWebhook(request, parsed.event, {
      account,
      webhookId: account.webhook_endpoint_id,
    }))
  ) {
    return response(403, "Invalid signature");
  }
  return processPayPalEvent(parsed.event, {
    creatorId: account.creator_id,
    providerAccountId: account.provider_account_id,
  });
}
