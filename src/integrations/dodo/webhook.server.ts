// Dodo Payments webhook handler. Invoked from src/server.ts for POST /api/webhooks/dodo.
// The webhook log is the idempotency boundary; Postgres remains the billing source of truth.
import { dodo } from "./client.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { captureServerEvent, captureServerException } from "@/lib/posthog.server";
import {
  verifiedDodoAddonState,
  type DodoAddonCartItem,
  type VerifiedDodoAddonState,
} from "@/lib/billing-addons";
import { readRequestText, RequestBodyTooLargeError } from "@/lib/request-security.server";
import { enqueueBentoBillingEmail } from "@/lib/email.server";
import {
  DODO_PRODUCT_ENV,
  BASE_MARKETING_CONTACTS,
  highestPlan,
  isPaidPlan,
  normalizePlan,
  PAID_PLAN_IDS,
  type BillingPeriod,
  type PaidPlanId,
  type PlanId,
} from "@/lib/plans";

function hydrateEnv(env: unknown) {
  if (!env || typeof env !== "object") return;
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    const allowed =
      key === "APP_ENV" ||
      key.startsWith("DODO_") ||
      key.startsWith("SUPABASE_") ||
      key.startsWith("CLOUDFLARE_") ||
      key.startsWith("VITE_");
    if (allowed && typeof value === "string" && !process.env[key]) process.env[key] = value;
  }
}

type JsonRecord = Record<string, unknown>;
export type DodoEvent = { type: string; timestamp?: string; data: JsonRecord };
export type DodoQueueMessage = {
  kind: "dodo_webhook";
  webhookId: string;
  event: DodoEvent;
};
type DodoWebhookEnvironment = { BILLING_QUEUE?: Queue<DodoQueueMessage> };
type SubStatus = "active" | "trialing" | "past_due" | "canceled" | "incomplete";

const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const asBoolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

function firstProductId(data: JsonRecord): string | null {
  const cart = data.product_cart;
  if (!Array.isArray(cart) || cart.length === 0) return asString(data.product_id);
  return asString(asRecord(cart[0]).product_id) ?? asString(data.product_id);
}

function resolveUserId(data: JsonRecord): string | null {
  return (
    asString(asRecord(data.metadata).user_id) ??
    asString(asRecord(asRecord(data.customer).metadata).user_id)
  );
}

function planFromEvent(data: JsonRecord): PaidPlanId | null {
  // The purchased product is the source of truth for the plan. Checkout
  // metadata is buyer-influenceable on Dodo payment links, so it is only a
  // fallback for events that carry no product reference at all.
  const productId = asString(data.product_id) ?? firstProductId(data);
  if (productId) {
    for (const plan of PAID_PLAN_IDS) {
      for (const period of ["monthly", "yearly"] as const) {
        if (process.env[DODO_PRODUCT_ENV[plan][period]] === productId) return plan;
      }
    }
    return null;
  }

  const metadataPlan = normalizePlan(asRecord(data.metadata).plan);
  return isPaidPlan(metadataPlan) ? metadataPlan : null;
}

function requiredPlanFromEvent(data: JsonRecord): PaidPlanId {
  const plan = planFromEvent(data);
  if (!plan) throw new Error("Dodo event references an unknown Bento product.");
  return plan;
}

function billingPeriodFromEvent(data: JsonRecord): BillingPeriod | null {
  const productId = asString(data.product_id) ?? firstProductId(data);
  if (productId) {
    for (const plan of PAID_PLAN_IDS) {
      for (const period of ["monthly", "yearly"] as const) {
        if (process.env[DODO_PRODUCT_ENV[plan][period]] === productId) return period;
      }
    }
  }
  const period = asString(data.payment_frequency_interval);
  return period === "monthly" || period === "yearly" ? period : null;
}

function addonCartFromEvent(data: JsonRecord): DodoAddonCartItem[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(data, "addons")) return undefined;
  const addons = data.addons;
  if (!Array.isArray(addons)) return [];
  return addons.map((addon) => {
    const item = asRecord(addon);
    return { addon_id: asString(item.addon_id) ?? "", quantity: asNumber(item.quantity) ?? 0 };
  });
}

