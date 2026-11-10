import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { dodo } from "@/integrations/dodo/client.server";
import type { PaidPlanId } from "./plans";
import { TRIAL_DAYS } from "./plans";
import { readBillingLifecycle } from "./billing-lifecycle";
// Private service-only tables, owned by the paired trial migration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any;

export async function checkoutEligibility(authUserId: string, workspaceId: string) {
  const [trial, subscriptions, profile] = await Promise.all([
    db
      .from("bento_trial_owners")
      .select("auth_user_id")
      .eq("auth_user_id", authUserId)
      .maybeSingle(),
    db
      .from("subscriptions")
      .select("dodo_subscription_id,status,trial_ends_at")
      .eq("user_id", workspaceId)
      .maybeSingle(),
    db
      .from("profiles")
      .select("billing_catalog,onboarded,billing_lifecycle,display_name")
      .eq("id", workspaceId)
      .single(),
  ]);
  if (trial.error || subscriptions.error || profile.error)
    throw new Error("Your trial eligibility could not be verified.");
  if (readBillingLifecycle(profile.data?.billing_lifecycle)?.deletingAt)
    throw new Error(
      "This workspace is being deleted. Contact your instance administrator before starting a new subscription.",
    );
  const active =
    subscriptions.data?.dodo_subscription_id &&
    ["active", "trialing", "past_due"].includes(subscriptions.data.status);
  return {
    // Signup provisions the initial profile with the auth identity. Additional
    // workspaces have independently generated IDs and never receive a trial.
    trialEligible:
      workspaceId === authUserId && !trial.data && !subscriptions.data?.dodo_subscription_id,
    active: Boolean(active),
    profile: profile.data,
  };
}

export async function reserveTrialCheckout(
  authUserId: string,
  workspaceId: string,
  plan: PaidPlanId,
  verificationKey: string,
) {
  const checkoutKey = crypto.randomUUID();
  const { error } = await db.from("bento_trial_checkouts").insert({
    auth_user_id: authUserId,
    workspace_id: workspaceId,
    plan_id: plan,
    checkout_key: checkoutKey,
    trial_verification_key: verificationKey,
    trial_days: TRIAL_DAYS,
  });
  if (!error) return { url: null, checkoutKey };
  if (error.code !== "23505") throw new Error("Secure checkout could not be reserved.");
  const { data, error: readError } = await db
    .from("bento_trial_checkouts")
    .select(
      "workspace_id,plan_id,checkout_url,checkout_session_id,trial_verification_key,trial_days,created_at",
    )
    .eq("auth_user_id", authUserId)
    .single();
  if (readError) throw new Error("Your previous checkout could not be loaded.");
  if (data.workspace_id !== workspaceId)
    throw new Error("Finish the trial checkout in your original workspace first.");
  // A Dodo checkout URL works once. After a declined card or an expired
  // session the owner has not used their trial, so issue a fresh reservation.
  if (await previousTrialCheckoutEnded(data.checkout_session_id, data.created_at)) {
    const nextKey = crypto.randomUUID();
    const { data: rotated, error: rotateError } = await db
      .from("bento_trial_checkouts")
      .update({
        plan_id: plan,
        checkout_key: nextKey,
        checkout_url: null,
        checkout_session_id: null,
        trial_verification_key: verificationKey,
        trial_days: TRIAL_DAYS,
        created_at: new Date().toISOString(),
      })
      .eq("auth_user_id", authUserId)
      .eq("checkout_session_id", data.checkout_session_id)
      .select("checkout_key");
    if (rotateError) throw new Error("Secure checkout could not be reserved.");
    // Another tab already started the retry; let it finish instead of racing it.
    if (!rotated?.length)
      throw new Error("Your new checkout is being prepared. Please try again in a moment.");
    return { url: null, checkoutKey: nextKey };
  }
  if (data.plan_id !== plan)
    throw new Error(
      "Your previous checkout is for a different plan. Resume that plan, then change your renewal plan in Billing before the trial ends.",
    );
  const priorSevenDayCheckout =
    data.trial_days === 7 &&
    typeof data.trial_verification_key === "string" &&
    data.trial_verification_key.startsWith(
      `free-card-v1:${process.env.DODO_PAYMENTS_ENVIRONMENT === "live_mode" ? "live_mode" : "test_mode"}:`,
    ) &&
    Boolean(data.checkout_url);
  if (data.trial_verification_key !== verificationKey && !priorSevenDayCheckout)
    throw new Error(
      "Your previous checkout needs verification. Contact your instance administrator to resume it safely; no second trial has been started.",
    );
  if (!data.checkout_url)
    throw new Error(
      "Your previous checkout is still being confirmed. Contact your instance administrator if it does not appear; no second trial has been started.",
    );
  return { url: String(data.checkout_url), checkoutKey: null };
}

// Dodo checkout sessions expire 24 hours after creation. Allow a small margin.
const CHECKOUT_SESSION_LIFETIME_MS = 25 * 60 * 60 * 1000;
const ENDED_PAYMENT_STATUSES = new Set(["failed", "cancelled"]);

/**
 * True only when the saved provider session can no longer start a trial: its
 * payment failed or was cancelled, or it expired before any payment was made.
 * Unknown, in-flight and succeeded sessions are never replaced.
 */
export async function previousTrialCheckoutEnded(
  sessionId: unknown,
  reservedAt: unknown,
  now = Date.now(),
) {
  if (typeof sessionId !== "string" || !sessionId) return false;
  try {
    const session = await dodo.checkoutSessions.retrieve(sessionId);
    if (session.payment_status) return ENDED_PAYMENT_STATUSES.has(session.payment_status);
    const createdAt = Date.parse(String(session.created_at ?? reservedAt ?? ""));
    return Number.isFinite(createdAt) && now - createdAt > CHECKOUT_SESSION_LIFETIME_MS;
  } catch {
    console.error("Dodo trial checkout status lookup failed.");
    return false;
  }
}

export async function saveTrialCheckout(authUserId: string, sessionId: string, url: string) {
  const { error } = await db
    .from("bento_trial_checkouts")
    .update({ checkout_session_id: sessionId, checkout_url: url })
    .eq("auth_user_id", authUserId);
  if (error)
    throw new Error(
      "Checkout was created but could not be saved. Contact your instance administrator to resume it safely.",
    );
}
