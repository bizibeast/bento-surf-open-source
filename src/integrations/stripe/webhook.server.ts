/* eslint-disable @typescript-eslint/no-explicit-any -- Stripe payloads are validated before use. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  getStripePaymentAccountById,
  stripeAccountFields,
  stripeRequestForPaymentAccount,
  stripeWebhookSecret,
  type StripePaymentAccount,
} from "./client.server";
import { decryptServerSecret } from "@/lib/secret-crypto.server";
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
  applyCommerceSubscriptionLifecycle,
  type CommerceSubscriptionState,
} from "@/lib/commerce-subscription-lifecycle.server";
import {
  claimCommerceWebhookEvent,
  completeCommerceWebhookEvent,
  failCommerceWebhookEvent,
} from "@/lib/commerce-webhook-receipts.server";

const encoder = new TextEncoder();
const MAX_WEBHOOK_BYTES = 1024 * 1024;

function response(status: number, body = "") {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function hmacSha256Hex(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function verifyStripeSignature(body: string, header: string, secret: string) {
  const values = header.split(",").map((part) => part.trim().split("=", 2));
  const timestamp = values.find(([key]) => key === "t")?.[1];
  const signatures = values.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || !signatures.length) return false;
  const timestampMs = Number(timestamp) * 1_000;
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60_000)
    return false;
  const expected = await hmacSha256Hex(secret, `${timestamp}.${body}`);
  return signatures.some((signature) => constantTimeEqual(signature, expected));
}

async function processorFeeForPaymentIntent(
  paymentIntentId: string,
  account: StripePaymentAccount,
) {
  try {
    const intent = await stripeRequestForPaymentAccount<any>(
      account,
      `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}?expand%5B%5D=latest_charge.balance_transaction`,
    );
    return Math.max(0, Number(intent.latest_charge?.balance_transaction?.fee || 0));
  } catch {
    return 0;
  }
}

async function fulfillCheckoutSession(
  event: any,
  context: { accountId: string; connectionId?: string; paymentAccount?: StripePaymentAccount },
) {
  const checkout = event.data?.object;
  if (!checkout || checkout.payment_status !== "paid") return;
  const localSessionId = String(checkout.metadata?.bento_session_id || "");
  const db = supabaseAdmin as any;
  const { data: local, error } = await db
    .from("commerce_payment_sessions")
    .select("*")
    .eq("id", localSessionId)
    .eq("provider", "stripe")
    .eq("provider_checkout_id", checkout.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!local) throw new Error("Stripe checkout does not match a Bento payment session.");
  if (context.connectionId && local.connection_id !== context.connectionId) {
    throw new Error("Stripe webhook connection does not match the Bento payment session.");
  }
  const paymentAccount =
    context.paymentAccount || (await getStripePaymentAccountById(local.connection_id));
  if (!paymentAccount || context.accountId !== paymentAccount.provider_account_id) {
    throw new Error("Stripe account does not match the Bento payment session.");
  }
  if (Number(checkout.amount_total) !== Number(local.gross_amount)) {
    throw new Error("Stripe checkout amount does not match the Bento product price.");
  }
  if (String(checkout.currency).toLowerCase() !== String(local.currency).toLowerCase()) {
    throw new Error("Stripe checkout currency does not match the Bento product currency.");
  }
  const paymentIntentId =
    typeof checkout.payment_intent === "string" ? checkout.payment_intent : "";
  const processorFee = paymentIntentId
    ? await processorFeeForPaymentIntent(paymentIntentId, paymentAccount)
    : 0;
  const providerPaymentId = paymentIntentId || String(checkout.invoice || checkout.id);
  const { data: fulfilled, error: fulfillmentError } = await db.rpc(
    "fulfill_provider_commerce_order",
    {
      p_product_id: local.product_id,
      p_buyer_email: local.buyer_email,
      p_buyer_name: checkout.customer_details?.name || local.buyer_name || "",
      p_provider: "stripe",
      p_provider_account_id: context.accountId,
      p_provider_checkout_id: checkout.id,
      p_provider_payment_id: providerPaymentId,
      p_provider_subscription_id:
        typeof checkout.subscription === "string" ? checkout.subscription : "",
      p_gross_amount: local.gross_amount,
      p_platform_fee_bps: local.platform_fee_bps,
      p_platform_fee_amount: local.platform_fee_amount,
      p_processor_fee_amount: processorFee,
      p_tax_amount: Math.max(0, Number(checkout.total_details?.amount_tax || 0)),
      p_net_amount: Math.max(
        0,
        Number(local.gross_amount) - Number(local.platform_fee_amount) - processorFee,
      ),
      p_currency: local.currency,
      p_metadata: commerceOrderMetadata(local, {
        bento_session_id: local.id,
        stripe_checkout_session_id: checkout.id,
        stripe_customer_id: checkout.customer || null,
        recording_addon_selected: Boolean(local.recording_addon_selected),
        recording_addon_amount: Number(local.recording_addon_amount || 0),
      }),
      p_access_token_hash: local.access_token_hash,
    },
  );
  if (fulfillmentError || !fulfilled?.order_id) {
    throw new Error(fulfillmentError?.message || "Stripe order could not be fulfilled.");
  }
  await finalizeCommerceFulfillment({
    session: local,
    orderId: fulfilled.order_id,
    providerCheckoutId: checkout.id,
  });
  const subscriptionId =
    typeof checkout.subscription === "string" ? checkout.subscription : checkout.subscription?.id;
  if (subscriptionId) {
    let subscription = checkout.subscription;
    if (typeof subscription === "string") {
      try {
        subscription = await stripeRequestForPaymentAccount<any>(
          paymentAccount,
          `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
        );
      } catch {
        subscription = { id: subscriptionId };
      }
    }
    await applyCommerceSubscriptionLifecycle({
      provider: "stripe",
      providerAccountId: context.accountId,
      providerSubscriptionId: subscriptionId,
      state: subscription.cancel_at_period_end ? "cancel_at_period_end" : "active",
      providerEventId: String(event.id),
      currentPeriodStart: subscription.current_period_start
        ? Number(subscription.current_period_start) * 1_000
        : null,
      currentPeriodEnd: subscription.current_period_end
        ? Number(subscription.current_period_end) * 1_000
        : null,
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      metadata: { stripe_status: subscription.status || null },
    });
  }
}

async function updateCheckoutStatus(event: any, status: "failed" | "expired") {
  const checkout = event.data?.object;
  if (!checkout?.id) return;
  const localSessionId = String(
    checkout.metadata?.bento_session_id || checkout.client_reference_id || "",
  );
  const db = supabaseAdmin as any;
  let query = db
    .from("commerce_payment_sessions")
    .update({ status })
    .eq("provider", "stripe")
    .eq("provider_checkout_id", checkout.id)
    .eq("status", "pending");
  if (localSessionId) query = query.eq("id", localSessionId);
  const { error } = await query;
  if (error) throw new Error(error.message);
}

async function processRefund(event: any, accountId: string) {
  const charge = event.data?.object;
  const paymentIntentId = typeof charge?.payment_intent === "string" ? charge.payment_intent : "";
  if (!paymentIntentId) return;
  await applyCommerceRefund({
    provider: "stripe",
    providerAccountId: accountId,
    providerPaymentId: paymentIntentId,
    providerEventId: String(event.id),
    refundAmount: Number(charge.amount_refunded || 0),
    amountIsCumulative: true,
    metadata: { charge_id: charge.id || null },
    occurredAt: event.created ? new Date(Number(event.created) * 1_000).toISOString() : null,
  });
}

async function processDispute(event: any, accountId: string) {
  const dispute = event.data?.object;
  const paymentIntentId =
    typeof dispute?.payment_intent === "string"
      ? dispute.payment_intent
      : String(dispute?.payment_intent?.id || "");
  if (!paymentIntentId || !dispute?.id) return;
  let outcome: CommerceDisputeOutcome = "open";
  if (event.type === "charge.dispute.closed") {
    outcome =
      dispute.status === "won" ? "won" : dispute.status === "warning_closed" ? "canceled" : "lost";
  } else if (dispute.status === "under_review") {
    outcome = "under_review";
  }
  await applyCommerceDispute({
    provider: "stripe",
    providerAccountId: accountId,
    providerPaymentId: paymentIntentId,
    providerEventId: String(event.id),
    disputeId: String(dispute.id),
    outcome,
    disputedAmount: Number(dispute.amount || 0),
    reason: dispute.reason || null,
    metadata: { charge_id: dispute.charge || null, provider_status: dispute.status || null },
    occurredAt: event.created ? new Date(Number(event.created) * 1_000).toISOString() : null,
  });
}

async function processStripeSubscriptionLifecycle(event: any, accountId: string) {
  const object = event.data?.object || {};
  const isInvoice = event.type.startsWith("invoice.");
  const subscriptionId = String(
    isInvoice
      ? typeof object.subscription === "string"
        ? object.subscription
        : object.subscription?.id || ""
      : object.id || "",
  );
  if (!subscriptionId) return;
  let state: CommerceSubscriptionState = "active";
  if (event.type === "invoice.paid") state = "renewed";
  if (event.type === "invoice.payment_failed") state = "past_due";
  if (event.type === "customer.subscription.deleted") state = "revoked";
  if (event.type === "customer.subscription.updated") {
    if (object.cancel_at_period_end) state = "cancel_at_period_end";
    else if (["past_due", "unpaid", "incomplete"].includes(String(object.status)))
      state = "past_due";
    else if (["canceled", "incomplete_expired"].includes(String(object.status))) state = "revoked";
  }
  await applyCommerceSubscriptionLifecycle({
    provider: "stripe",
    providerAccountId: accountId,
    providerSubscriptionId: subscriptionId,
    state,
    providerEventId: String(event.id),
    currentPeriodStart: object.current_period_start
      ? Number(object.current_period_start) * 1_000
      : object.period_start
        ? Number(object.period_start) * 1_000
        : null,
    currentPeriodEnd: object.current_period_end
      ? Number(object.current_period_end) * 1_000
      : object.period_end
        ? Number(object.period_end) * 1_000
        : null,
    cancelAtPeriodEnd: Boolean(object.cancel_at_period_end),
    metadata: {
      stripe_status: object.status || null,
      stripe_invoice_id: isInvoice ? object.id || null : null,
    },
  });
}

async function processAccountUpdated(event: any) {
  const account = event.data?.object;
  if (!account?.id || account.id !== event.account) {
    throw new Error("Stripe account update does not match the connected event account.");
  }
  const db = supabaseAdmin as any;
  const { data: connection, error } = await db
    .from("creator_payment_accounts")
    .update(stripeAccountFields(account))
    .eq("provider", "stripe")
    .eq("provider_account_id", event.account)
    .select("creator_id, onboarding_status")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!connection) return;
  if (connection.onboarding_status === "complete") return;
  const { error: profileError } = await db
    .from("profiles")
    .update({ commerce_payment_provider: null })
    .eq("id", connection.creator_id)
    .eq("commerce_payment_provider", "stripe");
  if (profileError) throw new Error(profileError.message);
}

async function processAccountDeauthorized(event: any) {
  const db = supabaseAdmin as any;
  const { data: connection, error } = await db
    .from("creator_payment_accounts")
    .update({
      onboarding_status: "disabled",
      charges_enabled: false,
      payouts_enabled: false,
      requirements: { disabled_reason: "application_deauthorized" },
    })
    .eq("provider", "stripe")
    .eq("provider_account_id", event.account)
    .select("creator_id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!connection) return;
  const { error: profileError } = await db
    .from("profiles")
    .update({ commerce_payment_provider: null })
    .eq("id", connection.creator_id)
    .eq("commerce_payment_provider", "stripe");
  if (profileError) throw new Error(profileError.message);
}

export async function handleStripeWebhook(request: Request) {
  const signature = request.headers.get("stripe-signature") || "";
  let body: string;
  try {
    body = await readRequestText(request, MAX_WEBHOOK_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return response(413, "Payload too large");
    return response(400, "Unable to read payload");
  }
  let signingSecret: string;
  try {
    signingSecret = stripeWebhookSecret();
  } catch {
    return response(503, "Stripe Connect webhook is not configured");
  }
  if (!(await verifyStripeSignature(body, signature, signingSecret))) {
    return response(403, "Invalid signature");
  }
  let event: any;
  try {
    event = JSON.parse(body);
  } catch {
    return response(400, "Invalid JSON");
  }
  if (!event.id || !event.type || !event.account) return response(400, "Invalid Connect event");
  return processStripeEvent(event, { accountId: event.account });
}

export async function handleDirectStripeWebhook(request: Request, connectionId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return response(404, "Not found");
  const account = await getStripePaymentAccountById(connectionId);
  if (
    !account ||
    account.credential_mode !== "restricted_key" ||
    !account.webhook_secret_ciphertext
  ) {
    return response(404, "Not found");
  }
  const signature = request.headers.get("stripe-signature") || "";
  let body: string;
  try {
    body = await readRequestText(request, MAX_WEBHOOK_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return response(413, "Payload too large");
    return response(400, "Unable to read payload");
  }
  const signingSecret = await decryptServerSecret(account.webhook_secret_ciphertext);
  if (!(await verifyStripeSignature(body, signature, signingSecret))) {
    return response(403, "Invalid signature");
  }
  let event: any;
  try {
    event = JSON.parse(body);
  } catch {
    return response(400, "Invalid JSON");
  }
  if (!event.id || !event.type) return response(400, "Invalid Stripe event");
  return processStripeEvent(event, {
    accountId: account.provider_account_id,
    connectionId: account.id,
    paymentAccount: account,
  });
}

async function processStripeEvent(
  event: any,
  context: { accountId: string; connectionId?: string; paymentAccount?: StripePaymentAccount },
) {
  let claim;
  try {
    claim = await claimCommerceWebhookEvent({
      provider: "stripe",
      eventId: event.id,
      eventType: event.type,
      payload: event,
    });
  } catch {
    return response(500, "Webhook receipt could not be recorded");
  }
  if (claim === "processed") return response(202);
  if (claim === "busy") return response(409, "Webhook is already being processed");
  try {
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      await fulfillCheckoutSession(event, context);
    }
    if (event.type === "checkout.session.async_payment_failed") {
      await updateCheckoutStatus(event, "failed");
    }
    if (event.type === "checkout.session.expired") {
      await updateCheckoutStatus(event, "expired");
    }
    if (event.type === "charge.refunded") await processRefund(event, context.accountId);
    if (event.type === "charge.dispute.created" || event.type === "charge.dispute.closed") {
      await processDispute(event, context.accountId);
    }
    if (
      event.type === "invoice.paid" ||
      event.type === "invoice.payment_failed" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      await processStripeSubscriptionLifecycle(event, context.accountId);
    }
    if (!context.connectionId && event.type === "account.updated")
      await processAccountUpdated(event);
    if (!context.connectionId && event.type === "account.application.deauthorized") {
      await processAccountDeauthorized(event);
    }
    await completeCommerceWebhookEvent("stripe", event.id);
    return response(202);
  } catch (error) {
    try {
      await failCommerceWebhookEvent("stripe", event.id, error);
    } catch (receiptError) {
      console.error("Stripe webhook failure could not be recorded", receiptError);
    }
    console.error("Stripe webhook processing failed", error);
    return response(500, "Webhook processing failed");
  }
}
