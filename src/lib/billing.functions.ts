import { setCookie } from "@tanstack/react-start/server";
import {
  signWorkspaceCookie,
  workspaceCookieSigningKey,
  WORKSPACE_COOKIE,
} from "./workspace-session.server";
import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { dodo } from "@/integrations/dodo/client.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  BASE_MARKETING_CONTACTS,
  CURRENT_DODO_PRODUCT_ENV,
  PLAN_ORDER,
  isPaidPlan,
  normalizePlan,
  planName,
  TRIAL_DAYS,
  type BillingPeriod,
  type ContactTier,
  type PaidPlanId,
  type PlanId,
} from "./plans";
import {
  checkoutEligibility,
  reserveTrialCheckout,
  saveTrialCheckout,
} from "./billing-checkout.server";
import { readOnboardingSession } from "./onboarding/session.server";
import { settingsIntegrationsPath } from "./settings-integrations";
import { resolveBillingProduct } from "./billing-catalog";
import { desiredDodoAddonCart } from "./billing-addons";
import { enforceRequestRateLimit } from "./request-security.server";
import { parsePublicHttpUrl } from "./safe-url";
import { usernameSchema } from "./username";
import type { CheckoutSessionCreateParams } from "dodopayments/resources/checkout-sessions";
import { verifyFreeTrialCheckout, verifyYearlyProduct } from "./billing-trial.server";
import { withWorkspaceBillingSync } from "./billing-sync.server";
import { refreshWorkspaceSubscription } from "@/integrations/dodo/webhook.server";
import { reserveRecoveryCheckout, saveRecoveryCheckout } from "./billing-recovery-checkout.server";
import { readBillingLifecycle, type BillingLifecycle } from "./billing-lifecycle";
import { enqueueBentoBillingEmail } from "./email.server";
import {
  cancellationReasonSchema,
  assertDowngradeIntent,
  markCancellationConfirmed,
  markDowngradeAccepted,
} from "./cancellation.functions";

const paidPlanSchema = z.enum(["store", "creator", "creator_plus"]);
const checkoutPeriodSchema = z.enum(["monthly", "yearly"]);
const returnToSchema = z.enum(["dashboard", "onboarding", "payments"]).default("dashboard");
export type CheckoutReturnTo = z.infer<typeof returnToSchema>;
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
const legacyCancellationFeedbackSchema = z.enum([
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
  reason: z
    .union([cancellationReasonSchema, legacyCancellationFeedbackSchema])
    .nullable()
    .optional(),
  details: z.string().trim().max(500).optional(),
  intentId: z.string().uuid().optional(),
});

export type CancellationFeedback = z.infer<typeof legacyCancellationFeedbackSchema>;

function providerCancellationFeedback(
  reason: z.infer<typeof cancellationInputSchema>["reason"],
): z.infer<typeof legacyCancellationFeedbackSchema> | null {
  const mapped = {
    budget: "too_expensive",
    break: "unused",
    missing_capability: "missing_features",
    product_problem: "low_quality",
    moving_elsewhere: "switched_service",
  } as const;
  if (reason && reason in mapped) return mapped[reason as keyof typeof mapped];
  const legacy = legacyCancellationFeedbackSchema.safeParse(reason);
  return legacy.success ? legacy.data : null;
}
export type CheckoutAddonSelection = z.infer<typeof checkoutAddonsSchema>;

function dodoErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  const status = Number(error.status);
  return Number.isFinite(status) ? status : null;
}

// Dodo appends `status` plus `subscription_id` or `payment_id`. The marker only
// says "returned from checkout"; the page reads Dodo's status for the outcome.
function checkoutReturnUrl(appUrl: string, returnTo: CheckoutReturnTo, trial = false) {
  const marker = `checkout=return&trial=${trial ? 1 : 0}`;
  if (returnTo === "onboarding") return `${appUrl}/onboarding?${marker}`;
  if (returnTo === "payments") return `${appUrl}${settingsIntegrationsPath("payments")}&${marker}`;
  return `${appUrl}/link?upgraded=1&${marker}`;
}

