import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { dodo } from "@/integrations/dodo/client.server";
import { resolveBillingProduct, verifiedTrialEnd } from "./billing-catalog";
import { readTrialTerms } from "./billing-trial-terms.server";
import { isTrialReminderDue } from "./trial-reminders";
import { planName } from "./plans";
import { enqueueBentoBillingEmail } from "./email.server";

/** Called again at delivery, so retries never send canceled or stale renewal terms. */
export async function readTrialReminder(userId: string, subscriptionId: string, chargeAt: string) {
  const { data: current, error } = await supabaseAdmin
    .from("subscriptions")
    .select("dodo_subscription_id,status,trial_ends_at,current_period_end,cancel_at_period_end")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!current || current.dodo_subscription_id !== subscriptionId || !isTrialReminderDue(current))
    return null;
  const remote = await dodo.subscriptions.retrieve(subscriptionId);
  const ownerId =
    typeof remote.metadata?.auth_user_id === "string" ? remote.metadata.auth_user_id : null;
  const checkoutKey =
    typeof remote.metadata?.trial_checkout_key === "string"
      ? remote.metadata.trial_checkout_key
      : null;
  const terms = await readTrialTerms({ workspaceId: userId, ownerId, checkoutKey, subscriptionId });
  const end = terms
    ? verifiedTrialEnd(
        remote as unknown as Record<string, unknown>,
        Date.now(),
        terms.days,
        terms.approvedExtensionEnd,
      )
    : null;
  let chargePlan = remote;
  const scheduled = remote.scheduled_change;
  if (end && scheduled && Date.parse(scheduled.effective_at) <= Date.parse(end)) {
    if (!resolveBillingProduct(scheduled.product_id, process.env))
      throw new Error("The next renewal product could not be verified.");
    const preview = await dodo.subscriptions.previewChangePlan(subscriptionId, {
      product_id: scheduled.product_id,
      quantity: scheduled.quantity,
      addons: scheduled.addons.map((addon) => ({
        addon_id: addon.addon_id,
        quantity: addon.quantity,
      })),
      proration_billing_mode: "do_not_bill",
    });
    if (preview.new_plan.product_id !== scheduled.product_id)
      throw new Error("The next renewal quote did not match the scheduled plan.");
    chargePlan = preview.new_plan;
  }
  const product = resolveBillingProduct(chargePlan.product_id, process.env);
  if (
    !end ||
    Date.parse(end) !== Date.parse(chargeAt) ||
    remote.cancel_at_next_billing_date ||
    !product
  )
    return null;
  if (
    !Number.isFinite(chargePlan.recurring_pre_tax_amount) ||
    chargePlan.recurring_pre_tax_amount <= 0
  )
    return null;
  const replyTo = process.env.RESEND_REPLY_TO?.trim();
  if (!replyTo) throw new Error("Configure a monitored RESEND_REPLY_TO for trial feedback.");
  return {
    subscriptionId,
    chargeAt: end,
    planName: planName(product.plan),
    billingPeriod: product.period,
    amount: chargePlan.recurring_pre_tax_amount,
    currency: chargePlan.currency,
    chargeDate:
      new Intl.DateTimeFormat("en", {
        dateStyle: "long",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(end)) + " UTC",
    taxNote: chargePlan.tax_inclusive ? "Taxes are included." : "Applicable taxes may be added.",
    replyTo,
  };
}

export async function enqueueDueTrialReminders() {
  const now = Date.now();
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("user_id,dodo_subscription_id,trial_ends_at")
    .eq("status", "trialing")
    .eq("cancel_at_period_end", false)
    .gt("trial_ends_at", new Date(now).toISOString())
    .lte("trial_ends_at", new Date(now + 86_400_000).toISOString());
  if (error) throw new Error(error.message);
  let queued = 0;
  for (const trial of data ?? []) {
    if (!trial.dodo_subscription_id || !trial.trial_ends_at) continue;
    const key = `trial-ending:${trial.dodo_subscription_id}:${new Date(trial.trial_ends_at).toISOString()}`;
    const { data: existing, error: lookupError } = await supabaseAdmin
      .from("email_outbox" as never)
      .select("id")
      .eq("event_key" as never, `billing-email:${key}`)
      .maybeSingle();
    if (lookupError) throw new Error(lookupError.message);
    if (existing) continue;
    try {
      const payload = await readTrialReminder(
        trial.user_id,
        trial.dodo_subscription_id,
        trial.trial_ends_at,
      );
      if (!payload) continue;
      const result = await enqueueBentoBillingEmail({
        userId: trial.user_id,
        eventKey: key,
        eventType: "trial_ending_reminder",
        payload,
        amount: payload.amount,
        currency: payload.currency,
      });
      if (result) queued++;
    } catch (error) {
      console.error("[trial-reminder] reminder needs retry", {
        subscriptionId: trial.dodo_subscription_id,
        error,
      });
    }
  }
  return { queued };
}
