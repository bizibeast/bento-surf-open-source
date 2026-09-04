import { configuredAppOrigin } from "@/lib/application-urls";
import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { dodo } from "@/integrations/dodo/client.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  BASE_MARKETING_CONTACTS,
  DODO_PRODUCT_ENV,
  isPaidPlan,
  normalizePlan,
  PAID_PLAN_IDS,
  TRIAL_DAYS,
  type BillingPeriod,
  type ContactTier,
  type PaidPlanId,
  type PlanId,
} from "./plans";
import { desiredDodoAddonCart } from "./billing-addons";
import { enforceRequestRateLimit } from "./request-security.server";
import { parsePublicHttpUrl } from "./safe-url";

const paidPlanSchema = z.enum(["store", "creator"]);
const checkoutPeriodSchema = z.enum(["monthly", "yearly"]);
const returnToSchema = z.enum(["dashboard", "onboarding"]).default("dashboard");
const checkoutAddonsSchema = z.object({
  contactTier: z
    .union([
      z.literal(500),
      z.literal(5_000),
      z.literal(10_000),
      z.literal(25_000),
      z.literal(50_000),
      z.literal(100_000),
      z.literal(150_000),
    ])
    .default(BASE_MARKETING_CONTACTS),
  storageUnits: z.number().int().min(0).max(100).default(0),
});
const cancellationFeedbackSchema = z.enum([
  "too_expensive",
  "missing_features",
  "switched_service",
  "unused",
  "customer_service",
  "low_quality",
  "too_complex",
  "other",
]);
const cancellationInputSchema = z.object({
  reason: cancellationFeedbackSchema,
  details: z.string().trim().max(500).optional(),
});

export type CancellationFeedback = z.infer<typeof cancellationFeedbackSchema>;
export type CheckoutAddonSelection = z.infer<typeof checkoutAddonsSchema>;

function dodoErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  const status = Number(error.status);
  return Number.isFinite(status) ? status : null;
}

async function createHostedCheckoutSession(input: {
  userId: string;
  email?: string;
  plan: PaidPlanId;
  period: BillingPeriod;
  returnTo: "dashboard" | "onboarding";
  addons?: CheckoutAddonSelection;
}) {
  const envKey = DODO_PRODUCT_ENV[input.plan][input.period];
  const productId = process.env[envKey];
  if (!productId) {
    throw new Error(`No Dodo product configured for ${input.plan} ${input.period}.`);
  }

  const appUrl = configuredAppOrigin(process.env.VITE_APP_URL);
  let session: Awaited<ReturnType<typeof dodo.checkoutSessions.create>>;
  try {
    const addons = input.addons
      ? desiredDodoAddonCart({ ...input, ...input.addons, env: process.env })
      : [];
    session = await dodo.checkoutSessions.create({
      product_cart: [{ product_id: productId, quantity: 1, ...(addons.length ? { addons } : {}) }],
      subscription_data: { trial_period_days: TRIAL_DAYS },
      ...(input.email ? { customer: { email: input.email, name: input.email.split("@")[0] } } : {}),
      metadata: { user_id: input.userId, plan: input.plan, period: input.period },
      return_url:
        input.returnTo === "onboarding"
          ? `${appUrl}/onboarding?checkout=success`
          : `${appUrl}/link?upgraded=1`,
    });
  } catch (error) {
    console.error("Dodo checkout session creation failed.", {
      status: dodoErrorStatus(error),
      plan: input.plan,
      period: input.period,
    });
    throw new Error(
      "Secure checkout is temporarily unavailable. Please try again or contact the instance operator.",
    );
  }

  const checkoutUrl = parsePublicHttpUrl(session.checkout_url, { requireHttps: true });
  if (!checkoutUrl) throw new Error("Dodo did not return a checkout URL.");
  return checkoutUrl.toString();
}

