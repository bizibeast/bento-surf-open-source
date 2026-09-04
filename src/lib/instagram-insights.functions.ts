/* eslint-disable @typescript-eslint/no-explicit-any -- social_connections gains generated types after migration sync. */
import { createServerFn } from "@tanstack/react-start";
import process from "node:process";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  buildInstagramInsightsUrl,
  instagramInsightsResponseSchema,
  normalizeInstagramInsights,
  type InstagramAccountInsights,
} from "./instagram-insights";
import { INSTAGRAM_INSIGHTS_SCOPE } from "./instagram-auto-dm";
import {
  decryptInstagramConnectionAccessToken,
  instagramMetaErrorNeedsReauth,
  MetaDeliveryError,
} from "./instagram-auto-dm.server";
import { requirePlanEntitlement } from "./plan.server";
import { enforceRequestRateLimit, readResponseText } from "./request-security.server";

const inputSchema = z.object({
  connectionId: z.string().uuid(),
  rangeDays: z.union([z.literal(7), z.literal(30)]).default(7),
});

type InsightConnection = {
  id: string;
  provider_handle: string;
  provider_user_id: string;
  access_token: string;
  scopes: string[] | null;
};

function graphVersion() {
  return process.env.META_GRAPH_API_VERSION?.trim() || "v25.0";
}

async function markConnectionForReconnect(userId: string, connectionId: string, error: unknown) {
  if (!instagramMetaErrorNeedsReauth(error)) return;
  await (supabaseAdmin as any)
    .from("social_connections")
    .update({
      connection_health: "action_required",
      reauth_required: true,
      last_health_check_at: new Date().toISOString(),
      provider_error_code: error instanceof MetaDeliveryError ? error.code : null,
      last_error: "Instagram permissions expired or were revoked.",
    })
    .eq("id", connectionId)
    .eq("user_id", userId)
    .eq("provider", "instagram");
}

export const getInstagramAccountInsights = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => inputSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requirePlanEntitlement(
      context.userId,
      "socialAnalytics",
      "Instagram Insights are included with the Creator plan. Upgrade to continue.",
    );
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "instagram-account-insights",
      context.userId,
    );

    const { data: rawConnection, error: connectionError } = await (supabaseAdmin as any)
      .from("social_connections")
      .select("id, provider_handle, provider_user_id, access_token, scopes")
      .eq("id", data.connectionId)
      .eq("user_id", context.userId)
      .eq("provider", "instagram")
      .eq("status", "active")
      .maybeSingle();
    if (connectionError || !rawConnection) throw new Error("Instagram connection not found.");
    const connection = rawConnection as InsightConnection;
    if (!connection.scopes?.includes(INSTAGRAM_INSIGHTS_SCOPE)) {
      throw new Error("Reconnect Instagram and approve Insights access to view analytics.");
    }

    try {
      const token = await decryptInstagramConnectionAccessToken(connection.access_token);
      const url = buildInstagramInsightsUrl({
        accountId: connection.provider_user_id,
        apiVersion: graphVersion(),
        rangeDays: data.rangeDays,
      });
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "bento.surf-instagram-insights",
        },
        signal: AbortSignal.timeout(15_000),
      });
      const raw = await readResponseText(response, 256 * 1024);
      const payload = instagramInsightsResponseSchema.parse(raw ? JSON.parse(raw) : {});
      if (!response.ok || payload.error) {
        const code = String(payload.error?.code || response.status || "meta_error");
        const error = new MetaDeliveryError(
          "Instagram could not load these insights.",
          code,
          response.status === 429 || response.status >= 500,
        );
        await markConnectionForReconnect(context.userId, connection.id, error);
        throw error;
      }
      return {
        connectionId: connection.id,
        handle: connection.provider_handle,
        rangeDays: data.rangeDays,
        metrics: normalizeInstagramInsights(payload),
        generatedAt: new Date().toISOString(),
        dataMayBeDelayed: true,
      } satisfies InstagramAccountInsights;
    } catch (error) {
      await markConnectionForReconnect(context.userId, connection.id, error);
      if (error instanceof MetaDeliveryError) {
        throw new Error(
          instagramMetaErrorNeedsReauth(error)
            ? "Reconnect Instagram to restore Insights access."
            : "Instagram Insights are temporarily unavailable. Try again shortly.",
        );
      }
      console.warn("Instagram Insights request failed", {
        connectionId: connection.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw new Error("Instagram Insights are temporarily unavailable. Try again shortly.");
    }
  });