async function createHostedCheckoutSession(input: {
  userId: string;
  authUserId?: string;
  workspaceId?: string;
  email?: string;
  plan: PaidPlanId;
  period: BillingPeriod;
  returnTo: CheckoutReturnTo;
  addons?: CheckoutAddonSelection;
  trial?: boolean;
}) {
  if (
    input.trial &&
    input.addons &&
    (input.addons.storageUnits > 0 || input.addons.contactTier !== BASE_MARKETING_CONTACTS)
  ) {
    throw new Error("Add-ons can be added after your trial. There is no charge today.");
  }
  const envKey = CURRENT_DODO_PRODUCT_ENV[input.plan][input.period];
  const productId = process.env[envKey];
  if (!productId) {
    throw new Error(`No Dodo product configured for ${input.plan} ${input.period}.`);
  }

  const addons = input.addons
    ? desiredDodoAddonCart({ ...input, ...input.addons, env: process.env })
    : [];
  const checkout: CheckoutSessionCreateParams = {
    product_cart: [{ product_id: productId, quantity: 1, ...(addons.length ? { addons } : {}) }],
    subscription_data: { trial_period_days: input.trial ? TRIAL_DAYS : 0 },
    allowed_payment_method_types: ["credit"],
    ...(input.email ? { customer: { email: input.email, name: input.email.split("@")[0] } } : {}),
  };
  if (input.period === "yearly" && !input.trial) await verifyYearlyProduct(productId, input.plan);
  // Verify before reserving: a failed read/preview creates no provider session
  // and must leave the owner's trial retryable. Recheck resumed checkouts too.
  const trialVerificationKey = input.trial
    ? await verifyFreeTrialCheckout(
        productId,
        checkout,
        input.period === "yearly" ? input.plan : undefined,
      )
    : null;

  const reservation = input.trial
    ? await reserveTrialCheckout(
        input.authUserId ?? input.userId,
        input.workspaceId ?? input.userId,
        input.plan,
        trialVerificationKey!,
      )
    : null;
  if (reservation?.url) return reservation.url;
  const recovery = input.trial
    ? null
    : await reserveRecoveryCheckout(input.workspaceId ?? input.userId);
  if (recovery?.url) return recovery.url;
  const appUrl = process.env.VITE_APP_URL || "http://localhost:8080";
  let session: Awaited<ReturnType<typeof dodo.checkoutSessions.create>>;
  try {
    session = await dodo.checkoutSessions.create({
      ...checkout,
      metadata: {
        user_id: input.workspaceId ?? input.userId,
        workspace_id: input.workspaceId ?? input.userId,
        auth_user_id: input.authUserId ?? input.userId,
        plan: input.plan,
        billing_catalog: "2026-10",
        ...(reservation?.checkoutKey ? { trial_checkout_key: reservation.checkoutKey } : {}),
        period: input.period,
      },
      return_url: checkoutReturnUrl(appUrl, input.returnTo, Boolean(input.trial)),
    });
  } catch (error) {
    console.error("Dodo checkout session creation failed.", {
      status: dodoErrorStatus(error),
      plan: input.plan,
      period: input.period,
    });
    throw new Error(
      "Secure checkout is temporarily unavailable. Please try again or contact support@example.com.",
    );
  }

  const checkoutUrl = parsePublicHttpUrl(session.checkout_url, { requireHttps: true });
  if (!checkoutUrl) throw new Error("Dodo did not return a checkout URL.");
  if (input.trial)
    await saveTrialCheckout(
      input.authUserId ?? input.userId,
      session.session_id,
      checkoutUrl.toString(),
    );
  if (recovery) await saveRecoveryCheckout(recovery.id, session.session_id, checkoutUrl.toString());
  return checkoutUrl.toString();
}

