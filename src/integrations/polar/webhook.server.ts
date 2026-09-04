/* eslint-disable @typescript-eslint/no-explicit-any -- Webhook payloads are validated by Polar's SDK before normalization. */
import { validateEvent, WebhookVerificationError } from "@polar-sh/sdk/webhooks";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptServerSecret } from "@/lib/secret-crypto.server";
import {
  commerceOrderMetadata,
  finalizeCommerceFulfillment,
} from "@/lib/commerce-fulfillment.server";
import { applyCommerceRefund } from "@/lib/commerce-order-lifecycle.server";
import { readRequestText, RequestBodyTooLargeError } from "@/lib/request-security.server";
import {
  applyCommerceSubscriptionLifecycle,
  polarSubscriptionState,
} from "@/lib/commerce-subscription-lifecycle.server";
import {
  claimCommerceWebhookEvent,
  completeCommerceWebhookEvent,
  failCommerceWebhookEvent,
} from "@/lib/commerce-webhook-receipts.server";

const MAX_WEBHOOK_BYTES = 1024 * 1024;

function response(status: number, body = "") {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export function assertPolarOrderSession(input: {
  session: {
    id: string;
    product_id: string;
    creator_id: string;
    connection_id: string;
    provider_checkout_id: string | null;
    gross_amount: number;
    currency: string;
    status: string;
  };
  connection: { id: string; creator_id: string };
  order: {
    checkoutId: string | null;
    netAmount: number;
    currency: string;
    platformFeeAmount: number;
  };
}) {
  const { session, connection, order } = input;
  if (session.connection_id !== connection.id || session.creator_id !== connection.creator_id) {
    throw new Error("Polar payment session does not match this Bento connection.");
  }
  if (["failed", "expired", "canceled"].includes(session.status)) {
    throw new Error("This Bento payment session is no longer valid.");
  }
  if (session.provider_checkout_id && session.provider_checkout_id !== order.checkoutId) {
    throw new Error("Polar checkout does not match the Bento payment session.");
  }
  if (
    session.gross_amount !== order.netAmount ||
    session.currency.toLowerCase() !== order.currency.toLowerCase()
  ) {
    throw new Error("Polar order amount does not match the Bento payment session.");
  }
  if (order.platformFeeAmount !== 0) {
    throw new Error("Polar returned an unexpected platform fee.");
  }
  return session.product_id;
}

async function processOrderPaid(
  event: Extract<ReturnType<typeof validateEvent>, { type: "order.paid" }>,
  connection: any,
  eventId: string,
) {
  const order = event.data;
  const db = supabaseAdmin as any;
  const sessionId = String(order.metadata.bento_session_id || "");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)
  ) {
    throw new Error("Polar order is missing its Bento payment session.");
  }
  const { data: session, error: sessionError } = await db
    .from("commerce_payment_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("provider", "polar")
    .eq("connection_id", connection.id)
    .eq("creator_id", connection.creator_id)
    .maybeSingle();
  if (sessionError || !session) {
    throw new Error(sessionError?.message || "Bento payment session was not found.");
  }
  const productId = String(assertPolarOrderSession({ session, connection, order }));
  const { data: product, error: productError } = await db
    .from("commerce_products")
    .select("id, creator_id, currency")
    .eq("id", productId)
    .eq("creator_id", connection.creator_id)
    .single();
  if (productError || !product)
    throw new Error(productError?.message || "Bento product was not found.");
  let checkoutProductId = String(session.metadata?.provider_product_id || "");
  if (!checkoutProductId) {
    const { data: providerRef, error: refError } = await db
      .from("commerce_product_provider_refs")
      .select("provider_product_id")
      .eq("product_id", productId)
      .eq("provider", "polar")
      .eq("provider_account_id", connection.provider_account_id)
      .maybeSingle();
    if (refError) throw new Error(refError.message);
    checkoutProductId = String(providerRef?.provider_product_id || "");
  }
  if (!checkoutProductId || checkoutProductId !== order.productId) {
    throw new Error("Polar product does not match the Bento product.");
  }
  const { data: fulfilled, error: fulfillmentError } = await db.rpc(
    "fulfill_provider_commerce_order",
    {
      p_product_id: productId,
      p_buyer_email: session.buyer_email,
      p_buyer_name: order.customer.name || order.billingName || "",
      p_provider: "polar",
      p_provider_account_id: connection.provider_account_id,
      p_provider_checkout_id: order.checkoutId || order.id,
      p_provider_payment_id: order.id,
      p_provider_subscription_id: order.subscriptionId || "",
      p_gross_amount: order.netAmount,
      p_platform_fee_bps: 0,
      p_platform_fee_amount: 0,
      p_processor_fee_amount: 0,
      p_tax_amount: order.taxAmount,
      p_net_amount: order.netAmount,
      p_currency: order.currency.toLowerCase(),
      p_metadata: commerceOrderMetadata(session, {
        bento_session_id: session.id,
        polar_order_id: order.id,
        polar_customer_id: order.customerId,
        polar_billing_reason: order.billingReason,
      }),
      p_access_token_hash: session.access_token_hash || null,
    },
  );
  if (fulfillmentError || !fulfilled?.order_id) {
    throw new Error(fulfillmentError?.message || "Polar order could not be fulfilled.");
  }
  await finalizeCommerceFulfillment({
    session,
    orderId: fulfilled.order_id,
    providerCheckoutId: order.checkoutId || order.id,
  });
  if (order.subscriptionId) {
    await applyCommerceSubscriptionLifecycle({
      provider: "polar",
      providerAccountId: connection.provider_account_id,
      providerSubscriptionId: order.subscriptionId,
      state: "active",
      providerEventId: eventId,
      metadata: {
        polar_order_id: order.id,
        polar_billing_reason: order.billingReason,
      },
    });
  }
}

