/* eslint-disable @typescript-eslint/no-explicit-any -- Scheduler tables are typed after migrations deploy. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getInstagramConnectionReadiness } from "./instagram-auto-dm";
import { scheduledInstagramAutoDmSchema } from "./social-scheduler";

export async function activateScheduledInstagramAutoDm(target: any) {
  if (target.provider !== "instagram" || target.status !== "published" || !target.remote_post_id)
    return;
  const config = scheduledInstagramAutoDmSchema.safeParse(
    target.provider_settings?.scheduledAutoDm,
  );
  if (!config.success) return;
  const db = supabaseAdmin as any;
  const postId = String(target.post_id);
  const { data: existing, error: lookupError } = await db
    .from("instagram_dm_automations")
    .select("id")
    .eq("scheduled_post_id", postId)
    .eq("connection_id", target.connection_id)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) return; // Preserve edits or a pause made in the Auto DMs dashboard.

  const { data: connection, error: connectionError } = await db
    .from("social_connections")
    .select(
      "status,connection_health,reauth_required,scopes,webhook_fields,token_expires_at,last_verified_at",
    )
    .eq("id", target.connection_id)
    .eq("user_id", target.post?.user_id || target.user_id)
    .maybeSingle();
  if (connectionError) throw connectionError;
  if (!getInstagramConnectionReadiness(connection).ready) return;

  const { error } = await db.from("instagram_dm_automations").insert({
    user_id: target.post?.user_id || target.user_id,
    connection_id: target.connection_id,
    scheduled_post_id: postId,
    name: `Scheduled post ${new Date(target.published_at || Date.now()).toLocaleDateString("en-US", { timeZone: "UTC" })}`,
    trigger_type: config.data.triggerType,
    keywords: config.data.triggerType === "comment_keyword" ? [config.data.keyword] : [],
    match_type: "contains",
    media_scope: "specific",
    media_ids: [String(target.remote_post_id)],
    reply_message: config.data.replyMessage,
    opening_message: config.data.openingMessage,
    confirmation_button_label: "Send it",
    enabled: true,
  });
  if (error && error.code !== "23505") throw error;
}

export async function reconcileScheduledInstagramAutoDms() {
  const db = supabaseAdmin as any;
  const { data, error } = await db.rpc("pending_scheduled_instagram_auto_dms", { p_limit: 100 });
  if (error) throw error;
  for (const target of data || []) {
    if (target.provider_settings?.scheduledAutoDm) {
      try {
        await activateScheduledInstagramAutoDm(target);
      } catch (activationError) {
        console.error("[scheduled-auto-dm] activation retry failed", activationError);
      }
    }
  }
}
