/* eslint-disable @typescript-eslint/no-explicit-any -- Cache table is created by the paired migration. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const RECONCILE_MS = 15 * 60 * 1000;

export async function cachedR2UserStorageBytes(
  bucket: R2Bucket,
  userId: string,
  scan: (bucket: R2Bucket, userId: string) => Promise<number>,
) {
  const db = supabaseAdmin as any;
  const { data, error } = await db
    .from("creator_r2_usage_cache")
    .select("used_bytes,reconciled_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error("Storage usage could not be checked.");
  if (data && Date.now() - Date.parse(data.reconciled_at) < RECONCILE_MS)
    return Number(data.used_bytes);
  const used = await scan(bucket, userId);
  const { error: saveError } = await db.from("creator_r2_usage_cache").upsert({
    user_id: userId,
    used_bytes: used,
    reconciled_at: new Date().toISOString(),
  });
  if (saveError) throw new Error("Storage usage could not be saved.");
  return used;
}

export async function adjustCachedR2UserStorageBytes(userId: string, delta: number) {
  const db = supabaseAdmin as any;
  const { error } = await db.rpc("adjust_creator_r2_usage", {
    p_user_id: userId,
    p_delta: delta,
  });
  if (error) {
    await db.from("creator_r2_usage_cache").delete().eq("user_id", userId);
    throw new Error("Storage usage could not be updated.");
  }
}
