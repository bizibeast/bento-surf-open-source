import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isSelfHostedEdition } from "./plan.server";
import { readBillingLifecycle } from "./billing-lifecycle";
import { enqueueWorkspaceLifecycleNotices } from "./billing-notices.server";
import { processWorkspaceRetention } from "./workspace-retention.server";

export async function processWorkspaceBillingLifecycle() {
  if (isSelfHostedEdition()) return { checked: 0, notices: 0, deleted: 0 };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Service-only lifecycle tables are migrated separately.
  const db = supabaseAdmin as any;
  const { refreshWorkspaceSubscription } = await import("@/integrations/dodo/webhook.server");
  const result = { checked: 0, notices: 0, deleted: 0 };
  const now = new Date().toISOString();
  // Due paid periods are refreshed even when a webhook is delayed or lost.
  for (let cursor: string | null = null; ;) {
    let query = db
      .from("subscriptions")
      .select("user_id,dodo_subscription_id")
      .in("status", ["active", "trialing", "past_due"])
      .lte("current_period_end", now)
      .order("user_id")
      .limit(100);
    if (cursor) query = query.gt("user_id", cursor);
    const { data: due, error } = await query;
    if (error) throw new Error("Due workspace subscriptions could not be loaded.");
    for (const row of due ?? []) {
      if (!row.dodo_subscription_id) continue;
      try {
        await refreshWorkspaceSubscription(row.user_id, row.dodo_subscription_id);
        result.checked++;
      } catch (error) {
        console.error("[billing-lifecycle] provider reconciliation deferred", {
          workspaceId: row.user_id,
          error,
        });
      }
    }
    if (!due || due.length < 100) break;
    cursor = due[due.length - 1].user_id;
  }
  // Keyset pagination keeps deletions/recovery from shifting the next page.
  for (let cursor: string | null = null; ;) {
    let query = db
      .from("profiles")
      .select("id,billing_lifecycle")
      .not("billing_lifecycle", "is", null)
      .order("id")
      .limit(100);
    if (cursor) query = query.gt("id", cursor);
    const { data: profiles, error: readError } = await query;
    if (readError) throw new Error("Workspace retention schedule could not be loaded.");
    for (const profile of profiles ?? []) {
      const lifecycle = readBillingLifecycle(profile.billing_lifecycle);
      if (
        !lifecycle ||
        lifecycle.reason === "paused" ||
        Date.parse(lifecycle.stoppedAt) > Date.now()
      )
        continue;
      try {
        result.notices += await enqueueWorkspaceLifecycleNotices(profile.id, lifecycle);
        if (await processWorkspaceRetention(profile.id)) result.deleted++;
      } catch (error) {
        console.error("[billing-lifecycle] workspace processing deferred", {
          workspaceId: profile.id,
          error,
        });
      }
    }
    if (!profiles || profiles.length < 100) break;
    cursor = profiles[profiles.length - 1].id;
  }
  return result;
}
