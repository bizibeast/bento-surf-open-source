/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase RPC types are generated after migrations deploy. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type CommerceSubscriptionState =
  "active" | "renewed" | "cancel_at_period_end" | "past_due" | "expired" | "revoked";

type ProviderSubscriptionSnapshot = {
  eventType: string;
  status?: unknown;
  cancelAtPeriodEnd?: boolean;
};

export function polarSubscriptionState({
  eventType,
  status,
  cancelAtPeriodEnd,
}: ProviderSubscriptionSnapshot): CommerceSubscriptionState | null {
  const normalizedStatus = String(status || "")
    .trim()
    .toLowerCase();
  if (eventType === "subscription.revoked" || ["canceled", "unpaid"].includes(normalizedStatus)) {
    return "revoked";
  }
  if (eventType === "subscription.past_due" || normalizedStatus === "past_due") {
    return "past_due";
  }
  if (normalizedStatus && normalizedStatus !== "active") return null;
  if (eventType === "subscription.canceled" || cancelAtPeriodEnd) {
    return "cancel_at_period_end";
  }
  if (
    normalizedStatus === "active" ||
    [
      "subscription.created",
      "subscription.active",
      "subscription.activated",
      "subscription.uncanceled",
    ].includes(eventType)
  )
    return "active";
  return null;
}

export function dodoSubscriptionState({
  eventType,
  status,
  cancelAtPeriodEnd,
}: ProviderSubscriptionSnapshot): CommerceSubscriptionState | null {
  const normalizedStatus = String(status || "")
    .trim()
    .toLowerCase();
  if (eventType === "subscription.expired" || normalizedStatus === "expired") return "expired";
  if (
    eventType === "subscription.cancelled" ||
    ["cancelled", "canceled"].includes(normalizedStatus)
  ) {
    return "revoked";
  }
  if (
    eventType === "subscription.failed" ||
    eventType === "subscription.on_hold" ||
    ["failed", "on_hold", "past_due", "paused", "unpaid"].includes(normalizedStatus)
  ) {
    return "past_due";
  }
  if (normalizedStatus && normalizedStatus !== "active") return null;
  if (eventType === "subscription.updated" && cancelAtPeriodEnd) {
    return "cancel_at_period_end";
  }
  if (eventType === "subscription.renewed") return "renewed";
  if (normalizedStatus === "active" || eventType === "subscription.active") return "active";
  return null;
}

export function creemSubscriptionState({
  eventType,
  status,
  cancelAtPeriodEnd,
}: ProviderSubscriptionSnapshot): CommerceSubscriptionState | null {
  const normalizedStatus = String(status || "")
    .trim()
    .toLowerCase();
  if (eventType === "subscription.canceled" || normalizedStatus === "canceled") {
    return "revoked";
  }
  if (eventType === "subscription.expired" || normalizedStatus === "expired") {
    return "expired";
  }
  if (
    eventType === "subscription.past_due" ||
    eventType === "subscription.paused" ||
    ["past_due", "paused", "unpaid"].includes(normalizedStatus)
  ) {
    return "past_due";
  }
  if (
    eventType === "subscription.trialing" ||
    (normalizedStatus && normalizedStatus !== "active")
  ) {
    return null;
  }
  if (eventType === "subscription.scheduled_cancel" || cancelAtPeriodEnd) {
    return "cancel_at_period_end";
  }
  if (eventType === "subscription.paid") return "renewed";
  if (normalizedStatus === "active" || eventType === "subscription.active") return "active";
  return null;
}

function isoDate(value: unknown) {
  if (!value) return null;
  const date =
    value instanceof Date
      ? value
      : typeof value === "number"
        ? new Date(value)
        : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Bound a paid event to its own cycle instead of a provider subscription's
// mutable next billing date, which may already describe an unpaid later cycle.
export function commercePaidServicePeriod(input: {
  paidAt: unknown;
  interval: unknown;
  intervalCount?: unknown;
}): { start: string | null; end: string | null } {
  const invalid = { start: null, end: null };
  const interval = String(input.interval || "")
    .trim()
    .toLowerCase();
  const count = input.intervalCount === undefined ? 1 : Number(input.intervalCount);
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    !["day", "week", "month", "year"].includes(interval)
  ) {
    return invalid;
  }
  if (
    !(input.paidAt instanceof Date) &&
    typeof input.paidAt !== "number" &&
    typeof input.paidAt !== "string"
  ) {
    return invalid;
  }
  const paidDate = new Date(input.paidAt instanceof Date ? input.paidAt.getTime() : input.paidAt);
  if (!Number.isFinite(paidDate.getTime())) return invalid;
  const end = new Date(paidDate);
  if (interval === "day" || interval === "week") {
    end.setUTCDate(end.getUTCDate() + count * (interval === "week" ? 7 : 1));
  } else {
    const originalDay = end.getUTCDate();
    end.setUTCDate(1);
    if (interval === "month") end.setUTCMonth(end.getUTCMonth() + count);
    else end.setUTCFullYear(end.getUTCFullYear() + count);
    const lastDay = new Date(end);
    lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
    end.setUTCDate(Math.min(originalDay, lastDay.getUTCDate()));
  }
  if (!Number.isFinite(end.getTime())) return invalid;
  return { start: paidDate.toISOString(), end: end.toISOString() };
}

export async function applyCommerceSubscriptionLifecycle(input: {
  provider: string;
  providerAccountId?: string | null;
  providerSubscriptionId: string;
  state: CommerceSubscriptionState | null;
  providerEventId: string;
  currentPeriodStart?: unknown;
  currentPeriodEnd?: unknown;
  cancelAtPeriodEnd?: boolean;
  metadata?: Record<string, unknown>;
  graceDays?: number;
}) {
  if (!input.providerSubscriptionId || input.state === null) return null;
  const db = supabaseAdmin as any;
  const { data, error } = await db.rpc("apply_commerce_subscription_lifecycle_guarded", {
    p_provider: input.provider,
    p_provider_account_id: input.providerAccountId || "",
    p_provider_subscription_id: input.providerSubscriptionId,
    p_state: input.state,
    p_provider_event_id: input.providerEventId,
    p_current_period_start: isoDate(input.currentPeriodStart),
    p_current_period_end: isoDate(input.currentPeriodEnd),
    p_cancel_at_period_end: Boolean(input.cancelAtPeriodEnd),
    p_metadata: input.metadata || {},
    p_grace_days: input.graceDays ?? 3,
  });
  if (error) throw new Error(error.message);
  return data as {
    applied: boolean;
    reason?: string;
    subscription_access_id?: string;
    access_grant_id?: string | null;
    status?: CommerceSubscriptionState;
    access_deadline?: string | null;
  };
}

export async function expireCommerceSubscriptionAccess(now = new Date()) {
  const db = supabaseAdmin as any;
  const { data, error } = await db.rpc("expire_commerce_subscription_access", {
    p_now: now.toISOString(),
  });
  if (error) throw new Error(error.message);
  return Number(data || 0);
}
