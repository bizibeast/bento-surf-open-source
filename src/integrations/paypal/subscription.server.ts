/* eslint-disable @typescript-eslint/no-explicit-any -- PayPal payloads are bound to stored checkout snapshots before fulfillment. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  commerceOrderMetadata,
  finalizeCommerceFulfillment,
} from "@/lib/commerce-fulfillment.server";
import {
  applyCommerceSubscriptionLifecycle,
  type CommerceSubscriptionState,
} from "@/lib/commerce-subscription-lifecycle.server";
import {
  getPayPalPaymentAccountById,
  paypalDirectWebhookUrl,
  paypalRequest,
  paypalRequestForAccount,
  PAYPAL_WEBHOOK_EVENTS,
  type PayPalPaymentAccount,
} from "./client.server";
import { paypalMinorUnits, paypalMoney } from "./money";

export function assertPayPalSubscriptionCheckout(input: {
  billingInterval: unknown;
  platformFeeAmount: number;
  hasAdjustments: boolean;
}) {
  if (
    typeof input.billingInterval !== "string" ||
    !["day", "week", "month", "year"].includes(input.billingInterval)
  ) {
    throw new Error("PayPal subscriptions require daily, weekly, monthly, or yearly billing.");
  }
  if (input.hasAdjustments) {
    throw new Error("Discounts and paid add-ons currently require a one-time offer.");
  }
  // Unlike Orders, the native Subscriptions API cannot split platform fees.
  if (input.platformFeeAmount !== 0) {
    throw new Error("PayPal subscriptions require Bento's platform fee to remain 0%.");
  }
}

export async function ensurePayPalSubscriptionWebhooks(account: PayPalPaymentAccount) {
  const direct = account.credential_mode === "api_key";
  const webhookId = direct ? account.webhook_endpoint_id : process.env.PAYPAL_WEBHOOK_ID?.trim();
  if (!webhookId)
    throw new Error("PayPal subscription webhooks are not configured. Reconnect PayPal.");
  const path = `/v1/notifications/webhooks/${encodeURIComponent(webhookId)}`;
  const webhook = direct
    ? await paypalRequestForAccount<any>(account, path)
    : await paypalRequest<any>(path, { includePartnerAttribution: false });
  if (webhook.id !== webhookId || (direct && webhook.url !== paypalDirectWebhookUrl(account.id))) {
    throw new Error("PayPal subscription webhook does not match this Bento connection.");
  }
  const subscribed = new Set((webhook.event_types || []).map((event: any) => event.name));
  if (!subscribed.has("*") && PAYPAL_WEBHOOK_EVENTS.some((name) => !subscribed.has(name))) {
    const init = {
      method: "PATCH" as const,
      body: [
        {
          op: "replace",
          path: "/event_types",
          value: Array.from(new Set([...subscribed, ...PAYPAL_WEBHOOK_EVENTS])).map((name) => ({
            name,
          })),
        },
      ],
      includePartnerAttribution: false,
    };
    if (direct) await paypalRequestForAccount(account, path, init);
    else await paypalRequest(path, init);
  }
}

export async function createPayPalSubscription(input: {
  account: PayPalPaymentAccount;
  sessionId: string;
  product: {
    title: string;
    description: string;
    price_amount: number;
    currency: string;
    billing_interval?: string | null;
  };
  metadata: Record<string, unknown>;
  email: string;
  returnUrl: string;
  cancelUrl: string;
}) {
  const { account, sessionId, product } = input;
  await ensurePayPalSubscriptionWebhooks(account);
  // A plan belongs to this checkout snapshot, so later catalogue edits cannot
  // change either an approved recurring price or payment validation.
  const providerProduct = await paypalRequestForAccount<{ id: string }>(
    account,
    "/v1/catalogs/products",
    {
      method: "POST",
      requestId: `${sessionId}-p`,
      body: {
        name: product.title.slice(0, 127),
        description: product.description.slice(0, 256) || product.title.slice(0, 256),
        type: "SERVICE",
      },
    },
  );
  if (!providerProduct.id) throw new Error("PayPal did not return a subscription product.");
  const plan = await paypalRequestForAccount<{ id: string }>(account, "/v1/billing/plans", {
    method: "POST",
    requestId: `${sessionId}-b`,
    body: {
      product_id: providerProduct.id,
      name: product.title.slice(0, 127),
      status: "ACTIVE",
      billing_cycles: [
        {
          frequency: {
            interval_unit: String(product.billing_interval).toUpperCase(),
            interval_count: 1,
          },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: {
              value: paypalMoney(product.price_amount, product.currency),
              currency_code: product.currency.toUpperCase(),
            },
          },
        },
      ],
      // Do not aggregate arrears into a later charge that differs from the
      // fixed recurring amount approved by the buyer.
      payment_preferences: { auto_bill_outstanding: false, payment_failure_threshold: 1 },
    },
  });
  if (!plan.id) throw new Error("PayPal did not return a subscription plan.");
  const { error } = await (supabaseAdmin as any)
    .from("commerce_payment_sessions")
    .update({
      metadata: {
        ...input.metadata,
        subscription_checkout: true,
        billing_interval: product.billing_interval,
        paypal_product_id: providerProduct.id,
        paypal_plan_id: plan.id,
      },
    })
    .eq("id", sessionId)
    .eq("status", "pending");
  if (error) throw new Error(error.message);
  return paypalRequestForAccount<{ id: string; links: Array<{ href: string; rel: string }> }>(
    account,
    "/v1/billing/subscriptions",
    {
      method: "POST",
      requestId: `${sessionId}-s`,
      body: {
        plan_id: plan.id,
        custom_id: sessionId,
        quantity: "1",
        subscriber: { email_address: input.email },
        application_context: {
          brand_name: "bento.surf",
          shipping_preference: "NO_SHIPPING",
          user_action: "SUBSCRIBE_NOW",
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
        },
      },
    },
  );
}

export async function verifiedPayPalSubscription(account: PayPalPaymentAccount, session: any) {
  const subscription = await paypalRequestForAccount<any>(
    account,
    `/v1/billing/subscriptions/${encodeURIComponent(session.provider_checkout_id)}`,
  );
  if (
    subscription.id !== session.provider_checkout_id ||
    subscription.custom_id !== session.id ||
    !session.metadata?.paypal_plan_id ||
    subscription.plan_id !== session.metadata.paypal_plan_id ||
    (subscription.quantity !== undefined && String(subscription.quantity) !== "1")
  ) {
    throw new Error("PayPal subscription does not match this Bento checkout.");
  }
  return subscription;
}

function isoDate(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function paidPeriodEnd(start: string, interval: unknown) {
  const date = new Date(start);
  if (interval === "day" || interval === "week") {
    date.setUTCDate(date.getUTCDate() + (interval === "day" ? 1 : 7));
    return date.toISOString();
  }
  const day = date.getUTCDate();
  // Clamp to the final day of the destination month (Jan 31 -> Feb 28).
  date.setUTCDate(1);
  if (interval === "year") date.setUTCFullYear(date.getUTCFullYear() + 1);
  else if (interval === "month") date.setUTCMonth(date.getUTCMonth() + 1);
  else throw new Error("PayPal checkout is missing its billing interval.");
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString();
}

function lifecycleState(status: unknown): CommerceSubscriptionState | null {
  if (status === "CANCELLED") return "cancel_at_period_end";
  if (status === "SUSPENDED") return "past_due";
  if (status === "EXPIRED") return "expired";
  return null;
}

export type PayPalSubscriptionScope = {
  creatorId?: string;
  providerAccountId?: string;
  connectionId?: string;
};

export async function processPayPalSubscriptionEvent(event: any, scope: PayPalSubscriptionScope) {
  const isPayment = event.event_type === "PAYMENT.SALE.COMPLETED";
  const resource = event.resource || {};
  const subscriptionId = String(
    isPayment ? resource.billing_agreement_id || "" : resource.id || "",
  );
  if (!subscriptionId) return;
  let query = (supabaseAdmin as any)
    .from("commerce_payment_sessions")
    .select("*")
    .eq("provider", "paypal")
    .eq("provider_checkout_id", subscriptionId);
  if (scope.creatorId) query = query.eq("creator_id", scope.creatorId);
  const { data: session, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  // Shared apps may also receive subscriptions created outside Bento.
  if (!session) {
    // A sale can arrive while the create-subscription response is still being
    // persisted. Let PayPal retry so the first paid event cannot be lost.
    if (isPayment) throw new Error("PayPal subscription checkout is not available yet.");
    return;
  }
  if (
    !session.metadata?.subscription_checkout ||
    !["pending", "approved", "paid"].includes(session.status)
  ) {
    throw new Error("PayPal subscription checkout is no longer payable.");
  }
  const account = await getPayPalPaymentAccountById(session.connection_id);
  if (
    !account ||
    account.id !== session.connection_id ||
    account.creator_id !== session.creator_id ||
    (scope.connectionId && account.id !== scope.connectionId) ||
    (scope.creatorId && account.creator_id !== scope.creatorId) ||
    (scope.providerAccountId && account.provider_account_id !== scope.providerAccountId)
  ) {
    throw new Error("PayPal subscription seller does not match the connected account.");
  }
  const subscription = await verifiedPayPalSubscription(account, session);
  let state = lifecycleState(subscription.status);
  let currentPeriodStart = isoDate(subscription.billing_info?.last_payment?.time);
  let currentPeriodEnd: string | null = null;
  if (isPayment) {
    if (
      resource.state !== "completed" ||
      !resource.id ||
      !resource.amount?.total ||
      !resource.amount?.currency
    ) {
      throw new Error("PayPal subscription payment was not completed.");
    }
    const gross = paypalMinorUnits(resource.amount.total, session.currency);
    if (
      gross !== Number(session.gross_amount) ||
      String(resource.amount.currency).toLowerCase() !== session.currency ||
      Number(session.platform_fee_amount) !== 0
    ) {
      throw new Error("PayPal subscription payment amount does not match the checkout.");
    }
    const fee = resource.transaction_fee;
    if (fee && String(fee.currency || fee.currency_code).toLowerCase() !== session.currency) {
      throw new Error("PayPal subscription payment fee currency does not match the checkout.");
    }
    const processorFee = fee ? paypalMinorUnits(fee.value, session.currency) : 0;
    if (processorFee > gross) throw new Error("PayPal subscription payment fee is invalid.");
    currentPeriodStart = isoDate(resource.create_time);
    if (!currentPeriodStart)
      throw new Error("PayPal subscription payment is missing its billing date.");
    currentPeriodEnd = paidPeriodEnd(currentPeriodStart, session.metadata.billing_interval);
    const nextBillingTime = isoDate(subscription.billing_info?.next_billing_time);
    // PayPal retains the original billing anchor through shorter months.
    // Bound the provider date to one cycle so an old delayed sale cannot use
    // today's distant next-billing date to grant several unpaid periods.
    const maximumCycleDays =
      session.metadata.billing_interval === "day"
        ? 1
        : session.metadata.billing_interval === "week"
          ? 7
          : session.metadata.billing_interval === "year"
            ? 366
            : 31;
    if (
      nextBillingTime &&
      nextBillingTime > currentPeriodStart &&
      Date.parse(nextBillingTime) - Date.parse(currentPeriodStart) <= maximumCycleDays * 86_400_000
    ) {
      currentPeriodEnd = nextBillingTime;
    }
    const { data: fulfilled, error: fulfillmentError } = await (supabaseAdmin as any).rpc(
      "fulfill_provider_commerce_order_with_period",
      {
        p_product_id: session.product_id,
        p_buyer_email: session.buyer_email,
        p_buyer_name: session.buyer_name || "",
        p_provider: "paypal",
        p_provider_account_id: account.provider_account_id,
        // Each renewal has its own financial history. The original approval ID
        // remains on the payment session; the RPC binds via bento_session_id.
        p_provider_checkout_id: String(resource.id),
        p_provider_payment_id: String(resource.id),
        p_provider_subscription_id: subscriptionId,
        p_subscription_period_start: currentPeriodStart,
        p_subscription_period_end: currentPeriodEnd,
        p_gross_amount: gross,
        p_platform_fee_bps: session.platform_fee_bps,
        p_platform_fee_amount: 0,
        p_processor_fee_amount: processorFee,
        p_tax_amount: 0,
        p_net_amount: gross - processorFee,
        p_currency: session.currency,
        p_metadata: commerceOrderMetadata(session, {
          bento_session_id: session.id,
          paypal_subscription_id: subscriptionId,
          paypal_sale_id: resource.id,
          current_period_start: currentPeriodStart,
          current_period_end: currentPeriodEnd,
        }),
        p_access_token_hash: session.access_token_hash || null,
      },
    );
    if (fulfillmentError || !fulfilled?.order_id)
      throw new Error(
        fulfillmentError?.message || "PayPal subscription order could not be fulfilled.",
      );
    await finalizeCommerceFulfillment({
      session,
      orderId: fulfilled.order_id,
      providerCheckoutId: subscriptionId,
    });
    // Only the verified paid transition may advance an existing paid period.
    // A subscription may already be cancelled/suspended when its final sale
    // arrives; preserve that paid boundary before applying its current status.
    await applyCommerceSubscriptionLifecycle({
      provider: "paypal",
      providerAccountId: account.provider_account_id,
      providerSubscriptionId: subscriptionId,
      state: "renewed",
      fundingOrderId: String(fulfilled.order_id),
      providerEventId: `${event.id}:paid`,
      currentPeriodStart,
      currentPeriodEnd,
      metadata: {
        paypal_status: subscription.status,
        provider_event_created_at: event.create_time || null,
      },
    });
  } else {
    // A status/approval event cannot manufacture or extend a paid period.
    // The guarded RPC requires a paid order; cancellation uses its stored end.
    if (event.event_type === "BILLING.SUBSCRIPTION.PAYMENT.FAILED" && !state) {
      const eventTime = isoDate(event.create_time);
      // A delayed failed-payment event must not override a later paid renewal.
      if (!eventTime || !currentPeriodStart || currentPeriodStart <= eventTime) state = "past_due";
    }
    currentPeriodStart = null;
  }
  if (state) {
    await applyCommerceSubscriptionLifecycle({
      provider: "paypal",
      providerAccountId: account.provider_account_id,
      providerSubscriptionId: subscriptionId,
      state,
      providerEventId: isPayment ? `${event.id}:status` : String(event.id),
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd: state === "cancel_at_period_end",
      metadata: {
        paypal_status: subscription.status,
        provider_event_created_at: event.create_time || null,
      },
    });
  }
}
