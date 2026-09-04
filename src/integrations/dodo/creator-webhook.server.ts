/* eslint-disable @typescript-eslint/no-explicit-any -- Dodo payloads are signature-verified before normalization. */
import type {
  PaymentSucceededWebhookEvent,
  RefundSucceededWebhookEvent,
  UnwrapWebhookEvent,
} from "dodopayments/resources/webhooks/webhooks";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  commerceOrderMetadata,
  finalizeCommerceFulfillment,
} from "@/lib/commerce-fulfillment.server";
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
import {
  dodoWebhookClientForCreatorAccount,
  type DodoCreatorPaymentAccount,
} from "./creator-client.server";
import {
  applyCommerceSubscriptionLifecycle,
  dodoSubscriptionState,
} from "@/lib/commerce-subscription-lifecycle.server";
import { assertDodoCreatorBusiness, assertDodoPaymentAmount } from "./creator-webhook-validation";

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function response(status: number, body = "") {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function paymentSession(
  event: PaymentSucceededWebhookEvent,
  connection: DodoCreatorPaymentAccount,
) {
  assertDodoCreatorBusiness(event.business_id, connection.provider_account_id, "payment");
  const sessionId = String(event.data.metadata?.bento_session_id || "");
  if (!UUID.test(sessionId)) throw new Error("Dodo payment is missing its Bento payment session.");
  const db = supabaseAdmin as any;
  const { data: session, error } = await db
    .from("commerce_payment_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("provider", "dodo")
    .eq("connection_id", connection.id)
    .eq("creator_id", connection.creator_id)
    .maybeSingle();
  if (error || !session) throw new Error(error?.message || "Bento payment session was not found.");
  if (["failed", "expired", "canceled"].includes(session.status)) {
    throw new Error("This Bento payment session is no longer valid.");
  }
  if (
    session.provider_checkout_id &&
    event.data.checkout_session_id &&
    session.provider_checkout_id !== event.data.checkout_session_id
  ) {
    throw new Error("Dodo checkout does not match the Bento payment session.");
  }
  return session;
}

async function processPaymentSucceeded(
  event: PaymentSucceededWebhookEvent,
  connection: DodoCreatorPaymentAccount,
  eventId: string,
) {
  const payment = event.data;
  const db = supabaseAdmin as any;
  const session = await paymentSession(event, connection);
  const { data: product, error: productError } = await db
    .from("commerce_products")
    .select("id, creator_id, currency")
    .eq("id", session.product_id)
    .eq("creator_id", connection.creator_id)
    .single();
  if (productError || !product)
    throw new Error(productError?.message || "Bento product was not found.");
  let checkoutProductId = String(session.metadata?.provider_product_id || "");
  if (!checkoutProductId) {
    // Backward compatibility for sessions created before provider product IDs
    // were snapshotted on the checkout session.
    const { data: providerRef, error: refError } = await db
      .from("commerce_product_provider_refs")
      .select("provider_product_id")
      .eq("product_id", product.id)
      .eq("provider", "dodo")
      .eq("provider_account_id", connection.provider_account_id)
      .maybeSingle();
    if (refError) throw new Error(refError.message);
    checkoutProductId = String(providerRef?.provider_product_id || "");
  }
  const productIds = new Set((payment.product_cart || []).map((item) => item.product_id));
  if (!checkoutProductId || !productIds.has(checkoutProductId)) {
    throw new Error("Dodo product does not match the Bento product.");
  }
  if (payment.currency.toLowerCase() !== String(session.currency).toLowerCase()) {
    throw new Error("Dodo payment currency does not match the Bento product.");
  }
  assertDodoPaymentAmount(payment, session);
  const tax = Math.max(0, payment.tax || 0);
  const netAmount =
    payment.settlement_currency.toLowerCase() === payment.currency.toLowerCase()
      ? Math.max(0, payment.settlement_amount)
      : Math.max(0, payment.total_amount - tax);
  const processorFee = Math.max(0, payment.total_amount - tax - netAmount);
  const { data: fulfilled, error: fulfillmentError } = await db.rpc(
    "fulfill_provider_commerce_order",
    {
      p_product_id: product.id,
      p_buyer_email: session.buyer_email,
      p_buyer_name: payment.customer.name || session.buyer_name || "",
      p_provider: "dodo",
      p_provider_account_id: connection.provider_account_id,
      p_provider_checkout_id:
        payment.checkout_session_id || session.provider_checkout_id || payment.payment_id,
      p_provider_payment_id: payment.payment_id,
      p_provider_subscription_id: payment.subscription_id || "",
      // Bento records the tax-exclusive offer price. Dodo's total includes tax.
      p_gross_amount: session.gross_amount,
      p_platform_fee_bps: 0,
      p_platform_fee_amount: 0,
      p_processor_fee_amount: processorFee,
      p_tax_amount: tax,
      p_net_amount: netAmount,
      p_currency: payment.currency.toLowerCase(),
      p_metadata: commerceOrderMetadata(session, {
        bento_session_id: session.id,
        dodo_business_id: event.business_id,
        dodo_brand_id: payment.brand_id,
        dodo_invoice_id: payment.invoice_id,
        dodo_invoice_url: payment.invoice_url,
        settlement_amount: payment.settlement_amount,
        settlement_currency: payment.settlement_currency,
      }),
      p_access_token_hash: session.access_token_hash || null,
    },
  );
  if (fulfillmentError || !fulfilled?.order_id) {
    throw new Error(fulfillmentError?.message || "Dodo order could not be fulfilled.");
  }
  await finalizeCommerceFulfillment({
    session,
    orderId: fulfilled.order_id,
    providerCheckoutId: payment.checkout_session_id || session.provider_checkout_id,
  });
  if (payment.subscription_id) {
    await applyCommerceSubscriptionLifecycle({
      provider: "dodo",
      providerAccountId: connection.provider_account_id,
      providerSubscriptionId: payment.subscription_id,
      state: "active",
      providerEventId: eventId,
      metadata: { dodo_payment_id: payment.payment_id },
    });
  }
}

async function processRefundSucceeded(
  event: RefundSucceededWebhookEvent,
  connection: DodoCreatorPaymentAccount,
) {
  assertDodoCreatorBusiness(event.business_id, connection.provider_account_id, "refund");
  const refund = event.data;
  await applyCommerceRefund({
    provider: "dodo",
    providerAccountId: connection.provider_account_id,
    providerPaymentId: refund.payment_id,
    providerEventId: refund.refund_id,
    refundAmount:
      refund.amount == null ? (refund.is_partial ? 0 : null) : Math.max(0, Number(refund.amount)),
    amountIsCumulative: false,
    metadata: { is_partial: Boolean(refund.is_partial) },
    occurredAt: event.timestamp || null,
  });
}

async function processDispute(event: UnwrapWebhookEvent, connection: DodoCreatorPaymentAccount) {
  assertDodoCreatorBusiness(event.business_id, connection.provider_account_id, "dispute");
  const dispute = event.data as {
    payment_id?: string;
    dispute_id?: string;
    amount?: number;
    currency?: string;
    dispute_status?: string;
    stage?: string;
    remarks?: string;
  };
  if (!dispute.payment_id || !dispute.dispute_id) return;
  const outcome = event.type.replace("dispute.", "") as
    CommerceDisputeOutcome | "opened" | "challenged";
  const normalizedOutcome: CommerceDisputeOutcome =
    outcome === "opened" ? "open" : outcome === "challenged" ? "under_review" : outcome;
  await applyCommerceDispute({
    provider: "dodo",
    providerAccountId: connection.provider_account_id,
    providerPaymentId: dispute.payment_id,
    providerEventId: `${event.type}:${dispute.dispute_id}:${event.timestamp}`,
    disputeId: dispute.dispute_id,
    outcome: normalizedOutcome,
    disputedAmount: dispute.amount == null ? null : Number(dispute.amount),
    reason: dispute.remarks || null,
    metadata: {
      provider_status: dispute.dispute_status || null,
      stage: dispute.stage || null,
      currency: dispute.currency || null,
    },
    occurredAt: event.timestamp || null,
  });
}

async function processPaymentFailure(
  event: UnwrapWebhookEvent,
  connection: DodoCreatorPaymentAccount,
) {
  if (event.business_id !== connection.provider_account_id) return;
  const data = event.data as { metadata?: Record<string, unknown>; checkout_session_id?: string };
  const sessionId = String(data.metadata?.bento_session_id || "");
  const db = supabaseAdmin as any;
  let query = db
    .from("commerce_payment_sessions")
    .update({ status: event.type === "payment.cancelled" ? "canceled" : "failed" })
    .eq("provider", "dodo")
    .eq("connection_id", connection.id)
    .eq("status", "pending");
  query = UUID.test(sessionId)
    ? query.eq("id", sessionId)
    : data.checkout_session_id
      ? query.eq("provider_checkout_id", data.checkout_session_id)
      : null;
  if (query) {
    const { error } = await query;
    if (error) throw new Error(error.message);
  }
}

async function processSubscriptionLifecycle(
  event: UnwrapWebhookEvent,
  connection: DodoCreatorPaymentAccount,
  eventId: string,
) {
  assertDodoCreatorBusiness(event.business_id, connection.provider_account_id, "subscription");
  const subscription = event.data as {
    subscription_id?: string;
    previous_billing_date?: string;
    next_billing_date?: string;
    cancel_at_next_billing_date?: boolean;
    status?: string;
  };
  const subscriptionId = String(subscription.subscription_id || "");
  if (!subscriptionId) return;
  await applyCommerceSubscriptionLifecycle({
    provider: "dodo",
    providerAccountId: connection.provider_account_id,
    providerSubscriptionId: subscriptionId,
    state: dodoSubscriptionState({
      eventType: event.type,
      status: subscription.status,
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_next_billing_date),
    }),
    providerEventId: eventId,
    currentPeriodStart: subscription.previous_billing_date,
    currentPeriodEnd: subscription.next_billing_date,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_next_billing_date),
    metadata: { dodo_status: subscription.status || null },
  });
}

