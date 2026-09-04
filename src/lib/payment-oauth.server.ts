/* eslint-disable @typescript-eslint/no-explicit-any -- Payment tables are introduced by the pending migration. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { CreatorPaymentProvider } from "./payment-providers";

function randomToken(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createPaymentOauthState(
  creatorId: string,
  provider: CreatorPaymentProvider,
  metadata: Record<string, unknown> = {},
) {
  const state = randomToken();
  const db = supabaseAdmin as any;
  await db
    .from("payment_oauth_states")
    .delete()
    .eq("creator_id", creatorId)
    .eq("provider", provider);
  const { error } = await db.from("payment_oauth_states").insert({
    creator_id: creatorId,
    provider,
    state_hash: await sha256(state),
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    metadata,
  });
  if (error) throw new Error(error.message);
  return state;
}

export async function consumePaymentOauthState(provider: CreatorPaymentProvider, state: string) {
  const db = supabaseAdmin as any;
  const { data, error } = await db
    .from("payment_oauth_states")
    .update({ used_at: new Date().toISOString() })
    .eq("provider", provider)
    .eq("state_hash", await sha256(state))
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("This payment connection link is invalid or has expired.");
  return data as {
    id: string;
    creator_id: string;
    provider: CreatorPaymentProvider;
    metadata: Record<string, unknown> | null;
  };
}