/**
 * Create a Dodo hosted-checkout session for the current user and return its URL.
 * Every paid subscription includes a 7-day free trial.
 * The user's id is attached as metadata so the webhook can map the purchase back to them.
 */
export const createCheckout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({ plan: paidPlanSchema, period: checkoutPeriodSchema, returnTo: returnToSchema })
      .and(checkoutAddonsSchema)
      .superRefine((value, ctx) => {
        if (value.plan === "store" && value.contactTier !== BASE_MARKETING_CONTACTS) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Contact tier add-ons require the Creator plan.",
            path: ["contactTier"],
          });
        }
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { userId, claims } = context;
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "billing-checkout", userId);
    const email = typeof claims.email === "string" ? claims.email : undefined;
    const url = await createHostedCheckoutSession({
      userId,
      email,
      plan: data.plan,
      period: data.period,
      returnTo: data.returnTo,
      addons: data,
    });
    return { url };
  });

export type MyBillingOverview = {
  plan: PlanId;
  status: "active" | "trialing" | "past_due" | "canceled" | "incomplete" | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  hasSubscription: boolean;
  billingPeriod: BillingPeriod | null;
  pendingPlan: PaidPlanId | null;
  pendingPlanEffectiveAt: string | null;
  retentionOfferAvailable: boolean;
  retentionOfferExpiresAt: string | null;
  complimentaryAccessExpiresAt: string | null;
  contactTierContacts: ContactTier;
  storageAddonUnits: number;
};

async function mySubscription(supabase: SupabaseClient<Database>, userId: string) {
  const { data, error } = await supabase
    .from("subscriptions")
    .select(
      "plan_id, status, cancel_at_period_end, current_period_end, dodo_subscription_id, customer_id, billing_interval, pending_plan_id, pending_plan_effective_at, retention_offer_redeemed_at, retention_offer_expires_at, contact_tier_contacts, storage_addon_units",
    )
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error("Your billing details could not be loaded.");
  return data;
}

function normalizeBillingPeriod(value: string | null | undefined): BillingPeriod | null {
  const interval = value?.trim().toLowerCase();
  if (interval === "month" || interval === "monthly") return "monthly";
  if (interval === "year" || interval === "yearly") return "yearly";
  return null;
}

