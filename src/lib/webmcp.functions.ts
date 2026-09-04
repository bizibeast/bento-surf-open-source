import { configuredAppOrigin } from "@/lib/application-urls";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { defaultBentoMcpOperations } from "./mcp.server";
import type { CreatorMcpContext } from "./mcp.creator-ops.server";

export const BENTO_WEBMCP_READ_OPERATIONS = [
  "get_bento_overview",
  "list_social_accounts",
  "list_social_posts",
  "list_auto_dm_automations",
  "list_pages",
  "list_products",
  "list_bookings",
  "get_store_workspace",
  "get_calendar_workspace",
  "get_community_workspace",
  "get_profile_workspace",
  "get_analytics_workspace",
  "get_integration_workspace",
  "get_earn_workspace",
] as const;

export const BENTO_WEBMCP_WRITE_OPERATIONS = [
  "upload_media",
  "create_social_post",
  "save_auto_dm_automation",
  "set_auto_dm_enabled",
  "delete_auto_dm_automation",
  "manage_page",
  "manage_block",
  "manage_product",
  "manage_discount_code",
  "manage_order_bump",
  "manage_audience",
  "manage_calendar",
  "manage_community",
  "update_profile",
  "manage_earn",
] as const;

export type BentoWebMcpReadOperation = (typeof BENTO_WEBMCP_READ_OPERATIONS)[number];
export type BentoWebMcpWriteOperation = (typeof BENTO_WEBMCP_WRITE_OPERATIONS)[number];

const inputSchema = z.record(z.string(), z.unknown()).default({});

const webMcpReadSchemas = {
  get_bento_overview: z.object({}).strict(),
  list_social_accounts: z
    .object({
      provider: z
        .enum(["instagram", "facebook", "threads", "tiktok", "linkedin", "twitter", "youtube"])
        .optional(),
    })
    .strict(),
  list_social_posts: z
    .object({
      status: z
        .enum([
          "draft",
          "scheduled",
          "publishing",
          "published",
          "partially_failed",
          "failed",
          "cancelled",
        ])
        .optional(),
      limit: z.number().int().min(1).max(100).default(30),
    })
    .strict(),
  list_auto_dm_automations: z
    .object({ platform: z.enum(["instagram", "facebook", "twitter"]).optional() })
    .strict(),
  list_pages: z.object({}).strict(),
  list_products: z.object({ limit: z.number().int().min(1).max(100).default(30) }).strict(),
  list_bookings: z.object({ limit: z.number().int().min(1).max(100).default(30) }).strict(),
  get_store_workspace: z.object({ publicationId: z.string().uuid().optional() }).strict(),
  get_calendar_workspace: z.object({}).strict(),
  get_community_workspace: z.object({ productId: z.string().uuid().optional() }).strict(),
  get_profile_workspace: z.object({}).strict(),
  get_analytics_workspace: z
    .object({ range: z.enum(["today", "3d", "7d", "30d", "90d", "all"]).default("30d") })
    .strict(),
  get_integration_workspace: z.object({}).strict(),
  get_earn_workspace: z.object({}).strict(),
} satisfies Record<BentoWebMcpReadOperation, z.ZodType<Record<string, unknown>>>;

export function parseBentoWebMcpReadInput(
  operation: BentoWebMcpReadOperation,
  input: Record<string, unknown>,
): Record<string, unknown> {
  return webMcpReadSchemas[operation].parse(input) as Record<string, unknown>;
}

const webMcpUploadInputSchema = z
  .object({
    sourceUrl: z.string().url().optional(),
    base64: z.string().optional(),
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(100),
    kind: z.enum(["image", "video", "audio", "file"]),
  })
  .strict()
  .refine((value) => Boolean(value.sourceUrl) !== Boolean(value.base64), {
    message: "Provide exactly one of sourceUrl or base64.",
  });

const webMcpAutoDmIdentifierSchema = z
  .object({
    platform: z.enum(["instagram", "facebook", "twitter"]),
    id: z.string().uuid(),
  })
  .strict();

