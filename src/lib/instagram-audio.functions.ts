import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  instagramAudioAuthorization,
  requireInstagramAudioDestination,
  searchInstagramAudio,
} from "./instagram-audio.server";
import { requirePlanEntitlement } from "./plan.server";
import { enforceRequestRateLimit } from "./request-security.server";

export const getInstagramAudioCatalog = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        connectionId: z.string().uuid(),
        type: z.enum(["music", "original_sound"]),
        query: z.string().trim().max(100),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await requirePlanEntitlement(
      context.userId,
      "postScheduler",
      "Upgrade to schedule Instagram Reels.",
    );
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "instagram-audio", context.userId);
    await requireInstagramAudioDestination(context.userId, data.connectionId);
    const authorization = await instagramAudioAuthorization(context.userId, data.connectionId);
    if (!authorization) return { connected: false as const, tracks: [] };
    return {
      connected: true as const,
      tracks: await searchInstagramAudio(authorization, data.type, data.query),
    };
  });