function configuredDodoProduct(productId: string | null | undefined) {
  if (!productId) return null;
  const matches: Array<{ plan: PaidPlanId; period: BillingPeriod }> = [];
  for (const plan of PAID_PLAN_IDS) {
    for (const period of ["monthly", "yearly"] as const) {
      if (process.env[DODO_PRODUCT_ENV[plan][period]]?.trim() === productId) {
        matches.push({ plan, period });
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function pendingPaidPlan(value: unknown): PaidPlanId | null {
  const plan = normalizePlan(value);
  return isPaidPlan(plan) ? plan : null;
}

function billingOverview(
  subscription: Awaited<ReturnType<typeof mySubscription>>,
  complimentaryAccessExpiresAt: string | null = null,
): MyBillingOverview {
  return {
    plan: normalizePlan(subscription?.plan_id),
    status: subscription?.status ?? null,
    cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
    currentPeriodEnd: subscription?.current_period_end ?? null,
    hasSubscription: Boolean(subscription?.dodo_subscription_id),
    billingPeriod: normalizeBillingPeriod(subscription?.billing_interval),
    pendingPlan: pendingPaidPlan(subscription?.pending_plan_id),
    pendingPlanEffectiveAt: subscription?.pending_plan_effective_at ?? null,
    retentionOfferAvailable:
      Boolean(subscription?.dodo_subscription_id) && !subscription?.retention_offer_redeemed_at,
    retentionOfferExpiresAt: subscription?.retention_offer_expires_at ?? null,
    complimentaryAccessExpiresAt,
    contactTierContacts: (subscription?.contact_tier_contacts ??
      BASE_MARKETING_CONTACTS) as ContactTier,
    storageAddonUnits: subscription?.storage_addon_units ?? 0,
  };
}

export const getMyBillingOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [subscription, grantResult] = await Promise.all([
      mySubscription(context.supabase, context.userId),
      supabaseAdmin
        .from("complimentary_plan_grants")
        .select("expires_at")
        .eq("user_id", context.userId)
        .eq("status", "active")
        .gt("expires_at", new Date().toISOString())
        .maybeSingle(),
    ]);
    if (grantResult.error) throw new Error("Your complimentary access could not be loaded.");
    return billingOverview(subscription, grantResult.data?.expires_at ?? null);
  });

async function setRenewal(
  userId: string,
  supabase: SupabaseClient<Database>,
  cancelAtPeriodEnd: boolean,
  cancellation?: z.infer<typeof cancellationInputSchema>,
) {
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "billing-renewal", userId);
  const subscription = await mySubscription(supabase, userId);
  if (
    !subscription?.dodo_subscription_id ||
    !["active", "trialing"].includes(subscription.status)
  ) {
    throw new Error("No active Bento subscription was found.");
  }
  await dodo.subscriptions.update(subscription.dodo_subscription_id, {
    cancel_at_next_billing_date: cancelAtPeriodEnd,
    ...(cancelAtPeriodEnd && cancellation
      ? {
          cancel_reason: "cancelled_by_customer" as const,
          cancellation_feedback: cancellation.reason,
          cancellation_comment: cancellation.details || null,
        }
      : {}),
  });
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({ cancel_at_period_end: cancelAtPeriodEnd })
    .eq("user_id", userId)
    .eq("dodo_subscription_id", subscription.dodo_subscription_id);
  if (error) throw new Error("Your renewal preference could not be saved.");
  return billingOverview({ ...subscription, cancel_at_period_end: cancelAtPeriodEnd });
}

/** Schedule cancellation at the trial/current-period boundary; access is never removed early. */
export const cancelMyRenewal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => cancellationInputSchema.parse(input))
  .handler(({ data, context }) => setRenewal(context.userId, context.supabase, true, data));

export const resumeMyRenewal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) => setRenewal(context.userId, context.supabase, false));

function addUtcMonths(value: Date, months: number) {
  const next = new Date(value);
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

/** Apply the one-time three-month retention extension to the next Dodo billing date. */
export const acceptMyRetentionOffer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => cancellationInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { userId, supabase } = context;
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "billing-retention", userId);
    const subscription = await mySubscription(supabase, userId);
    if (
      !subscription?.dodo_subscription_id ||
      !["active", "trialing"].includes(subscription.status) ||
      !isPaidPlan(normalizePlan(subscription.plan_id))
    ) {
      throw new Error("No active paid Bento subscription was found.");
    }
    if (subscription.retention_offer_redeemed_at) {
      throw new Error("This three-month offer has already been used on your account.");
    }

    const claimedAt = new Date().toISOString();
    const { data: claimed, error: claimError } = await supabaseAdmin
      .from("subscriptions")
      .update({
        retention_offer_redeemed_at: claimedAt,
        retention_offer_reason: data.reason,
      })
      .eq("user_id", userId)
      .eq("dodo_subscription_id", subscription.dodo_subscription_id)
      .is("retention_offer_redeemed_at", null)
      .select("user_id")
      .maybeSingle();
    if (claimError || !claimed) {
      throw new Error("This three-month offer is no longer available.");
    }

    const now = new Date();
    const periodEnd = subscription.current_period_end
      ? new Date(subscription.current_period_end)
      : now;
    const extensionBase = Number.isNaN(periodEnd.getTime()) || periodEnd < now ? now : periodEnd;
    const extendedUntil = addUtcMonths(extensionBase, 3).toISOString();

    try {
      await dodo.subscriptions.update(subscription.dodo_subscription_id, {
        cancel_at_next_billing_date: false,
        next_billing_date: extendedUntil,
      });
    } catch (error) {
      await supabaseAdmin
        .from("subscriptions")
        .update({
          retention_offer_redeemed_at: null,
          retention_offer_reason: null,
        })
        .eq("user_id", userId)
        .eq("retention_offer_redeemed_at", claimedAt);
      console.error("Dodo retention extension failed.", {
        status: dodoErrorStatus(error),
        userId,
      });
      throw new Error("The three-month offer could not be applied. Please try again.");
    }

    const { error: saveError } = await supabaseAdmin
      .from("subscriptions")
      .update({
        cancel_at_period_end: false,
        current_period_end: extendedUntil,
        retention_offer_expires_at: extendedUntil,
      })
      .eq("user_id", userId)
      .eq("dodo_subscription_id", subscription.dodo_subscription_id);
    if (saveError) {
      console.error("Retention extension applied at Dodo but local billing sync failed.", {
        userId,
        extendedUntil,
      });
    }

    return billingOverview({
      ...subscription,
      cancel_at_period_end: false,
      current_period_end: extendedUntil,
      retention_offer_redeemed_at: claimedAt,
      retention_offer_expires_at: extendedUntil,
    });
  });