const webMcpAutoDmStateSchema = webMcpAutoDmIdentifierSchema
  .extend({ enabled: z.boolean() })
  .strict();

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function project(value: unknown, keys: readonly string[]) {
  const source = asRecord(value);
  return Object.fromEntries(
    keys
      .filter((key) => key in source)
      .map((key) => {
        const value = source[key];
        return [
          key,
          typeof value === "string" && value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value,
        ];
      }),
  );
}

function projectList(value: unknown, keys: readonly string[], limit = 50) {
  return Array.isArray(value) ? value.slice(0, limit).map((item) => project(item, keys)) : [];
}

const productFields = [
  "id",
  "slug",
  "public_slug",
  "title",
  "subtitle",
  "description",
  "kind",
  "status",
  "pricing_type",
  "price_amount",
  "currency",
  "billing_interval",
  "cta_label",
  "cover_url",
  "sales_count",
  "inventory_limit",
  "noindex",
  "created_at",
  "published_at",
] as const;

const bookingFields = [
  "id",
  "product_id",
  "buyer_name",
  "status",
  "starts_at",
  "ends_at",
  "timezone",
  "created_at",
] as const;

const socialAccountFields = [
  "id",
  "provider",
  "handle",
  "displayName",
  "avatarUrl",
  "status",
  "canPublish",
  "autoDmReady",
  "autoDmIssues",
  "needsReconnect",
  "lastVerifiedAt",
  "lastError",
  "connectedAt",
] as const;