/**
 * Create a Dodo hosted-checkout session for the current user and return its URL.
 * An eligible owner can start one card-required three-day trial.
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
    const { authUserId, userId, claims } = context;
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "billing-checkout", userId);
    if (data.storageUnits > 0 || data.contactTier !== BASE_MARKETING_CONTACTS)
      throw new Error("Add-ons can be added after your trial. There is no charge today.");
    const eligibility = await checkoutEligibility(authUserId, userId);
    if (eligibility.active)
      throw new Error(
        "Manage your existing subscription in Billing; a second subscription is not needed.",
      );
    if (eligibility.profile.billing_catalog === "2026-10" && !eligibility.profile.onboarded) {
      const preparation = await readOnboardingSession(userId);
      if (
        preparation?.status !== "prepared" ||
        preparation.approved_revision !== preparation.revision
      ) {
        return { url: `${process.env.VITE_APP_URL || "http://localhost:8080"}/onboarding` };
      }
    }
    const email = typeof claims.email === "string" ? claims.email : undefined;
    const url = await createHostedCheckoutSession({
      userId,
      authUserId,
      workspaceId: userId,
      email,
      plan: data.plan,
      period: data.period,
      returnTo: data.returnTo,
      addons: data,
      trial: eligibility.trialEligible,
    });
    return { url };
  });

const additionalWorkspaceSchema = z.object({
  displayName: z.string().trim().min(1).max(60),
  username: usernameSchema,
});

export const beginAdditionalWorkspaceCheckout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => additionalWorkspaceSchema.parse(input))
  .handler(async ({ data, context }) => {
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "additional-workspace-checkout",
      context.authUserId,
    );
    const subscription = await mySubscription(context.supabase, context.userId);
    const plan = normalizePlan(subscription?.plan_id);
    const period = normalizeBillingPeriod(subscription?.billing_interval);
    if (
      !isPaidPlan(plan) ||
      !period ||
      !subscription?.dodo_subscription_id ||
      !subscription.status ||
      !["active", "trialing"].includes(subscription.status)
    ) {
      throw new Error("Choose a paid plan first.");
    }

    const { data: workspaceId, error } = await supabaseAdmin.rpc(
      "create_pending_workspace" as never,
      {
        p_auth_user_id: context.authUserId,
        p_display_name: data.displayName,
        p_username: data.username,
      } as never,
    );
    if (error?.code === "23505") throw new Error("Username already taken");
    if (error || typeof workspaceId !== "string") {
      throw new Error("The new workspace could not be created.");
    }

    const signed = await signWorkspaceCookie(workspaceId, workspaceCookieSigningKey());
    setCookie(WORKSPACE_COOKIE, signed, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 365 * 24 * 60 * 60,
    });
    // Keep the response shape for the existing dialog, but no payment is requested
    // until this workspace has completed and approved its own preparation.
    return {
      checkoutUrl: `${process.env.VITE_APP_URL || "http://localhost:8080"}/onboarding`,
      workspaceId,
    };
  });

export type MyBillingOverview = {
  billingLifecycle?: BillingLifecycle | null;
  plan: PlanId;
  status: "active" | "trialing" | "past_due" | "paused" | "canceled" | "incomplete" | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  hasSubscription: boolean;
  billingPeriod: BillingPeriod | null;
  billingCatalog: "legacy" | "2026-10" | null;
  pendingPlan: PaidPlanId | null;
  pendingPlanEffectiveAt: string | null;
  retentionOfferAvailable: boolean;
  retentionOfferExpiresAt: string | null;
  pausedUntil: string | null;
  complimentaryAccessExpiresAt: string | null;
  contactTierContacts: ContactTier;
  storageAddonUnits: number;
};

async function mySubscription(supabase: SupabaseClient<Database>, userId: string) {
  const { data, error } = await supabase
    .from("subscriptions")
    .select(
      "plan_id, status, cancel_at_period_end, current_period_end, dodo_subscription_id, customer_id, billing_interval, billing_catalog, pending_plan_id, pending_plan_effective_at, retention_offer_redeemed_at, retention_offer_expires_at, contact_tier_contacts, storage_addon_units",
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
  return resolveBillingProduct(productId, process.env);
}

function pendingPaidPlan(value: unknown): PaidPlanId | null {
  const plan = normalizePlan(value);
  return isPaidPlan(plan) ? plan : null;
}

function billingOverview(
  subscription: Awaited<ReturnType<typeof mySubscription>>,
  complimentaryAccessExpiresAt: string | null = null,
  lifecycle: BillingLifecycle | null = null,
  pausedUntil: string | null = null,
): MyBillingOverview {
  return {
    plan: normalizePlan(lifecycle?.plan ?? subscription?.plan_id),
    billingLifecycle: lifecycle,
    status: subscription?.status ?? null,
    cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
    currentPeriodEnd: subscription?.current_period_end ?? null,
    hasSubscription: Boolean(subscription?.dodo_subscription_id),
    billingPeriod: normalizeBillingPeriod(subscription?.billing_interval),
    billingCatalog:
      subscription?.billing_catalog === "2026-10" ? "2026-10" : subscription ? "legacy" : null,
    pendingPlan: pendingPaidPlan(subscription?.pending_plan_id),
    pendingPlanEffectiveAt: subscription?.pending_plan_effective_at ?? null,
    retentionOfferAvailable:
      Boolean(subscription?.dodo_subscription_id) &&
      subscription?.status !== "trialing" &&
      !subscription?.retention_offer_redeemed_at,
    retentionOfferExpiresAt: subscription?.retention_offer_expires_at ?? null,
    pausedUntil,
    complimentaryAccessExpiresAt,
    contactTierContacts: (subscription?.contact_tier_contacts ??
      BASE_MARKETING_CONTACTS) as ContactTier,
    storageAddonUnits: subscription?.storage_addon_units ?? 0,
  };
}

export const getMyBillingOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [subscription, grantResult, profileResult, pauseResult] = await Promise.all([
      mySubscription(context.supabase, context.userId),
      supabaseAdmin
        .from("complimentary_plan_grants")
        .select("expires_at")
        .eq("user_id", context.userId)
        .eq("status", "active")
        .gt("expires_at", new Date().toISOString())
        .maybeSingle(),
      supabaseAdmin
        .from("profiles")
        .select("billing_lifecycle")
        .eq("id", context.userId)
        .maybeSingle(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Service-only table is introduced by the paired migration.
      (supabaseAdmin as any)
        .from("subscription_pauses")
        .select("resume_at")
        .eq("workspace_id", context.userId)
        .is("resumed_at", null)
        .maybeSingle(),
    ]);
    if (grantResult.error) throw new Error("Your complimentary access could not be loaded.");
    if (profileResult.error)
      throw new Error("Your workspace billing deadlines could not be loaded.");
    if (pauseResult.error) throw new Error("Your pause date could not be loaded.");
    return billingOverview(
      subscription,
      grantResult.data?.expires_at ?? null,
      readBillingLifecycle(profileResult.data?.billing_lifecycle),
      pauseResult.data?.resume_at ?? null,
    );
  });

async function setRenewal(
  userId: string,
  ownerId: string,
  supabase: SupabaseClient<Database>,
  cancelAtPeriodEnd: boolean,
  cancellation?: z.infer<typeof cancellationInputSchema>,
) {
  return withWorkspaceBillingSync(userId, async (lease) => {
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "billing-renewal", userId);
    let subscription = await mySubscription(supabase, userId);
    if (
      !subscription?.dodo_subscription_id ||
      !["active", "trialing"].includes(subscription.status)
    ) {
      throw new Error("No active Bento subscription was found.");
    }
    // A trial may have converted since this page was opened. Reconcile with the
    // provider under the billing lease before choosing immediate cancellation.
    await refreshWorkspaceSubscription(userId, subscription.dodo_subscription_id, lease);
    subscription = await mySubscription(supabase, userId);
    if (
      !subscription?.dodo_subscription_id ||
      !["active", "trialing"].includes(subscription.status)
    )
      throw new Error("No active Bento subscription was found.");
    // Trials and paid periods both cancel at the next billing date: a trial keeps
    // access until it ends and is never charged. Never set status "cancelled"
    // here, which would end access immediately.
    await dodo.subscriptions.update(subscription.dodo_subscription_id, {
      cancel_at_next_billing_date: cancelAtPeriodEnd,
      ...(cancelAtPeriodEnd && cancellation
        ? {
            cancel_reason: "cancelled_by_customer" as const,
            ...(providerCancellationFeedback(cancellation.reason)
              ? { cancellation_feedback: providerCancellationFeedback(cancellation.reason) }
              : {}),
            cancellation_comment: cancellation.details || null,
          }
        : {}),
    });
    await refreshWorkspaceSubscription(userId, subscription.dodo_subscription_id, lease);
    if (cancelAtPeriodEnd)
      await markCancellationConfirmed({
        intentId: cancellation?.intentId,
        ownerId,
        workspaceId: userId,
        subscriptionId: subscription.dodo_subscription_id,
      });
    const [verifiedSubscription, { data: profile, error }] = await Promise.all([
      mySubscription(supabase, userId),
      supabaseAdmin.from("profiles").select("billing_lifecycle").eq("id", userId).maybeSingle(),
    ]);
    if (error) throw new Error("Your updated billing status could not be loaded.");
    if (cancelAtPeriodEnd && !verifiedSubscription?.cancel_at_period_end)
      throw new Error("Your cancellation is being verified. Refresh Billing before trying again.");
    if (cancelAtPeriodEnd && verifiedSubscription?.current_period_end) {
      const endDate =
        new Intl.DateTimeFormat("en", {
          dateStyle: "long",
          timeStyle: "short",
          timeZone: "UTC",
        }).format(new Date(verifiedSubscription.current_period_end)) + " UTC";
      try {
        await enqueueBentoBillingEmail({
          userId,
          eventKey: `cancellation-scheduled:${subscription.dodo_subscription_id}:${cancellation?.intentId ?? verifiedSubscription.current_period_end}`,
          eventType: "subscription_cancellation_scheduled",
          payload: { planName: planName(normalizePlan(verifiedSubscription.plan_id)), endDate },
        });
      } catch (cause) {
        console.error("[billing] cancellation receipt needs retry", { workspaceId: userId, cause });
      }
    }
    return billingOverview(
      verifiedSubscription,
      null,
      readBillingLifecycle(profile?.billing_lifecycle),
    );
  });
}

/** Stop the next charge. Trials and paid periods keep access until they end. */
export const cancelMyRenewal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => cancellationInputSchema.parse(input))
  .handler(({ data, context }) =>
    setRenewal(context.userId, context.authUserId, context.supabase, true, data),
  );

