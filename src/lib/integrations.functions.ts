/* eslint-disable @typescript-eslint/no-explicit-any -- Booking connection tables ship with their paired migration. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { googleCalendarReady } from "./booking-google.server";
import { fathomReady } from "./booking-fathom.server";
import { socialProviderReadiness } from "./social-oauth.functions";
import { isPublicSocialProvider, socialConnectionCanPublish } from "./social-scheduler";
import { FACEBOOK_AUTO_DM_REQUIRED_SCOPES } from "./facebook-auto-dm";
import { TWITTER_AUTO_DM_REQUIRED_SCOPES } from "./twitter-auto-dm";
import { telegramBotUsername, telegramReady } from "./telegram.server";
import { notionReady } from "./notion-content.server";
import { granolaReady } from "./granola-content.server";
import { githubReady } from "./github-content.server";
import { slackReady } from "./slack-content.server";

export const getIntegrationOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = supabaseAdmin as any;
    const [social, calendars, fathom, content] = await Promise.all([
      db
        .from("social_connections")
        .select(
          "id,provider,provider_handle,provider_display_name,provider_avatar_url,status,scopes,reauth_required",
        )
        .eq("user_id", context.userId)
        .order("created_at", { ascending: true }),
      db
        .from("booking_calendar_connections")
        .select("id,email,display_name,status,is_default")
        .eq("user_id", context.userId)
        .order("created_at", { ascending: true }),
      db
        .from("booking_fathom_connections")
        .select("id,email,display_name,status,is_default")
        .eq("user_id", context.userId)
        .order("created_at", { ascending: true }),
      db
        .from("content_connections")
        .select(
          "id,provider,external_account_id,display_name,status,scopes,selected_resources,metadata,last_attempt_at,last_success_at,last_error,created_at",
        )
        .eq("user_id", context.userId)
        .order("created_at", { ascending: true }),
    ]);

    if (social.error || calendars.error || fathom.error || content.error) {
      throw new Error("Your integration status could not be loaded.");
    }

    return {
      readiness: socialProviderReadiness(),
      bookingReadiness: { google: googleCalendarReady(), fathom: fathomReady() },
      contentReadiness: {
        telegram: telegramReady(),
        notion: notionReady(),
        granola: granolaReady(),
        github: githubReady(),
        slack: slackReady(),
      },
      contentProviderMetadata: { telegramUsername: telegramBotUsername() },
      socialConnections: (social.data || [])
        .filter((connection: any) => isPublicSocialProvider(connection.provider))
        .map((connection: any) => ({
          id: connection.id as string,
          provider: connection.provider as string,
          handle: connection.provider_handle as string,
          displayName: (connection.provider_display_name || connection.provider_handle) as string,
          avatarUrl: (connection.provider_avatar_url as string | null) || null,
          status: connection.status as string,
          scopes: (connection.scopes || []) as string[],
          canPublish: socialConnectionCanPublish(
            connection.provider,
            connection.scopes,
            connection.status,
            Boolean(connection.reauth_required),
          ),
          canAutomate:
            (connection.provider !== "twitter" ||
              TWITTER_AUTO_DM_REQUIRED_SCOPES.every((scope) =>
                (connection.scopes || []).includes(scope),
              )) &&
            (connection.provider !== "facebook" ||
              FACEBOOK_AUTO_DM_REQUIRED_SCOPES.every((scope) =>
                (connection.scopes || []).includes(scope),
              )),
        })),
      calendarConnections: (calendars.data || []).map(publicBookingConnection),
      fathomConnections: (fathom.data || []).map(publicBookingConnection),
      contentConnections: (content.data || []).map((row: any) => ({
        id: String(row.id),
        provider: String(row.provider),
        externalAccountId: String(row.external_account_id),
        displayName: (row.display_name as string | null) || null,
        status: String(row.status),
        scopes: (row.scopes || []) as string[],
        selectedResources: (row.selected_resources || {}) as Record<string, unknown>,
        metadata: (row.metadata || {}) as Record<string, unknown>,
        lastAttemptAt: (row.last_attempt_at as string | null) || null,
        lastSuccessAt: (row.last_success_at as string | null) || null,
        lastError: (row.last_error as string | null) || null,
        createdAt: String(row.created_at),
      })),
    };
  });

function publicBookingConnection(row: any) {
  return {
    id: row.id as string,
    email: (row.email as string | null) || null,
    displayName: (row.display_name as string | null) || null,
    status: row.status as string,
    isDefault: Boolean(row.is_default),
  };
}
