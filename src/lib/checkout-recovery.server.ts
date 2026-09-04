/* eslint-disable @typescript-eslint/no-explicit-any -- Commerce payment sessions are server-only. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export async function expireStaleCommerceCheckouts(now = new Date()) {
  const { data, error } = await (supabaseAdmin as any)
    .from("commerce_payment_sessions")
    .update({ status: "expired" })
    .eq("status", "pending")
    .lte("expires_at", now.toISOString())
    .select("id");
  if (error) throw new Error(`Stale checkouts could not be expired: ${error.message}`);
  return { expired: Array.isArray(data) ? data.length : 0 };
}