export const resumeMyRenewal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) =>
    setRenewal(context.userId, context.authUserId, context.supabase, false),
  );

/** Reject stale clients that still call the retired blanket three-month offer. */
export const acceptMyRetentionOffer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => cancellationInputSchema.parse(input))
  .handler(async () => {
    throw new Error(
      "The previous three-month retention offer has ended. Review your current cancellation options in Billing.",
    );
  });

export const changeMyPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ plan: paidPlanSchema, intentId: z.string().uuid().optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { userId, supabase } = context;
    return withWorkspaceBillingSync(userId, async (lease) => {
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
      if (data.intentId)
        await assertDowngradeIntent({
          intentId: data.intentId,
          ownerId: context.authUserId,
          workspaceId: userId,
          subscriptionId: subscription.dodo_subscription_id,
        });

      let remote: Awaited<ReturnType<typeof dodo.subscriptions.retrieve>>;
      try {
        // Always verify the provider-side subscription before writing a pending
        // plan change. This also detects subscriptions created in Dodo test mode
        // before Bento's production billing environment was enabled.
        remote = await dodo.subscriptions.retrieve(subscription.dodo_subscription_id);
      } catch (error) {
        if (dodoErrorStatus(error) === 404) {
          throw new Error(
            "Your previous subscription could not be found in the active billing environment. Contact support@example.com to reconcile it before changing plans. No replacement checkout or charge has been started.",
          );
        }
        console.error("Dodo subscription verification failed before plan change.", {
          status: dodoErrorStatus(error),
          userId,
          currentPlan,
          nextPlan: data.plan,
        });
        throw new Error(
          "Your subscription could not be verified. Please try again or contact support@example.com.",
        );
      }

      const period =
        normalizeBillingPeriod(remote.payment_frequency_interval) ??
        normalizeBillingPeriod(subscription.billing_interval);
      if (!period) throw new Error("Your billing interval could not be determined.");

      const currentProduct = resolveBillingProduct(remote.product_id, process.env);
      if (period === "yearly" && currentProduct?.catalog !== "2026-10")
        throw new Error(
          "Contact support to change an existing annual contract. Its original price is preserved.",
        );
      const productId = process.env[CURRENT_DODO_PRODUCT_ENV[data.plan][period]];
      if (!productId) throw new Error(`No Dodo product configured for ${data.plan} ${period}.`);
      if (period === "yearly") await verifyYearlyProduct(productId, data.plan);

      const inTrial = subscription.status === "trialing";
      const isUpgrade = !inTrial && PLAN_ORDER.indexOf(data.plan) > PLAN_ORDER.indexOf(currentPlan);
      const contactTier =
        data.plan !== "store"
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
      try {
        await dodo.subscriptions.changePlan(subscription.dodo_subscription_id, {
          product_id: productId,
          quantity: 1,
          addons,
          proration_billing_mode: isUpgrade ? "prorated_immediately" : "full_immediately",
          effective_at: isUpgrade ? "immediately" : "next_billing_date",
          on_payment_failure: "prevent_change",
          metadata: {
            ...remote.metadata,
            user_id: userId,
            plan: data.plan,
            period,
            workspace_id: userId,
            auth_user_id: context.authUserId,
            billing_catalog: "2026-10",
          },
        });
      } catch (error) {
        console.error("Dodo plan change failed.", {
          status: dodoErrorStatus(error),
          userId,
          currentPlan,
          nextPlan: data.plan,
          period,
        });
        throw new Error(
          "Your plan could not be changed right now. Please try again or contact support@example.com.",
        );
      }

      await refreshWorkspaceSubscription(userId, subscription.dodo_subscription_id, lease);
      if (data.intentId && !isUpgrade) {
        try {
          await markDowngradeAccepted({
            intentId: data.intentId,
            ownerId: context.authUserId,
            workspaceId: userId,
            subscriptionId: subscription.dodo_subscription_id,
          });
        } catch (cause) {
          console.error("[billing] plan save metric write deferred", {
            workspaceId: userId,
            cause,
          });
        }
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
  });

/** Update paid add-ons without letting browser input select provider IDs or prices. */
export const updateMyBillingAddons = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => checkoutAddonsSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { userId, supabase } = context;
    return withWorkspaceBillingSync(userId, async (lease) => {
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
          "Your subscription could not be verified. Please try again or contact support@example.com.",
        );
      }

      if (subscription.status === "trialing")
        throw new Error("Add-ons can be changed after your trial; nothing will be charged today.");

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
          "Your subscription could not be verified. Please try again or contact support@example.com.",
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
          "Your add-ons could not be changed right now. Please try again or contact support@example.com.",
        );
      }

      await refreshWorkspaceSubscription(userId, subscription.dodo_subscription_id, lease);

      return billingOverview({
        ...subscription,
        contact_tier_contacts: data.contactTier,
        storage_addon_units: data.storageUnits,
      });
    });
  });