function addonStateForSubscription(
  addonState: VerifiedDodoAddonState | null,
  plan: PlanId,
  active: boolean,
): VerifiedDodoAddonState | null {
  if (!active || plan === "free") {
    return { contactTierContacts: BASE_MARKETING_CONTACTS, storageAddonUnits: 0 };
  }
  if (!addonState) return null;
  if (plan === "store") return { ...addonState, contactTierContacts: BASE_MARKETING_CONTACTS };
  return addonState;
}

function eventStatus(type: string, data: JsonRecord): string {
  return asString(data.status) ?? type.split(".").at(-1) ?? "unknown";
}

function occurredAt(event: DodoEvent): string | null {
  return asString(event.timestamp) ?? asString(event.data.created_at) ?? null;
}

async function applyPlan(
  userId: string,
  plan: PlanId,
  subscription: {
    dodoId?: string | null;
    status: SubStatus;
    currentPeriodEnd?: string | null;
    productId?: string | null;
    customerId?: string | null;
    amount?: number | null;
    currency?: string | null;
    billingInterval?: string | null;
    cancelAtPeriodEnd?: boolean;
    canceledAt?: string | null;
    addonState?: VerifiedDodoAddonState | null;
  },
) {
  const { data: complimentaryGrant, error: complimentaryError } = await supabaseAdmin
    .from("complimentary_plan_grants")
    .select("plan_id")
    .eq("user_id", userId)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (complimentaryError) {
    throw new Error(`complimentary plan lookup failed: ${complimentaryError.message}`);
  }
  const grantedPlan = normalizePlan(complimentaryGrant?.plan_id);
  const effectiveProfilePlan = highestPlan(grantedPlan, plan);

  const { error: profileError } = await supabaseAdmin
    .from("profiles")
    .update({ is_pro: isPaidPlan(effectiveProfilePlan), plan_id: effectiveProfilePlan })
    .eq("id", userId);
  if (profileError) throw new Error(`profiles update failed: ${profileError.message}`);

  const { error: subscriptionError } = await supabaseAdmin.from("subscriptions").upsert(
    {
      user_id: userId,
      plan_id: plan,
      pending_plan_id: null,
      pending_plan_effective_at: null,
      status: subscription.status,
      dodo_subscription_id: subscription.dodoId ?? null,
      stripe_subscription_id: subscription.dodoId ?? null,
      product_id: subscription.productId ?? null,
      price_id: subscription.productId ?? null,
      customer_id: subscription.customerId ?? null,
      amount: subscription.amount ?? null,
      currency: subscription.currency ?? null,
      billing_interval: subscription.billingInterval ?? null,
      cancel_at_period_end: subscription.cancelAtPeriodEnd ?? false,
      canceled_at: subscription.canceledAt ?? null,
      current_period_end: subscription.currentPeriodEnd ?? null,
      ...(subscription.addonState
        ? {
            contact_tier_contacts: subscription.addonState.contactTierContacts,
            storage_addon_units: subscription.addonState.storageAddonUnits,
          }
        : {}),
    },
    { onConflict: "user_id" },
  );
  if (subscriptionError) {
    throw new Error(`subscriptions upsert failed: ${subscriptionError.message}`);
  }

  // Downgrades never destroy creator data. Host routing checks the current plan
  // before serving a saved custom domain, so it becomes available again after
  // a later upgrade without making the creator repeat DNS setup.
}

async function findPaymentUser(paymentId: string | null): Promise<string | null> {
  if (!paymentId) return null;
  const { data, error } = await supabaseAdmin
    .from("payments")
    .select("user_id")
    .eq("payment_id", paymentId)
    .maybeSingle();
  if (error) throw new Error(`payment lookup failed: ${error.message}`);
  return data?.user_id ?? null;
}

