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
}: ProviderSubscriptionSnapshot): CommerceSubscriptionState {
  const normalizedStatus = String(status || "").toLowerCase();
  if (eventType === "subscription.revoked" || ["canceled", "unpaid"].includes(normalizedStatus)) {
    return "revoked";
  }
  if (eventType === "subscription.past_due" || normalizedStatus === "past_due") {
    return "past_due";
  }
  if (eventType === "subscription.canceled" || cancelAtPeriodEnd) {
    return "cancel_at_period_end";
  }
  return eventType === "subscription.updated" ? "renewed" : "active";
}

export function dodoSubscriptionState({
  eventType,
  status,
  cancelAtPeriodEnd,
}: ProviderSubscriptionSnapshot): CommerceSubscriptionState {
  const normalizedStatus = String(status || "").toLowerCase();
  if (eventType === "subscription.expired" || eventType === "subscription.cancelled") {
    return eventType === "subscription.expired" ? "expired" : "revoked";
  }
  if (
    eventType === "subscription.failed" ||
    eventType === "subscription.on_hold" ||
    ["failed", "on_hold"].includes(normalizedStatus)
  ) {
    return "past_due";
  }
  if (eventType === "subscription.updated" && cancelAtPeriodEnd) {
    return "cancel_at_period_end";
  }
  return eventType === "subscription.renewed" ? "renewed" : "active";
}

export function creemSubscriptionState({
  eventType,
  status,
  cancelAtPeriodEnd,
}: ProviderSubscriptionSnapshot): CommerceSubscriptionState {
  const normalizedStatus = String(status || "").toLowerCase();
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
  if (eventType === "subscription.scheduled_cancel" || cancelAtPeriodEnd) {
    return "cancel_at_period_end";
  }
  return eventType === "subscription.paid" ? "renewed" : "active";
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

export async function applyCommerceSubscriptionLifecycle(input: {
  provider: string;
  providerAccountId?: string | null;
  providerSubscriptionId: string;
  state: CommerceSubscriptionState;
  providerEventId: string;
  currentPeriodStart?: unknown;
  currentPeriodEnd?: unknown;
  cancelAtPeriodEnd?: boolean;
  metadata?: Record<string, unknown>;
  graceDays?: number;
}) {
  if (!input.providerSubscriptionId) return null;
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