export const changeMyPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ plan: paidPlanSchema }).parse(input))
  .handler(async ({ data, context }) => {
    const { userId, supabase, claims } = context;
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "billing-plan-change", userId);
    const subscription = await mySubscription(supabase, userId);
    if (
      !subscription?.dodo_subscription_id ||
      !["active", "trialing"].includes(subscription.status)
    ) {
      throw new Error("No active Bento subscription was found.");
    }

    const currentPlan = normalizePlan(subscription.plan_id);
    if (!isPaidPlan(currentPlan)) throw new Error("Choose a paid plan to start checkout.");
    if (currentPlan === data.plan) throw new Error(`You are already on the ${data.plan} plan.`);
    if (subscription.pending_plan_id) {
      throw new Error("Finish or cancel your scheduled plan change first.");
    }
    if (subscription.cancel_at_period_end) {
      throw new Error("Keep your current plan before changing to another paid plan.");
    }

    let remote: Awaited<ReturnType<typeof dodo.subscriptions.retrieve>>;
    try {
      // Always verify the provider-side subscription before writing a pending
      // plan change. This also detects subscriptions created in Dodo test mode
      // before Bento's production billing environment was enabled.
      remote = await dodo.subscriptions.retrieve(subscription.dodo_subscription_id);
    } catch (error) {
      if (dodoErrorStatus(error) === 404) {
        const period = normalizeBillingPeriod(subscription.billing_interval);
        if (!period) {
          throw new Error(
            "Your previous billing subscription cannot be migrated automatically. Contact the instance operator for help.",
          );
        }
        const email = typeof claims.email === "string" ? claims.email : undefined;
        const url = await createHostedCheckoutSession({
          userId,
          email,
          plan: data.plan,
          period,
          returnTo: "dashboard",
          addons: {
            contactTier:
              data.plan === "creator"
                ? ((subscription.contact_tier_contacts ?? BASE_MARKETING_CONTACTS) as ContactTier)
                : BASE_MARKETING_CONTACTS,
            storageUnits: subscription.storage_addon_units ?? 0,
          },
        });
        console.info(
          "Restarting checkout for a subscription unavailable in the active Dodo environment.",
          {
            userId,
            currentPlan,
            nextPlan: data.plan,
            period,
          },
        );
        return { mode: "checkout" as const, url };
      }
      console.error("Dodo subscription verification failed before plan change.", {
        status: dodoErrorStatus(error),
        userId,
        currentPlan,
        nextPlan: data.plan,
      });
      throw new Error(
        "Your subscription could not be verified. Please try again or contact the instance operator.",
      );
    }

    const period =
      normalizeBillingPeriod(remote.payment_frequency_interval) ??
      normalizeBillingPeriod(subscription.billing_interval);
    if (!period) throw new Error("Your billing interval could not be determined.");

    const productId = process.env[DODO_PRODUCT_ENV[data.plan][period]];
    if (!productId) throw new Error(`No Dodo product configured for ${data.plan} ${period}.`);

    const isUpgrade = currentPlan === "store" && data.plan === "creator";
    const contactTier =
      data.plan === "creator"
        ? ((subscription.contact_tier_contacts ?? BASE_MARKETING_CONTACTS) as ContactTier)
        : BASE_MARKETING_CONTACTS;
    const storageUnits = subscription.storage_addon_units ?? 0;
    const addons = desiredDodoAddonCart({
      plan: data.plan,
      period,
      contactTier,
      storageUnits,
      env: process.env,
    });
    const { error } = await supabaseAdmin
      .from("subscriptions")
      .update({
        pending_plan_id: data.plan,
        pending_plan_effective_at: isUpgrade ? null : subscription.current_period_end,
        cancel_at_period_end: false,
      })
      .eq("user_id", userId)
      .eq("dodo_subscription_id", subscription.dodo_subscription_id);
    if (error) throw new Error("Your plan change could not be saved.");

    try {
      await dodo.subscriptions.changePlan(subscription.dodo_subscription_id, {
        product_id: productId,
        quantity: 1,
        addons,
        proration_billing_mode: isUpgrade ? "prorated_immediately" : "do_not_bill",
        effective_at: isUpgrade ? "immediately" : "next_billing_date",
        on_payment_failure: "prevent_change",
        metadata: { user_id: userId, plan: data.plan, period },
      });
    } catch (error) {
      await supabaseAdmin
        .from("subscriptions")
        .update({ pending_plan_id: null, pending_plan_effective_at: null })
        .eq("user_id", userId)
        .eq("dodo_subscription_id", subscription.dodo_subscription_id);
      console.error("Dodo plan change failed.", {
        status: dodoErrorStatus(error),
        userId,
        currentPlan,
        nextPlan: data.plan,
        period,
      });
      throw new Error(
        "Your plan could not be changed right now. Please try again or contact the instance operator.",
      );
    }

    if (isUpgrade) {
      const { error: addonStateError } = await supabaseAdmin
        .from("subscriptions")
        .update({ contact_tier_contacts: contactTier, storage_addon_units: storageUnits })
        .eq("user_id", userId)
        .eq("dodo_subscription_id", subscription.dodo_subscription_id);
      if (addonStateError) throw new Error("Your add-on selection could not be saved.");
    }

    return {
      mode: "changed" as const,
      billing: billingOverview({
        ...subscription,
        pending_plan_id: data.plan,
        pending_plan_effective_at: isUpgrade ? null : subscription.current_period_end,
        cancel_at_period_end: false,
        ...(isUpgrade
          ? { contact_tier_contacts: contactTier, storage_addon_units: storageUnits }
          : {}),
      }),
    };
  });