async function recordPayment(event: DodoEvent, userId: string | null) {
  const data = event.data;
  const paymentId = asString(data.payment_id);
  if (!paymentId) throw new Error(`${event.type} has no payment_id`);

  const { error } = await supabaseAdmin.from("payments").upsert(
    {
      payment_id: paymentId,
      user_id: userId,
      subscription_id: asString(data.subscription_id),
      checkout_session_id: asString(data.checkout_session_id),
      product_id: firstProductId(data),
      status: eventStatus(event.type, data),
      total_amount: asNumber(data.total_amount) ?? 0,
      settlement_amount: asNumber(data.settlement_amount),
      currency: asString(data.currency) ?? "USD",
      settlement_currency: asString(data.settlement_currency),
      tax: asNumber(data.tax),
      refund_status: asString(data.refund_status),
      payment_method: asString(data.payment_method),
      occurred_at: occurredAt(event),
    },
    { onConflict: "payment_id" },
  );
  if (error) throw new Error(`payments upsert failed: ${error.message}`);
}

async function recordRefund(
  event: DodoEvent,
  initialUserId: string | null,
): Promise<string | null> {
  const data = event.data;
  const refundId = asString(data.refund_id);
  const paymentId = asString(data.payment_id);
  if (!refundId || !paymentId) throw new Error(`${event.type} has no refund_id or payment_id`);

  const userId = initialUserId ?? (await findPaymentUser(paymentId));
  const { error } = await supabaseAdmin.from("refunds").upsert(
    {
      refund_id: refundId,
      payment_id: paymentId,
      user_id: userId,
      status: eventStatus(event.type, data),
      amount: asNumber(data.amount) ?? 0,
      currency: asString(data.currency) ?? "USD",
      reason: asString(data.reason),
      occurred_at: occurredAt(event),
    },
    { onConflict: "refund_id" },
  );
  if (error) throw new Error(`refunds upsert failed: ${error.message}`);
  return userId;
}

function subscriptionState(event: DodoEvent): { active: boolean; status: SubStatus } {
  const rawStatus = eventStatus(event.type, event.data);
  if (event.type === "subscription.cancelled" || event.type === "subscription.expired") {
    return { active: false, status: "canceled" };
  }
  if (event.type === "subscription.failed" || event.type === "subscription.on_hold") {
    return { active: false, status: "past_due" };
  }
  if (["cancelled", "canceled", "expired"].includes(rawStatus)) {
    return { active: false, status: "canceled" };
  }
  if (["failed", "on_hold", "past_due", "paused"].includes(rawStatus)) {
    return { active: false, status: "past_due" };
  }
  if (rawStatus === "trialing") return { active: true, status: "trialing" };
  if (["active", "renewed", "updated", "plan_changed"].includes(rawStatus)) {
    return { active: true, status: "active" };
  }
  // Unknown/pending states never grant a paid plan (fail closed).
  return { active: false, status: "incomplete" };
}

async function syncSubscription(event: DodoEvent, userId: string) {
  const data = event.data;
  const state = subscriptionState(event);
  const plan = state.active ? requiredPlanFromEvent(data) : "free";
  const billingPeriod = billingPeriodFromEvent(data);
  const addonState = addonStateForSubscription(
    verifiedDodoAddonState(addonCartFromEvent(data), billingPeriod, process.env),
    plan,
    state.active,
  );
  const dodoId = asString(data.subscription_id);
  if (!state.active && dodoId) {
    // A terminal/inactive event for subscription X must not downgrade a user
    // whose current entitlement comes from a different, still-active
    // subscription Y (e.g. a stale/foreign subscription referencing this user).
    const { data: current, error } = await supabaseAdmin
      .from("subscriptions")
      .select("dodo_subscription_id, status")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(`subscription lookup failed: ${error.message}`);
    if (
      current?.dodo_subscription_id &&
      current.dodo_subscription_id !== dodoId &&
      (current.status === "active" || current.status === "trialing")
    ) {
      console.warn("[dodo] ignoring inactive event for a non-current subscription", {
        eventType: event.type,
        eventSubscription: dodoId,
        currentSubscription: current.dodo_subscription_id,
      });
      return;
    }
  }
  await applyPlan(userId, plan, {
    dodoId: asString(data.subscription_id),
    status: state.status,
    currentPeriodEnd: asString(data.next_billing_date),
    productId: asString(data.product_id) ?? firstProductId(data),
    customerId: asString(data.customer_id),
    amount: asNumber(data.recurring_pre_tax_amount),
    currency: asString(data.currency),
    billingInterval: asString(data.payment_frequency_interval),
    cancelAtPeriodEnd: asBoolean(data.cancel_at_next_billing_date) ?? false,
    canceledAt: state.status === "canceled" ? occurredAt(event) : null,
    addonState,
  });
  if (state.active && billingPeriod && addonState) {
    await captureServerEvent(userId, "dodo_addons_verified", {
      plan,
      billing_period: billingPeriod,
      contact_tier: addonState.contactTierContacts,
      storage_units: addonState.storageAddonUnits,
    });
  }
}

