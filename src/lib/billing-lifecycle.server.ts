import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { readBillingLifecycle, type BillingLifecycle } from "./billing-lifecycle";
import type { PaidPlanId } from "./plans";

export async function syncWorkspaceBillingLifecycle(input: {
  workspaceId: string;
  subscriptionId: string;
  reason: BillingLifecycle["reason"] | null;
  plan: PaidPlanId;
  stoppedAt: string | null;
  lastPaidAt?: string | null;
}) {
  const { data, error } = await supabaseAdmin.rpc(
    "reconcile_workspace_billing_lifecycle" as never,
    {
      p_workspace_id: input.workspaceId,
      p_subscription_id: input.subscriptionId,
      p_reason: input.reason,
      p_plan: input.plan,
      p_stopped_at: input.stoppedAt,
      p_last_paid_at: input.lastPaidAt ?? null,
    } as never,
  );
  if (error) throw new Error("Workspace billing deadlines could not be saved.");
  if (data == null) return null;
  const lifecycle = readBillingLifecycle(data);
  if (!lifecycle) throw new Error("Workspace billing deadlines could not be verified.");
  return lifecycle;
}
