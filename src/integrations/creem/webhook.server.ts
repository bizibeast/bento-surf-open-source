/* eslint-disable @typescript-eslint/no-explicit-any -- Creem payloads are signature-verified before normalization. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  commerceOrderMetadata,
  finalizeCommerceFulfillment,
} from "@/lib/commerce-fulfillment.server";
import { applyCommerceDispute, applyCommerceRefund } from "@/lib/commerce-order-lifecycle.server";
import { readRequestText, RequestBodyTooLargeError } from "@/lib/request-security.server";
import { decryptServerSecret } from "@/lib/secret-crypto.server";
import {
  claimCommerceWebhookEvent,
  completeCommerceWebhookEvent,
  failCommerceWebhookEvent,
} from "@/lib/commerce-webhook-receipts.server";
import {
  applyCommerceSubscriptionLifecycle,
  creemSubscriptionState,
} from "@/lib/commerce-subscription-lifecycle.server";
import {
  creemEnvironmentForAccount,
  getCreemPaymentAccountById,
  verifyCreemWebhookSignature,
  type CreemPaymentAccount,
} from "./client.server";

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function response(status: number, body = "") {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function eventMatchesEnvironment(event: any, account: CreemPaymentAccount) {
  const mode = String(event?.object?.mode || "").toLowerCase();
  if (!mode) return true;
  return creemEnvironmentForAccount(account) === "production"
    ? mode === "prod" || mode === "production"
    : mode === "test" || mode === "sandbox" || mode === "local";
}

async function findSession(sessionId: string, account: CreemPaymentAccount) {
  if (!UUID.test(sessionId)) throw new Error("Creem payment is missing its Bento payment session.");
  const { data, error } = await (supabaseAdmin as any)
    .from("commerce_payment_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("provider", "creem")
    .eq("connection_id", account.id)
    .eq("creator_id", account.creator_id)
    .maybeSingle();
  if (error || !data) throw new Error(error?.message || "Bento payment session was not found.");
  if (["failed", "expired", "canceled"].includes(data.status)) {
    throw new Error("This Bento payment session is no longer valid.");
  }
  return data;
}

async function validateProduct(input: {
  session: any;
  account: CreemPaymentAccount;
  providerProductId: string;
  amount: number;
  currency: string;
}) {
  const db = supabaseAdmin as any;
  const { data: product, error: productError } = await db
    .from("commerce_products")
    .select("id, creator_id")
    .eq("id", input.session.product_id)
    .eq("creator_id", input.account.creator_id)
    .single();
  if (productError || !product)
    throw new Error(productError?.message || "Bento product was not found.");
  let checkoutProductId = String(input.session.metadata?.provider_product_id || "");
  if (!checkoutProductId) {
    const { data: providerRef, error: refError } = await db
      .from("commerce_product_provider_refs")
      .select("provider_product_id")
      .eq("product_id", input.session.product_id)
      .eq("provider", "creem")
      .eq("provider_account_id", input.account.provider_account_id)
      .maybeSingle();
    if (refError) throw new Error(refError.message);
    checkoutProductId = String(providerRef?.provider_product_id || "");
  }
  if (!checkoutProductId || checkoutProductId !== input.providerProductId) {
    throw new Error("Creem product does not match the Bento product.");
  }
  if (
    Number(input.amount) !== Number(input.session.gross_amount) ||
    input.currency.toLowerCase() !== String(input.session.currency).toLowerCase()
  ) {
    throw new Error("Creem payment amount does not match this Bento checkout.");
  }
  return product;
}

async function fulfill(input: {
  account: CreemPaymentAccount;
  session: any;
  providerProductId: string;
  checkoutId: string;
  paymentId: string;
  subscriptionId?: string;
  amount: number;
  currency: string;
  buyerEmail?: string;
  buyerName?: string;
  metadata?: Record<string, unknown>;
}) {
  if (!input.checkoutId || !input.paymentId || !input.providerProductId) {
    throw new Error("Creem payment is missing a provider identifier.");
  }
  await validateProduct(input);
  const db = supabaseAdmin as any;
  const { data: fulfilled, error } = await db.rpc("fulfill_provider_commerce_order", {
    p_product_id: input.session.product_id,
    p_buyer_email: input.session.buyer_email,
    p_buyer_name: input.buyerName || input.session.buyer_name || "",
    p_provider: "creem",
    p_provider_account_id: input.account.provider_account_id,
    p_provider_checkout_id: input.checkoutId,
    p_provider_payment_id: input.paymentId,
    p_provider_subscription_id: input.subscriptionId || "",
    p_gross_amount: input.amount,
    p_platform_fee_bps: 0,
    p_platform_fee_amount: 0,
    p_processor_fee_amount: 0,
    p_tax_amount: 0,
    p_net_amount: input.amount,
    p_currency: input.currency.toLowerCase(),
    p_metadata: commerceOrderMetadata(input.session, {
      bento_session_id: input.session.id,
      provider_reported_net_unavailable: true,
      ...(input.metadata || {}),
    }),
    p_access_token_hash: input.session.access_token_hash || null,
  });
  if (error || !fulfilled?.order_id) {
    throw new Error(error?.message || "Creem order could not be fulfilled.");
  }
  await finalizeCommerceFulfillment({
    session: input.session,
    orderId: fulfilled.order_id,
    providerCheckoutId: input.checkoutId,
  });
}

async function checkoutCompleted(event: any, account: CreemPaymentAccount) {
  const checkout = event.object || {};
  if (checkout.product?.billing_type === "recurring") return;
  const session = await findSession(String(checkout.request_id || ""), account);
  if (checkout.status !== "completed" || checkout.order?.status !== "paid") {
    throw new Error("Creem checkout is not paid.");
  }
  if (session.provider_checkout_id && session.provider_checkout_id !== checkout.id) {
    throw new Error("Creem checkout does not match the Bento payment session.");
  }
  await fulfill({
    account,
    session,
    providerProductId: String(checkout.product?.id || checkout.order?.product || ""),
    checkoutId: String(checkout.id || ""),
    paymentId: String(checkout.order?.id || ""),
    amount: Number(checkout.order?.amount),
    currency: String(checkout.order?.currency || ""),
    buyerEmail: checkout.customer?.email,
    buyerName: checkout.customer?.name,
    metadata: { creem_order_id: checkout.order?.id, creem_customer_id: checkout.customer?.id },
  });
}

async function subscriptionPaid(event: any, account: CreemPaymentAccount) {
  const subscription = event.object || {};
  const sessionId = String(subscription.metadata?.bento_session_id || "");
  const session = await findSession(sessionId, account);
  await fulfill({
    account,
    session,
    providerProductId: String(subscription.product?.id || subscription.product || ""),
    checkoutId: String(session.provider_checkout_id || session.id),
    paymentId: String(subscription.last_transaction_id || ""),
    subscriptionId: String(subscription.id || ""),
    amount: Number(subscription.product?.price),
    currency: String(subscription.product?.currency || ""),
    buyerEmail: subscription.customer?.email,
    buyerName: subscription.customer?.name,
    metadata: {
      creem_subscription_id: subscription.id,
      current_period_start: subscription.current_period_start_date,
      current_period_end: subscription.current_period_end_date,
    },
  });
  await applyCommerceSubscriptionLifecycle({
    provider: "creem",
    providerAccountId: account.provider_account_id,
    providerSubscriptionId: String(subscription.id || ""),
    state: "renewed",
    providerEventId: String(event.id),
    currentPeriodStart: subscription.current_period_start_date,
    currentPeriodEnd: subscription.current_period_end_date,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    metadata: { creem_status: subscription.status || null },
  });
}

async function refundCreated(event: any, account: CreemPaymentAccount) {
  const refund = event.object || {};
  if (refund.status !== "succeeded") return;
  const transactionId = String(refund.transaction?.id || "");
  const orderId = String(refund.order?.id || refund.transaction?.order || "");
  const providerPaymentId = transactionId || orderId;
  if (!providerPaymentId) return;
  const eventId = String(event.id || refund.id || "");
  if (!eventId) return;
  const result = await applyCommerceRefund({
    provider: "creem",
    providerAccountId: account.provider_account_id,
    providerPaymentId,
    providerEventId: eventId,
    refundAmount: Number(refund.refund_amount || 0),
    amountIsCumulative: true,
  });
  if (!result && transactionId && orderId) {
    await applyCommerceRefund({
      provider: "creem",
      providerAccountId: account.provider_account_id,
      providerPaymentId: orderId,
      providerEventId: eventId,
      refundAmount: Number(refund.refund_amount || 0),
      amountIsCumulative: true,
    });
  }
}

async function disputeCreated(event: any, account: CreemPaymentAccount) {
  const dispute = event.object || {};
  const transactionId = String(dispute.transaction?.id || dispute.transaction_id || "");
  const disputeId = String(dispute.id || "");
  if (!transactionId || !disputeId) return;
  await applyCommerceDispute({
    provider: "creem",
    providerAccountId: account.provider_account_id,
    providerPaymentId: transactionId,
    providerEventId: String(event.id),
    disputeId,
    outcome: "open",
    disputedAmount: Number(dispute.amount || dispute.disputed_amount || 0),
    reason: dispute.reason || null,
    metadata: {
      provider_status: dispute.status || null,
      currency: dispute.currency || null,
    },
    occurredAt: event.created_at || null,
  });
}

async function subscriptionLifecycle(event: any, account: CreemPaymentAccount) {
  const subscriptionId = String(event.object?.id || "");
  if (!subscriptionId) return;
  await applyCommerceSubscriptionLifecycle({
    provider: "creem",
    providerAccountId: account.provider_account_id,
    providerSubscriptionId: subscriptionId,
    state: creemSubscriptionState({
      eventType: event.eventType,
      status: event.object?.status,
      cancelAtPeriodEnd: Boolean(event.object?.cancel_at_period_end),
    }),
    providerEventId: String(event.id),
    currentPeriodStart: event.object?.current_period_start_date,
    currentPeriodEnd: event.object?.current_period_end_date,
    cancelAtPeriodEnd:
      event.eventType === "subscription.scheduled_cancel" ||
      Boolean(event.object?.cancel_at_period_end),
    metadata: { creem_status: event.object?.status || null },
  });
}

export async function handleCreemWebhook(request: Request, connectionId: string) {
  if (!UUID.test(connectionId)) return response(404, "Not found");
  let body: string;
  try {
    body = await readRequestText(request, MAX_WEBHOOK_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return response(413, "Payload too large");
    return response(400, "Unable to read payload");
  }
  const account = await getCreemPaymentAccountById(connectionId);
  if (!account?.webhook_secret_ciphertext) return response(404, "Not found");
  const signature = request.headers.get("creem-signature") || "";
  if (
    !/^[a-f0-9]{64}$/i.test(signature) ||
    !(await verifyCreemWebhookSignature(
      body,
      signature,
      await decryptServerSecret(account.webhook_secret_ciphertext),
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
  if (!event?.id || !event?.eventType || !event?.object)
    return response(400, "Invalid Creem event");
  if (!eventMatchesEnvironment(event, account)) return response(403, "Environment mismatch");
  let claim;
  try {
    claim = await claimCommerceWebhookEvent({
      provider: "creem_creator",
      eventId: event.id,
      eventType: event.eventType,
      payload: event,
    });
  } catch {
    return response(500, "Webhook receipt could not be recorded");
  }
  if (claim === "processed") return response(200);
  if (claim === "busy") return response(409, "Webhook is already being processed");
  try {
    if (event.eventType === "checkout.completed") await checkoutCompleted(event, account);
    if (event.eventType === "subscription.paid") await subscriptionPaid(event, account);
    if (event.eventType === "refund.created") await refundCreated(event, account);
    if (event.eventType === "dispute.created") await disputeCreated(event, account);
    if (
      [
        "subscription.active",
        "subscription.canceled",
        "subscription.scheduled_cancel",
        "subscription.past_due",
        "subscription.expired",
        "subscription.trialing",
        "subscription.paused",
        "subscription.update",
      ].includes(event.eventType)
    ) {
      await subscriptionLifecycle(event, account);
    }
    await completeCommerceWebhookEvent("creem_creator", event.id);
    return response(200);
  } catch (error) {
    try {
      await failCommerceWebhookEvent("creem_creator", event.id, error);
    } catch (receiptError) {
      console.error("Creem creator webhook failure could not be recorded", receiptError);
    }
    console.error("Creem creator webhook processing failed", error);
    return response(500, "Webhook processing failed");
  }
}
