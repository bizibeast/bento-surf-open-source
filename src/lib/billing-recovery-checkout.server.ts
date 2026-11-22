import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { parsePublicHttpUrl } from "./safe-url";

export async function reserveRecoveryCheckout(workspaceId: string, productId: string) {
  const { data, error } = await supabaseAdmin.rpc("reserve_workspace_checkout_for_product", {
    p_workspace_id: workspaceId,
    p_product_id: productId,
  });
  if (error?.message === "A different recovery checkout is still within its payment window.")
    throw new Error(
      "Finish your previous checkout, or wait until it expires before choosing a different plan.",
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
  const { error } = await supabaseAdmin
    .from("workspace_recovery_checkouts")
    .update({ session_id: sessionId, checkout_url: url })
    .eq("id", id);
  if (error)
    throw new Error(
      "Recovery checkout needs verification. Contact your instance administrator to resume it safely.",
    );
}
