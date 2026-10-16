import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** Serialize provider reads, then fence their atomic writes against expired leases. */
export async function withWorkspaceBillingSync<T>(
  workspaceId: string,
  action: (lease: string) => Promise<T>,
): Promise<T> {
  const db = supabaseAdmin as any;
  const { data: lease, error } = await db.rpc("claim_workspace_billing_sync", {
    p_workspace_id: workspaceId,
  });
  if (error || typeof lease !== "string")
    throw new Error("Workspace billing is being updated. Please try again shortly.");
  try {
    return await action(lease);
  } finally {
    const { error: releaseError } = await db.rpc("release_workspace_billing_sync", {
      p_workspace_id: workspaceId,
      p_lease_key: lease,
    });
    if (releaseError)
      console.error("[billing] reconciliation lease release deferred", { workspaceId });
  }
}

export async function applyWorkspaceBillingSnapshot(
  workspaceId: string,
  lease: string,
  subscription: Record<string, unknown>,
  lifecycle: unknown,
) {
  const { error } = await (supabaseAdmin as any).rpc("apply_workspace_billing_snapshot", {
    p_workspace_id: workspaceId,
    p_lease_key: lease,
    p_subscription: subscription,
    p_lifecycle: lifecycle ?? null,
  });
  if (error) throw new Error("Workspace billing could not be synchronized. Please try again.");
}
