/* eslint-disable @typescript-eslint/no-explicit-any -- Customer library tables are service-role only. */
import { getCookie } from "@tanstack/react-start/server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { commerceTokenHash, plausibleCommerceToken } from "./commerce-access.server";

export { sanitizeCustomerLibraryReturnTo } from "./safe-url";

export const CUSTOMER_SESSION_COOKIE = "__Host-bento_customer";
export const CUSTOMER_SESSION_DAYS = 30;

export async function currentCustomerSession() {
  const token = getCookie(CUSTOMER_SESSION_COOKIE);
  if (!plausibleCommerceToken(token)) return null;
  const db = supabaseAdmin as any;
  const now = new Date().toISOString();
  const { data: session, error } = await db
    .from("commerce_customer_sessions")
    .select("id, customer_id, expires_at, last_seen_at")
    .eq("token_hash", await commerceTokenHash(token!))
    .is("revoked_at", null)
    .gt("expires_at", now)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!session) return null;
  const { data: customer, error: customerError } = await db
    .from("commerce_customers")
    .select("id, email, email_normalized, name")
    .eq("id", session.customer_id)
    .single();
  if (customerError || !customer) throw new Error(customerError?.message || "Customer not found.");
  if (Date.now() - new Date(session.last_seen_at).getTime() > 5 * 60_000) {
    await db.from("commerce_customer_sessions").update({ last_seen_at: now }).eq("id", session.id);
  }
  return { session, customer, rawToken: token! };
}
