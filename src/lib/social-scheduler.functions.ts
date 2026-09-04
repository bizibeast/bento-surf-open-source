/* eslint-disable @typescript-eslint/no-explicit-any -- Scheduler tables land with the paired migration. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enforceRequestRateLimit } from "./request-security.server";
import { configuredAppOrigin, configuredPublicOrigin } from "./application-urls";
import {
  PUBLIC_SOCIAL_PROVIDERS,
  deriveSocialPostStatus,
  isPublicSocialProvider,
  socialPostInputSchema,
  validatePostForProviders,
  type SchedulerConnection,
  type SchedulerMedia,
  type SchedulerPost,
  type SocialProvider,
  socialConnectionCanPublish,
  providerSettingsMedia,
  postingScheduleSchema,
  type PostingSchedule,
} from "./social-scheduler";
import {
  accessTokenForConnection,
  loadTikTokCreatorInfo,
  loadRedditCommunities,
  preflightRedditCommunity,
  type SocialPublishMessage,
} from "./social-publisher.server";
import {
  socialAccountProfiles,
  socialProviderReadiness,
  type GenericProvider,
} from "./social-oauth.functions";
import { fetchInstagramAccountProfile } from "./instagram-auto-dm.server";
import { durableSocialAvatarUrl } from "./social-avatar.server";
import { requirePlanEntitlement } from "./plan.server";
import { getPlan } from "./plan.server";
import { planHasEntitlement, type PlanId } from "./plans";

const requireScheduler = (userId: string) =>
  requirePlanEntitlement(
    userId,
    "postScheduler",
    "The post scheduler is included with the Creator plan. Upgrade to continue.",
  );

function connectionFromRow(row: any): SchedulerConnection {
  const canPublish = socialConnectionCanPublish(row.provider, row.scopes);
  return {
    id: row.id,
    provider: row.provider,
    handle: row.provider_handle,
    displayName: row.provider_display_name || row.provider_handle,
    avatarUrl: row.provider_avatar_url || null,
    status: row.status,
    connectedAt: row.created_at,
    canPublish,
    publishBlockReason: canPublish
      ? null
      : "Reconnect Instagram from the scheduler and approve publishing access.",
  };
}

type TargetInsight = {
  remotePostUrl: string | null;
  likes: number | null;
  comments: number | null;
};

function metric(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function postFromRow(row: any, insights: Map<string, TargetInsight>): SchedulerPost {
  return {
    id: row.id,
    body: row.body,
    title: row.title || null,
    scheduledAt: row.scheduled_at || null,
    timezone: row.timezone,
    status: row.status,
    media: Array.isArray(row.media) ? row.media : [],
    createdAt: row.created_at,
    targets: (row.targets || [])
      .filter((target: any) => isPublicSocialProvider(target.provider))
      .map((target: any) => {
        const insight = insights.get(`${target.connection_id}:${target.remote_post_id}`);
        return {
          id: target.id,
          connectionId: target.connection_id,
          provider: target.provider,
          status: target.status,
          remotePostUrl: target.remote_post_url || insight?.remotePostUrl || null,
          errorMessage: target.last_error_message || null,
          publishedAt: target.published_at || null,
          likes: insight?.likes ?? null,
          comments: insight?.comments ?? null,
          providerSettings:
            target.provider_settings && typeof target.provider_settings === "object"
              ? target.provider_settings
              : {},
        };
      }),
  };
}

export function mediaBelongsToCreator(media: SchedulerMedia, userId: string) {
  const prefix = `users/${userId}/`;
  if (!media.key.startsWith(prefix) || media.key.includes("..")) return false;
  try {
    const url = new URL(media.url);
    const expectedPath = `/cdn/${media.key
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/")}`;
    const configuredOrigins = new Set([
      configuredAppOrigin(process.env.VITE_APP_URL),
      configuredPublicOrigin(process.env.VITE_PUBLIC_URL),
    ]);
    return configuredOrigins.has(url.origin) && url.pathname === expectedPath;
  } catch {
    return false;
  }
}

async function schedulerData(userId: string, plan?: PlanId) {
  const db = supabaseAdmin as any;
  const [
    resolvedPlan,
    { data: connections, error: connectionError },
    { data: posts, error: postError },
    { data: postingSchedule, error: postingScheduleError },
    { data: profile, error: profileError },
    { data: insights, error: insightsError },
  ] = await Promise.all([
    plan ? Promise.resolve(plan) : getPlan(userId),
    db
      .from("social_connections")
      .select(
        "id, provider, provider_handle, provider_display_name, provider_avatar_url, status, scopes, created_at",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: true }),
    db
      .from("social_posts")
      .select(
        "*, targets:social_post_targets(id, connection_id, provider, status, remote_post_id, remote_post_url, last_error_message, published_at, provider_settings)",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(100),
    db
      .from("social_posting_schedules")
      .select("timezone,slots,natural_offset")
      .eq("user_id", userId)
      .maybeSingle(),
    db.from("profiles").select("account_timezone,analytics_timezone").eq("id", userId).single(),
    db
      .from("social_content_insights")
      .select("connection_id,remote_post_id,remote_post_url,likes,comments")
      .eq("user_id", userId)
      .limit(1_000),
  ]);
  if (connectionError || postError || postingScheduleError || profileError || insightsError)
    throw new Error("The social scheduler could not be loaded.");
  const insightsByTarget = new Map<string, TargetInsight>(
    (insights || []).map((insight: any) => [
      `${insight.connection_id}:${insight.remote_post_id}`,
      {
        remotePostUrl: insight.remote_post_url || null,
        likes: metric(insight.likes),
        comments: metric(insight.comments),
      },
    ]),
  );
  const defaultTimeZone =
    profile?.account_timezone || profile?.analytics_timezone || postingSchedule?.timezone || "UTC";
  const schedule: PostingSchedule = {
    timezone: defaultTimeZone,
    slots: Array.isArray(postingSchedule?.slots) ? postingSchedule.slots : [],
    naturalOffset: Boolean(postingSchedule?.natural_offset),
  };
  return {
    locked: false,
    plan: resolvedPlan,
    connections: (connections || [])
      .filter((row: any) => isPublicSocialProvider(row.provider))
      .map(connectionFromRow),
    posts: (posts || []).map((post: any) => postFromRow(post, insightsByTarget)),
    providers: PUBLIC_SOCIAL_PROVIDERS,
    readiness: socialProviderReadiness(),
    postingSchedule: postingScheduleSchema.safeParse(schedule).success
      ? schedule
      : { timezone: defaultTimeZone, slots: [], naturalOffset: false },
  };
}

export const getSocialScheduler = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const data = await schedulerData(context.userId);
    return planHasEntitlement(data.plan, "postScheduler") ? data : { ...data, locked: true };
  });

export const refreshSocialConnectionAvatar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "social-avatar-refresh",
      context.userId,
    );
    const db = supabaseAdmin as any;
    const { data: connection, error } = await db
      .from("social_connections")
      .select(
        "id,user_id,provider,provider_user_id,provider_avatar_url,access_token,refresh_token,token_expires_at,status",
      )
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .eq("status", "active")
      .maybeSingle();
    if (error || !connection || !isPublicSocialProvider(connection.provider)) {
      throw new Error("This connected account could not be refreshed.");
    }

    const token = await accessTokenForConnection(connection);
    const providerUrl =
      connection.provider === "instagram"
        ? (await fetchInstagramAccountProfile(token, connection.provider_user_id, 5_000))
            .profilePictureUrl
        : (
            await socialAccountProfiles(
              connection.provider as GenericProvider,
              token,
              connection.provider_user_id,
              5_000,
            )
          )[0]?.avatar;
    const avatarUrl = await durableSocialAvatarUrl({
      userId: context.userId,
      provider: connection.provider,
      providerUserId: connection.provider_user_id,
      value: typeof providerUrl === "string" ? providerUrl : connection.provider_avatar_url,
    });
    if (!avatarUrl) throw new Error("This connected account has no profile image.");
    const { error: updateError } = await db
      .from("social_connections")
      .update({ provider_avatar_url: avatarUrl })
      .eq("id", connection.id)
      .eq("user_id", context.userId);
    if (updateError) throw new Error("This connected account photo could not be saved.");
    return { id: connection.id, avatarUrl };
  });

export const savePostingSchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => postingScheduleSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireScheduler(context.userId);
    const { error } = await (supabaseAdmin as any).from("social_posting_schedules").upsert({
      user_id: context.userId,
      timezone: data.timezone,
      slots: data.slots,
      natural_offset: data.naturalOffset,
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(`Posting times could not be saved: ${error.message}`);
    return schedulerData(context.userId);
  });

export const getRedditCommunities = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ connectionId: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    await requireScheduler(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "reddit-community-list",
      context.userId,
    );
    const { data: connection, error } = await (supabaseAdmin as any)
      .from("social_connections")
      .select("*")
      .eq("id", data.connectionId)
      .eq("user_id", context.userId)
      .eq("provider", "reddit")
      .eq("status", "active")
      .maybeSingle();
    if (error || !connection) throw new Error("Reconnect Reddit before choosing a community.");
    return loadRedditCommunities(connection);
  });

export const getTikTokCreatorInfo = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ connectionIds: z.array(z.string().uuid()).min(1).max(2) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireScheduler(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "tiktok-creator-info",
      context.userId,
    );
    const { data: connections, error } = await (supabaseAdmin as any)
      .from("social_connections")
      .select("*")
      .eq("user_id", context.userId)
      .eq("provider", "tiktok")
      .eq("status", "active")
      .in("id", data.connectionIds);
    if (error || connections?.length !== new Set(data.connectionIds).size) {
      throw new Error("Reconnect TikTok before composing this post.");
    }
    return Promise.all(connections.map(loadTikTokCreatorInfo));
  });

export const saveSocialPost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => socialPostInputSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireScheduler(context.userId);
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "social-post-save", context.userId);
    const db = supabaseAdmin as any;
    const { data: connections, error: connectionError } = await db
      .from("social_connections")
      .select("id, provider, status, scopes")
      .eq("user_id", context.userId)
      .in("id", data.connectionIds);
    if (connectionError) throw new Error("Connected accounts could not be verified.");
    if ((connections || []).length !== new Set(data.connectionIds).size) {
      throw new Error("One or more selected accounts are unavailable.");
    }
    if (connections.some((connection: any) => connection.status !== "active")) {
      throw new Error("Reconnect expired accounts before scheduling.");
    }
    if (connections.some((connection: any) => !isPublicSocialProvider(connection.provider))) {
      throw new Error("One or more selected accounts are no longer supported.");
    }
    if (
      connections.some(
        (connection: any) => !socialConnectionCanPublish(connection.provider, connection.scopes),
      )
    ) {
      throw new Error(
        "Reconnect Instagram from the scheduler and approve publishing access before posting.",
      );
    }
    if (
      [...data.media, ...providerSettingsMedia(data.providerSettings)].some(
        (item) => !mediaBelongsToCreator(item, context.userId),
      )
    ) {
      throw new Error("Upload media through Bento before scheduling it.");
    }
    const providers = connections.map((connection: any) => connection.provider) as SocialProvider[];
    const providerErrors = validatePostForProviders(
      data.body,
      data.media as SchedulerMedia[],
      providers,
      data.title,
      data.providerSettings,
    );
    if (Object.keys(providerErrors).length) throw new Error(Object.values(providerErrors)[0]);

    const redditSettings = data.providerSettings.reddit || {};
    const redditConnections = connections.filter(
      (connection: any) => connection.provider === "reddit",
    );
    if (redditConnections.length) {
      const community = String(redditSettings.community || "");
      const kind = redditSettings.kind === "link" ? "link" : "self";
      await Promise.all(
        redditConnections.map(async (summaryConnection: any) => {
          const { data: fullConnection, error } = await db
            .from("social_connections")
            .select("*")
            .eq("id", summaryConnection.id)
            .eq("user_id", context.userId)
            .maybeSingle();
          if (error || !fullConnection) throw new Error("Reconnect Reddit before posting.");
          await preflightRedditCommunity(fullConnection, community, kind);
        }),
      );
    }

    const scheduledAt = data.asDraft
      ? null
      : data.publishNow
        ? new Date().toISOString()
        : data.scheduledAt;
    const { data: savedTargets, error: saveError } = await db.rpc("save_social_post_atomic", {
      p_user_id: context.userId,
      p_post_id: data.id || null,
      p_body: data.body,
      p_title: data.title || null,
      p_media: data.media,
      p_scheduled_at: scheduledAt,
      p_timezone: data.timezone,
      p_targets: connections.map((connection: any) => ({
        connectionId: connection.id,
        provider: connection.provider,
        providerSettings: data.providerSettings[connection.provider] || {},
      })),
      p_as_draft: Boolean(data.asDraft),
    });
    if (saveError || !savedTargets?.length) {
      throw new Error(saveError?.message || "The post could not be saved.");
    }

    if (data.publishNow && !data.asDraft) {
      const postId = savedTargets[0].saved_post_id as string;
      const { error: publishingStateError } = await db
        .from("social_posts")
        .update({ status: deriveSocialPostStatus(["pending"]) })
        .eq("id", postId)
        .eq("user_id", context.userId);
      if (publishingStateError) throw new Error("The publishing queue could not be updated.");

      const queue = globalThis.__env__?.SOCIAL_PUBLISH_QUEUE as
        Queue<SocialPublishMessage> | undefined;
      if (queue) {
        const targetIds = savedTargets.map((target: any) => target.target_id as string);
        const { error: queueStateError } = await db
          .from("social_post_targets")
          .update({
            status: "queued",
            lease_expires_at: new Date(Date.now() + 300_000).toISOString(),
          })
          .in("id", targetIds)
          .eq("status", "pending");
        if (!queueStateError) {
          try {
            await queue.sendBatch(
              savedTargets.map((target: any) => ({
                body: {
                  kind: "social_publish",
                  targetId: target.target_id,
                  idempotencyKey: target.idempotency_key,
                },
              })),
            );
          } catch {
            // The database remains the source of truth. Releasing the claim lets
            // the minute scheduler retry without waiting for the lease to expire.
            await db.rpc("release_social_target_claims", { p_target_ids: targetIds });
          }
        }
      }
    }
    return {
      ...(await schedulerData(context.userId)),
      queuedPostId: data.publishNow && !data.asDraft ? String(savedTargets[0].saved_post_id) : null,
    };
  });

export const rescheduleSocialPost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        id: z.string().uuid(),
        scheduledAt: z.string().datetime({ offset: true }),
        timezone: z.string().min(1).max(100).optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireScheduler(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "social-post-reschedule",
      context.userId,
    );
    if (new Date(data.scheduledAt).getTime() < Date.now() - 60_000) {
      throw new Error("Choose a future publish time.");
    }
    const db = supabaseAdmin as any;
    const { data: rescheduled, error } = await db.rpc("reschedule_social_post_atomic", {
      p_user_id: context.userId,
      p_post_id: data.id,
      p_scheduled_at: data.scheduledAt,
      p_timezone: data.timezone || null,
    });
    if (error || !rescheduled) {
      throw new Error(error?.message || "This post could not be rescheduled.");
    }
    return schedulerData(context.userId);
  });

export const duplicateSocialPost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    await requireScheduler(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "social-post-duplicate",
      context.userId,
    );
    const db = supabaseAdmin as any;
    const { data: duplicatedId, error } = await db.rpc("duplicate_social_post_atomic", {
      p_user_id: context.userId,
      p_post_id: data.id,
    });
    if (error || !duplicatedId) {
      throw new Error(error?.message || "The post could not be duplicated.");
    }
    return schedulerData(context.userId);
  });

export const cancelSocialPost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const db = supabaseAdmin as any;
    const { data: cancelled, error } = await db.rpc("cancel_social_post_atomic", {
      p_user_id: context.userId,
      p_post_id: data.id,
    });
    if (error || !cancelled) {
      throw new Error(error?.message || "This post can no longer be cancelled.");
    }
    return schedulerData(context.userId);
  });

export const deleteSocialPost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const db = supabaseAdmin as any;
    const { data: deleted, error } = await db
      .from("social_posts")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .in("status", ["draft", "cancelled", "failed"])
      .select("id")
      .maybeSingle();
    if (error || !deleted) throw new Error("The post could not be deleted.");
    return schedulerData(context.userId);
  });
