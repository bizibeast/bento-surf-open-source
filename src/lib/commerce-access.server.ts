/* eslint-disable @typescript-eslint/no-explicit-any -- Commerce access tables are managed by additive migrations and queried through the service-role client. */
import { isWorkspacePublicBillingAvailable } from "./billing-public.server";

export function randomCommerceToken(bytes = 32) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function commerceTokenHash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function plausibleCommerceToken(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{20,200}$/.test(value);
}

export async function resolveCommerceGrantByToken(client: any, token: string, select = "*") {
  if (!plausibleCommerceToken(token)) return null;
  // Authorization fields are mandatory even when a caller requests a small projection.
  const fields = select.split(",").map((field) => field.trim());
  if (!fields.includes("*")) {
    for (const field of ["creator_id", "expires_at"])
      if (!fields.includes(field)) select += `,${field}`;
  }
  const hash = await commerceTokenHash(token);
  const now = new Date().toISOString();
  const { data: permanent, error: permanentError } = await client
    .from("commerce_access_grants")
    .select(select)
    .eq("token_hash", hash)
    .eq("status", "active")
    .maybeSingle();
  if (permanentError) throw new Error(permanentError.message);
  if (
    permanent &&
    (!permanent.expires_at || new Date(permanent.expires_at).getTime() > Date.now())
  ) {
    return permanent.creator_id && (await isWorkspacePublicBillingAvailable(permanent.creator_id))
      ? permanent
      : null;
  }

  const { data: capability, error: capabilityError } = await client
    .from("commerce_customer_access_tokens")
    .select("grant_id")
    .eq("token_hash", hash)
    .gt("expires_at", now)
    .maybeSingle();
  if (capabilityError) throw new Error(capabilityError.message);
  if (!capability) return null;

  const { data: grant, error: grantError } = await client
    .from("commerce_access_grants")
    .select(select)
    .eq("id", capability.grant_id)
    .eq("status", "active")
    .maybeSingle();
  if (grantError) throw new Error(grantError.message);
  if (!grant || (grant.expires_at && new Date(grant.expires_at).getTime() <= Date.now())) {
    return null;
  }
  return grant.creator_id && (await isWorkspacePublicBillingAvailable(grant.creator_id))
    ? grant
    : null;
}
