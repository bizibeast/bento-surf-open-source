// Server-only helpers for reading a user's plan and enforcing storage quota.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { billingAllows, readBillingLifecycle, type BillingSurface } from "./billing-lifecycle";
import {
  highestPlan,
  isPaidPlan,
  MAX_STORAGE_ADDON_UNITS,
  normalizePlan,
  planHasEntitlement,
  planLimits,
  STORAGE_ADDON_UNIT_MB,
  type BillingCatalog,
  type EntitlementKey,
  type PlanId,
} from "./plans";

export function isSelfHostedEdition() {
  return process.env.BENTO_EDITION === "self_hosted";
}

export async function getBillingCatalog(userId: string): Promise<BillingCatalog> {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("billing_catalog")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  // Only an explicit legacy marker can retain the former bundle.
  return data?.billing_catalog === "legacy" ? "legacy" : "2026-10";
}

export async function hasPlanEntitlement(
  userId: string,
  entitlement: EntitlementKey,
): Promise<boolean> {
  if (isSelfHostedEdition()) return true;
  const [plan, profile] = await Promise.all([
    getPlan(userId),
    supabaseAdmin
      .from("profiles")
      .select("billing_catalog,billing_lifecycle")
      .eq("id", userId)
      .maybeSingle(),
  ]);
  if (profile.error) throw new Error(profile.error.message);
  const catalog = profile.data?.billing_catalog === "legacy" ? "legacy" : "2026-10";
  if (plan === "free" && !billingAllows(profile.data?.billing_lifecycle, "tools")) return false;
  if (catalog !== "legacy" && plan === "free") return false;
  return planHasEntitlement(plan, entitlement, catalog);
}

export function resolveAuthoritativePlan(
  complimentaryPlan: string | null | undefined,
  profilePlan: string | null | undefined,
  isPro: boolean,
): PlanId {
  const grant = normalizePlan(complimentaryPlan);
  return highestPlan(grant, normalizePlan(profilePlan, isPro));
}

export function isComplimentaryGrantActive(
  status: string | null | undefined,
  expiresAt: string | null | undefined,
  now = Date.now(),
): boolean {
  if (status !== "active" || !expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry > now;
}

/** Authoritative plan read (service role, bypasses RLS). */
export async function getPlan(userId: string, surface: BillingSurface = "tools"): Promise<PlanId> {
  if (isSelfHostedEdition()) return "creator_plus";
  const [profileResult, grantResult] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("plan_id, is_pro, trial_ends_at, billing_lifecycle")
      .eq("id", userId)
      .maybeSingle(),
    supabaseAdmin
      .from("complimentary_plan_grants")
      .select("id, plan_id, status, expires_at")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  if (profileResult.error) throw new Error(profileResult.error.message);
  if (grantResult.error) throw new Error(grantResult.error.message);

  const grant = grantResult.data;
  if (grant?.status === "active" && !isComplimentaryGrantActive(grant.status, grant.expires_at)) {
    const { error: expiryError } = await supabaseAdmin.rpc("expire_complimentary_plan_grant", {
      p_grant_id: grant.id,
    });
    if (expiryError) throw new Error(expiryError.message);

    const { data: reconciledProfile, error: reconciledError } = await supabaseAdmin
      .from("profiles")
      .select("plan_id, is_pro, trial_ends_at, billing_lifecycle")
      .eq("id", userId)
      .maybeSingle();
    if (reconciledError) throw new Error(reconciledError.message);
    return profilePlanForBillingSurface(reconciledProfile, surface);
  }

  return highestPlan(
    normalizePlan(
      isComplimentaryGrantActive(grant?.status, grant?.expires_at) ? grant?.plan_id : null,
    ),
    profilePlanForBillingSurface(profileResult.data, surface),
  );
}

export function profilePlanForBillingSurface(
  profile:
    | {
        plan_id?: string;
        is_pro?: boolean;
        trial_ends_at?: string | null;
        billing_lifecycle?: unknown;
      }
    | null
    | undefined,
  surface: BillingSurface,
  now = Date.now(),
): PlanId {
  if (!billingAllows(profile?.billing_lifecycle, surface, now)) return "free";
  const lifecycle = readBillingLifecycle(profile?.billing_lifecycle);
  if (lifecycle)
    return profile?.trial_ends_at && Date.parse(profile.trial_ends_at) > now
      ? highestPlan(lifecycle.plan, "creator_plus")
      : lifecycle.plan;
  if (profile?.trial_ends_at)
    return Date.parse(profile.trial_ends_at) > now ? "creator_plus" : "free";
  return normalizePlan(profile?.plan_id, Boolean(profile?.is_pro));
}

/** Compatibility helper: Store and Creator are both paid plans. */
export async function getIsPro(userId: string): Promise<boolean> {
  return isPaidPlan(await getPlan(userId));
}

/** Verified storage capacity. Complimentary access gets only its base plan storage. */
export async function getStorageAllowanceMb(userId: string): Promise<number> {
  const [plan, subscriptionResult] = await Promise.all([
    getPlan(userId),
    supabaseAdmin
      .from("subscriptions")
      .select("plan_id, status, storage_addon_units")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  if (subscriptionResult.error) throw new Error(subscriptionResult.error.message);

  const subscription = subscriptionResult.data;
  if (
    !isPaidPlan(plan) ||
    !subscription ||
    !["active", "trialing"].includes(subscription.status) ||
    !isPaidPlan(normalizePlan(subscription.plan_id))
  ) {
    return planLimits(plan).storageMb;
  }

  const units = Math.min(MAX_STORAGE_ADDON_UNITS, Math.max(0, subscription.storage_addon_units));
  return planLimits(plan).storageMb + units * STORAGE_ADDON_UNIT_MB;
}

export async function requirePlanEntitlement(
  userId: string,
  entitlement: EntitlementKey,
  message: string,
): Promise<PlanId> {
  const plan = await getPlan(userId);
  if (!(await hasPlanEntitlement(userId, entitlement))) throw new Error(message);
  return plan;
}