async function processEvent(event: DodoEvent): Promise<string | null> {
  const userId = resolveUserId(event.data);

  if (event.type.startsWith("payment.")) {
    await recordPayment(event, userId);
    if (event.type === "payment.succeeded") {
      const paymentId = asString(event.data.payment_id);
      const { error } = await supabaseAdmin.rpc(
        "record_referral_payment_effect" as never,
        {
          p_payment_id: paymentId,
          p_product_eligible: Boolean(planFromEvent(event.data)),
        } as never,
      );
      if (error) throw new Error(`referral payment effect failed: ${error.message}`);
    }
    if (event.type === "payment.succeeded" && !asString(event.data.subscription_id)) {
      if (!userId) throw new Error("lifetime payment has no metadata.user_id");
      await applyPlan(userId, requiredPlanFromEvent(event.data), {
        dodoId: asString(event.data.payment_id),
        status: "active",
        productId: firstProductId(event.data) ?? "lifetime",
        amount: asNumber(event.data.total_amount),
        currency: asString(event.data.currency),
        billingInterval: "lifetime",
      });
    }
    return userId;
  }

  if (event.type.startsWith("refund.")) {
    const resolvedUserId = await recordRefund(event, userId);
    if (event.type === "refund.succeeded") {
      const { error } = await supabaseAdmin.rpc(
        "apply_referral_refund" as never,
        { p_refund_id: asString(event.data.refund_id) } as never,
      );
      if (error) throw new Error(`referral refund reversal failed: ${error.message}`);
    }
    return resolvedUserId;
  }

  if (event.type.startsWith("subscription.")) {
    if (!userId) throw new Error(`${event.type} has no metadata.user_id`);
    await syncSubscription(event, userId);
    return userId;
  }

  return userId;
}

async function claimEvent(webhookId: string, event: DodoEvent): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc(
    "claim_billing_event" as never,
    {
      p_webhook_id: webhookId,
      p_event_type: event.type,
      p_payload: event as unknown as Json,
      p_occurred_at: occurredAt(event),
    } as never,
  );
  if (error) throw new Error(`billing event claim failed: ${error.message}`);
  return Boolean(data);
}

async function markEvent(
  webhookId: string,
  status: "processed" | "failed",
  userId: string | null,
  errorMessage: string | null = null,
) {
  const { error } = await supabaseAdmin
    .from("billing_events")
    .update({
      status,
      user_id: userId,
      error_message: errorMessage,
      processed_at: status === "processed" ? new Date().toISOString() : null,
    })
    .eq("webhook_id", webhookId);
  if (error) throw new Error(`billing event update failed: ${error.message}`);
}

export function buildBillingAnalyticsProperties(event: DodoEvent, webhookId: string) {
  const isPayment = event.type === "payment.succeeded";
  const isRefund = event.type === "refund.succeeded";
  const amount =
    asNumber(event.data.total_amount) ??
    asNumber(event.data.amount) ??
    asNumber(event.data.recurring_pre_tax_amount);
  const revenue = amount != null && (isPayment || isRefund) ? amount * (isRefund ? -1 : 1) : null;

  return {
    $insert_id: `dodo:${webhookId}`,
    provider: "dodo",
    amount,
    revenue,
    revenue_kind: isPayment ? "payment" : isRefund ? "refund" : null,
    currency: asString(event.data.currency)?.toUpperCase() ?? null,
    product: firstProductId(event.data),
    product_id: firstProductId(event.data),
    subscription_id: asString(event.data.subscription_id),
    payment_id: asString(event.data.payment_id),
    refund_id: asString(event.data.refund_id),
    billing_status: eventStatus(event.type, event.data),
  };
}