function projectAutoDmAutomation(value: unknown) {
  const row = asRecord(value);
  return project(
    {
      id: row.id,
      connectionId: row.connection_id,
      name: row.name,
      triggerType: row.trigger_type,
      keywords: row.keywords,
      excludedKeywords: row.excluded_keywords,
      matchType: row.match_type,
      mediaScope: row.media_scope,
      mediaIds: row.media_ids,
      replyMessage: row.reply_message,
      publicReplyEnabled: row.public_reply_enabled,
      publicReplyMessages: row.public_reply_messages,
      openingMessage: row.opening_message,
      confirmationButtonLabel: row.confirmation_button_label,
      emailCaptureEnabled: row.email_capture_enabled,
      emailPromptMessage: row.email_prompt_message,
      emailMarketingConsentEnabled: row.email_marketing_consent_enabled,
      followGateEnabled: row.follow_gate_enabled,
      followPromptMessage: row.follow_prompt_message,
      followMaxRechecks: row.follow_max_rechecks,
      followFailAction: row.follow_fail_action,
      replyButtonLabel: row.reply_button_label,
      replyButtonUrl: row.reply_button_url,
      enabled: row.enabled,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    [
      "id",
      "connectionId",
      "name",
      "triggerType",
      "keywords",
      "excludedKeywords",
      "matchType",
      "mediaScope",
      "mediaIds",
      "replyMessage",
      "publicReplyEnabled",
      "publicReplyMessages",
      "openingMessage",
      "confirmationButtonLabel",
      "emailCaptureEnabled",
      "emailPromptMessage",
      "emailMarketingConsentEnabled",
      "followGateEnabled",
      "followPromptMessage",
      "followMaxRechecks",
      "followFailAction",
      "replyButtonLabel",
      "replyButtonUrl",
      "enabled",
      "createdAt",
      "updatedAt",
    ],
  );
}

export function sanitizeBentoWebMcpReadResult(
  operation: BentoWebMcpReadOperation,
  result: unknown,
): unknown {
  const data = asRecord(result);
  switch (operation) {
    case "get_bento_overview":
      return {
        profile: project(data.profile, [
          "id",
          "username",
          "display_name",
          "bio",
          "onboarded",
          "account_timezone",
        ]),
        plan: project(data.plan, ["id", "name"]),
        counts: project(data.counts, [
          "pages",
          "products",
          "socialPosts",
          "bookings",
          "socialConnections",
          "autoDmAutomations",
        ]),
        features: project(data.features, [
          "dashboard",
          "pages",
          "products",
          "scheduler",
          "automations",
          "analytics",
          "socialInsights",
          "bookings",
          "community",
          "settings",
        ]),
      };
    case "list_social_accounts":
      return projectList(result, socialAccountFields);
    case "list_social_posts":
      return Array.isArray(result)
        ? result.map((post) => {
            const safe = project(post, [
              "id",
              "body",
              "title",
              "scheduled_at",
              "timezone",
              "status",
              "created_at",
            ]);
            safe.targets = projectList(asRecord(post).targets, [
              "id",
              "connection_id",
              "provider",
              "status",
              "remote_post_url",
              "last_error_message",
              "published_at",
            ]);
            return safe;
          })
        : [];
    case "list_auto_dm_automations":
      return Array.isArray(result)
        ? result.map((group) => ({
            platform: asRecord(group).platform,
            connections: projectList(asRecord(group).connections, socialAccountFields),
            automations: Array.isArray(asRecord(group).automations)
              ? (asRecord(group).automations as unknown[]).slice(0, 50).map(projectAutoDmAutomation)
              : [],
          }))
        : [];
    case "list_pages":
      return {
        pages: projectList(data.pages, ["id", "name", "slug", "created_at"]),
        blocks: Array.isArray(data.blocks)
          ? data.blocks.map((block) => {
              const row = asRecord(block);
              const content = asRecord(row.content);
              return {
                ...project(row, ["id", "page_id", "type", "x", "y", "w", "h", "position"]),
                summary: project(content, [
                  "title",
                  "text",
                  "label",
                  "name",
                  "description",
                  "productId",
                ]),
              };
            })
          : [],
      };
    case "list_products":
      return projectList(result, productFields, 100);
    case "list_bookings":
      return projectList(result, bookingFields, 100);
    case "get_store_workspace":
      return {
        publications: projectList(data.publications, [
          "id",
          "title",
          "slug",
          "status",
          "is_default",
        ]),
        selectedPublicationId:
          typeof data.selectedPublicationId === "string" ? data.selectedPublicationId : null,
        products: projectList(data.products, productFields),
        orders: projectList(data.orders, [
          "id",
          "product_id",
          "status",
          "gross_amount",
          "net_amount",
          "refunded_amount",
          "currency",
          "created_at",
          "paid_at",
        ]),
        loadedLeadCount: Array.isArray(data.leads) ? data.leads.length : 0,
        loadedAudienceContactCount: Array.isArray(data.audienceContacts)
          ? data.audienceContacts.length
          : 0,
        audienceContacts: projectList(
          data.audienceContacts,
          ["id", "name", "marketing_status", "source", "created_at", "last_seen_at"],
          500,
        ),
        discountCodes: projectList(data.discountCodes, [
          "id",
          "product_id",
          "code",
          "discount_type",
          "discount_value",
          "currency",
          "is_active",
          "max_redemptions",
          "max_redemptions_per_email",
          "starts_at",
          "expires_at",
          "created_at",
          "updated_at",
        ]),
        orderBumps: projectList(data.orderBumps, [
          "id",
          "primary_product_id",
          "bump_product_id",
          "headline",
          "description",
          "is_active",
          "created_at",
        ]),
        audienceLists: projectList(data.audienceLists, [
          "id",
          "publication_id",
          "name",
          "description",
          "created_at",
          "updated_at",
        ]),
        audienceCampaigns: projectList(data.audienceCampaigns, [
          "id",
          "publication_id",
          "kind",
          "list_id",
          "name",
          "subject",
          "preview_text",
          "status",
          "scheduled_at",
          "sent_at",
          "created_at",
          "updated_at",
        ]),
      };
    case "get_calendar_workspace":
      return {
        availability: project(data.availability, [
          "timezone",
          "weeklyRules",
          "weekly_rules",
          "minimumNoticeMinutes",
          "minimum_notice_minutes",
          "maximumDaysAhead",
          "bufferBeforeMinutes",
          "bufferAfterMinutes",
          "slotIntervalMinutes",
          "dateOverrides",
        ]),
        calendarConnections: projectList(data.calendarConnections, [
          "id",
          "provider",
          "display_name",
          "status",
          "is_default",
          "last_error",
          "created_at",
        ]),
        fathomConnections: projectList(data.fathomConnections, [
          "id",
          "display_name",
          "status",
          "is_default",
          "last_error",
          "created_at",
        ]),
        sessions: projectList(data.sessions, productFields),
        bookings: projectList(data.bookings, bookingFields),
        reviews: projectList(data.reviews, [
          "id",
          "booking_id",
          "reviewer_name",
          "rating",
          "body",
          "is_public",
          "submitted_at",
          "created_at",
        ]),
        publicPage: project(data.publicPage, ["enabled", "name", "username"]),
      };
    case "get_community_workspace":
      return {
        products: projectList(data.products, productFields),
        selected: project(data.selected, productFields),
        members: projectList(data.members, [
          "id",
          "product_id",
          "member_name",
          "community_role",
          "status",
          "source",
          "created_at",
          "updated_at",
        ]),
        posts: projectList(data.posts, [
          "id",
          "product_id",
          "author_kind",
          "author_name",
          "title",
          "body",
          "resources",
          "is_pinned",
          "moderation_status",
          "created_at",
          "updated_at",
        ]),
        comments: projectList(data.comments, [
          "id",
          "post_id",
          "parent_comment_id",
          "author_kind",
          "author_name",
          "body",
          "moderation_status",
          "created_at",
          "updated_at",
        ]),
      };
    case "get_profile_workspace":
      return {
        profile: project(data.profile, [
          "id",
          "username",
          "display_name",
          "bio",
          "avatar_url",
          "cover_url",
          "theme",
          "accent_color",
          "badge_hidden",
          "calendar_page_enabled",
          "calendar_page_name",
          "social_insights_enabled",
          "store_page_enabled",
          "account_timezone",
          "onboarded",
          "noindex",
          "meta_title",
          "meta_description",
          "primary_font",
          "secondary_font",
          "header_mode",
          "pattern",
          "pattern_settings",
          "show_in_explore",
          "explore_category",
          "explore_review_status",
          "created_at",
          "updated_at",
        ]),
        plan: data.plan,
        limits: project(data.limits, [
          "analyticsHistoryDays",
          "maxPages",
          "storageMb",
          "maxLinksAndBlocks",
          "imageUploadMb",
          "videoUploadMb",
          "productAssetUploadMb",
        ]),
        usage: project(data.usage, ["pages", "blocks"]),
        paymentAccounts: projectList(data.paymentAccounts, [
          "id",
          "provider",
          "credential_mode",
          "onboarding_status",
          "charges_enabled",
          "payouts_enabled",
          "created_at",
        ]),
      };
    case "get_analytics_workspace": {
      const site = asRecord(data.site);
      return {
        range: data.range,
        timeZone: data.timeZone,
        site: {
          totalViews: site.totalViews,
          totalClicks: site.totalClicks,
          uniqueVisitors: site.uniqueVisitors,
          daily: projectList(site.daily, ["date", "views", "clicks", "uniqueVisitors"], 100),
          hourly: Array.isArray(site.hourly) ? site.hourly.slice(0, 24) : [],
          dimensions: projectList(site.dimensions, ["dimension", "value", "count"], 100),
          blockClicks: projectList(site.blockClicks, ["blockId", "clicks"], 100),
        },
        socialSnapshots: projectList(data.socialSnapshots, [
          "provider",
          "provider_handle",
          "provider_display_name",
          "provider_avatar_url",
          "followers",
          "following",
          "posts",
          "views",
          "reach",
          "engagements",
          "status",
          "note",
          "fetched_at",
        ]),
        socialContent: projectList(data.socialContent, [
          "provider",
          "remote_post_url",
          "caption",
          "content_type",
          "thumbnail_url",
          "views",
          "impressions",
          "reach",
          "engagements",
          "likes",
          "comments",
          "shares",
          "saves",
          "published_at",
          "fetched_at",
        ]),
      };
    }
    case "get_integration_workspace":
      return {
        social: projectList(data.social, [
          "id",
          "provider",
          "provider_handle",
          "provider_display_name",
          "status",
          "scopes",
          "connection_health",
          "last_error",
        ]),
        calendars: projectList(data.calendars, [
          "id",
          "provider",
          "display_name",
          "status",
          "is_default",
          "last_error",
        ]),
        fathom: projectList(data.fathom, [
          "id",
          "display_name",
          "status",
          "is_default",
          "last_error",
        ]),
        paymentAccounts: projectList(data.paymentAccounts, [
          "id",
          "provider",
          "credential_mode",
          "onboarding_status",
          "charges_enabled",
          "payouts_enabled",
          "created_at",
        ]),
      };
    case "get_earn_workspace":
      return {
        account: project(data.account, ["code", "status", "created_at"]),
        referralUrl: data.referralUrl,
        clickCount: data.clicks,
        referralCount: Array.isArray(data.referrals) ? data.referrals.length : 0,
        commissions: projectList(data.commissions, [
          "id",
          "status",
          "amount",
          "currency",
          "created_at",
          "available_at",
          "updated_at",
        ]),
        payouts: projectList(data.payouts, [
          "id",
          "status",
          "amount",
          "currency",
          "requested_at",
          "approved_at",
          "processed_at",
          "paid_at",
        ]),
        reach: projectList(data.reach, [
          "id",
          "provider",
          "canonical_post_url",
          "status",
          "baseline_views",
          "final_views",
          "reward_amount",
          "currency",
          "created_at",
        ]),
        settings: project(data.settings, [
          "commission_rate_bps",
          "payout_minimums",
          "reach_rates",
          "reach_cap",
        ]),
      };
    default:
      return result;
  }
}

export const runBentoWebMcpRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        operation: z.enum(BENTO_WEBMCP_READ_OPERATIONS),
        input: inputSchema,
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const creatorContext: CreatorMcpContext = {
      userId: context.userId,
      supabase: context.supabase,
    };
    const input = parseBentoWebMcpReadInput(data.operation, data.input);
    const result = await (async () => {
      switch (data.operation) {
        case "get_bento_overview":
          return defaultBentoMcpOperations.getBentoOverview(
            context.userId,
            configuredAppOrigin(process.env.VITE_APP_URL),
          );
        case "list_social_accounts":
          return defaultBentoMcpOperations.listSocialAccounts(
            context.userId,
            typeof input.provider === "string" ? input.provider : undefined,
          );
        case "list_social_posts":
          return defaultBentoMcpOperations.listSocialPosts(
            context.userId,
            typeof input.status === "string" ? input.status : undefined,
            typeof input.limit === "number" ? input.limit : 30,
          );
        case "list_auto_dm_automations":
          return defaultBentoMcpOperations.listAutoDmAutomations(
            context.userId,
            typeof input.platform === "string" ? (input.platform as never) : undefined,
          );
        case "list_pages":
          return defaultBentoMcpOperations.listPages(context.userId);
        case "list_products":
          return defaultBentoMcpOperations.listProducts(
            context.userId,
            typeof input.limit === "number" ? input.limit : 30,
          );
        case "list_bookings":
          return defaultBentoMcpOperations.listBookings(
            context.userId,
            typeof input.limit === "number" ? input.limit : 30,
          );
        case "get_store_workspace":
          return defaultBentoMcpOperations.getStoreWorkspace(
            creatorContext,
            typeof input.publicationId === "string" ? input.publicationId : undefined,
          );
        case "get_calendar_workspace":
          return defaultBentoMcpOperations.getCalendarWorkspace(creatorContext);
        case "get_community_workspace":
          return defaultBentoMcpOperations.getCommunityWorkspace(
            creatorContext,
            typeof input.productId === "string" ? input.productId : undefined,
          );
        case "get_profile_workspace":
          return defaultBentoMcpOperations.getProfileWorkspace(creatorContext);
        case "get_analytics_workspace":
          return defaultBentoMcpOperations.getAnalyticsWorkspace(creatorContext, {
            range:
              typeof input.range === "string"
                ? (input.range as "today" | "3d" | "7d" | "30d" | "90d" | "all")
                : "30d",
          });
        case "get_integration_workspace":
          return defaultBentoMcpOperations.getIntegrationWorkspace(creatorContext);
        case "get_earn_workspace":
          return defaultBentoMcpOperations.getEarnWorkspace(creatorContext);
      }
    })();
    return sanitizeBentoWebMcpReadResult(data.operation, result) as JsonValue;
  });