/** Update paid add-ons without letting browser input select provider IDs or prices. */
export const updateMyBillingAddons = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => checkoutAddonsSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { userId, supabase } = context;
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "billing-addons", userId);
    const subscription = await mySubscription(supabase, userId);
    if (
      !subscription?.dodo_subscription_id ||
      !["active", "trialing"].includes(subscription.status)
    ) {
      throw new Error("No active Bento subscription was found.");
    }

    const plan = normalizePlan(subscription.plan_id);
    if (!isPaidPlan(plan)) throw new Error("No active Bento subscription was found.");
    if (subscription.pending_plan_id) {
      throw new Error("Finish or cancel your scheduled plan change first.");
    }
    if (plan === "store" && data.contactTier !== BASE_MARKETING_CONTACTS) {
      throw new Error("Contact tier add-ons require the Creator plan.");
    }

    let remote: Awaited<ReturnType<typeof dodo.subscriptions.retrieve>>;
    try {
      remote = await dodo.subscriptions.retrieve(subscription.dodo_subscription_id);
    } catch (error) {
      console.error("Dodo subscription verification failed before add-on change.", {
        status: dodoErrorStatus(error),
        userId,
      });
      throw new Error(
        "Your subscription could not be verified. Please try again or contact the instance operator.",
      );
    }

    const localPeriod = normalizeBillingPeriod(subscription.billing_interval);
    const remotePeriod = normalizeBillingPeriod(remote.payment_frequency_interval);
    const remoteProduct = configuredDodoProduct(remote.product_id);
    if (
      !localPeriod ||
      !remoteProduct ||
      remoteProduct.plan !== plan ||
      remoteProduct.period !== localPeriod ||
      (remotePeriod !== null && remotePeriod !== remoteProduct.period)
    ) {
      throw new Error(
        "Your subscription could not be verified. Please try again or contact the instance operator.",
      );
    }
    const period = remoteProduct.period;
    const addons = desiredDodoAddonCart({ ...data, plan, period, env: process.env });

    try {
      await dodo.subscriptions.changePlan(subscription.dodo_subscription_id, {
        product_id: remote.product_id,
        quantity: 1,
        addons,
        proration_billing_mode: "difference_immediately",
        on_payment_failure: "prevent_change",
      });
    } catch (error) {
      console.error("Dodo add-on change failed.", {
        status: dodoErrorStatus(error),
        userId,
        period,
      });
      throw new Error(
        "Your add-ons could not be changed right now. Please try again or contact the instance operator.",
      );
    }

    const { error } = await supabaseAdmin
      .from("subscriptions")
      .update({ contact_tier_contacts: data.contactTier, storage_addon_units: data.storageUnits })
      .eq("user_id", userId)
      .eq("dodo_subscription_id", subscription.dodo_subscription_id);
    if (error) throw new Error("Your add-on selection could not be saved.");

    return billingOverview({
      ...subscription,
      contact_tier_contacts: data.contactTier,
      storage_addon_units: data.storageUnits,
    });
  });

