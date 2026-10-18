/* eslint-disable @typescript-eslint/no-explicit-any -- New service-only retention tables are paired with a migration. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { dodo } from "@/integrations/dodo/client.server";
import { refreshWorkspaceSubscription } from "@/integrations/dodo/webhook.server";
import { withWorkspaceBillingSync } from "./billing-sync.server";
import { TRIAL_DAYS } from "./plans";
import { trialExtensionEnd } from "./billing-catalog";
import { enqueueBentoBillingEmail } from "./email.server";
import { SOCIAL_CONNECTION_LIST_LIMIT } from "./large-table-columns";
import {
  cancellationReasonSchema,
  firstOfferAvailable,
  selectCancellationOffer,
} from "./cancellation-policy";
export { cancellationReasonSchema } from "./cancellation-policy";
export type { CancellationReason } from "./cancellation-policy";

const db = supabaseAdmin as any;
const dayMs = 86_400_000;
const startSchema = z.object({
  reason: cancellationReasonSchema.nullable(),
  details: z.string().trim().max(500).optional(),
  switchDestination: z.string().trim().max(80).optional(),
  switchWhy: z.string().trim().max(120).optional(),
});
const intentSchema = z.object({ intentId: z.string().uuid() });

async function mySubscription(workspaceId: string) {
  const { data, error } = await db
    .from("subscriptions")
    .select(
      "user_id,plan_id,status,dodo_subscription_id,customer_id,billing_interval,current_period_end,cancel_at_period_end,pending_plan_id,retention_offer_redeemed_at",
    )
    .eq("user_id", workspaceId)
    .maybeSingle();
  if (error || !data?.dodo_subscription_id)
    throw new Error("An active Bento subscription could not be found.");
  return data as {
    user_id: string;
    plan_id: string;
    status: string;
    dodo_subscription_id: string;
    customer_id: string | null;
    billing_interval: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    pending_plan_id: string | null;
    retention_offer_redeemed_at: string | null;
  };
}

async function integrationSignals(workspaceId: string) {
  const [social, calendar, fathom, content, payments, profile, posts] = await Promise.all([
    db
      .from("social_connections")
      .select("provider,status,reauth_required")
      .eq("user_id", workspaceId)
      .limit(SOCIAL_CONNECTION_LIST_LIMIT),
    db.from("booking_calendar_connections").select("status").eq("user_id", workspaceId),
    db.from("booking_fathom_connections").select("status").eq("user_id", workspaceId),
    db.from("content_connections").select("provider,status").eq("user_id", workspaceId),
    db
      .from("creator_payment_accounts")
      .select("provider,onboarding_status,charges_enabled,payouts_enabled")
      .eq("creator_id", workspaceId),
    db.from("profiles").select("page_published,display_name").eq("id", workspaceId).single(),
    db
      .from("social_posts")
      .select("id")
      .eq("user_id", workspaceId)
      .in("status", ["scheduled", "published"])
      .limit(1),
  ]);
  if ([social, calendar, fathom, content, payments, profile, posts].some((r) => r.error))
    throw new Error("Integration eligibility could not be checked.");
  const providers = new Set<string>();
  let hasSocial = false;
  for (const row of social.data ?? []) {
    if (row.status !== "active" || row.reauth_required) continue;
    hasSocial = true;
    providers.add(`social:${row.provider}`);
  }
  if ((calendar.data ?? []).some((row: { status: string }) => row.status === "active"))
    providers.add("calendar:google");
  if ((fathom.data ?? []).some((row: { status: string }) => row.status === "active"))
    providers.add("meeting:fathom");
  for (const row of content.data ?? []) {
    if (row.status === "active") providers.add(`content:${row.provider}`);
  }
  for (const row of payments.data ?? []) {
    if (row.charges_enabled && row.payouts_enabled && row.onboarding_status === "complete")
      providers.add(`payments:${row.provider}`);
  }
  const activeUsage = Boolean(profile.data?.page_published || (posts.data ?? []).length);
  return {
    activeIntegrations: providers.size,
    hasSocial,
    activeUsage,
    displayName: typeof profile.data?.display_name === "string" ? profile.data.display_name : null,
  };
}

export const startMyCancellation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => startSchema.parse(input))
  .handler(async ({ data, context }) => {
    const subscription = await mySubscription(context.userId);
    if (!["active", "trialing"].includes(subscription.status) || subscription.cancel_at_period_end)
      throw new Error("This subscription is not set to renew.");
    const signals = await integrationSignals(context.userId);
    const { data: existing, error: existingError } = await db
      .from("cancellation_intents")
      .select("id")
      .eq("owner_id", context.authUserId)
      .eq("first_attempt", true)
      .maybeSingle();
    if (existingError) throw new Error("Cancellation history could not be checked.");
    const { data: customerFirst, error: customerError } = subscription.customer_id
      ? await db
          .from("cancellation_intents")
          .select("id")
          .eq("customer_id", subscription.customer_id)
          .eq("first_attempt", true)
          .limit(1)
      : { data: [], error: null };
    if (customerError) throw new Error("Customer offer history could not be checked.");
    const firstAttempt = firstOfferAvailable({
      ownerHasAttempt: Boolean(existing),
      customerHasAttempt: Boolean((customerFirst ?? []).length),
      legacyOfferRedeemed: Boolean(subscription.retention_offer_redeemed_at),
    });
    let offerType = firstAttempt
      ? selectCancellationOffer({
          reason: data.reason,
          subscription,
          signals,
          discountConfigured:
            process.env.DODO_RETENTION_DISCOUNT_READY === "true" &&
            Boolean(process.env.DODO_RETENTION_DISCOUNT_CODE),
        })
      : null;
    const discountQuote =
      offerType === "discount" ? await previewRetentionDiscount(subscription) : null;
    if (offerType === "discount" && !discountQuote) offerType = null;
    const row = {
      owner_id: context.authUserId,
      workspace_id: context.userId,
      subscription_id: subscription.dodo_subscription_id,
      customer_id: subscription.customer_id,
      first_attempt: firstAttempt,
      reason: data.reason,
      details: data.details ?? null,
      switch_destination:
        data.reason === "moving_elsewhere" ? (data.switchDestination ?? null) : null,
      switch_why: data.reason === "moving_elsewhere" ? (data.switchWhy ?? null) : null,
      offer_type: offerType,
      offer_shown_at: offerType ? new Date().toISOString() : null,
    };
    const { data: inserted, error } = await db
      .from("cancellation_intents")
      .insert(row)
      .select("id")
      .single();
    if (error || !inserted) {
      if (error?.code === "23505") {
        const { data: second, error: secondError } = await db
          .from("cancellation_intents")
          .insert({ ...row, first_attempt: false, offer_type: null, offer_shown_at: null })
          .select("id")
          .single();
        if (!secondError && second)
          return {
            intentId: second.id as string,
            firstAttempt: false,
            reason: data.reason,
            offerType: null,
            discountPercent: null,
            ...signals,
          };
      }
      throw new Error("Your cancellation options could not be prepared.");
    }
    return {
      intentId: inserted.id as string,
      firstAttempt,
      reason: data.reason,
      offerType,
      discountPercent: discountQuote ? discountQuote.discount.amount / 100 : null,
      ...signals,
    };
  });

export const getMyCancellationImpact = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const workspaceId = context.userId;
    const queries = await Promise.all([
      db
        .from("pages")
        .select("id", { count: "exact", head: true })
        .eq("user_id", workspaceId)
        .eq("is_visible", true),
      db
        .from("commerce_products")
        .select("id", { count: "exact", head: true })
        .eq("creator_id", workspaceId)
        .eq("status", "published"),
      db
        .from("social_posts")
        .select("id", { count: "exact", head: true })
        .eq("user_id", workspaceId)
        .eq("status", "scheduled"),
      db
        .from("instagram_dm_automations")
        .select("id", { count: "exact", head: true })
        .eq("user_id", workspaceId)
        .eq("enabled", true),
      db
        .from("twitter_dm_automations")
        .select("id", { count: "exact", head: true })
        .eq("user_id", workspaceId)
        .eq("enabled", true),
      db
        .from("facebook_dm_automations")
        .select("id", { count: "exact", head: true })
        .eq("user_id", workspaceId)
        .eq("enabled", true),
    ]);
    if (queries.some((result) => result.error))
      throw new Error("Your workspace impact could not be loaded.");
    return {
      publishedPages: queries[0].count ?? 0,
      publishedProducts: queries[1].count ?? 0,
      scheduledPosts: queries[2].count ?? 0,
      activeAutoDms: (queries[3].count ?? 0) + (queries[4].count ?? 0) + (queries[5].count ?? 0),
    };
  });

async function checkedIntent(
  intentId: string,
  ownerId: string,
  workspaceId: string,
  offerType: string,
) {
  const { data, error } = await db
    .from("cancellation_intents")
    .select("id,subscription_id,offer_type,first_attempt,offer_accepted_at")
    .eq("id", intentId)
    .eq("owner_id", ownerId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (
    error ||
    !data ||
    !data.first_attempt ||
    data.offer_type !== offerType ||
    data.offer_accepted_at
  )
    throw new Error("This one-time offer is no longer available.");
  return data as { id: string; subscription_id: string };
}

async function acceptIntent(intentId: string, workspaceId: string) {
  const { error } = await db
    .from("cancellation_intents")
    .update({ offer_accepted_at: new Date().toISOString() })
    .eq("id", intentId)
    .eq("workspace_id", workspaceId)
    .is("offer_accepted_at", null);
  if (error) throw new Error("Your offer result could not be recorded.");
}

async function previewRetentionDiscount(subscription: Awaited<ReturnType<typeof mySubscription>>) {
  const code = process.env.DODO_RETENTION_DISCOUNT_CODE?.trim();
  if (!code || process.env.DODO_RETENTION_DISCOUNT_READY !== "true") return null;
  const expectedBps = Number(process.env.DODO_RETENTION_DISCOUNT_BPS ?? 2500);
  if (!Number.isInteger(expectedBps) || expectedBps < 1 || expectedBps > 4000) return null;
  try {
    const [remote, discount] = await Promise.all([
      dodo.subscriptions.retrieve(subscription.dodo_subscription_id),
      dodo.discounts.retrieveByCode(code),
    ]);
    if (
      remote.status !== "active" ||
      remote.scheduled_change ||
      (remote.discounts?.length ?? 0) > 0 ||
      discount.type !== "percentage" ||
      discount.amount !== expectedBps ||
      discount.subscription_cycles !== 3 ||
      discount.per_customer_usage_limit !== 1 ||
      discount.customer_eligibility !== "specific" ||
      discount.preserve_on_plan_change ||
      !discount.restricted_to.includes(remote.product_id)
    )
      return null;
    const addons = (remote.addons ?? []).map((addon) => ({
      addon_id: addon.addon_id,
      quantity: addon.quantity,
    }));
    const preview = await dodo.subscriptions.previewChangePlan(subscription.dodo_subscription_id, {
      product_id: remote.product_id,
      quantity: 1,
      addons,
      proration_billing_mode: "do_not_bill",
      effective_at: "immediately",
      discount_codes: [code],
      on_payment_failure: "prevent_change",
    });
    if (
      preview.new_plan.product_id !== remote.product_id ||
      !preview.new_plan.discounts?.some((item) => item.code === code)
    )
      return null;
    return { code, remote, addons, discount };
  } catch (cause) {
    console.error("[billing] retention discount preview unavailable", {
      subscriptionId: subscription.dodo_subscription_id,
      cause,
    });
    return null;
  }
}

export const acceptMyRetentionDiscount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => intentSchema.parse(input))
  .handler(async ({ data, context }) =>
    withWorkspaceBillingSync(context.userId, async (lease) => {
      const intent = await checkedIntent(
        data.intentId,
        context.authUserId,
        context.userId,
        "discount",
      );
      const subscription = await mySubscription(context.userId);
      if (
        subscription.dodo_subscription_id !== intent.subscription_id ||
        subscription.status !== "active" ||
        subscription.cancel_at_period_end ||
        !["month", "monthly"].includes(subscription.billing_interval?.toLowerCase() ?? "")
      )
        throw new Error("This discount is no longer available.");
      const quote = await previewRetentionDiscount(subscription);
      if (!quote)
        throw new Error("Dodo could not verify this discount. No billing change was made.");
      await dodo.subscriptions.changePlan(subscription.dodo_subscription_id, {
        product_id: quote.remote.product_id,
        quantity: 1,
        addons: quote.addons,
        proration_billing_mode: "do_not_bill",
        effective_at: "immediately",
        discount_codes: [quote.code],
        on_payment_failure: "prevent_change",
      });
      const verified = await dodo.subscriptions.retrieve(subscription.dodo_subscription_id);
      if (
        !verified.discounts?.some(
          (item) => item.code === quote.code && (item.cycles_remaining ?? 0) === 3,
        )
      )
        throw new Error(
          "Dodo has not confirmed the retention discount. Review Billing before retrying.",
        );
      await refreshWorkspaceSubscription(context.userId, subscription.dodo_subscription_id, lease);
      await acceptIntent(intent.id, context.userId);
      return { accepted: true as const, nextBillingDate: verified.next_billing_date };
    }),
  );

export async function markDowngradeAccepted(input: {
  intentId: string;
  ownerId: string;
  workspaceId: string;
  subscriptionId: string;
}) {
  const intent = await checkedIntent(input.intentId, input.ownerId, input.workspaceId, "downgrade");
  if (intent.subscription_id !== input.subscriptionId)
    throw new Error("The offered plan change no longer matches this subscription.");
  await acceptIntent(intent.id, input.workspaceId);
}

export async function assertDowngradeIntent(input: {
  intentId: string;
  ownerId: string;
  workspaceId: string;
  subscriptionId: string;
}) {
  const intent = await checkedIntent(input.intentId, input.ownerId, input.workspaceId, "downgrade");
  if (intent.subscription_id !== input.subscriptionId)
    throw new Error("The offered plan change no longer matches this subscription.");
}

export const pauseMySubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    intentSchema
      .extend({ days: z.union([z.literal(30), z.literal(60), z.literal(90)]) })
      .parse(input),
  )
  .handler(async ({ data, context }) =>
    withWorkspaceBillingSync(context.userId, async (lease) => {
      const intent = await checkedIntent(
        data.intentId,
        context.authUserId,
        context.userId,
        "pause",
      );
      const subscription = await mySubscription(context.userId);
      const { data: existingPause, error: readError } = await db
        .from("subscription_pauses")
        .select("id,subscription_id,resume_at")
        .eq("workspace_id", context.userId)
        .is("resumed_at", null)
        .maybeSingle();
      if (readError) throw new Error("The pause status could not be checked.");
      if (existingPause && existingPause.subscription_id !== subscription.dodo_subscription_id)
        throw new Error("A pause belongs to another subscription in this workspace.");
      if (
        subscription.status === "paused" &&
        existingPause &&
        subscription.dodo_subscription_id === intent.subscription_id
      ) {
        await acceptIntent(intent.id, context.userId);
        return { paused: true as const, resumeAt: existingPause.resume_at as string };
      }
      if (
        subscription.dodo_subscription_id !== intent.subscription_id ||
        subscription.status !== "active" ||
        subscription.cancel_at_period_end ||
        !["store", "creator", "creator_plus"].includes(subscription.plan_id)
      )
        throw new Error("Only an active paid subscription can be paused.");
      const started = new Date();
      const requestedResumeAt = new Date(started.getTime() + data.days * dayMs);
      let pause = existingPause;
      if (!pause) {
        const { data: created, error: saveError } = await db
          .from("subscription_pauses")
          .insert({
            owner_id: context.authUserId,
            workspace_id: context.userId,
            subscription_id: subscription.dodo_subscription_id,
            started_at: started.toISOString(),
            resume_at: requestedResumeAt.toISOString(),
            next_attempt_at: requestedResumeAt.toISOString(),
          })
          .select("id,subscription_id,resume_at")
          .single();
        if (saveError || !created)
          throw new Error("A pause is already scheduled for this workspace.");
        pause = created;
      }
      const resumeAt = new Date(pause.resume_at);
      try {
        const before = await dodo.subscriptions.retrieve(subscription.dodo_subscription_id);
        if (before.status !== "paused")
          await dodo.subscriptions.update(subscription.dodo_subscription_id, { status: "paused" });
        const remote = await dodo.subscriptions.retrieve(subscription.dodo_subscription_id);
        if (remote.status !== "paused") throw new Error("Dodo did not confirm the pause.");
        await refreshWorkspaceSubscription(
          context.userId,
          subscription.dodo_subscription_id,
          lease,
        );
        await acceptIntent(intent.id, context.userId);
        try {
          await enqueueBentoBillingEmail({
            userId: context.userId,
            eventKey: `subscription-pause:${pause.id}`,
            eventType: "subscription_paused",
            payload: {
              resumeDate:
                new Intl.DateTimeFormat("en", {
                  dateStyle: "long",
                  timeStyle: "short",
                  timeZone: "UTC",
                }).format(resumeAt) + " UTC",
            },
          });
        } catch (cause) {
          console.error("[billing] pause receipt needs retry", {
            workspaceId: context.userId,
            cause,
          });
        }
      } catch (error) {
        // The provider may have accepted a request even if the response was lost.
        // Keep the pause record so reconciliation can check before another offer.
        console.error("[billing] pause needs provider reconciliation", {
          workspaceId: context.userId,
          error,
        });
        throw new Error(
          "The pause could not be confirmed. Please refresh billing before retrying.",
        );
      }
      return { paused: true as const, resumeAt: resumeAt.toISOString() };
    }),
  );

export const resumeMyPausedSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) =>
    withWorkspaceBillingSync(context.userId, async (lease) => {
      const subscription = await mySubscription(context.userId);
      if (subscription.status !== "paused")
        throw new Error("No paused Bento subscription was found.");
      const { data: pause, error } = await db
        .from("subscription_pauses")
        .select("id")
        .eq("workspace_id", context.userId)
        .is("resumed_at", null)
        .maybeSingle();
      if (error) throw new Error("The pause could not be verified.");
      await dodo.subscriptions.update(subscription.dodo_subscription_id, { status: "active" });
      const remote = await dodo.subscriptions.retrieve(subscription.dodo_subscription_id);
      if (remote.status !== "active") throw new Error("Dodo did not confirm reactivation.");
      await refreshWorkspaceSubscription(context.userId, subscription.dodo_subscription_id, lease);
      if (pause) {
        const { error: saveError } = await db
          .from("subscription_pauses")
          .update({ resumed_at: new Date().toISOString() })
          .eq("id", pause.id)
          .is("resumed_at", null);
        if (saveError)
          throw new Error("Reactivation succeeded but local pause status needs reconciliation.");
      }
      return { active: true as const, nextBillingDate: remote.next_billing_date };
    }),
  );

export const extendMyTrial = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => intentSchema.parse(input))
  .handler(async ({ data, context }) =>
    withWorkspaceBillingSync(context.userId, async (lease) => {
      const intent = await checkedIntent(
        data.intentId,
        context.authUserId,
        context.userId,
        "trial_extension",
      );
      const subscription = await mySubscription(context.userId);
      if (
        subscription.status !== "trialing" ||
        subscription.cancel_at_period_end ||
        subscription.dodo_subscription_id !== intent.subscription_id
      )
        throw new Error("This trial is no longer eligible for an extension.");
      const signals = await integrationSignals(context.userId);
      if (!signals.hasSocial || !signals.activeUsage || signals.activeIntegrations < 3)
        throw new Error(
          "Connect three integrations, including social, and use Bento before extending.",
        );
      const { data: owner, error } = await db
        .from("bento_trial_owners")
        .select(
          "trial_days,trial_ends_at,subscription_id,extension_approved_until,extension_redeemed_at",
        )
        .eq("auth_user_id", context.authUserId)
        .maybeSingle();
      if (
        error ||
        !owner ||
        owner.subscription_id !== subscription.dodo_subscription_id ||
        owner.trial_days !== TRIAL_DAYS
      )
        throw new Error("This one-time trial extension is no longer available.");
      const remote = await dodo.subscriptions.retrieve(subscription.dodo_subscription_id);
      const targetIso = trialExtensionEnd(
        owner.trial_ends_at,
        owner.extension_approved_until,
        owner.extension_redeemed_at,
      );
      const target = new Date(targetIso ?? "");
      if (
        !targetIso ||
        target.getTime() <= Date.now() ||
        Date.parse(remote.next_billing_date) > target.getTime() ||
        remote.cancel_at_next_billing_date
      )
        throw new Error("The trial extension is no longer available.");
      if (!owner.extension_redeemed_at) {
        const { data: approval, error: approvalError } = await db
          .from("bento_trial_owners")
          .update({
            extension_approved_until: targetIso,
            extension_redeemed_at: new Date().toISOString(),
          })
          .eq("auth_user_id", context.authUserId)
          .eq("subscription_id", subscription.dodo_subscription_id)
          .is("extension_redeemed_at", null)
          .select("auth_user_id")
          .maybeSingle();
        if (approvalError || !approval)
          throw new Error("The trial extension could not be reserved.");
      }
      try {
        if (Math.abs(Date.parse(remote.next_billing_date) - target.getTime()) > 60_000)
          await dodo.subscriptions.update(subscription.dodo_subscription_id, {
            next_billing_date: targetIso,
          });
        const verified = await dodo.subscriptions.retrieve(subscription.dodo_subscription_id);
        if (Math.abs(Date.parse(verified.next_billing_date) - target.getTime()) > 60_000)
          throw new Error("Dodo did not confirm the new trial date.");
        await refreshWorkspaceSubscription(
          context.userId,
          subscription.dodo_subscription_id,
          lease,
        );
        await acceptIntent(intent.id, context.userId);
        try {
          await enqueueBentoBillingEmail({
            userId: context.userId,
            eventKey: `trial-extended:${subscription.dodo_subscription_id}:${targetIso}`,
            eventType: "trial_extended",
            payload: {
              chargeDate:
                new Intl.DateTimeFormat("en", {
                  dateStyle: "long",
                  timeStyle: "short",
                  timeZone: "UTC",
                }).format(target) + " UTC",
            },
          });
        } catch (cause) {
          console.error("[billing] trial extension receipt needs retry", {
            workspaceId: context.userId,
            cause,
          });
        }
      } catch (cause) {
        console.error("[billing] trial extension needs provider reconciliation", {
          workspaceId: context.userId,
          cause,
        });
        throw new Error(
          "The extension could not be confirmed. Please refresh billing before retrying.",
        );
      }
      return { trialEndsAt: targetIso };
    }),
  );

export async function markCancellationConfirmed(input: {
  intentId?: string;
  ownerId: string;
  workspaceId: string;
  subscriptionId: string;
}) {
  if (input.intentId) {
    const { data: updated, error } = await db
      .from("cancellation_intents")
      .update({ cancellation_confirmed_at: new Date().toISOString() })
      .eq("id", input.intentId)
      .eq("owner_id", input.ownerId)
      .eq("workspace_id", input.workspaceId)
      .eq("subscription_id", input.subscriptionId)
      .select("id")
      .maybeSingle();
    if (!error && updated) return;
  }
  // Older clients can cancel without opening the new flow. Record that intent
  // so a later attempt cannot claim a first-time perk.
  try {
    const { data: openIntent, error: openError } = await db
      .from("cancellation_intents")
      .select("id")
      .eq("owner_id", input.ownerId)
      .eq("workspace_id", input.workspaceId)
      .eq("subscription_id", input.subscriptionId)
      .is("offer_accepted_at", null)
      .is("cancellation_confirmed_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (openError) throw openError;
    if (openIntent) {
      const { error: saveError } = await db
        .from("cancellation_intents")
        .update({ cancellation_confirmed_at: new Date().toISOString() })
        .eq("id", openIntent.id)
        .is("cancellation_confirmed_at", null);
      if (saveError) throw saveError;
      return;
    }
    const subscription = await mySubscription(input.workspaceId);
    const { data: prior, error: priorError } = await db
      .from("cancellation_intents")
      .select("id")
      .eq("owner_id", input.ownerId)
      .eq("first_attempt", true)
      .limit(1);
    if (priorError) throw priorError;
    const firstAttempt = firstOfferAvailable({
      ownerHasAttempt: Boolean((prior ?? []).length),
      customerHasAttempt: false,
      legacyOfferRedeemed: Boolean(subscription.retention_offer_redeemed_at),
    });
    const row = {
      owner_id: input.ownerId,
      workspace_id: input.workspaceId,
      subscription_id: input.subscriptionId,
      customer_id: subscription.customer_id,
      first_attempt: firstAttempt,
      cancellation_confirmed_at: new Date().toISOString(),
    };
    const { error } = await db.from("cancellation_intents").insert(row);
    if (error?.code === "23505") {
      const { error: secondError } = await db
        .from("cancellation_intents")
        .insert({ ...row, first_attempt: false });
      if (secondError) throw secondError;
    } else if (error) throw error;
  } catch (cause) {
    console.error("[billing] cancellation history write deferred", {
      workspaceId: input.workspaceId,
      cause,
    });
  }
}

export async function processDueSubscriptionPauses() {
  const { data: due, error } = await db
    .from("subscription_pauses")
    .select("id,workspace_id,subscription_id,resume_at,resume_attempts")
    .is("resumed_at", null)
    .lte("resume_at", new Date().toISOString())
    .lte("next_attempt_at", new Date().toISOString())
    .lt("resume_attempts", 8)
    .order("resume_attempts", { ascending: true })
    .order("resume_at")
    .limit(25);
  if (error) throw new Error("Due subscription pauses could not be loaded.");
  let resumed = 0;
  for (const row of due ?? []) {
    try {
      await withWorkspaceBillingSync(row.workspace_id, async (lease) => {
        const remote = await dodo.subscriptions.retrieve(row.subscription_id);
        if (remote.status === "paused")
          await dodo.subscriptions.update(row.subscription_id, { status: "active" });
        const verified = await dodo.subscriptions.retrieve(row.subscription_id);
        if (verified.status !== "active") throw new Error("Provider did not confirm resume.");
        await refreshWorkspaceSubscription(row.workspace_id, row.subscription_id, lease);
        const { error: saveError } = await db
          .from("subscription_pauses")
          .update({ resumed_at: new Date().toISOString(), last_error: null })
          .eq("id", row.id)
          .is("resumed_at", null);
        if (saveError) throw saveError;
      });
      resumed++;
    } catch (cause) {
      const attempts = (row.resume_attempts ?? 0) + 1;
      const retryMinutes = Math.min(5 * 2 ** (attempts - 1), 24 * 60);
      await db
        .from("subscription_pauses")
        .update({
          resume_attempts: attempts,
          next_attempt_at: new Date(Date.now() + retryMinutes * 60_000).toISOString(),
          last_error: attempts >= 8 ? "Manual review required" : "Provider resume requires retry",
        })
        .eq("id", row.id)
        .is("resumed_at", null);
      console.error("[billing] automatic pause resume deferred", {
        workspaceId: row.workspace_id,
        cause,
      });
    }
  }
  return { checked: (due ?? []).length, resumed };
}

export async function readPauseReminder(workspaceId: string, pauseId: string, resumeAt: string) {
  const { data: pause, error } = await db
    .from("subscription_pauses")
    .select("subscription_id,resume_at,resumed_at")
    .eq("id", pauseId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (
    error ||
    !pause ||
    pause.resumed_at ||
    pause.resume_at !== resumeAt ||
    Date.parse(resumeAt) <= Date.now()
  )
    return null;
  const subscription = await mySubscription(workspaceId);
  if (
    subscription.status !== "paused" ||
    subscription.dodo_subscription_id !== pause.subscription_id
  )
    return null;
  const remote = await dodo.subscriptions.retrieve(pause.subscription_id);
  if (remote.status !== "paused") return null;
  return {
    pauseId,
    resumeAt,
    resumeDate:
      new Intl.DateTimeFormat("en", {
        dateStyle: "long",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(resumeAt)) + " UTC",
  };
}

export async function enqueueDuePauseReminders() {
  const now = Date.now();
  const { data: pauses, error } = await db
    .from("subscription_pauses")
    .select("id,workspace_id,resume_at")
    .is("resumed_at", null)
    .gt("resume_at", new Date(now).toISOString())
    .lte("resume_at", new Date(now + 7 * dayMs).toISOString())
    .order("resume_at")
    .limit(100);
  if (error) throw new Error("Pause reminders could not be loaded.");
  let queued = 0;
  for (const pause of pauses ?? []) {
    const remaining = Date.parse(pause.resume_at) - now;
    const daysBefore = remaining <= dayMs ? 1 : 7;
    const eventKey = `pause-ending:${pause.id}:${daysBefore}`;
    const { data: existing, error: lookupError } = await db
      .from("email_outbox")
      .select("id")
      .eq("event_key", `billing-email:${eventKey}`)
      .maybeSingle();
    if (lookupError) throw new Error("Pause reminder history could not be checked.");
    if (existing) continue;
    const payload = await readPauseReminder(pause.workspace_id, pause.id, pause.resume_at);
    if (!payload) continue;
    const result = await enqueueBentoBillingEmail({
      userId: pause.workspace_id,
      eventKey,
      eventType: "pause_ending_reminder",
      payload,
    });
    if (result) queued++;
  }
  return { queued };
}
