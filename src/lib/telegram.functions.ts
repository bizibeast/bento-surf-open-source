/* eslint-disable @typescript-eslint/no-explicit-any -- New table ships with its paired migration. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireContentWorkspace } from "./content-access.server";
import { enforceRequestRateLimit } from "./request-security.server";
import { telegramDeepLink } from "./telegram.server";

const disconnectSchema = z.object({ id: z.string().uuid() });

export const beginTelegramConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId);
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "telegram-connect", context.userId);
    const db = supabaseAdmin as any;
    const now = new Date();
    await db
      .from("content_connection_states")
      .delete()
      .eq("user_id", context.userId)
      .eq("provider", "telegram")
      .lt("expires_at", now.toISOString());
    const state = crypto.randomUUID();
    const { error } = await db.from("content_connection_states").insert({
      state,
      user_id: context.userId,
      provider: "telegram",
      expires_at: new Date(now.getTime() + 10 * 60_000).toISOString(),
    });
    if (error) throw new Error("Telegram connection could not be started.");
    return { url: telegramDeepLink(state) };
  });

export const disconnectTelegramConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => disconnectSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const { data: deleted, error } = await (supabaseAdmin as any)
      .from("content_connections")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .eq("provider", "telegram")
      .select("id")
      .maybeSingle();
    if (error || !deleted) throw new Error("Telegram connection not found.");
    return { disconnected: true as const };
  });