export const cancelMyPlanChange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId, supabase } = context;
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "billing-plan-change", userId);
    const subscription = await mySubscription(supabase, userId);
    if (!subscription?.dodo_subscription_id || !subscription.pending_plan_id) {
      throw new Error("No scheduled plan change was found.");
    }
    await dodo.subscriptions.cancelChangePlan(subscription.dodo_subscription_id);
    const { error } = await supabaseAdmin
      .from("subscriptions")
      .update({ pending_plan_id: null, pending_plan_effective_at: null })
      .eq("user_id", userId)
      .eq("dodo_subscription_id", subscription.dodo_subscription_id);
    if (error) throw new Error("Your scheduled plan change could not be cleared.");
    return billingOverview({
      ...subscription,
      pending_plan_id: null,
      pending_plan_effective_at: null,
    });
  });

export const createMyBillingPortal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId, supabase } = context;
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "billing-portal", userId);
    const subscription = await mySubscription(supabase, userId);
    if (!subscription?.dodo_subscription_id) {
      throw new Error("No Bento billing account was found.");
    }

    let customerId = subscription.customer_id;
    if (!customerId) {
      const remote = await dodo.subscriptions.retrieve(subscription.dodo_subscription_id);
      customerId = remote.customer.customer_id;
      if (customerId) {
        await supabaseAdmin
          .from("subscriptions")
          .update({ customer_id: customerId })
          .eq("user_id", userId);
      }
    }
    if (!customerId) throw new Error("Your billing profile could not be found.");

    const appUrl = configuredAppOrigin(process.env.VITE_APP_URL);
    const returnUrl = new URL("/settings?section=plan", appUrl).toString();
    const session = await dodo.customers.customerPortal.create(customerId, {
      return_url: returnUrl,
    });
    const portalUrl = parsePublicHttpUrl(session.link, { requireHttps: true });
    if (!portalUrl) throw new Error("Dodo did not return a billing portal URL.");
    return { url: portalUrl.toString() };
  });
