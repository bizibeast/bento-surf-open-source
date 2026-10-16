import { searchStockPhotos, importStockPhoto, type StockProvider } from "./scheduler-stock.server";
import { resolveOwnedAgentMedia } from "./content-agent-media.server";
import { scheduledPostAutoDmSchemas } from "./scheduled-post-auto-dm";
/* eslint-disable @typescript-eslint/no-explicit-any -- MCP spans service-role tables generated after migrations deploy. */
import { createClient } from "@supabase/supabase-js";
import { createMcpHandler, McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod-v4";
import {
  beginMcpMediaUpload,
  beginMediaUploadSchema,
  mcpMediaOrigin,
} from "./mcp-media-upload.server";
import type { Database } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  INSTAGRAM_TRIAL_GRADUATION_STRATEGIES,
  isPublicSocialProvider,
  postingScheduleSchema,
  scheduledInstagramAutoDmSchema,
  socialConnectionCanPublish,
  socialPostInputSchema,
} from "./social-scheduler";
import { saveSocialPostForUser as saveSchedulerPostForUser } from "./social-scheduler.functions";
import {
  enforceRequestRateLimit,
  readResponseBytes,
  RequestHttpError,
} from "./request-security.server";
import { fetchPublicFollowingSafeRedirects } from "./link-metadata.functions";
import { parsePublicHttpUrl } from "./safe-url";
import {
  handleR2StorageRequest,
  sanitizeFileExtension,
  type UploadKind,
} from "./r2-storage.server";
import { getPlan, requirePlanEntitlement } from "./plan.server";
import { planHasEntitlement, planName, usesAdvancedAutoDm } from "./plans";
import {
  getInstagramConnectionReadiness,
  instagramDmAutomationInputSchema,
} from "./instagram-auto-dm";
import {
  facebookDmAutomationInputSchema,
  getFacebookConnectionReadiness,
} from "./facebook-auto-dm";
import { getTwitterConnectionReadiness, twitterDmAutomationInputSchema } from "./twitter-auto-dm";
import {
  loadPriorityDmInboxForCreator,
  type PriorityDmConversationSummary,
} from "./priority-dm.server";
import {
  sendCreatorPriorityDmMessageForUser,
  setPriorityDmConversationClosedForUser,
} from "./priority-dm.functions";
import bentoSkill from "../../skills/bento/SKILL.md?raw";
import bentoToolsReference from "../../skills/bento/references/tools.md?raw";
import {
  getCalendarWorkspace,
  getCommunityWorkspace,
  getEarnWorkspace,
  getAnalyticsWorkspace,
  getIntegrationWorkspace,
  getProfileWorkspace,
  getStoreWorkspace,
  mutateAudience,
  mutateBlock,
  mutateCalendar,
  mutateCommunity,
  mutateDiscount,
  mutateEarn,
  mutateOrderBump,
  mutatePage,
  mutateProduct,
  updateCreatorProfile,
  type CreatorMcpContext,
} from "./mcp.creator-ops.server";
import {
  agentMutationSchema,
  brainMutationSchema,
  discoverMutationSchema,
  getMcpContentAgent,
  getMcpContentBrain,
  getMcpContentDiscover,
  getMcpContentMedia,
  getMcpContentRoutines,
  manageMcpContentAgent,
  manageMcpContentBrain,
  manageMcpContentDiscover,
  manageMcpContentMedia,
  manageMcpContentRoutine,
  mediaMutationSchema,
  routineMutationSchema,
} from "./mcp.content-ops.server";

const MCP_PATH = "/mcp";
// ChatGPT's app dashboard scans this endpoint from the browser. Other origins
// stay rejected so a DNS-rebinding page cannot call the MCP server.
const MCP_BROWSER_ORIGINS = new Set([
  "https://chatgpt.com",
  "https://chat.openai.com",
  "https://platform.openai.com",
]);
const MCP_CORS_ALLOW_METHODS = "POST, GET, DELETE, OPTIONS";
const MCP_CORS_ALLOW_HEADERS =
  "authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id";
const MCP_CORS_EXPOSE_HEADERS = "mcp-session-id, www-authenticate";
const SKILL_URI = "skill://bento/bento/SKILL.md";
const SKILL_TOOLS_URI = "skill://bento/bento/references/tools.md";
const SKILL_DESCRIPTION =
  "Operate a creator's Bento workspace through MCP, including Content Brain, Media, Routines, Agent, Discover, pages, Store, Calendar, communities, social publishing, and Auto-DMs.";
const MAX_MCP_MEDIA_BYTES = 25 * 1024 * 1024;
const OAUTH_SCOPES = ["openid", "email", "profile"];
const AUTO_DM = {
  instagram: {
    table: "instagram_dm_automations",
    entitlement: "instagramAutoDM",
    schema: instagramDmAutomationInputSchema,
  },
  facebook: {
    table: "facebook_dm_automations",
    entitlement: "facebookAutoDM",
    schema: facebookDmAutomationInputSchema,
  },
  twitter: {
    table: "twitter_dm_automations",
    entitlement: "twitterAutoDM",
    schema: twitterDmAutomationInputSchema,
  },
} as const;

type AutoDmPlatform = keyof typeof AUTO_DM;

function db() {
  return supabaseAdmin as any;
}

function textResult(message: string, data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: data,
  };
}

function userIdFrom(authInfo: AuthInfo) {
  const userId = authInfo.extra?.userId;
  if (typeof userId !== "string") throw new Error("Bento account authorization is missing.");
  return userId;
}

function featureLinks(origin: string) {
  return {
    dashboard: `${origin}/link`,
    pages: `${origin}/link`,
    products: `${origin}/store`,
    priorityDm: `${origin}/priority-dm`,
    emailMarketing: `${origin}/email-marketing`,
    scheduler: `${origin}/post-scheduler`,
    automations: `${origin}/auto-dms`,
    analytics: `${origin}/analytics`,
    socialInsights: `${origin}/social-insights`,
    bookings: `${origin}/calendar`,
    community: `${origin}/community`,
    settings: `${origin}/settings`,
    mcp: `${origin}/mcp`,
    content: `${origin}/content`,
  };
}

async function getBentoOverview(userId: string, origin: string) {
  const client = db();
  const [
    plan,
    profile,
    pages,
    products,
    posts,
    bookings,
    connections,
    instagram,
    facebook,
    twitter,
  ] = await Promise.all([
    getPlan(userId),
    client
      .from("profiles")
      .select("id,username,display_name,bio,onboarded,account_timezone")
      .eq("id", userId)
      .single(),
    client.from("pages").select("id", { count: "exact", head: true }).eq("user_id", userId),
    client
      .from("commerce_products")
      .select("id", { count: "exact", head: true })
      .eq("creator_id", userId),
    client.from("social_posts").select("id", { count: "exact", head: true }).eq("user_id", userId),
    client
      .from("commerce_bookings")
      .select("id", { count: "exact", head: true })
      .eq("creator_id", userId),
    client
      .from("social_connections")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId),
    client
      .from("instagram_dm_automations")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId),
    client
      .from("facebook_dm_automations")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId),
    client
      .from("twitter_dm_automations")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId),
  ]);
  if (profile.error) throw new Error("Bento profile could not be loaded.");
  return {
    profile: profile.data,
    plan: { id: plan, name: planName(plan) },
    counts: {
      pages: pages.count || 0,
      products: products.count || 0,
      socialPosts: posts.count || 0,
      bookings: bookings.count || 0,
      socialConnections: connections.count || 0,
      autoDmAutomations: (instagram.count || 0) + (facebook.count || 0) + (twitter.count || 0),
    },
    features: featureLinks(origin),
  };
}

function autoDmReadiness(platform: AutoDmPlatform, connection: any) {
  if (platform === "instagram") return getInstagramConnectionReadiness(connection);
  if (platform === "facebook") return getFacebookConnectionReadiness(connection);
  return getTwitterConnectionReadiness(connection);
}

async function listSocialAccounts(userId: string, provider?: string) {
  let query = db()
    .from("social_connections")
    .select(
      "id,provider,provider_handle,provider_display_name,provider_avatar_url,status,scopes,connection_health,webhook_fields,last_verified_at,last_error,reauth_required,token_expires_at,created_at",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (provider) query = query.eq("provider", provider);
  const { data, error } = await query;
  if (error) throw new Error("Connected social accounts could not be loaded.");
  return (data || []).map((connection: any) => {
    const autoDm = ["instagram", "facebook", "twitter"].includes(connection.provider)
      ? autoDmReadiness(connection.provider as AutoDmPlatform, connection)
      : null;
    return {
      id: connection.id,
      provider: connection.provider,
      handle: connection.provider_handle,
      displayName: connection.provider_display_name || connection.provider_handle,
      avatarUrl: connection.provider_avatar_url,
      status: connection.status,
      canPublish:
        isPublicSocialProvider(connection.provider) &&
        socialConnectionCanPublish(
          connection.provider,
          connection.scopes,
          connection.status,
          Boolean(connection.reauth_required),
        ),
      autoDmReady: autoDm?.ready ?? false,
      autoDmIssues: autoDm?.issues || [],
      needsReconnect: Boolean(connection.reauth_required || autoDm?.needsReconnect),
      lastVerifiedAt: connection.last_verified_at,
      lastError: connection.last_error,
      connectedAt: connection.created_at,
    };
  });
}

async function listSocialPosts(userId: string, status: string | undefined, limit: number) {
  let query = db()
    .from("social_posts")
    .select(
      "id,body,title,media,scheduled_at,timezone,status,created_at,targets:social_post_targets(id,connection_id,provider,status,remote_post_url,last_error_message,published_at,provider_settings)",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw new Error("Social posts could not be loaded.");
  return data || [];
}

async function saveSocialPostForUser(userId: string, input: unknown) {
  const data = socialPostInputSchema.parse(input);
  const result = await saveSchedulerPostForUser(userId, data);
  return (
    result.posts.find((post: { id: string }) => post.id === result.savedPostId) || {
      id: result.savedPostId,
    }
  );
}

async function listAutoDmAutomations(userId: string, platform?: AutoDmPlatform) {
  const platforms = platform ? [platform] : (Object.keys(AUTO_DM) as AutoDmPlatform[]);
  const results = await Promise.all(
    platforms.map(async (name) => {
      const config = AUTO_DM[name];
      const [{ data: automations, error }, connections] = await Promise.all([
        db()
          .from(config.table)
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false }),
        listSocialAccounts(userId, name),
      ]);
      if (error) throw new Error(`${name} automations could not be loaded.`);
      return { platform: name, connections, automations: automations || [] };
    }),
  );
  return results;
}

