/* eslint-disable @typescript-eslint/no-explicit-any -- New columns are typed after migration deployment. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  getTwitterConnectionReadiness,
  twitterConnectionReadinessMessage,
  type TwitterDmTriggerType,
} from "./twitter-auto-dm";
import {
  getFacebookConnectionReadiness,
  facebookConnectionReadinessMessage,
} from "./facebook-auto-dm";
import { hasPlanEntitlement, requirePlanEntitlement } from "./plan.server";
import {
  scheduledPostAutoDmSchemas,
  type ScheduledPostAutoDmProvider,
} from "./scheduled-post-auto-dm";

export function scheduledPostAutoDmBlockReason(
  provider: ScheduledPostAutoDmProvider,
  connection: any,
  triggerType: TwitterDmTriggerType = "any_mention",
) {
  if (provider === "twitter") {
    const readiness = getTwitterConnectionReadiness(connection, new Date(), triggerType);
    return readiness.ready ? null : twitterConnectionReadinessMessage(readiness.issues);
  }
  const readiness = getFacebookConnectionReadiness(connection);
  return readiness.ready ? null : facebookConnectionReadinessMessage(readiness.issues);
}

export async function validateScheduledPostAutoDms(
  userId: string,
  settings: Record<string, Record<string, unknown>>,
  connections: any[],
) {
  for (const provider of ["twitter", "facebook"] as const) {
    if (settings[provider]?.scheduledAutoDm == null) continue;
    const network = provider === "twitter" ? "X" : "Facebook";
    const scheduledAutoDm = scheduledPostAutoDmSchemas[provider].parse(
      settings[provider].scheduledAutoDm,
    );
    const destinations = connections.filter((connection) => connection.provider === provider);
    if (!destinations.length) throw new Error(`Select a ${network} account for the Auto DM.`);
    for (const connection of destinations) {
      const reason = scheduledPostAutoDmBlockReason(
        provider,
        connection,
        scheduledAutoDm.triggerType as TwitterDmTriggerType,
      );
      if (reason) throw new Error(`${network} Auto DM: ${reason}`);
    }
    await requirePlanEntitlement(
      userId,
      provider === "twitter" ? "twitterAutoDM" : "facebookAutoDM",
      `${network} Auto DM is not available on this plan.`,
    );
    await requirePlanEntitlement(
      userId,
      "advancedAutoDM",
      "Scheduled Auto DMs are included with the Creator plan.",
    );
  }
}

export async function activateScheduledPostAutoDm(target: any) {
  if (
    !(["twitter", "facebook"] as string[]).includes(target.provider) ||
    target.status !== "published" ||
    !target.remote_post_id
  )
    return;
  const provider = target.provider as ScheduledPostAutoDmProvider;
  const config = scheduledPostAutoDmSchemas[provider].safeParse(
    target.provider_settings?.scheduledAutoDm,
  );
  if (!config.success) return;
  const owner = target.post?.user_id || target.user_id;
  if (
    !owner ||
    !(await hasPlanEntitlement(owner, "advancedAutoDM")) ||
    !(await hasPlanEntitlement(owner, provider === "twitter" ? "twitterAutoDM" : "facebookAutoDM"))
  )
    return;
  const table = `${provider}_dm_automations`;
  const db = supabaseAdmin as any;
  const { data: existing, error: lookupError } = await db
    .from(table)
    .select("id")
    .eq("scheduled_post_id", target.post_id)
    .eq("connection_id", target.connection_id)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) return; // Never overwrite a user edit or pause.
  const { data: connection, error: connectionError } = await db
    .from("social_connections")
    .select(
      "provider,status,connection_health,reauth_required,scopes,webhook_fields,token_expires_at,last_verified_at",
    )
    .eq("id", target.connection_id)
    .eq("user_id", owner)
    .maybeSingle();
  if (connectionError) throw connectionError;
  if (
    !connection ||
    connection.provider !== provider ||
    scheduledPostAutoDmBlockReason(provider, connection)
  )
    return;
  const common = {
    user_id: owner,
    connection_id: target.connection_id,
    scheduled_post_id: target.post_id,
    name: `Scheduled post ${new Date(target.published_at || Date.now()).toLocaleDateString("en-US", { timeZone: "UTC" })}`,
    trigger_type: config.data.triggerType,
    keywords: config.data.keywords,
    excluded_keywords: config.data.excludedKeywords,
    match_type: config.data.matchType,
    reply_message: config.data.replyMessage,
    enabled: true,
  };
  let row: Record<string, unknown>;
  if (provider === "twitter") row = { ...common, source_post_id: String(target.remote_post_id) };
  else {
    const facebook = scheduledPostAutoDmSchemas.facebook.parse(config.data);
    row = {
      ...common,
      media_scope: "specific",
      media_ids: [String(target.remote_post_id)],
      opening_message: facebook.openingMessage,
      confirmation_button_label: facebook.confirmationButtonLabel,
      public_reply_enabled: facebook.publicReplyEnabled,
      public_reply_message: facebook.publicReplyMessages[0] || null,
      public_reply_messages: facebook.publicReplyMessages,
      email_capture_enabled: facebook.emailCaptureEnabled,
      email_prompt_message: facebook.emailPromptMessage,
      email_marketing_consent_enabled: facebook.emailMarketingConsentEnabled,
      reply_button_label: facebook.replyButtonLabel,
      reply_button_url: facebook.replyButtonUrl,
    };
  }
  const { error } = await db.from(table).insert(row);
  if (error && error.code !== "23505") throw error; // Concurrent publish/reconcile attempts share a unique key.
}

export async function reconcileScheduledPostAutoDms() {
  const { data, error } = await (supabaseAdmin as any).rpc("pending_scheduled_post_auto_dms", {
    p_limit: 50,
  });
  if (error) throw error;
  for (const target of data || []) {
    try {
      await activateScheduledPostAutoDm(target);
    } catch (error) {
      console.error("[scheduled-post-auto-dm] activation retry failed", error);
    }
  }
}