export const runBentoWebMcpWrite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        operation: z.enum(BENTO_WEBMCP_WRITE_OPERATIONS),
        input: inputSchema,
        confirmed: z.literal(true, {
          errorMap: () => ({ message: "Review and confirm this change before applying it." }),
        }),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const creatorContext: CreatorMcpContext = {
      userId: context.userId,
      supabase: context.supabase,
    };
    const input = data.input;
    switch (data.operation) {
      case "upload_media": {
        const mediaInput = webMcpUploadInputSchema.parse(input);
        return defaultBentoMcpOperations.uploadMedia(
          {
            token: context.accessToken,
            clientId: "webmcp",
            scopes: [],
            extra: { userId: context.userId },
          },
          configuredAppOrigin(process.env.VITE_APP_URL),
          mediaInput,
        );
      }
      case "create_social_post": {
        const mode = input.mode;
        if (!["draft", "schedule", "publish_now"].includes(String(mode))) {
          throw new Error("Choose draft, schedule, or publish_now mode.");
        }
        if (mode === "schedule" && typeof input.scheduledAt !== "string") {
          throw new Error("Choose an ISO timestamp when scheduling a post.");
        }
        const { mode: _mode, ...post } = input;
        return defaultBentoMcpOperations.saveSocialPostForUser(context.userId, {
          ...post,
          scheduledAt: mode === "schedule" ? input.scheduledAt : null,
          asDraft: mode === "draft",
          publishNow: mode === "publish_now",
        });
      }
      case "save_auto_dm_automation": {
        const { platform, ...automation } = input;
        if (!["instagram", "facebook", "twitter"].includes(String(platform))) {
          throw new Error("Choose Instagram, Facebook, or X.");
        }
        return defaultBentoMcpOperations.saveAutoDmAutomation(
          context.userId,
          platform as never,
          automation,
        );
      }
      case "set_auto_dm_enabled": {
        const autoDmState = webMcpAutoDmStateSchema.parse(input);
        return defaultBentoMcpOperations.setAutoDmEnabled(
          context.userId,
          autoDmState.platform,
          autoDmState.id,
          autoDmState.enabled,
        );
      }
      case "delete_auto_dm_automation": {
        const autoDmDelete = webMcpAutoDmIdentifierSchema.parse(input);
        return defaultBentoMcpOperations.deleteAutoDmAutomation(
          context.userId,
          autoDmDelete.platform,
          autoDmDelete.id,
        );
      }
      case "manage_page":
        return defaultBentoMcpOperations.mutatePage(creatorContext, input);
      case "manage_block":
        return defaultBentoMcpOperations.mutateBlock(creatorContext, input);
      case "manage_product":
        return defaultBentoMcpOperations.mutateProduct(creatorContext, input);
      case "manage_discount_code":
        return defaultBentoMcpOperations.mutateDiscount(creatorContext, input);
      case "manage_order_bump":
        return defaultBentoMcpOperations.mutateOrderBump(creatorContext, input);
      case "manage_audience":
        return defaultBentoMcpOperations.mutateAudience(creatorContext, input);
      case "manage_calendar":
        return defaultBentoMcpOperations.mutateCalendar(creatorContext, input);
      case "manage_community":
        return defaultBentoMcpOperations.mutateCommunity(creatorContext, input);
      case "update_profile":
        return defaultBentoMcpOperations.updateCreatorProfile(creatorContext, input);
      case "manage_earn":
        return defaultBentoMcpOperations.mutateEarn(creatorContext, input);
    }
  });
