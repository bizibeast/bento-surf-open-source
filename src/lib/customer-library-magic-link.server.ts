import { configuredAppOrigin } from "@/lib/application-urls";
/* eslint-disable @typescript-eslint/no-explicit-any -- Customer library tables are service-role only. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { commerceTokenHash, randomCommerceToken } from "./commerce-access.server";
import { normalizeEmailRecipient } from "./email-recipient";
import { sanitizeCustomerLibraryReturnTo } from "./safe-url";

const MAGIC_LINK_MINUTES = 15;

function appUrl() {
  return configuredAppOrigin(process.env.VITE_APP_URL);
}

export async function issueCustomerLibraryMagicLinkForEmail(input: {
  email: string;
  returnTo: string;
}): Promise<string | null> {
  const email = normalizeEmailRecipient(input.email);
  if (!email) return null;
  const db = supabaseAdmin as any;
  const { data: customer, error } = await db
    .from("commerce_customers")
    .select("id")
    .eq("email_normalized", email)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!customer) return null;

  const issuedAt = new Date().toISOString();
  const { error: invalidateError } = await db
    .from("commerce_customer_magic_links")
    .update({ used_at: issuedAt })
    .eq("customer_id", customer.id)
    .eq("purpose", "library_login")
    .is("used_at", null);
  if (invalidateError) throw new Error(invalidateError.message);

  const rawToken = randomCommerceToken();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_MINUTES * 60_000).toISOString();
  const { error: linkError } = await db.from("commerce_customer_magic_links").insert({
    customer_id: customer.id,
    token_hash: await commerceTokenHash(rawToken),
    purpose: "library_login",
    expires_at: expiresAt,
  });
  if (linkError) throw new Error(linkError.message);
  return `${appUrl()}/library/verify?token=${encodeURIComponent(rawToken)}&returnTo=${encodeURIComponent(
    sanitizeCustomerLibraryReturnTo(input.returnTo),
  )}`;
}