export const cancelMyPlanChange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId, supabase } = context;
    return withWorkspaceBillingSync(userId, async (lease) => {
      await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "billing-plan-change", userId);
      const subscription = await mySubscription(supabase, userId);
      if (!subscription?.dodo_subscription_id || !subscription.pending_plan_id) {
        throw new Error("No scheduled plan change was found.");
      }
      await dodo.subscriptions.cancelChangePlan(subscription.dodo_subscription_id);
      await refreshWorkspaceSubscription(userId, subscription.dodo_subscription_id, lease);

      return billingOverview({
        ...subscription,
        pending_plan_id: null,
        pending_plan_effective_at: null,
      });
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

    const appUrl = process.env.VITE_APP_URL || "http://localhost:8080";
    const returnUrl = new URL("/settings?section=plan", appUrl).toString();
    const session = await dodo.customers.customerPortal.create(customerId, {
      return_url: returnUrl,
    });
    const portalUrl = parsePublicHttpUrl(session.link, { requireHttps: true });
    if (!portalUrl) throw new Error("Dodo did not return a billing portal URL.");
    return { url: portalUrl.toString() };
  });

export const getCheckoutOffer = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const result = await checkoutEligibility(context.authUserId, context.userId);
    return { trialEligible: result.trialEligible, active: result.active };
  });