async function saveAutoDmAutomation(userId: string, platform: AutoDmPlatform, input: unknown) {
  const config = AUTO_DM[platform];
  let candidate = input;
  if (input && typeof input === "object" && !Array.isArray(input) && Object.hasOwn(input, "id")) {
    const supplied = input as Record<string, unknown>;
    const id = z.string().uuid().parse(supplied.id);
    const { data: current, error } = await db()
      .from(config.table)
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !current) throw new Error(`The ${platform} automation could not be loaded.`);

    candidate = {
      connectionId: current.connection_id,
      name: current.name,
      triggerType: current.trigger_type,
      keywords: current.keywords,
      excludedKeywords: current.excluded_keywords,
      matchType: current.match_type,
      replyMessage: current.reply_message,
      enabled: current.enabled,
      ...(platform === "twitter"
        ? {}
        : {
            mediaScope: current.media_scope,
            mediaIds: current.media_ids,
            publicReplyEnabled: current.public_reply_enabled,
            publicReplyMessages:
              current.public_reply_messages ??
              (current.public_reply_message ? [current.public_reply_message] : []),
            openingMessage: current.opening_message,
            confirmationButtonLabel: current.confirmation_button_label,
            emailCaptureEnabled: current.email_capture_enabled,
            emailPromptMessage: current.email_prompt_message,
            emailMarketingConsentEnabled: current.email_marketing_consent_enabled,
            replyButtonLabel: current.reply_button_label,
            replyButtonUrl: current.reply_button_url,
          }),
      ...(platform === "instagram"
        ? {
            followGateEnabled: current.follow_gate_enabled,
            followPromptMessage: current.follow_prompt_message,
            followMaxRechecks: current.follow_max_rechecks,
            followFailAction: current.follow_fail_action,
          }
        : {}),
      ...supplied,
      id,
    };
  }
  const data = config.schema.parse(candidate) as any;
  const plan = await requirePlanEntitlement(
    userId,
    config.entitlement,
    `${platform} Auto-DMs are not available on this plan.`,
  );
  if (usesAdvancedAutoDm(data) && !planHasEntitlement(plan, "advancedAutoDM")) {
    throw new Error("Advanced Auto-DMs require the Store plan.");
  }
  await enforceRequestRateLimit(
    "EXPENSIVE_API_RATE_LIMITER",
    `mcp-${platform}-auto-dm-save`,
    userId,
  );
  const { data: connection, error: connectionError } = await db()
    .from("social_connections")
    .select("*")
    .eq("id", data.connectionId)
    .eq("user_id", userId)
    .eq("provider", platform)
    .maybeSingle();
  if (connectionError || !connection) throw new Error(`Connect this ${platform} account first.`);
  if (data.enabled && !autoDmReadiness(platform, connection).ready) {
    throw new Error(`Reconnect and verify ${platform} before enabling this automation.`);
  }

  const common = {
    user_id: userId,
    connection_id: data.connectionId,
    name: data.name,
    trigger_type: data.triggerType,
    keywords: data.keywords,
    excluded_keywords: data.excludedKeywords,
    match_type: data.matchType,
    reply_message: data.replyMessage,
    enabled: data.enabled,
  };
  const row =
    platform === "twitter"
      ? common
      : {
          ...common,
          media_scope: data.mediaScope,
          media_ids: data.mediaIds,
          public_reply_enabled: data.publicReplyEnabled,
          public_reply_message: data.publicReplyMessages[0] || null,
          public_reply_messages: data.publicReplyMessages,
          opening_message: data.openingMessage,
          confirmation_button_label: data.confirmationButtonLabel,
          email_capture_enabled: data.emailCaptureEnabled,
          email_prompt_message: data.emailPromptMessage,
          email_marketing_consent_enabled: data.emailMarketingConsentEnabled,
          ...(platform === "instagram"
            ? {
                follow_gate_enabled: data.followGateEnabled,
                follow_prompt_message: data.followPromptMessage,
                follow_max_rechecks: data.followMaxRechecks,
                follow_fail_action: data.followFailAction,
              }
            : {}),
          reply_button_label: data.replyButtonLabel,
          reply_button_url: data.replyButtonUrl,
        };
  const query = data.id
    ? db()
        .from(config.table)
        .update(row)
        .eq("id", data.id)
        .eq("user_id", userId)
        .select("*")
        .maybeSingle()
    : db().from(config.table).insert(row).select("*").single();
  const { data: automation, error } = await query;
  if (error || !automation) throw new Error(`The ${platform} automation could not be saved.`);
  return automation;
}

async function setAutoDmEnabled(
  userId: string,
  platform: AutoDmPlatform,
  id: string,
  enabled: boolean,
) {
  const config = AUTO_DM[platform];
  if (enabled) {
    await requirePlanEntitlement(
      userId,
      config.entitlement,
      `${platform} Auto-DMs are unavailable.`,
    );
    const { data: automation } = await db()
      .from(config.table)
      .select("connection_id")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!automation) throw new Error("Automation not found.");
    const { data: connection } = await db()
      .from("social_connections")
      .select("*")
      .eq("id", automation.connection_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!connection || !autoDmReadiness(platform, connection).ready) {
      throw new Error(`Reconnect and verify ${platform} before enabling this automation.`);
    }
  }
  const { data, error } = await db()
    .from(config.table)
    .update({ enabled })
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();
  if (error || !data) throw new Error("Automation not found.");
  return data;
}

async function deleteAutoDmAutomation(userId: string, platform: AutoDmPlatform, id: string) {
  const { data, error } = await db()
    .from(AUTO_DM[platform].table)
    .delete()
    .eq("id", id)
    .eq("user_id", userId)
    .select("id")
    .maybeSingle();
  if (error || !data) throw new Error("Automation not found.");
  return { id, deleted: true };
}

async function listPages(userId: string) {
  const [{ data: pages, error: pageError }, { data: blocks, error: blockError }] =
    await Promise.all([
      db()
        .from("pages")
        .select("id,name,slug,created_at")
        .eq("user_id", userId)
        .order("created_at"),
      db()
        .from("blocks")
        .select("id,page_id,type,content,cover_url,x,y,w,h,position")
        .eq("user_id", userId)
        .order("position")
        .limit(300),
    ]);
  if (pageError || blockError) throw new Error("Bento pages could not be loaded.");
  return { pages: pages || [], blocks: blocks || [] };
}

