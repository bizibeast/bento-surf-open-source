import { highestPlan, normalizePlan, type PlanId } from "@/lib/plans";

export const ADMIN_ACCESS_ERROR = "Admin access required.";
export const ADMIN_DATA_ERROR = "Founder dashboard data could not be loaded. Please try again.";

const ACTIVE_BILLING_STATUSES = new Set(["active", "trialing", "past_due"]);

export type AdminSubscriptionRow = {
  user_id: string;
  plan_id: string;
  status: string;
  updated_at: string;
};

export type AdminSubscriptionSummary = {
  planId: PlanId | null;
  status: string | null;
};

export function isAdminAccessError(error: unknown) {
  return error instanceof Error && error.message === ADMIN_ACCESS_ERROR;
}

/**
 * A creator can have historical subscription rows from multiple providers.
 * Resolve all active rows deterministically instead of trusting whichever row
 * PostgREST happened to return last.
 */
export function summarizeAdminSubscriptions(rows: AdminSubscriptionRow[]) {
  const summaries = new Map<string, AdminSubscriptionSummary>();

  for (const row of [...rows].sort((a, b) => b.updated_at.localeCompare(a.updated_at))) {
    const existing = summaries.get(row.user_id);
    if (!ACTIVE_BILLING_STATUSES.has(row.status)) {
      if (!existing) summaries.set(row.user_id, { planId: null, status: row.status });
      continue;
    }

    const planId = normalizePlan(row.plan_id);
    if (!existing?.planId) {
      summaries.set(row.user_id, { planId, status: row.status });
      continue;
    }

    const effectivePlan = highestPlan(existing.planId, planId);
    if (effectivePlan !== existing.planId) {
      summaries.set(row.user_id, { planId: effectivePlan, status: row.status });
    }
  }

  return summaries;
}

/**
 * Operational messages can originate with payment providers. Redact common
 * credentials/contact data before returning a useful, bounded summary to the
 * browser.
 */
export function sanitizeAdminOperationalMessage(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;

  return value
    .replace(/\b(?:sk|pk|whsec|rk)_(?:live|test)_[A-Za-z0-9_-]+\b/gi, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, "Bearer [redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email redacted]")
    .replace(/https?:\/\/\S+/gi, "[url redacted]")
    .trim()
    .slice(0, 180);
}
