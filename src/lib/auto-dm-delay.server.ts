/* eslint-disable @typescript-eslint/no-explicit-any -- Existing database schema types. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { autoDmDelay } from "./auto-dm-delay";

/** Cloudflare's original queue timestamp survives retries. Never trust the webhook's date. */
export async function deferAutoDmDelivery(
  provider: "instagram" | "facebook" | "twitter",
  providerUserId: string,
  message: { timestamp: Date; retry: (options: { delaySeconds: number }) => void },
  now = Date.now(),
) {
  const queuedAt = new Date(message.timestamp).getTime();
  if (!Number.isFinite(queuedAt)) throw new Error("Auto DM queue timestamp is missing.");
  const elapsed = Math.max(0, (now - queuedAt) / 1000);
  if (elapsed >= 180) return false;
  const { data, error } = await (supabaseAdmin as any)
    .from("social_connections")
    .select("user_id")
    .eq("provider", provider)
    .eq("provider_user_id", providerUserId)
    .eq("status", "active")
    .limit(10);
  if (error) throw new Error("Auto DM delay could not be loaded.");
  const owners = [...new Set<string>((data || []).map((row: any) => String(row.user_id)))];
  const profiles = owners.length
    ? await (supabaseAdmin as any)
        .from("profiles")
        .select("auto_dm_delay_seconds")
        .in("id", owners)
        .limit(10)
    : { data: [], error: null };
  if (profiles.error) throw new Error("Auto DM delay could not be loaded.");
  // An account connected to more than one workspace uses the longest selected delay.
  const delay = profiles.data?.length
    ? Math.max(...profiles.data.map((row: any) => autoDmDelay(row.auto_dm_delay_seconds)))
    : 60;
  const remaining = Math.ceil(delay - elapsed);
  if (remaining <= 0) return false;
  message.retry({ delaySeconds: remaining });
  return true;
}