async function processOrderRefunded(
  event: Extract<ReturnType<typeof validateEvent>, { type: "order.refunded" }>,
  connection: { provider_account_id: string },
) {
  const order = event.data;
  await applyCommerceRefund({
    provider: "polar",
    providerPaymentId: order.id,
    providerAccountId: connection.provider_account_id,
    providerEventId: `${event.data.id}:${event.timestamp.toISOString()}`,
    refundAmount: order.refundedAmount,
    amountIsCumulative: true,
    occurredAt: event.timestamp.toISOString(),
  });
}

async function processSubscriptionLifecycle(event: any, connection: any, eventId: string) {
  const subscription = event.data;
  if (!subscription?.id) return;
  await applyCommerceSubscriptionLifecycle({
    provider: "polar",
    providerAccountId: connection.provider_account_id,
    providerSubscriptionId: String(subscription.id),
    state: polarSubscriptionState({
      eventType: event.type,
      status: subscription.status,
      cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd),
    }),
    providerEventId: eventId,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelAtPeriodEnd: Boolean(
      subscription.cancelAtPeriodEnd || event.type === "subscription.canceled",
    ),
    metadata: { polar_status: subscription.status || null },
  });
}

export async function handlePolarWebhook(request: Request, connectionId: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(connectionId)
  ) {
    return response(404, "Not found");
  }
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
    .eq("provider", "polar")
    .maybeSingle();
  if (error) return response(500, "Connection lookup failed");
  if (!connection?.webhook_secret_ciphertext) return response(404, "Not found");

  const headers = Object.fromEntries(request.headers.entries());
  let event: ReturnType<typeof validateEvent>;
  try {
    event = validateEvent(
      body,
      headers,
      await decryptServerSecret(connection.webhook_secret_ciphertext),
    );
  } catch (error) {
    if (error instanceof WebhookVerificationError) return response(403, "Invalid signature");
    throw error;
  }
  const eventId =
    request.headers.get("webhook-id") || `${event.type}:${event.timestamp.toISOString()}`;
  let claim;
  try {
    claim = await claimCommerceWebhookEvent({
      provider: "polar",
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
    if (event.type === "order.paid") await processOrderPaid(event, connection, eventId);
    if (event.type === "order.refunded") await processOrderRefunded(event, connection);
    if (event.type.startsWith("subscription.")) {
      await processSubscriptionLifecycle(event, connection, eventId);
    }
    await completeCommerceWebhookEvent("polar", eventId);
    return response(202);
  } catch (error) {
    try {
      await failCommerceWebhookEvent("polar", eventId, error);
    } catch (receiptError) {
      console.error("Polar webhook failure could not be recorded", receiptError);
    }
    console.error("Polar webhook processing failed", error);
    return response(500, "Webhook processing failed");
  }
}
