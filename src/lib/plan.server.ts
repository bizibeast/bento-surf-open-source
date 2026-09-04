// Server-only helpers for reading a user's plan and enforcing storage quota.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  highestPlan,
  isPaidPlan,
  MAX_STORAGE_ADDON_UNITS,
  normalizePlan,
  planHasEntitlement,
  planLimits,
  STORAGE_ADDON_UNIT_MB,
  type EntitlementKey,
  type PlanId,
} from "./plans";

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
export async function getPlan(userId: string): Promise<PlanId> {
  const [profileResult, grantResult] = await Promise.all([
    supabaseAdmin.from("profiles").select("plan_id, is_pro").eq("id", userId).maybeSingle(),
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
      .select("plan_id, is_pro")
      .eq("id", userId)
      .maybeSingle();
    if (reconciledError) throw new Error(reconciledError.message);
    return resolveAuthoritativePlan(
      null,
      reconciledProfile?.plan_id,
      Boolean(reconciledProfile?.is_pro),
    );
  }

  return resolveAuthoritativePlan(
    isComplimentaryGrantActive(grant?.status, grant?.expires_at) ? grant?.plan_id : null,
    profileResult.data?.plan_id,
    Boolean(profileResult.data?.is_pro),
  );
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
  if (!planHasEntitlement(plan, entitlement)) throw new Error(message);
  return plan;
}
