import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { parsePublicHttpUrl } from "./safe-url";

export async function reserveRecoveryCheckout(workspaceId: string) {
  const { data, error } = await supabaseAdmin.rpc(
    "reserve_workspace_recovery_checkout" as never,
    { p_workspace_id: workspaceId } as never,
  );
  if (error)
    throw new Error(
      "Your previous checkout or workspace retention period needs verification. Contact your instance administrator before starting another subscription.",
    );
  if (!data) return null;
  const record = data as { id: string; url: string | null };
  if (record.url && !parsePublicHttpUrl(record.url, { requireHttps: true }))
    throw new Error("The saved recovery checkout could not be verified.");
  return record;
}
export async function saveRecoveryCheckout(id: string, sessionId: string, url: string) {
  const { error } = await (supabaseAdmin as any)
    .from("workspace_recovery_checkouts")
    .update({ session_id: sessionId, checkout_url: url })
    .eq("id", id);
  if (error)
    throw new Error(
      "Recovery checkout needs verification. Contact your instance administrator to resume it safely.",
    );
}