async function listProducts(userId: string, limit: number) {
  const { data, error } = await db()
    .from("commerce_products")
    .select(
      "id,slug,title,subtitle,kind,status,pricing_type,price_amount,currency,billing_interval,cover_url,sales_count,inventory_limit,created_at,published_at",
    )
    .eq("creator_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("Bento products could not be loaded.");
  return data || [];
}

async function listBookings(userId: string, limit: number) {
  const { data, error } = await db()
    .from("commerce_bookings")
    .select(
      "id,product_id,buyer_name,buyer_email,status,starts_at,ends_at,timezone,meeting_url,created_at",
    )
    .eq("creator_id", userId)
    .order("starts_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("Bookings could not be loaded.");
  return data || [];
}

function decodeBase64(value: string) {
  const normalized = value.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
  if (normalized.length > Math.ceil((MAX_MCP_MEDIA_BYTES * 4) / 3) + 4) {
    throw new Error(
      "Inline base64 is limited to 25 MB. Call begin_media_upload and upload the original file in binary chunks; do not compress it to fit MCP JSON.",
    );
  }
  let binary: string;
  try {
    binary = atob(normalized);
  } catch {
    throw new Error("Media base64 is invalid.");
  }
  // Uint8Array.from(string, callback) first materializes the iterable into a
  // huge intermediate array. A 21 MB video can exhaust the Worker's memory.
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  if (!bytes.length || bytes.length > MAX_MCP_MEDIA_BYTES) {
    throw new Error("Media must be between 1 byte and 25 MB.");
  }
  return bytes;
}

const extensionByMimeType: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "application/pdf": "pdf",
};

async function uploadMedia(
  authInfo: AuthInfo,
  origin: string,
  input: {
    sourceUrl?: string;
    base64?: string;
    fileName: string;
    mimeType: string;
    kind: UploadKind;
  },
) {
  if (Boolean(input.sourceUrl) === Boolean(input.base64))
    throw new Error("Provide exactly one of sourceUrl or base64.");
  origin = mcpMediaOrigin(origin);
  let body: BodyInit;
  let size: number;
  if (input.sourceUrl) {
    const url = parsePublicHttpUrl(input.sourceUrl, { allowNonStandardPort: false });
    if (!url) throw new Error("Use a public HTTP or HTTPS media URL.");
    const { response } = await fetchPublicFollowingSafeRedirects(
      url,
      fetch,
      {
        Accept: input.mimeType,
        "User-Agent": "Bento-MCP/1.0 (+http://localhost:8080)",
      },
      120_000,
    );
    if (!response.ok) throw new Error("Bento could not download media from that URL.");
    const declaredSize = Number(response.headers.get("content-length"));
    if (
      Number.isSafeInteger(declaredSize) &&
      declaredSize > 0 &&
      response.body &&
      !response.headers.get("content-encoding")
    ) {
      // Stream large URL imports through the normal plan/quota/signature checks.
      body = response.body;
      size = declaredSize;
    } else {
      try {
        const bytes = await readResponseBytes(response, MAX_MCP_MEDIA_BYTES);
        body = new Blob([bytes as Uint8Array<ArrayBuffer>]);
        size = bytes.byteLength;
      } catch {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(
          "This media URL does not provide a usable file size. Download the original file and use begin_media_upload for chunked upload.",
        );
      }
    }
  } else if (input.base64) {
    const bytes = decodeBase64(input.base64);
    body = new Blob([bytes as Uint8Array<ArrayBuffer>]);
    size = bytes.byteLength;
  } else {
    throw new Error("Provide sourceUrl or base64 media.");
  }
  const extension =
    sanitizeFileExtension(input.fileName.split(".").pop() || "") ||
    extensionByMimeType[input.mimeType.toLowerCase()];
  if (!extension) throw new Error("The media filename needs a supported extension.");
  const request = new Request(`${origin}/api/storage/upload`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${authInfo.token}`,
      "Content-Type": input.mimeType,
      "Content-Length": String(size),
      "X-Bento-File-Extension": extension,
      "X-Bento-File-Size": String(size),
      "X-Bento-File-Name": encodeURIComponent(input.fileName),
      "X-Bento-Upload-Kind": input.kind,
    },
    body,
    ...{ duplex: "half" },
  });
  const env = globalThis.__env__;
  if (!env?.MEDIA_BUCKET) throw new Error("Bento media storage is unavailable.");
  const response = await handleR2StorageRequest(
    request,
    env,
    { waitUntil: () => undefined },
    { authenticate: async () => userIdFrom(authInfo) },
  );
  if (!response?.ok) {
    await request.body?.cancel().catch(() => undefined);
    const payload = (await response?.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error || "Media could not be uploaded.");
  }
  const payload = (await response.json()) as { key: string; publicUrl: string; size: number };
  return {
    key: payload.key,
    url: payload.publicUrl,
    name: input.fileName,
    mimeType: input.mimeType,
    size: payload.size,
  };
}

async function getPriorityDmConversations(
  userId: string,
  filter: "open" | "closed",
  limit: number,
) {
  const conversations = await loadPriorityDmInboxForCreator(db(), userId);
  return conversations
    .filter((conversation: PriorityDmConversationSummary) =>
      filter === "closed" ? conversation.status === "closed" : conversation.status !== "closed",
    )
    .slice(0, limit)
    .map(
      ({ buyerEmail: _buyerEmail, ...conversation }: PriorityDmConversationSummary) => conversation,
    );
}

async function sendPriorityDmMessage(userId: string, input: { requestId: string; body: string }) {
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "mcp-priority-dm-send", userId);
  return sendCreatorPriorityDmMessageForUser(db(), userId, input);
}

async function setPriorityDmClosed(userId: string, input: { requestId: string; closed: boolean }) {
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "mcp-priority-dm-status", userId);
  return setPriorityDmConversationClosedForUser(db(), userId, input);
}

async function getSchedulerWorkspace(userId: string) {
  const [accounts, posts, schedule] = await Promise.all([
    listSocialAccounts(userId),
    listSocialPosts(userId, undefined, 100),
    db()
      .from("social_posting_schedules")
      .select("timezone,slots,natural_offset,updated_at")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  if (schedule.error) throw new Error("Posting times could not be loaded.");
  return { accounts, posts, postingSchedule: schedule.data };
}

const schedulerMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save_posting_schedule"), schedule: postingScheduleSchema }),
  z.object({
    action: z.literal("reschedule_post"),
    id: z.uuid(),
    scheduledAt: z.iso.datetime({ offset: true }),
    timezone: z.string().min(1).max(100).optional(),
  }),
  z.object({
    action: z.enum(["move_to_draft", "duplicate_post", "cancel_post", "delete_post"]),
    id: z.uuid(),
  }),
]);

async function manageScheduler(userId: string, input: unknown) {
  const data = schedulerMutationSchema.parse(input);
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "mcp-scheduler", userId);
  const client = db();

  if (data.action === "save_posting_schedule") {
    await requirePlanEntitlement(userId, "postScheduler", "The post scheduler is not available.");
    const schedule = postingScheduleSchema.parse(data.schedule);
    const { error } = await client.from("social_posting_schedules").upsert({
      user_id: userId,
      timezone: schedule.timezone,
      slots: schedule.slots,
      natural_offset: schedule.naturalOffset,
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error("Posting times could not be saved.");
  } else if (data.action === "reschedule_post") {
    await requirePlanEntitlement(userId, "postScheduler", "The post scheduler is not available.");
    if (new Date(data.scheduledAt).getTime() < Date.now() - 60_000) {
      throw new Error("Choose a future publish time.");
    }
    const { data: rescheduled, error } = await client.rpc("reschedule_social_post_atomic", {
      p_user_id: userId,
      p_post_id: data.id,
      p_scheduled_at: data.scheduledAt,
      p_timezone: data.timezone || null,
    });
    if (error || !rescheduled) throw new Error("This post could not be rescheduled.");
  } else if (data.action === "duplicate_post") {
    await requirePlanEntitlement(userId, "postScheduler", "The post scheduler is not available.");
    const { data: duplicated, error } = await client.rpc("duplicate_social_post_atomic", {
      p_user_id: userId,
      p_post_id: data.id,
    });
    if (error || !duplicated) throw new Error("The post could not be duplicated.");
  } else if (data.action === "move_to_draft") {
    await requirePlanEntitlement(userId, "postScheduler", "The post scheduler is not available.");
    const { data: post, error: postError } = await client
      .from("social_posts")
      .select("body,title,media,timezone")
      .eq("id", data.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (postError || !post) throw new Error("This post could not be found.");
    const { data: targets, error: targetError } = await client
      .from("social_post_targets")
      .select("connection_id,provider,provider_settings")
      .eq("post_id", data.id);
    if (targetError || !targets?.length)
      throw new Error("This post has no publishing destinations.");
    const { data: saved, error } = await client.rpc("save_social_post_atomic", {
      p_user_id: userId,
      p_post_id: data.id,
      p_body: post.body,
      p_title: post.title,
      p_media: Array.isArray(post.media) ? post.media : [],
      p_scheduled_at: null,
      p_timezone: post.timezone || "UTC",
      p_targets: targets.map((target: any) => ({
        connectionId: target.connection_id,
        provider: target.provider,
        providerSettings: target.provider_settings || {},
      })),
      p_as_draft: true,
    });
    if (error || !saved?.length) throw new Error("This post could not be moved to drafts.");
  } else if (data.action === "cancel_post") {
    const { data: cancelled, error } = await client.rpc("cancel_social_post_atomic", {
      p_user_id: userId,
      p_post_id: data.id,
    });
    if (error || !cancelled) throw new Error("This post can no longer be cancelled.");
  } else {
    const { data: deleted, error } = await client
      .from("social_posts")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId)
      .in("status", ["draft", "cancelled", "failed"])
      .select("id")
      .maybeSingle();
    if (error || !deleted) throw new Error("The post could not be deleted.");
  }

  return getSchedulerWorkspace(userId);
}

async function findPostStockPhotos(userId: string, query: string) {
  await requirePlanEntitlement(userId, "postScheduler", "Upgrade to Creator to use stock photos.");
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "stock-search", userId);
  return (await searchStockPhotos(query, 1)).slice(0, 6);
}
async function importPostStockPhoto(userId: string, id: number, provider: StockProvider) {
  await requirePlanEntitlement(userId, "postScheduler", "Upgrade to Creator to use stock photos.");
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "stock-import", userId);
  return importStockPhoto(userId, id, provider);
}
async function resolvePostMedia(userId: string, ids: string[]) {
  await requirePlanEntitlement(
    userId,
    "postScheduler",
    "Upgrade to Creator to prepare post media.",
  );
  return resolveOwnedAgentMedia(userId, ids);
}

export const defaultBentoMcpOperations = {
  findPostStockPhotos,
  importPostStockPhoto,
  resolvePostMedia,
  getBentoOverview,
  listSocialAccounts,
  listSocialPosts,
  saveSocialPostForUser,
  listAutoDmAutomations,
  saveAutoDmAutomation,
  setAutoDmEnabled,
  deleteAutoDmAutomation,
  listPages,
  listProducts,
  listBookings,
  uploadMedia,
  beginMcpMediaUpload,
  getStoreWorkspace,
  mutateProduct,
  mutateDiscount,
  mutateOrderBump,
  mutateAudience,
  mutatePage,
  mutateBlock,
  getCalendarWorkspace,
  mutateCalendar,
  getCommunityWorkspace,
  mutateCommunity,
  getProfileWorkspace,
  updateCreatorProfile,
  getAnalyticsWorkspace,
  getIntegrationWorkspace,
  getEarnWorkspace,
  mutateEarn,
  getPriorityDmConversations,
  sendPriorityDmMessage,
  setPriorityDmClosed,
  getSchedulerWorkspace,
  manageScheduler,
  getMcpContentBrain,
  manageMcpContentBrain,
  getMcpContentMedia,
  manageMcpContentMedia,
  getMcpContentRoutines,
  manageMcpContentRoutine,
  getMcpContentAgent,
  manageMcpContentAgent,
  getMcpContentDiscover,
  manageMcpContentDiscover,
};

export type BentoMcpOperations = typeof defaultBentoMcpOperations;

const socialPostStatusSchema = z.enum([
  "draft",
  "scheduled",
  "publishing",
  "published",
  "partially_failed",
  "failed",
  "cancelled",
]);
const platformSchema = z.enum(["instagram", "facebook", "twitter"]);
const mediaSchema = z.object({
  key: z.string(),
  url: z.url(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().positive(),
});
const socialProviderSettingsSchema = z
  .object({
    instagram: z
      .object({
        trialReel: z.boolean().optional(),
        graduationStrategy: z.enum(INSTAGRAM_TRIAL_GRADUATION_STRATEGIES).default("MANUAL"),
        cover: mediaSchema.optional(),
        scheduledAutoDm: scheduledInstagramAutoDmSchema.nullable().optional(),
      })
      .passthrough()
      .optional(),
    youtube: z
      .object({
        youtubePrivacy: z.enum(["private", "unlisted", "public"]).optional(),
        description: z.string().max(5_000).optional(),
        titleOverride: z.string().max(100).optional(),
        thumbnail: mediaSchema.optional(),
      })
      .passthrough()
      .optional(),
    tiktok: z
      .object({
        privacyLevel: z.string().optional(),
        disableComment: z.boolean().optional(),
        disableDuet: z.boolean().optional(),
        disableStitch: z.boolean().optional(),
        commercialContent: z.boolean().optional(),
        brandOrganicToggle: z.boolean().optional(),
        brandContentToggle: z.boolean().optional(),
        isAigc: z.boolean().optional(),
        videoCoverTimestampMs: z.number().int().min(0).optional(),
      })
      .passthrough()
      .optional(),
    facebook: z
      .object({ scheduledAutoDm: scheduledPostAutoDmSchemas.facebook.nullable().optional() })
      .passthrough()
      .optional(),
    twitter: z
      .object({
        scheduledAutoDm: scheduledPostAutoDmSchemas.twitter.nullable().optional(),
        autoRepost: z
          .object({
            afterHours: z.number().int().min(1).max(168),
            removeAfterHours: z.number().int().min(2).max(336).nullable(),
          })
          .nullable()
          .optional(),
      })
      .passthrough()
      .optional(),
    linkedin: z
      .object({
        autoRepost: z
          .object({
            afterHours: z.number().int().min(1).max(168),
            removeAfterHours: z.number().int().min(2).max(336).nullable(),
          })
          .nullable()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .default({});
const autoDmInputSchema = z.object({
  platform: platformSchema,
  id: z.uuid().optional(),
  connectionId: z.uuid(),
  name: z.string().min(1).max(80),
  triggerType: z.string().min(1).max(80),
  keywords: z.array(z.string()).max(20).default([]),
  excludedKeywords: z.array(z.string()).max(20).default([]),
  matchType: z.enum(["contains", "exact"]).default("contains"),
  mediaScope: z.enum(["any", "specific", "future"]).default("any"),
  mediaIds: z.array(z.string()).max(100).default([]),
  replyMessage: z.string().min(1).max(10_000),
  publicReplyEnabled: z.boolean().default(false),
  publicReplyMessages: z.array(z.string()).max(3).default([]),
  openingMessage: z.string().nullable().default(null),
  confirmationButtonLabel: z.string().nullable().default(null),
  emailCaptureEnabled: z.boolean().default(false),
  emailPromptMessage: z.string().nullable().default(null),
  emailMarketingConsentEnabled: z.boolean().default(false),
  followGateEnabled: z.boolean().default(false),
  followPromptMessage: z.string().default("Follow this account, then tap I’ve followed."),
  followMaxRechecks: z.number().int().min(1).max(3).default(3),
  followFailAction: z.enum(["send_anyway", "withhold"]).default("send_anyway"),
  replyButtonLabel: z.string().nullable().default(null),
  replyButtonUrl: z.url().nullable().default(null),
  enabled: z.boolean().default(true),
});

const pageMutationInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    name: z.string().min(1).max(40),
    url: z.url().nullable().optional(),
  }),
  z.object({ action: z.literal("rename"), id: z.uuid(), name: z.string().min(1).max(40) }),
  z.object({ action: z.literal("delete"), id: z.uuid() }),
]);

const blockTypeInputSchema = z.enum([
  "social_link",
  "generic_link",
  "image",
  "image_gallery",
  "video",
  "spotify",
  "link_preview",
  "map",
  "heading",
  "note",
  "quote",
  "email_capture",
  "booking",
  "tip_jar",
  "contact",
  "audio",
  "file_download",
  "divider",
  "section_title",
  "experience",
  "commerce",
]);
const blockMutationInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    type: blockTypeInputSchema,
    content: z.record(z.string(), z.unknown()).default({}),
    coverUrl: z.url().nullable().optional(),
    width: z.number().int().min(1).max(4).default(2),
    height: z.number().int().min(1).max(6).default(2),
    x: z.number().int().min(0).optional(),
    y: z.number().int().min(0).optional(),
    pageId: z.uuid().nullable().optional(),
  }),
  z.object({
    action: z.literal("update"),
    id: z.uuid(),
    content: z.record(z.string(), z.unknown()).optional(),
    coverUrl: z.url().nullable().optional(),
    width: z.number().int().min(1).max(4).optional(),
    height: z.number().int().min(1).max(6).optional(),
  }),
  z.object({
    action: z.literal("layout"),
    items: z
      .array(
        z.object({
          id: z.uuid(),
          x: z.number().int().min(0),
          y: z.number().int().min(0),
          width: z.number().int().min(1).max(4),
          height: z.number().int().min(1).max(6),
          position: z.number().int().min(0),
        }),
      )
      .max(200),
  }),
  z.object({ action: z.literal("delete"), id: z.uuid() }),
]);

const commerceKindInputSchema = z.enum([
  "digital_product",
  "coaching_call",
  "course",
  "webinar",
  "paid_community",
  "membership",
  "custom_product",
  "lead_form",
  "bento_affiliate",
]);
const productDraftInputSchema = z.object({
  kind: commerceKindInputSchema,
  title: z.string().min(1).max(120),
  subtitle: z.string().max(180).default(""),
  description: z.string().max(20_000).default(""),
  cover_url: z.url().nullable().optional(),
  pricing_type: z.enum(["free", "one_time", "subscription"]),
  price_amount: z.number().int().min(0).max(100_000_000),
  currency: z
    .string()
    .regex(/^[a-z]{3}$/)
    .default("usd"),
  billing_interval: z.enum(["day", "week", "month", "year"]).nullable().optional(),
  cta_label: z.string().min(1).max(40),
  settings: z.record(z.string(), z.unknown()).default({}),
  inventory_limit: z.number().int().positive().max(1_000_000).nullable().optional(),
  noindex: z.boolean().optional(),
});
const productMutationInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    product: productDraftInputSchema,
    addToBento: z.boolean().default(true),
    pageId: z.uuid().nullable().optional(),
  }),
  z.object({ action: z.literal("update"), id: z.uuid(), product: productDraftInputSchema }),
  z.object({
    action: z.literal("set_status"),
    id: z.uuid(),
    status: z.enum(["published", "archived"]),
  }),
  z.object({
    action: z.literal("add_to_page"),
    productId: z.uuid(),
    pageId: z.uuid().nullable().optional(),
  }),
  z.object({ action: z.literal("delete"), productId: z.uuid() }),
]);

const discountMutationInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    id: z.uuid().optional(),
    productId: z.uuid().nullable().optional(),
    code: z.string().min(2).max(32),
    discountType: z.enum(["percent", "fixed"]),
    discountValue: z.number().int().positive().max(100_000_000),
    currency: z
      .string()
      .regex(/^[a-z]{3}$/)
      .nullable()
      .optional(),
    startsAt: z.iso.datetime({ offset: true }).nullable().optional(),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
    maxRedemptions: z.number().int().positive().max(1_000_000).nullable().optional(),
    maxRedemptionsPerEmail: z.number().int().min(1).max(100).default(1),
    isActive: z.boolean().default(true),
  }),
  z.object({ action: z.literal("delete"), id: z.uuid() }),
]);
const orderBumpMutationInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    id: z.uuid().optional(),
    primaryProductId: z.uuid(),
    bumpProductId: z.uuid(),
    headline: z.string().min(1).max(120),
    description: z.string().max(500).default(""),
    isActive: z.boolean().default(true),
  }),
  z.object({ action: z.literal("delete"), id: z.uuid() }),
]);
const audienceMutationInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_list"),
    publicationId: z.uuid(),
    name: z.string().min(1).max(80),
    description: z.string().max(500).default(""),
  }),
  z.object({ action: z.literal("delete_list"), id: z.uuid(), publicationId: z.uuid().optional() }),
  z.object({
    action: z.literal("set_list_member"),
    listId: z.uuid(),
    publicationId: z.uuid().optional(),
    contactId: z.uuid(),
    included: z.boolean(),
  }),
  z.object({
    action: z.literal("save_campaign"),
    publicationId: z.uuid(),
    id: z.uuid().optional(),
    listId: z.uuid().nullable().optional(),
    name: z.string().min(1).max(120),
    subject: z.string().min(1).max(180),
    previewText: z.string().max(240).default(""),
    body: z.string().min(1).max(50_000),
  }),
  z.object({
    action: z.literal("delete_campaign"),
    id: z.uuid(),
    publicationId: z.uuid().optional(),
  }),
  z.object({
    action: z.literal("send_campaign"),
    id: z.uuid(),
    publicationId: z.uuid().optional(),
  }),
]);

const availabilityInputSchema = z.object({
  timezone: z.string().min(1).max(100),
  weeklyRules: z
    .array(
      z.object({
        day: z.number().int().min(0).max(6),
        start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      }),
    )
    .max(28),
  dateOverrides: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        unavailable: z.boolean().optional(),
        ranges: z
          .array(z.object({ start: z.string(), end: z.string() }))
          .max(12)
          .optional(),
      }),
    )
    .max(366)
    .default([]),
  minimumNoticeMinutes: z.number().int().min(0).max(525_600),
  maximumDaysAhead: z.number().int().min(1).max(365),
  bufferBeforeMinutes: z.number().int().min(0).max(480),
  bufferAfterMinutes: z.number().int().min(0).max(480),
  slotIntervalMinutes: z.number().int().min(5).max(240),
});
const calendarMutationInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save_availability"), availability: availabilityInputSchema }),
  z.object({ action: z.literal("set_public_page"), enabled: z.boolean() }),
  z.object({ action: z.literal("rename_public_page"), name: z.string().min(1).max(40) }),
  z.object({
    action: z.literal("set_review_visibility"),
    reviewId: z.uuid(),
    isPublic: z.boolean(),
  }),
  z.object({
    action: z.literal("set_default_connection"),
    type: z.enum(["google", "fathom"]),
    id: z.uuid(),
  }),
  z.object({
    action: z.literal("disconnect_connection"),
    type: z.enum(["google", "fathom"]),
    id: z.uuid(),
  }),
]);

const communityMutationInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("invite_member"),
    productId: z.uuid(),
    email: z.email(),
    name: z.string().max(120).optional(),
    role: z.enum(["member", "moderator"]).default("member"),
    notificationsEnabled: z.boolean().default(true),
  }),
  z.object({
    action: z.literal("set_member_status"),
    grantId: z.uuid(),
    status: z.enum(["active", "revoked"]),
  }),
  z.object({
    action: z.literal("update_member"),
    grantId: z.uuid(),
    role: z.enum(["member", "moderator"]),
    notificationsEnabled: z.boolean(),
  }),
  z.object({
    action: z.literal("create_post"),
    productId: z.uuid(),
    body: z.string().min(1).max(10_000),
    pinned: z.boolean().default(false),
    resources: z
      .array(z.object({ label: z.string().max(80), url: z.url() }))
      .max(5)
      .default([]),
  }),
  z.object({
    action: z.literal("pin_post"),
    productId: z.uuid(),
    postId: z.uuid(),
    pinned: z.boolean(),
  }),
  z.object({ action: z.literal("delete_post"), productId: z.uuid(), postId: z.uuid() }),
  z.object({
    action: z.literal("create_comment"),
    productId: z.uuid(),
    postId: z.uuid(),
    body: z.string().min(1).max(3_000),
  }),
  z.object({
    action: z.literal("moderate"),
    productId: z.uuid(),
    contentId: z.uuid(),
    kind: z.enum(["post", "comment"]),
    status: z.enum(["published", "hidden", "removed"]),
    reason: z.string().max(500).optional(),
  }),
  z.object({
    action: z.literal("update_settings"),
    productId: z.uuid(),
    welcomeMessage: z.string().min(1).max(2_000),
    rules: z.string().max(5_000),
    allowMemberPosts: z.boolean(),
  }),
  z.object({ action: z.literal("delete_community"), productId: z.uuid() }),
]);

const profileUpdateInputSchema = z.object({
  username: z.string().min(3).max(64).optional(),
  display_name: z.string().max(60).optional(),
  bio: z.string().max(280).optional(),
  avatar_url: z.url().or(z.literal("")).optional(),
  theme: z.enum(["light", "dark", "system"]).optional(),
  accent_color: z.string().max(20).optional(),
  primary_font: z.string().max(60).optional(),
  secondary_font: z.string().max(60).optional(),
  show_in_explore: z.boolean().optional(),
  explore_category: z.string().optional(),
  header_mode: z.enum(["with_photo", "no_banner"]).optional(),
  pattern: z.string().max(40).optional(),
  pattern_settings: z.record(z.string(), z.unknown()).optional(),
});
const earnMutationInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("update_code"), code: z.string().min(3).max(32) }),
  z.object({ action: z.literal("request_payout"), currency: z.string().regex(/^[A-Za-z]{3}$/) }),
]);

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Explicit JSON value. `z.unknown()` / `z.any()` emit `{}`, which strict scanners reject. */
const JSON_VALUE_SCHEMA = {
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
    { type: "array" },
    { type: "object" },
  ],
};
const SCHEMA_TYPE_KEYS = new Set(["$ref", "allOf", "anyOf", "const", "enum", "oneOf", "type"]);
const SCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_CHILD_KEYS = new Set([
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const SCHEMA_ANNOTATION_KEYS = new Set([
  "default",
  "deprecated",
  "description",
  "examples",
  "title",
]);
// Zod's format patterns (uuid ~166, date-time ~293, email ~96) duplicate `format`
// and are large enough for a scanner to reject or stall on. Runtime checks stay on Zod.
const REDUNDANT_FORMAT_PATTERN_MAX = 80;

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeMcpJsonSchema(schema: unknown): Record<string, unknown> {
  const sanitized = sanitizeSchemaNode(schema);
  return isSchemaRecord(sanitized) ? replaceUnresolvedRefs(sanitized) : { ...JSON_VALUE_SCHEMA };
}

function sanitizeSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((item) => sanitizeSchemaNode(item));
  if (!isSchemaRecord(node)) return node;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    // Draft 2020-12 `$schema` makes a draft-07 scanner try to load a meta-schema it does not have.
    if (key === "$schema") continue;
    if (SCHEMA_MAP_KEYS.has(key) && isSchemaRecord(value)) {
      copy[key] = Object.fromEntries(
        Object.entries(value).map(([childKey, child]) => [childKey, sanitizeSchemaNode(child)]),
      );
      continue;
    }
    if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      copy[key] = value.map((item) => sanitizeSchemaNode(item));
      continue;
    }
    if (SCHEMA_CHILD_KEYS.has(key)) {
      copy[key] = sanitizeSchemaNode(value);
      continue;
    }
    copy[key] = value;
  }
  if (
    isSchemaRecord(copy.propertyNames) &&
    copy.propertyNames.type === "string" &&
    Object.keys(copy.propertyNames).length === 1
  ) {
    // JSON object keys are already strings. `propertyNames` is redundant and trips strict scanners.
    delete copy.propertyNames;
  }
  if (
    typeof copy.pattern === "string" &&
    copy.pattern.length > REDUNDANT_FORMAT_PATTERN_MAX &&
    typeof copy.format === "string"
  ) {
    delete copy.pattern;
  }
  const hasType = Object.keys(copy).some((key) => SCHEMA_TYPE_KEYS.has(key));
  if (!hasType) {
    if (
      "properties" in copy ||
      "additionalProperties" in copy ||
      "patternProperties" in copy ||
      "required" in copy
    ) {
      copy.type = "object";
    } else {
      const annotations: Record<string, unknown> = {};
      for (const key of SCHEMA_ANNOTATION_KEYS) {
        if (key in copy) annotations[key] = copy[key];
      }
      return { ...JSON_VALUE_SCHEMA, ...annotations };
    }
  }
  if (
    copy.type === "object" &&
    isSchemaRecord(copy.properties) &&
    !("required" in copy) &&
    !("oneOf" in copy) &&
    !("anyOf" in copy) &&
    !("allOf" in copy)
  ) {
    // OpenAI's strict tool check requires this key even when nothing is required.
    copy.required = [];
  }
  return copy;
}

function resolveJsonPointer(root: Record<string, unknown>, ref: string) {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    if (!isSchemaRecord(current)) return undefined;
    current = current[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return current;
}

function replaceUnresolvedRefs(root: Record<string, unknown>) {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map((item) => visit(item));
    if (!isSchemaRecord(node)) return node;
    if (typeof node.$ref === "string" && resolveJsonPointer(root, node.$ref) === undefined) {
      const annotations: Record<string, unknown> = {};
      for (const key of SCHEMA_ANNOTATION_KEYS) {
        if (key in node) annotations[key] = node[key];
      }
      return { ...JSON_VALUE_SCHEMA, ...annotations };
    }
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, visit(value)]));
  };
  const replaced = visit(root);
  return isSchemaRecord(replaced) ? replaced : { ...JSON_VALUE_SCHEMA };
}

function isStandardJsonSchema(schema: unknown): schema is {
  "~standard": {
    validate: (value: unknown) => unknown;
    jsonSchema: {
      input: (params?: { target?: string }) => unknown;
      output: (params?: { target?: string }) => unknown;
    };
  };
} {
  if (!schema || typeof schema !== "object" || !("~standard" in schema)) return false;
  const standard = (
    schema as {
      "~standard"?: {
        validate?: unknown;
        jsonSchema?: { input?: unknown; output?: unknown };
      };
    }
  )["~standard"];
  return (
    typeof standard?.validate === "function" &&
    typeof standard.jsonSchema?.input === "function" &&
    typeof standard.jsonSchema?.output === "function"
  );
}

function scannerSafeInputSchema<T>(schema: T): T {
  if (!isStandardJsonSchema(schema)) return schema;
  const standard = schema["~standard"];
  const validate = standard.validate.bind(standard);
  const input = standard.jsonSchema.input.bind(standard.jsonSchema);
  const output = standard.jsonSchema.output.bind(standard.jsonSchema);
  return {
    "~standard": {
      version: 1,
      vendor: "bento-mcp",
      validate,
      jsonSchema: {
        input: (params?: { target?: string }) => sanitizeMcpJsonSchema(input(params)),
        output: (params?: { target?: string }) => sanitizeMcpJsonSchema(output(params)),
      },
    },
  } as T;
}

function installScannerSafeToolSchemas(server: McpServer) {
  const registerTool = server.registerTool.bind(server);
  server.registerTool = ((
    name: string,
    config: { inputSchema?: unknown },
    cb: Parameters<McpServer["registerTool"]>[2],
  ) => {
    if (config && typeof config === "object" && "inputSchema" in config) {
      config = {
        ...config,
        inputSchema: scannerSafeInputSchema(config.inputSchema),
      };
    }
    return registerTool(name, config as never, cb as never);
  }) as typeof server.registerTool;
}

function advertiseSkillsOnlyWhenRequested(server: McpServer) {
  const protocol = server.server as unknown as {
    _oninitialize: (request: {
      params?: { capabilities?: { extensions?: unknown } };
    }) => Promise<{ capabilities?: Record<string, unknown> } & Record<string, unknown>>;
  };
  const negotiate = protocol._oninitialize.bind(protocol);
  protocol._oninitialize = async (request) => {
    const result = await negotiate(request);
    const clientExtensions = request.params?.capabilities?.extensions;
    // MCP 2025-06-18 ServerCapabilities has no `extensions` key. A strict client
    // rejects it. Clients that advertise the field (OpenAI's skills importer) still get it.
    if (clientExtensions !== null && typeof clientExtensions === "object") return result;
    if (!result.capabilities || !("extensions" in result.capabilities)) return result;
    const { extensions: _extensions, ...capabilities } = result.capabilities;
    return { ...result, capabilities };
  };
}

/** The web Agent and remote MCP clients share these schemas and service boundaries. */
export type BentoAppTool = {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  inputSchema: z.ZodType;
  execute: (input: unknown) => Promise<any>;
};

export function createBentoAppTools(
  context: CreatorMcpContext & { accessToken: string },
  origin: string,
  operations: BentoMcpOperations = defaultBentoMcpOperations,
): Map<string, BentoAppTool> {
  const tools = new Map<string, BentoAppTool>();
  const registry = {
    registerTool(name: string, config: any, callback: (input: any) => Promise<any>) {
      tools.set(name, {
        name,
        title: config.title || name,
        description: config.description || "",
        readOnly: config.annotations?.readOnlyHint === true,
        inputSchema: config.inputSchema,
        execute: async (input: unknown) => callback(config.inputSchema.parse(input)),
      });
    },
  } as unknown as Pick<McpServer, "registerTool">;
  registerBentoTools(
    registry,
    {
      token: context.accessToken,
      clientId: "bento-agent",
      scopes: [],
      extra: { userId: context.userId },
    },
    origin,
    operations,
    () => context,
  );
  // Chat recursion and arbitrary URL/base64 imports are not Agent operations.
  // The authenticated attachment picker handles uploads with storage limits.
  tools.delete("manage_content_agent");
  tools.delete("upload_media");
  tools.delete("begin_media_upload");
  return tools;
}

function registerBentoTools(
  server: Pick<McpServer, "registerTool">,
  authInfo: AuthInfo,
  origin: string,
  operations: BentoMcpOperations,
  creatorContext: () => CreatorMcpContext,
) {
  const userId = userIdFrom(authInfo);
  server.registerTool(
    "get_bento_overview",
    {
      title: "Get Bento overview",
      description: "Load the creator's Bento profile, plan, feature links, and workspace counts.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async () => {
      const overview = await operations.getBentoOverview(userId, origin);
      return textResult("Loaded the Bento workspace overview.", { overview });
    },
  );

  server.registerTool(
    "get_content_brain",
    {
      title: "Get Content Brain",
      description: "Load the creator's Content profile, Brain documents, and indexing status.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async () =>
      textResult("Loaded Content Brain.", { brain: await operations.getMcpContentBrain(userId) }),
  );

  server.registerTool(
    "manage_content_brain",
    {
      title: "Manage Content Brain",
      description:
        "Save the Content profile or a Brain document, confirm, lock, delete, or refresh the index.",
      inputSchema: brainMutationSchema,
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    async (input) =>
      textResult(`Completed Brain action: ${input.action}.`, {
        result: await operations.manageMcpContentBrain(userId, input),
      }),
  );

  server.registerTool(
    "get_content_media",
    {
      title: "Get Brain Media",
      description:
        "List or search paginated Brain Media, folders, pending imports, and library limits.",
      inputSchema: z.object({
        page: z.number().int().min(0).max(100).default(0),
        query: z.string().trim().max(300).optional(),
        previewOld: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async (input) =>
      textResult("Loaded Brain Media.", {
        media: await operations.getMcpContentMedia(userId, input),
      }),
  );

  server.registerTool(
    "manage_content_media",
    {
      title: "Manage Brain Media",
      description:
        "Register an uploaded image or video, fetch media from a connected post, manage folders, move items, or set one of four hero images. Upload with upload_media first.",
      inputSchema: mediaMutationSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async (input) =>
      textResult(`Completed Media action: ${input.action}.`, {
        result: await operations.manageMcpContentMedia(userId, input),
      }),
  );

  server.registerTool(
    "get_content_routines",
    {
      title: "Get Content Routines",
      description: "Load routines, schedules, and recent activity for the signed-in creator.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async () =>
      textResult("Loaded Content Routines.", {
        routines: await operations.getMcpContentRoutines(userId),
      }),
  );

  server.registerTool(
    "manage_content_routine",
    {
      title: "Manage Content Routine",
      description: "Create or edit a template or custom routine, or pause and resume a routine.",
      inputSchema: routineMutationSchema,
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    },
    async (input) =>
      textResult(`Completed Routine action: ${input.action}.`, {
        result: await operations.manageMcpContentRoutine(userId, input),
      }),
  );

  server.registerTool(
    "get_content_agent",
    {
      title: "Get Content Agent",
      description: "List Content Agent conversations or load one conversation and its cards.",
      inputSchema: z.object({ threadId: z.uuid().optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async ({ threadId }) =>
      textResult("Loaded Content Agent.", {
        agent: await operations.getMcpContentAgent(userId, threadId),
      }),
  );

  server.registerTool(
    "manage_content_agent",
    {
      title: "Manage Content Agent",
      description:
        "Send a message, edit/reject/regenerate a draft, or approve Brain and scheduling proposals. Schedule approval may create social posts.",
      inputSchema: agentMutationSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async (input) =>
      textResult(`Completed Agent action: ${input.action}.`, {
        result: await operations.manageMcpContentAgent(userId, input),
      }),
  );

  server.registerTool(
    "get_content_discover",
    {
      title: "Get Content Discover",
      description: "Load personalized Discover recommendations, tracked creators, and preferences.",
      inputSchema: z.object({ creatorId: z.uuid().optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async ({ creatorId }) =>
      textResult("Loaded Content Discover.", {
        discover: await operations.getMcpContentDiscover(userId, creatorId),
      }),
  );

  server.registerTool(
    "manage_content_discover",
    {
      title: "Manage Content Discover",
      description:
        "Refresh recommendations, set feedback or bookmarks, edit preferences, or track and untrack creators.",
      inputSchema: discoverMutationSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async (input) =>
      textResult(`Completed Discover action: ${input.action}.`, {
        result: await operations.manageMcpContentDiscover(userId, input),
      }),
  );

  server.registerTool(
    "list_social_accounts",
    {
      title: "List social accounts",
      description:
        "List connected social profiles, publishing access, and Auto-DM readiness before acting.",
      inputSchema: z.object({
        provider: z
          .enum(["instagram", "facebook", "threads", "tiktok", "linkedin", "twitter", "youtube"])
          .optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async ({ provider }) => {
      const accounts = await operations.listSocialAccounts(userId, provider);
      return textResult(`Found ${accounts.length} connected social account(s).`, { accounts });
    },
  );

  server.registerTool(
    "upload_media",
    {
      title: "Upload media to Bento",
      description:
        "Import one public media URL (streamed within plan and remaining storage limits) or inline base64 up to 25 MB. Prefer begin_media_upload for local videos over 8 MB; never compress just to fit MCP. Returns media to reuse in ONE create_social_post with all selected accounts.",
      inputSchema: z.object({
        sourceUrl: z.url().optional(),
        base64: z.string().optional(),
        fileName: z.string().min(1).max(255),
        mimeType: z.string().min(1).max(100),
        kind: z.enum(["image", "video", "audio", "file"]),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
    async (input) => {
      const media = await operations.uploadMedia(authInfo, origin, input as any);
      return textResult("Uploaded media to Bento.", { media });
    },
  );

  server.registerTool(
    "begin_media_upload",
    {
      title: "Start a large media upload",
      description:
        "Upload an original local video or other file without putting it in MCP JSON. Checks plan and remaining storage, then returns a private two-hour upload credential and exact HTTP instructions. Use file/HTTP tools to PUT 8 MiB binary parts, then POST their ETags to complete and obtain media for create_social_post. DELETE cancels the unfinished upload. No account token is needed. If this client cannot read files or send HTTP, ask the user to attach it in Bento; do not pretend it was uploaded.",
      inputSchema: beginMediaUploadSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
    async (input) =>
      textResult(
        "Upload prepared. Send the original bytes and complete before attaching to a post.",
        {
          upload: await operations.beginMcpMediaUpload(userId, origin, input),
        },
      ),
  );

  server.registerTool(
    "list_social_posts",
    {
      title: "List social posts",
      description: "List recent Bento drafts, scheduled posts, and publishing results.",
      inputSchema: z.object({
        status: socialPostStatusSchema.optional(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async ({ status, limit }) => {
      const posts = await operations.listSocialPosts(userId, status, limit);
      return textResult(`Found ${posts.length} social post(s).`, { posts });
    },
  );

  server.registerTool(
    "search_stock_photos",
    {
      title: "Find free post photos",
      description:
        "Find up to six free stock photos for a generic topic. Never use stock as proof of the creator's own product, face, customer or event. Pass a returned id/provider to create_social_post.stockPhoto to import it on approval. No paid fallback.",
      inputSchema: z.object({ query: z.string().trim().min(3).max(100) }),
      annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    async ({ query }) =>
      textResult("Found stock photo options.", {
        photos: await operations.findPostStockPhotos(userId, query),
      }),
  );
  server.registerTool(
    "resolve_post_media",
    {
      title: "Prepare owned post media",
      description:
        "Resolve up to ten owned Brain/Agent image IDs into verified publishing media. Use exact IDs returned by get_content_media or current context.",
      inputSchema: z.object({ ids: z.array(z.uuid()).min(1).max(10) }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async ({ ids }) =>
      textResult("Verified owned post media.", {
        media: await operations.resolvePostMedia(userId, ids),
      }),
  );

  server.registerTool(
    "create_social_post",
    {
      title: "Create social post",
      description:
        "Create or edit a social draft, schedule it, or publish now. For multiple networks use ONE action with all connectionIds and tailored connectionOverrides[id].bodyOverride. Optional stockPhoto imports one selected free photo when executing. providerSettings supports Instagram Trial Reels and scheduled Auto DM (public replies, email, follow gate, link button), X and Facebook scheduledAutoDm, YouTube title, description, visibility and thumbnail, TikTok privacy and interactions, and auto repost.",
      inputSchema: z.object({
        id: z.uuid().optional(),
        body: z.string().max(25_000),
        title: z.string().max(300).default(""),
        connectionIds: z.array(z.uuid()).max(20),
        media: z.array(mediaSchema).max(10).default([]),
        stockPhoto: z
          .object({
            id: z.number().int().positive(),
            provider: z.enum(["pixabay", "pexels", "commons"]),
          })
          .optional(),
        providerSettings: socialProviderSettingsSchema,
        connectionOverrides: socialPostInputSchema.shape.connectionOverrides.describe(
          'Per-account settings keyed by a selected connection UUID, e.g. {"<x-connection-id>":{"bodyOverride":"X caption"},"<instagram-connection-id>":{"bodyOverride":"Instagram caption"}}. Keep these in ONE post. YouTube titleOverride/description/youtubePrivacy belong in providerSettings.youtube.',
        ),
        mode: z.enum(["draft", "schedule", "publish_now"]),
        scheduledAt: z.iso.datetime({ offset: true }).optional(),
        timezone: z.string().min(1).max(100).default("UTC"),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async ({ mode, stockPhoto, ...input }) => {
      if (stockPhoto && input.media.length)
        throw new Error("Choose either your attached media or one stock photo.");
      if (mode === "schedule" && !input.scheduledAt)
        throw new Error("scheduledAt is required in schedule mode.");
      if (stockPhoto)
        input.media = [
          (await operations.importPostStockPhoto(userId, stockPhoto.id, stockPhoto.provider)).media,
        ];
      const post = await operations.saveSocialPostForUser(userId, {
        ...input,
        scheduledAt: input.scheduledAt || null,
        asDraft: mode === "draft",
        publishNow: mode === "publish_now",
      });
      return textResult(
        mode === "publish_now"
          ? "Queued the social post for publishing."
          : mode === "draft"
            ? "Saved the social draft."
            : "Scheduled the social post.",
        { post },
      );
    },
  );

  server.registerTool(
    "list_auto_dm_automations",
    {
      title: "List Auto-DM automations",
      description:
        "List Instagram, Facebook, or X Auto-DM automations and their connected account readiness.",
      inputSchema: z.object({ platform: platformSchema.optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async ({ platform }) => {
      const automations = await operations.listAutoDmAutomations(userId, platform);
      return textResult("Loaded Bento Auto-DM automations.", { automations });
    },
  );

  server.registerTool(
    "save_auto_dm_automation",
    {
      title: "Save Auto-DM automation",
      description:
        "Create or update an Instagram, Facebook, or X keyword/engagement Auto-DM automation.",
      inputSchema: autoDmInputSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async ({ platform, ...input }) => {
      const automation = await operations.saveAutoDmAutomation(userId, platform, input);
      return textResult(`Saved the ${platform} Auto-DM automation.`, { platform, automation });
    },
  );

  server.registerTool(
    "set_auto_dm_enabled",
    {
      title: "Enable or pause Auto-DM",
      description: "Enable or pause one owned Instagram, Facebook, or X Auto-DM automation.",
      inputSchema: z.object({ platform: platformSchema, id: z.uuid(), enabled: z.boolean() }),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ platform, id, enabled }) => {
      const automation = await operations.setAutoDmEnabled(userId, platform, id, enabled);
      return textResult(`${enabled ? "Enabled" : "Paused"} the ${platform} Auto-DM automation.`, {
        platform,
        automation,
      });
    },
  );

  server.registerTool(
    "delete_auto_dm_automation",
    {
      title: "Delete Auto-DM automation",
      description: "Permanently delete one owned Instagram, Facebook, or X Auto-DM automation.",
      inputSchema: z.object({ platform: platformSchema, id: z.uuid() }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async ({ platform, id }) => {
      const result = await operations.deleteAutoDmAutomation(userId, platform, id);
      return textResult(`Deleted the ${platform} Auto-DM automation.`, { platform, ...result });
    },
  );

  server.registerTool(
    "list_pages",
    {
      title: "List Bento pages",
      description: "List the creator's Bento pages and blocks.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async () => textResult("Loaded Bento pages and blocks.", await operations.listPages(userId)),
  );

  server.registerTool(
    "list_products",
    {
      title: "List Bento products",
      description:
        "List recent products and their publication, pricing, inventory, and sales state.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(30) }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async ({ limit }) => {
      const products = await operations.listProducts(userId, limit);
      return textResult(`Found ${products.length} product(s).`, { products });
    },
  );

  server.registerTool(
    "list_bookings",
    {
      title: "List Bento bookings",
      description: "List recent creator bookings and their meeting state.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(30) }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async ({ limit }) => {
      const bookings = await operations.listBookings(userId, limit);
      return textResult(`Found ${bookings.length} booking(s).`, { bookings });
    },
  );

  server.registerTool(
    "get_priority_dm_conversations",
    {
      title: "Get Priority DM conversations",
      description:
        "List bounded Priority DM inbox summaries. Buyer emails, full messages, orders, payments, and links are omitted.",
      inputSchema: z.object({
        filter: z.enum(["open", "closed"]).default("open"),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async ({ filter, limit }) => {
      const conversations = await operations.getPriorityDmConversations(userId, filter, limit);
      return textResult(`Loaded ${conversations.length} Priority DM conversation(s).`, {
        conversations,
      });
    },
  );

  server.registerTool(
    "send_priority_dm_message",
    {
      title: "Send Priority DM message",
      description:
        "Send and email a creator reply to one owned, eligible Priority DM conversation.",
      inputSchema: z.object({
        requestId: z.uuid(),
        body: z.string().trim().min(1).max(10_000),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async (input) => {
      const message = await operations.sendPriorityDmMessage(userId, input);
      return textResult("Priority DM message sent.", {
        requestId: input.requestId,
        messageId: message.id,
      });
    },
  );

  server.registerTool(
    "set_priority_dm_closed",
    {
      title: "Close or reopen Priority DM conversation",
      description: "Close or reopen one owned Priority DM conversation.",
      inputSchema: z.object({ requestId: z.uuid(), closed: z.boolean() }),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input) => {
      const conversation = await operations.setPriorityDmClosed(userId, input);
      return textResult(
        input.closed ? "Priority DM conversation closed." : "Priority DM conversation reopened.",
        {
          conversation,
        },
      );
    },
  );

  server.registerTool(
    "get_scheduler_workspace",
    {
      title: "Get scheduler workspace",
      description:
        "Load posting times, connected-account readiness, and bounded social-post lifecycle state.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async () => {
      const scheduler = await operations.getSchedulerWorkspace(userId);
      return textResult("Loaded social scheduler workspace.", { scheduler });
    },
  );

  server.registerTool(
    "manage_scheduler",
    {
      title: "Manage scheduler lifecycle",
      description:
        "Save posting times or reschedule, move to draft, duplicate, cancel, or delete an owned social post.",
      inputSchema: schedulerMutationSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async (input) => {
      const scheduler = await operations.manageScheduler(userId, input);
      return textResult(`Completed scheduler action: ${input.action}.`, { scheduler });
    },
  );

  server.registerTool(
    "manage_page",
    {
      title: "Manage Bento page",
      description:
        "Create, rename, or delete a secondary Bento page. Deleting also removes its page blocks.",
      inputSchema: pageMutationInputSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async (input) => {
      const result = await operations.mutatePage(creatorContext(), input);
      return textResult(`Completed page action: ${input.action}.`, { result });
    },
  );

  server.registerTool(
    "manage_block",
    {
      title: "Manage Bento block",
      description:
        "Create, edit, position, or delete a Bento block, including links, media, email capture, booking, commerce, headings, notes, and social links.",
      inputSchema: blockMutationInputSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async (input) => {
      const result = await operations.mutateBlock(creatorContext(), input);
      return textResult(`Completed block action: ${input.action}.`, { result });
    },
  );

  server.registerTool(
    "get_store_workspace",
    {
      title: "Get Bento Store workspace",
      description:
        "Load products, orders, leads, audience contacts, discount codes, order bumps, publications, Posts, audience lists, and campaigns.",
      inputSchema: z.object({ publicationId: z.uuid().optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async ({ publicationId }) => {
      const store = await operations.getStoreWorkspace(creatorContext(), publicationId);
      return textResult("Loaded the Bento Store workspace.", { store });
    },
  );

  server.registerTool(
    "manage_product",
    {
      title: "Manage Bento product",
      description:
        "Create, update, publish, archive, delete, or add a Bento Store product/session/course/webinar/community/lead form to a page. Product settings are kind-specific.",
      inputSchema: productMutationInputSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async (input) => {
      const result = await operations.mutateProduct(creatorContext(), input);
      return textResult(`Completed product action: ${input.action}.`, { result });
    },
  );

  server.registerTool(
    "manage_discount_code",
    {
      title: "Manage discount code",
      description: "Create, update, activate, deactivate, or delete a Bento Store discount code.",
      inputSchema: discountMutationInputSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async (input) => {
      const result = await operations.mutateDiscount(creatorContext(), input);
      return textResult(`Completed discount-code action: ${input.action}.`, { result });
    },
  );

  server.registerTool(
    "manage_order_bump",
    {
      title: "Manage order bump",
      description:
        "Create, update, activate, deactivate, or delete an order bump between two products.",
      inputSchema: orderBumpMutationInputSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async (input) => {
      const result = await operations.mutateOrderBump(creatorContext(), input);
      return textResult(`Completed order-bump action: ${input.action}.`, { result });
    },
  );

  server.registerTool(
    "manage_audience",
    {
      title: "Manage Store audience",
      description:
        "Create/delete publication lists, change membership, save/delete Broadcasts, or send to explicitly subscribed recipients. Send only when the user explicitly asks.",
      inputSchema: audienceMutationInputSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async (input) => {
      const result = await operations.mutateAudience(creatorContext(), input);
      return textResult(
        `Completed audience action: ${input.action}${input.publicationId ? ` for publication ${input.publicationId}` : ""}.`,
        { result },
      );
    },
  );

  server.registerTool(
    "get_calendar_workspace",
    {
      title: "Get Calendar workspace",
      description:
        "Load availability, calendar/Fathom connections, sessions, bookings, reviews, and public-calendar state.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async () => {
      const calendar = await operations.getCalendarWorkspace(creatorContext());
      return textResult("Loaded the Bento Calendar workspace.", { calendar });
    },
  );

  server.registerTool(
    "manage_calendar",
    {
      title: "Manage Calendar",
      description:
        "Save availability, enable/rename the public calendar, publish review visibility, or manage Google Calendar/Fathom connections. Create sessions with manage_product using coaching_call.",
      inputSchema: calendarMutationInputSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async (input) => {
      const result = await operations.mutateCalendar(creatorContext(), input);
      return textResult(`Completed calendar action: ${input.action}.`, { result });
    },
  );

  server.registerTool(
    "get_community_workspace",
    {
      title: "Get Community workspace",
      description: "Load a paid community or membership, its members, posts, and comments.",
      inputSchema: z.object({ productId: z.uuid().optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async ({ productId }) => {
      const community = await operations.getCommunityWorkspace(creatorContext(), productId);
      return textResult("Loaded the Bento Community workspace.", { community });
    },
  );

  server.registerTool(
    "manage_community",
    {
      title: "Manage Community",
      description:
        "Invite or update members, publish/pin/delete posts, reply, moderate content, update community settings, or delete a community.",
      inputSchema: communityMutationInputSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async (input) => {
      const result = await operations.mutateCommunity(creatorContext(), input);
      return textResult(`Completed community action: ${input.action}.`, { result });
    },
  );

  server.registerTool(
    "get_profile_workspace",
    {
      title: "Get profile workspace",
      description:
        "Load editable Bento profile settings, plan limits, usage, and safe payment-account readiness.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async () => {
      const profile = await operations.getProfileWorkspace(creatorContext());
      return textResult("Loaded the Bento profile workspace.", { profile });
    },
  );

  server.registerTool(
    "update_profile",
    {
      title: "Update Bento profile",
      description:
        "Update creator identity, username, bio, avatar, theme, fonts, Explore visibility/category, header, or pattern.",
      inputSchema: profileUpdateInputSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async (input) => {
      const profile = await operations.updateCreatorProfile(creatorContext(), input);
      return textResult("Updated the Bento profile.", { profile });
    },
  );

  server.registerTool(
    "get_analytics_workspace",
    {
      title: "Get analytics workspace",
      description:
        "Load site analytics, social account snapshots, and recent social-content performance.",
      inputSchema: z.object({
        range: z.enum(["today", "3d", "7d", "30d", "90d", "all"]).default("30d"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async (input) => {
      const analytics = await operations.getAnalyticsWorkspace(creatorContext(), input);
      return textResult("Loaded Bento analytics.", { analytics });
    },
  );

  server.registerTool(
    "get_integration_workspace",
    {
      title: "Get integrations",
      description:
        "Load safe connection state for social profiles, Google Calendar, Fathom, and creator payment providers. Secrets are never returned.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async () => {
      const integrations = await operations.getIntegrationWorkspace(creatorContext());
      return textResult("Loaded Bento integrations.", { integrations });
    },
  );

  server.registerTool(
    "get_earn_workspace",
    {
      title: "Get Earn workspace",
      description:
        "Load Bento referral account, link, referrals, commissions, payouts, and reach rewards.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async () => {
      const earn = await operations.getEarnWorkspace(creatorContext());
      return textResult("Loaded the Bento Earn workspace.", { earn });
    },
  );

  server.registerTool(
    "manage_earn",
    {
      title: "Manage Earn",
      description: "Change the referral code or request a payout in an available currency.",
      inputSchema: earnMutationInputSchema,
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async (input) => {
      const result = await operations.mutateEarn(creatorContext(), input);
      return textResult(`Completed Earn action: ${input.action}.`, { result });
    },
  );
}

export function createBentoMcpServer(
  authInfo: AuthInfo,
  origin: string,
  operations: BentoMcpOperations = defaultBentoMcpOperations,
) {
  const userId = userIdFrom(authInfo);
  let cachedCreatorContext: CreatorMcpContext | undefined;
  const creatorContext = (): CreatorMcpContext => {
    if (cachedCreatorContext) return cachedCreatorContext;
    const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
    if (!publishableKey) throw new Error("SUPABASE_PUBLISHABLE_KEY is not configured.");
    cachedCreatorContext = {
      userId,
      supabase: createClient<Database>(configuredSupabaseUrl(), publishableKey, {
        global: { headers: { Authorization: `Bearer ${authInfo.token}` } },
        auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
      }),
    };
    return cachedCreatorContext;
  };
  const server = new McpServer(
    { name: "bento", version: "1.0.0" },
    {
      instructions:
        "Use stable IDs returned by list tools. List accounts before posting or creating Auto-DMs. For one piece of content on several networks create ONE social post with all connectionIds, shared media uploaded once, and connectionOverrides[connectionId].bodyOverride for each caption. YouTube titleOverride/description/youtubePrivacy go in providerSettings.youtube. Edit by passing the existing post id; do not split or duplicate drafts for different captions. For local videos over 8 MB use begin_media_upload and its binary chunk instructions, not large base64 JSON or compression. Read skill://bento/bento/references/tools.md for complete examples. Publish now or delete only when the user explicitly requested that external action.",
      capabilities: { extensions: { "io.modelcontextprotocol/skills": {} } },
    },
  );

  installScannerSafeToolSchemas(server);
  advertiseSkillsOnlyWhenRequested(server);
  registerBentoTools(server, authInfo, origin, operations, creatorContext);

  server.registerResource(
    "bento-skill",
    SKILL_URI,
    {
      title: "Bento agent skill",
      description: "Instructions for operating Bento safely.",
      mimeType: "text/markdown",
    },
    async () => ({ contents: [{ uri: SKILL_URI, mimeType: "text/markdown", text: bentoSkill }] }),
  );
  server.registerResource(
    "bento-skill-tools",
    SKILL_TOOLS_URI,
    {
      title: "Bento tool reference",
      description: "Bento MCP workflow and tool reference.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [{ uri: SKILL_TOOLS_URI, mimeType: "text/markdown", text: bentoToolsReference }],
    }),
  );

  const skillEntry = async () => ({
    uri: SKILL_URI,
    frontmatter: {
      name: "bento",
      description: SKILL_DESCRIPTION,
    },
    resources: [
      { uri: SKILL_URI, digest: await sha256(bentoSkill) },
      { uri: SKILL_TOOLS_URI, digest: await sha256(bentoToolsReference) },
    ],
  });
  server.server.setRequestHandler(
    "skills/list",
    {
      params: z.object({ cursor: z.string().optional() }),
      result: z.object({ skills: z.array(z.any()), nextCursor: z.string().optional() }),
    },
    async () => ({ skills: [await skillEntry()] }),
  );
  server.server.setRequestHandler(
    "skills/get",
    { params: z.object({ uri: z.string() }), result: z.object({ skill: z.any() }) },
    async ({ uri }) => {
      if (uri !== SKILL_URI) throw new Error("Bento skill not found.");
      return { skill: await skillEntry() };
    },
  );

  return server;
}

const mcpHandler = createMcpHandler((context) => {
  if (!context.authInfo) throw new Error("Bento MCP requires authorization.");
  if (!context.requestInfo) throw new Error("Bento MCP request origin is missing.");
  const origin = new URL(context.requestInfo.url).origin;
  return createBentoMcpServer(context.authInfo, origin);
});

function configuredSupabaseUrl() {
  const value = process.env.SUPABASE_URL?.trim();
  if (!value) throw new Error("SUPABASE_URL is not configured.");
  return value.replace(/\/$/, "");
}

async function authenticateMcpRequest(request: Request): Promise<AuthInfo> {
  const match = request.headers
    .get("authorization")
    ?.match(/^Bearer ([A-Za-z0-9._~+/-]{20,8192})$/);
  if (!match) throw new RequestHttpError(401, "Unauthorized");
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!publishableKey) throw new Error("SUPABASE_PUBLISHABLE_KEY is not configured.");
  const token = match[1];
  const client = createClient<Database>(configuredSupabaseUrl(), publishableKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });
  // getClaims returns { data, error } for AuthError, but rethrows anything else.
  // A 3-part base64url token that is not a JWT (for example "aaaaaaaa.bbbbbbbb.cccccccc")
  // throws Error "Invalid UTF-8 sequence" from the decoder. That used to escape the
  // worker and become Cloudflare error 1101.
  let claimsResult: Awaited<ReturnType<typeof client.auth.getClaims>>;
  try {
    claimsResult = await client.auth.getClaims(token);
  } catch (verificationError) {
    console.error(
      "MCP bearer verification failed",
      verificationError instanceof Error ? verificationError.name : "unknown",
    );
    throw new RequestHttpError(401, "Unauthorized");
  }
  const { data, error } = claimsResult;
  const claims = data?.claims as Record<string, unknown> | undefined;
  const userId = claims?.sub;
  const clientId = claims?.client_id;
  if (error || typeof userId !== "string" || typeof clientId !== "string") {
    throw new RequestHttpError(401, "Unauthorized");
  }
  const verifiedClaims = claims as Record<string, unknown>;
  const scope =
    typeof verifiedClaims.scope === "string"
      ? verifiedClaims.scope.split(/\s+/).filter(Boolean)
      : OAUTH_SCOPES;
  return {
    token,
    clientId,
    scopes: scope,
    expiresAt: typeof verifiedClaims.exp === "number" ? verifiedClaims.exp : undefined,
    extra: { userId },
  };
}

function protectedResourceMetadata(request: Request) {
  const origin = new URL(request.url).origin;
  return Response.json(
    {
      resource: `${origin}${MCP_PATH}`,
      authorization_servers: [`${configuredSupabaseUrl()}/auth/v1`],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ["header"],
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
}

function applyMcpCors(response: Response, request: Request) {
  const vary = response.headers.get("vary");
  const variesByOrigin = vary?.split(",").some((part) => part.trim().toLowerCase() === "origin");
  if (!variesByOrigin) response.headers.set("vary", vary ? `${vary}, Origin` : "Origin");
  const origin = request.headers.get("origin");
  if (!origin || !MCP_BROWSER_ORIGINS.has(origin)) return response;
  response.headers.set("access-control-allow-origin", origin);
  response.headers.set("access-control-allow-methods", MCP_CORS_ALLOW_METHODS);
  response.headers.set("access-control-allow-headers", MCP_CORS_ALLOW_HEADERS);
  response.headers.set("access-control-expose-headers", MCP_CORS_EXPOSE_HEADERS);
  return response;
}

function unauthorized(request: Request, message = "Authorization required") {
  const metadata = `${new URL(request.url).origin}/.well-known/oauth-protected-resource`;
  return Response.json(
    { error: "unauthorized", message },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": `Bearer error="invalid_token", error_description="Authorization required", resource_metadata="${metadata}", scope="${OAUTH_SCOPES.join(" ")}"`,
      },
    },
  );
}

async function mcpInternalErrorResponse(request: { json: () => Promise<unknown> }) {
  const headers = { "cache-control": "no-store" };
  try {
    const body = (await request.json()) as { jsonrpc?: unknown; id?: unknown };
    if (body?.jsonrpc === "2.0") {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: { code: -32603, message: "Internal error" },
        },
        { status: 500, headers },
      );
    }
  } catch {
    // Not a JSON-RPC body. Fall through to a plain HTTP error.
  }
  return Response.json({ error: "internal_error" }, { status: 500, headers });
}

export async function handleBentoMcpRequest(
  request: Request,
  configuredOrigin: string | null | undefined,
  authenticate: (request: Request) => Promise<AuthInfo> = authenticateMcpRequest,
): Promise<Response | null> {
  const captured = request.clone();
  try {
    const response = await routeBentoMcpRequest(request, configuredOrigin, authenticate);
    return response ? applyMcpCors(response, request) : null;
  } catch (error) {
    console.error("MCP request failed", error instanceof Error ? error.name : "unknown");
    return applyMcpCors(await mcpInternalErrorResponse(captured), request);
  }
}

async function routeBentoMcpRequest(
  request: Request,
  configuredOrigin: string | null | undefined,
  authenticate: (request: Request) => Promise<AuthInfo>,
): Promise<Response | null> {
  const url = new URL(request.url);
  let expectedOrigin: string;
  try {
    const parsed = new URL(configuredOrigin?.trim() || "");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    expectedOrigin = parsed.origin;
  } catch {
    return null;
  }
  if (url.origin !== expectedOrigin) return null;
  if (
    url.pathname === "/.well-known/oauth-protected-resource" ||
    url.pathname === "/.well-known/oauth-protected-resource/mcp"
  ) {
    return protectedResourceMetadata(request);
  }
  if (url.pathname !== MCP_PATH) return null;
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin && !MCP_BROWSER_ORIGINS.has(origin)) {
    return Response.json({ error: "Invalid origin" }, { status: 403 });
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { Allow: MCP_CORS_ALLOW_METHODS } });
  }
  let authInfo: AuthInfo;
  try {
    authInfo = await authenticate(request);
  } catch (error) {
    if (error instanceof RequestHttpError && error.statusCode === 401) return unauthorized(request);
    throw error;
  }
  try {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "mcp", userIdFrom(authInfo));
  } catch (error) {
    if (error instanceof RequestHttpError) {
      return Response.json(
        { error: error.statusCode === 429 ? "rate_limited" : "temporarily_unavailable" },
        { status: error.statusCode, headers: { "cache-control": "no-store" } },
      );
    }
    throw error;
  }
  const response = await mcpHandler.fetch(request, { authInfo });
  response.headers.set("cache-control", "no-store");
  return response;
}
