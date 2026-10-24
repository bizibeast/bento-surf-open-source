import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { lifecycleEndedTrial, type BillingLifecycle } from "./billing-lifecycle";

/** Whether this workspace's current stop came from cancelling its trial. */
export async function readLifecycleEndedTrial(
  workspaceId: string,
  lifecycle: BillingLifecycle | null,
): Promise<boolean> {
  if (!lifecycle || lifecycle.reason !== "canceled") return false;
  // The generated types do not include this service-only table yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("bento_trial_owners")
    .select("subscription_id,trial_ends_at,extension_approved_until")
    .eq("workspace_id", workspaceId)
    .eq("subscription_id", lifecycle.subscriptionId)
    .maybeSingle();
  if (error) throw new Error("Your trial details could not be loaded.");
  return lifecycleEndedTrial(lifecycle, data);
}
