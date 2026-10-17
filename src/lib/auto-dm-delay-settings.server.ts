import { enforceRequestRateLimit } from "./request-security.server";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { autoDmDelay, autoDmDelaySchema } from "./auto-dm-delay";
export async function readAutoDmDelay(userId: string) {
  await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "auto-dm-delay-read", userId);
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("auto_dm_delay_seconds" as never)
    .eq("id", userId)
    .single();
  if (error) throw new Error("Reply delay could not be loaded.");
  return {
    delaySeconds: autoDmDelay(
      (data as unknown as { auto_dm_delay_seconds: number }).auto_dm_delay_seconds,
    ),
  };
}
export async function writeAutoDmDelay(userId: string, input: unknown) {
  await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "auto-dm-delay-write", userId);
  const { delaySeconds } = z.object({ delaySeconds: autoDmDelaySchema }).strict().parse(input);
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ auto_dm_delay_seconds: delaySeconds } as never)
    .eq("id", userId)
    .select("id")
    .single();
  if (error) throw new Error("Reply delay could not be saved.");
  return { delaySeconds };
}