export async function handleDodoCreatorWebhook(request: Request, connectionId: string) {
  if (!UUID.test(connectionId)) return response(404, "Not found");
  let body: string;
  try {
    body = await readRequestText(request, MAX_WEBHOOK_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return response(413, "Payload too large");
    return response(400, "Unable to read payload");
  }
  const db = supabaseAdmin as any;
  const { data: connection, error } = await db
    .from("creator_payment_accounts")
    .select("*")
    .eq("id", connectionId)
    .eq("provider", "dodo")
    .maybeSingle();
  if (error) return response(500, "Connection lookup failed");
  if (!connection?.webhook_secret_ciphertext) return response(404, "Not found");

  let event: UnwrapWebhookEvent;
  try {
    const client = await dodoWebhookClientForCreatorAccount(connection);
    event = client.webhooks.unwrap(body, {
      headers: Object.fromEntries(request.headers.entries()),
    });
  } catch {
    return response(403, "Invalid signature");
  }
  const eventId =
    request.headers.get("webhook-id") || `${event.type}:${event.timestamp}:${connectionId}`;
  let claim;
  try {
    claim = await claimCommerceWebhookEvent({
      provider: "dodo_creator",
      eventId,
      eventType: event.type,
      payload: JSON.parse(body),
    });
  } catch {
    return response(500, "Webhook receipt could not be recorded");
  }
  if (claim === "processed") return response(202);
  if (claim === "busy") return response(409, "Webhook is already being processed");
  try {
    if (event.type === "payment.succeeded") {
      await processPaymentSucceeded(event, connection, eventId);
    }
    if (event.type === "refund.succeeded") await processRefundSucceeded(event, connection);
    if (event.type.startsWith("dispute.")) await processDispute(event, connection);
    if (event.type === "payment.failed" || event.type === "payment.cancelled") {
      await processPaymentFailure(event, connection);
    }
    if (event.type.startsWith("subscription.")) {
      await processSubscriptionLifecycle(event, connection, eventId);
    }
    await completeCommerceWebhookEvent("dodo_creator", eventId);
    return response(202);
  } catch (error) {
    try {
      await failCommerceWebhookEvent("dodo_creator", eventId, error);
    } catch (receiptError) {
      console.error("Dodo creator webhook failure could not be recorded", receiptError);
    }
    console.error("Dodo creator webhook processing failed", error);
    return response(500, "Webhook processing failed");
  }
}