async function captureBillingEvent(event: DodoEvent, userId: string | null, webhookId: string) {
  if (!userId) return;
  await captureServerEvent(
    userId,
    event.type.replaceAll(".", "_"),
    buildBillingAnalyticsProperties(event, webhookId),
  );
}

async function enqueueBillingEmail(event: DodoEvent, userId: string | null, webhookId: string) {
  if (!userId) return;
  let emailType:
    "pro_activated" | "payment_failed" | "subscription_cancelled" | "refund_processed" | null =
    null;
  const belongsToSubscription = Boolean(asString(event.data.subscription_id));
  // Dodo emits both a payment event and a subscription event for the same
  // subscription transition. Use subscription events for recurring plans and
  // payment events only for one-time/lifetime purchases to avoid duplicate mail.
  if (
    event.type === "subscription.active" ||
    (event.type === "payment.succeeded" && !belongsToSubscription)
  ) {
    emailType = "pro_activated";
  } else if (
    (event.type === "payment.failed" && !belongsToSubscription) ||
    event.type === "subscription.failed" ||
    event.type === "subscription.on_hold"
  ) {
    emailType = "payment_failed";
  } else if (event.type === "subscription.cancelled" || event.type === "subscription.expired") {
    emailType = "subscription_cancelled";
  } else if (event.type === "refund.succeeded") {
    emailType = "refund_processed";
  }
  if (!emailType) return;
  await enqueueBentoBillingEmail({
    eventKey: `dodo:${webhookId}`,
    eventType: emailType,
    userId,
    amount:
      asNumber(event.data.total_amount) ??
      asNumber(event.data.amount) ??
      asNumber(event.data.recurring_pre_tax_amount),
    currency: asString(event.data.currency),
  });
}

export async function processVerifiedDodoEvent(event: DodoEvent, webhookId: string) {
  let userId: string | null = resolveUserId(event.data);
  try {
    if (!(await claimEvent(webhookId, event))) {
      return { duplicate: true };
    }
    userId = await processEvent(event);
    await markEvent(webhookId, "processed", userId);
    await captureBillingEvent(event, userId, webhookId);
    try {
      await enqueueBillingEmail(event, userId, webhookId);
    } catch (emailError) {
      console.error("[email] billing notification was deferred", emailError);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown handler error";
    console.error(`[dodo] failed to process ${event.type}`, error);
    try {
      await markEvent(webhookId, "failed", userId, message.slice(0, 1_000));
    } catch (markError) {
      console.error("[dodo] failed to mark webhook failure", markError);
    }
    await captureServerException(error, userId ?? "dodo-webhook", {
      surface: "dodo_webhook",
      event_type: event.type,
    });
    throw error;
  }

  return { duplicate: false };
}

export async function handleDodoWebhook(request: Request, env?: unknown): Promise<Response> {
  hydrateEnv(env);
  const webhookId = request.headers.get("webhook-id")?.trim();
  if (!webhookId || webhookId.length > 255) {
    return new Response("missing or invalid webhook-id", { status: 400 });
  }

  let raw: string;
  try {
    raw = await readRequestText(request, 1_048_576);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return new Response("payload too large", { status: 413 });
    }
    throw error;
  }
  let event: DodoEvent;
  try {
    event = dodo.webhooks.unwrap(raw, {
      headers: {
        "webhook-id": webhookId,
        "webhook-signature": request.headers.get("webhook-signature") ?? "",
        "webhook-timestamp": request.headers.get("webhook-timestamp") ?? "",
      },
    }) as unknown as DodoEvent;
  } catch (error) {
    console.error("[dodo] webhook signature verification failed", error);
    return new Response("invalid signature", { status: 401 });
  }

  const billingQueue = (env as DodoWebhookEnvironment | undefined)?.BILLING_QUEUE;
  if (billingQueue) {
    try {
      await billingQueue.send({ kind: "dodo_webhook", webhookId, event });
      return Response.json({ received: true, queued: true }, { status: 202 });
    } catch (error) {
      console.error("[dodo] failed to enqueue verified webhook", error);
      return new Response("queue unavailable", { status: 503 });
    }
  }

  try {
    const result = await processVerifiedDodoEvent(event, webhookId);
    return Response.json({ received: true, ...result });
  } catch {
    return new Response("handler error", { status: 500 });
  }
}
