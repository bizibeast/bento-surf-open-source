/* eslint-disable @typescript-eslint/no-explicit-any -- ChatGPT adapters project heterogeneous service records. */
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod-v4";
import type { CreatorMcpContext } from "./mcp.creator-ops.server";
import { reorderPagesForCreator } from "./pages.functions";
import { schedulerReadFiltersShape } from "./mcp-scheduler-read";
import type { listSchedulerPosts } from "./mcp-scheduler-read.server";
import { sanitizeMcpReadData } from "./mcp-read-results";
import { postingScheduleSchema } from "./social-scheduler";

export const CHATGPT_MCP_PATH = "/chatgpt/mcp";
export const CHATGPT_MCP_INSTRUCTIONS =
  "Use list tools to read IDs before creating or updating. Counts are summaries, not proof of individual posts; paginate list_social_posts and retain publication and metric timestamps. Page tools edit the creator's public link-in-bio. Social tools save a draft or a scheduled post in Bento. Create Auto-DM starts paused unless enabled is true. This server has no store, product, discount, checkout, payment, booking, or referral tools.";

/** Checkout, paid booking, and tip blocks stay on the full MCP server. */
const HIDDEN_BLOCK_TYPES = new Set(["booking", "commerce", "tip_jar"]);
const PAGE_BLOCK_TYPES = [
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
  "contact",
  "audio",
  "file_download",
  "divider",
  "section_title",
  "experience",
] as const;

const pageBlockTypeSchema = z.enum(PAGE_BLOCK_TYPES);
const platformSchema = z.enum(["instagram", "facebook", "twitter"]);
const socialProviderSchema = z.enum([
  "instagram",
  "facebook",
  "threads",
  "tiktok",
  "linkedin",
  "twitter",
  "youtube",
]);
const socialPostStatusSchema = z.enum([
  "draft",
  "scheduled",
  "publishing",
  "published",
  "partially_failed",
  "failed",
  "cancelled",
]);
const mediaSchema = z.object({
  key: z.string(),
  url: z.url(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().positive(),
});
const captionSchema = z.object({
  connectionId: z.uuid(),
  bodyOverride: z.string().max(25_000),
});
const blockLayoutItemSchema = z.object({
  id: z.uuid(),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1).max(4),
  height: z.number().int().min(1).max(6),
  position: z.number().int().min(0),
});

type ChatGptAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

const READ: ChatGptAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export type ChatGptToolOperations = {
  getBentoOverview: (userId: string, origin: string) => Promise<any>;
  getProfileWorkspace: (context: CreatorMcpContext) => Promise<any>;
  listPages: (userId: string) => Promise<{ pages: any[]; blocks: any[] }>;
  mutatePage: (context: CreatorMcpContext, input: any) => Promise<any>;
  mutateBlock: (context: CreatorMcpContext, input: any) => Promise<any>;
  reorderPages: (context: CreatorMcpContext, pageIds: string[]) => Promise<{ ok: true }>;
  listSocialAccounts: (userId: string, provider?: string) => Promise<any>;
  listSocialPosts: typeof listSchedulerPosts;
  saveSocialPostForUser: (userId: string, input: any) => Promise<any>;
  getSchedulerWorkspace: (userId: string) => Promise<any>;
  manageScheduler: (userId: string, input: any) => Promise<any>;
  getMcpContentBrain: (userId: string) => Promise<any>;
  getMcpContentMedia: (userId: string, input: any) => Promise<any>;
  uploadMedia: (authInfo: AuthInfo, origin: string, input: any) => Promise<any>;
  beginMcpMediaUpload: (userId: string, origin: string, input: any) => Promise<any>;
  getAnalyticsWorkspace: (context: CreatorMcpContext, input: any) => Promise<any>;
  listAutoDmAutomations: (
    userId: string,
    platform?: "instagram" | "facebook" | "twitter",
  ) => Promise<any>;
  saveAutoDmAutomation: (
    userId: string,
    platform: "instagram" | "facebook" | "twitter",
    input: unknown,
  ) => Promise<any>;
  setAutoDmEnabled: (
    userId: string,
    platform: "instagram" | "facebook" | "twitter",
    id: string,
    enabled: boolean,
  ) => Promise<any>;
  deleteAutoDmAutomation: (
    userId: string,
    platform: "instagram" | "facebook" | "twitter",
    id: string,
  ) => Promise<any>;
};

const OVERVIEW_FEATURE_KEYS = [
  "pages",
  "scheduler",
  "automations",
  "analytics",
  "socialInsights",
  "settings",
  "content",
] as const;

function userIdFrom(authInfo: AuthInfo) {
  const userId = authInfo.extra?.userId;
  if (typeof userId !== "string") throw new Error("Bento account authorization is missing.");
  return userId;
}

function textResult(message: string, data: Record<string, unknown>) {
  return {
    content: [
      { type: "text" as const, text: message },
      { type: "text" as const, text: JSON.stringify(data) },
    ],
    structuredContent: data,
  };
}

function connectionOverrides(
  captions: { connectionId: string; bodyOverride: string }[] | undefined,
) {
  if (!captions?.length) return undefined;
  return Object.fromEntries(
    captions.map((item) => [item.connectionId, { bodyOverride: item.bodyOverride }]),
  );
}

function publicOverview(overview: any) {
  const counts = { ...(overview?.counts || {}) };
  delete counts.products;
  delete counts.bookings;
  const source = overview?.features || {};
  const features = Object.fromEntries(
    OVERVIEW_FEATURE_KEYS.filter((key) => typeof source[key] === "string").map((key) => [
      key,
      source[key],
    ]),
  );
  return { profile: overview?.profile, plan: overview?.plan, counts, features };
}

function publicProfile(profile: any) {
  if (!profile || typeof profile !== "object") return profile;
  const { paymentAccounts: _paymentAccounts, ...rest } = profile;
  return rest;
}

function publicAnalytics(analytics: any) {
  if (!analytics || typeof analytics !== "object") return analytics;
  const { dataAccess: _dataAccess, ...rest } = analytics;
  return rest;
}

function visibleBlocks(blocks: any[]) {
  return (blocks || []).filter((block) => !HIDDEN_BLOCK_TYPES.has(String(block?.type)));
}

export function chatGptOperations(
  base: Omit<ChatGptToolOperations, "reorderPages">,
): ChatGptToolOperations {
  return {
    ...base,
    reorderPages: (context, pageIds) =>
      reorderPagesForCreator(context.supabase, context.userId, pageIds),
  };
}

export function registerChatGptTools(
  server: Pick<McpServer, "registerTool">,
  authInfo: AuthInfo,
  origin: string,
  operations: ChatGptToolOperations,
  creatorContext: () => CreatorMcpContext,
) {
  const userId = userIdFrom(authInfo);
  const register = (
    name: string,
    title: string,
    description: string,
    annotations: ChatGptAnnotations,
    inputSchema: z.ZodType,
    handler: (input: any) => Promise<ReturnType<typeof textResult>>,
  ) => {
    server.registerTool(name, { title, description, annotations, inputSchema }, handler);
  };

  async function loadPages() {
    const loaded = await operations.listPages(userId);
    return {
      pages: loaded?.pages || [],
      blocks: loaded?.blocks || [],
    };
  }

  async function requireEditableBlock(id: string) {
    // ponytail: listPages returns at most 300 blocks. A block past that cap is treated as missing until that shared read is paged.
    const { blocks } = await loadPages();
    const block = blocks.find((item) => item?.id === id);
    if (!block || HIDDEN_BLOCK_TYPES.has(String(block.type))) throw new Error("Block not found.");
    return block;
  }

  register(
    "get_bento_overview",
    "Get Bento overview",
    "Read the signed-in creator's profile, plan, page and social counts, and links to pages, the scheduler, Auto-DMs, analytics, and content.",
    READ,
    z.object({}),
    async () =>
      textResult("Loaded the Bento workspace overview.", {
        overview: publicOverview(await operations.getBentoOverview(userId, origin)),
      }),
  );

  register(
    "get_profile",
    "Get profile",
    "Read the creator's editable profile, plan, limits, and page and block usage.",
    READ,
    z.object({}),
    async () =>
      textResult("Loaded the Bento profile.", {
        profile: publicProfile(await operations.getProfileWorkspace(creatorContext())),
      }),
  );

  register(
    "list_pages",
    "List pages",
    "List the creator's Bento pages.",
    READ,
    z.object({}),
    async () => {
      const { pages } = await loadPages();
      return textResult(`Found ${pages.length} page(s).`, { pages });
    },
  );

  register(
    "get_page",
    "Get page",
    "Read one Bento page and the blocks on it.",
    READ,
    z.object({ id: z.uuid() }),
    async ({ id }) => {
      const { pages, blocks } = await loadPages();
      const page = pages.find((item) => item?.id === id);
      if (!page) throw new Error("Page not found.");
      return textResult("Loaded the Bento page.", {
        page,
        blocks: visibleBlocks(blocks.filter((block) => block?.page_id === id)),
      });
    },
  );

  register(
    "create_page",
    "Create page",
    "Create a secondary Bento page with a name and an optional public URL.",
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    z.object({
      name: z.string().min(1).max(40),
      url: z.url().nullable().optional(),
    }),
    async (input) =>
      textResult("Created the Bento page.", {
        page: await operations.mutatePage(creatorContext(), { action: "create", ...input }),
      }),
  );

  register(
    "update_page",
    "Update page",
    "Rename one Bento page the creator owns.",
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    z.object({ id: z.uuid(), name: z.string().min(1).max(40) }),
    async (input) =>
      textResult("Renamed the Bento page.", {
        page: await operations.mutatePage(creatorContext(), { action: "rename", ...input }),
      }),
  );

  register(
    "reorder_pages",
    "Reorder pages",
    "Set the order of the creator's visible pages. Pass every visible page ID once.",
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    z.object({ pageIds: z.array(z.uuid()).min(1).max(100) }),
    async ({ pageIds }) =>
      textResult("Reordered Bento pages.", {
        result: await operations.reorderPages(creatorContext(), pageIds),
      }),
  );

  register(
    "delete_page",
    "Delete page",
    "Permanently delete one secondary Bento page and the blocks on it.",
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    z.object({ id: z.uuid() }),
    async ({ id }) =>
      textResult("Deleted the Bento page.", {
        result: await operations.mutatePage(creatorContext(), { action: "delete", id }),
      }),
  );

  register(
    "list_page_blocks",
    "List page blocks",
    "List link, media, text, and layout blocks. Pass pageId to limit the list to one page. Omit pageId to include home-page blocks.",
    READ,
    z.object({ pageId: z.uuid().optional() }),
    async ({ pageId }) => {
      const { blocks } = await loadPages();
      const matched = pageId ? blocks.filter((block) => block?.page_id === pageId) : blocks;
      const visible = visibleBlocks(matched);
      return textResult(`Found ${visible.length} block(s).`, { blocks: visible });
    },
  );

  register(
    "get_page_block",
    "Get page block",
    "Read one link, media, text, or layout block by ID.",
    READ,
    z.object({ id: z.uuid() }),
    async ({ id }) => {
      const block = await requireEditableBlock(id);
      return textResult("Loaded the Bento block.", { block });
    },
  );

  register(
    "create_page_block",
    "Create page block",
    "Add a link, image, video, audio, file, heading, note, quote, map, Spotify, email-capture, contact, divider, or section block to a page. Omit pageId to place it on the home page.",
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    z.object({
      type: pageBlockTypeSchema,
      content: z.record(z.string().max(100), z.unknown()).default({}),
      coverUrl: z.url().nullable().optional(),
      width: z.number().int().min(1).max(4).default(2),
      height: z.number().int().min(1).max(6).default(2),
      x: z.number().int().min(0).optional(),
      y: z.number().int().min(0).optional(),
      pageId: z.uuid().nullable().optional(),
    }),
    async (input) =>
      textResult("Created the Bento block.", {
        block: await operations.mutateBlock(creatorContext(), { action: "create", ...input }),
      }),
  );

  register(
    "update_page_block",
    "Update page block",
    "Change the content, cover, or size of one existing link, media, text, or layout block.",
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    z.object({
      id: z.uuid(),
      content: z.record(z.string().max(100), z.unknown()).optional(),
      coverUrl: z.url().nullable().optional(),
      width: z.number().int().min(1).max(4).optional(),
      height: z.number().int().min(1).max(6).optional(),
    }),
    async (input) => {
      await requireEditableBlock(input.id);
      return textResult("Updated the Bento block.", {
        block: await operations.mutateBlock(creatorContext(), { action: "update", ...input }),
      });
    },
  );

  register(
    "reorder_page_blocks",
    "Reorder page blocks",
    "Move blocks on the creator's page grid. Pass the new x, y, width, height, and position for each block you want to place.",
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    z.object({ items: z.array(blockLayoutItemSchema).max(200) }),
    async ({ items }) => {
      await Promise.all(items.map((item: { id: string }) => requireEditableBlock(item.id)));
      return textResult("Reordered Bento blocks.", {
        result: await operations.mutateBlock(creatorContext(), { action: "layout", items }),
      });
    },
  );

  register(
    "delete_page_block",
    "Delete page block",
    "Permanently delete one link, media, text, or layout block.",
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    z.object({ id: z.uuid() }),
    async ({ id }) => {
      await requireEditableBlock(id);
      return textResult("Deleted the Bento block.", {
        result: await operations.mutateBlock(creatorContext(), { action: "delete", id }),
      });
    },
  );

  register(
    "list_social_accounts",
    "List social accounts",
    "List connected social profiles and whether each one can publish or run Auto-DMs.",
    READ,
    z.object({ provider: socialProviderSchema.optional() }),
    async ({ provider }) => {
      const accounts = await operations.listSocialAccounts(userId, provider);
      return textResult(`Found ${accounts.length} connected social account(s).`, { accounts });
    },
  );

  register(
    "list_social_posts",
    "List social posts",
    "List stored Scheduler posts with full captions and destination settings. Follow pagination.nextCursor using cursor. status is parent state; targetStatus is platform state; date bounds default to destination published_at. No provider refresh.",
    READ,
    z.object({
      status: socialPostStatusSchema.optional(),
      ...schedulerReadFiltersShape,
      limit: z.number().int().min(1).max(100).default(30),
    }),
    async ({ status, limit, ...filters }) => {
      const result = await operations.listSocialPosts(userId, status, limit, filters);
      return textResult(
        `Found ${result.posts.length} social post(s) on this page.`,
        sanitizeMcpReadData(result),
      );
    },
  );

  register(
    "draft_social_post",
    "Draft social post",
    "Save a new social post as a draft in Bento. This does not publish or schedule it.",
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    z.object({
      body: z.string().max(25_000),
      title: z.string().max(300).default(""),
      connectionIds: z.array(z.uuid()).max(20).default([]),
      media: z.array(mediaSchema).max(10).default([]),
      captions: z.array(captionSchema).max(20).optional(),
      timezone: z.string().min(1).max(100).default("UTC"),
    }),
    async ({ captions, ...input }) =>
      textResult("Saved the social draft.", {
        post: await operations.saveSocialPostForUser(userId, {
          ...input,
          connectionOverrides: connectionOverrides(captions),
          scheduledAt: null,
          asDraft: true,
          publishNow: false,
        }),
      }),
  );

  register(
    "schedule_social_post",
    "Schedule social post",
    "Create a social post, or schedule an existing draft when id is set, for a future time on the selected accounts. This does not publish immediately.",
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    z.object({
      id: z.uuid().optional(),
      body: z.string().max(25_000),
      title: z.string().max(300).default(""),
      connectionIds: z.array(z.uuid()).min(1).max(20),
      media: z.array(mediaSchema).max(10).default([]),
      captions: z.array(captionSchema).max(20).optional(),
      scheduledAt: z.iso.datetime({ offset: true }),
      timezone: z.string().min(1).max(100).default("UTC"),
    }),
    async ({ captions, ...input }) =>
      textResult("Scheduled the social post.", {
        post: await operations.saveSocialPostForUser(userId, {
          ...input,
          connectionOverrides: connectionOverrides(captions),
          asDraft: false,
          publishNow: false,
        }),
      }),
  );

  register(
    "update_social_post",
    "Update social post",
    "Replace the caption, title, destinations, and media of one existing social post. Pass scheduledAt to keep or set a future publish time. Omit scheduledAt to store it as a draft. This does not publish immediately.",
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    z.object({
      id: z.uuid(),
      body: z.string().max(25_000),
      title: z.string().max(300).default(""),
      connectionIds: z.array(z.uuid()).max(20),
      media: z.array(mediaSchema).max(10),
      captions: z.array(captionSchema).max(20).optional(),
      scheduledAt: z.iso.datetime({ offset: true }).optional(),
      timezone: z.string().min(1).max(100).default("UTC"),
    }),
    async ({ captions, scheduledAt, ...input }) =>
      textResult(scheduledAt ? "Updated the scheduled social post." : "Updated the social draft.", {
        post: await operations.saveSocialPostForUser(userId, {
          ...input,
          connectionOverrides: connectionOverrides(captions),
          scheduledAt: scheduledAt ?? null,
          asDraft: !scheduledAt,
          publishNow: false,
        }),
      }),
  );

  register(
    "cancel_social_post",
    "Cancel social post",
    "Cancel one scheduled social post so Bento does not publish it. The post remains in the workspace with a cancelled status.",
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    z.object({ id: z.uuid() }),
    async ({ id }) =>
      textResult("Cancelled the social post.", {
        scheduler: await operations.manageScheduler(userId, { action: "cancel_post", id }),
      }),
  );

  register(
    "get_content_calendar",
    "Get content calendar",
    "Read saved posting times and the posts currently scheduled in Bento.",
    READ,
    z.object({}),
    async () => {
      const scheduler = await operations.getSchedulerWorkspace(userId);
      const posts = Array.isArray(scheduler?.posts) ? scheduler.posts : [];
      return textResult("Loaded the content calendar.", {
        calendar: {
          postingSchedule: scheduler?.postingSchedule ?? null,
          scheduledPosts: posts.filter((post: { status?: string }) => post?.status === "scheduled"),
        },
      });
    },
  );

  register(
    "update_content_calendar",
    "Update content calendar",
    "Save the creator's weekly posting times and timezone. This does not publish a post.",
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    z.object({ schedule: postingScheduleSchema }),
    async ({ schedule }) =>
      textResult("Saved posting times.", {
        scheduler: await operations.manageScheduler(userId, {
          action: "save_posting_schedule",
          schedule,
        }),
      }),
  );

  register(
    "get_content_brain",
    "Get Content Brain",
    "Read the creator's content profile, voice, Brain document previews, connected sources, and indexing status.",
    READ,
    z.object({}),
    async () =>
      textResult("Loaded Content Brain.", { brain: await operations.getMcpContentBrain(userId) }),
  );

  register(
    "get_content_media",
    "Get content media",
    "List or search media already stored in the creator's Brain library, including folders and library limits.",
    READ,
    z.object({
      page: z.number().int().min(0).max(100).default(0),
      query: z.string().trim().max(300).optional(),
      previewOld: z.boolean().optional(),
    }),
    async (input) =>
      textResult("Loaded Brain Media.", {
        media: await operations.getMcpContentMedia(userId, input),
      }),
  );

  register(
    "upload_media",
    "Upload media",
    "Import one public media URL, or inline base64 up to 25 MB, into the creator's Bento media library. This does not publish a post or create a product.",
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    z.object({
      sourceUrl: z.url().optional(),
      base64: z.string().optional(),
      fileName: z.string().min(1).max(255),
      mimeType: z.string().min(1).max(100),
      kind: z.enum(["image", "video", "audio", "file"]),
    }),
    async (input) =>
      textResult("Uploaded media to Bento.", {
        media: await operations.uploadMedia(authInfo, origin, input),
      }),
  );

  register(
    "begin_media_upload",
    "Begin media upload",
    "Prepare a private two-hour upload for an original local file larger than inline base64. Returns the upload credential and chunk instructions. This does not fetch a remote file or publish a post.",
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    z.object({
      fileName: z.string().min(1).max(255),
      mimeType: z.string().min(1).max(100),
      kind: z.enum(["image", "video", "audio", "file"]),
      size: z
        .number()
        .int()
        .positive()
        .max(5 * 1024 * 1024 * 1024),
    }),
    async (input) =>
      textResult("Prepared the media upload.", {
        upload: await operations.beginMcpMediaUpload(userId, origin, input),
      }),
  );

  register(
    "get_analytics",
    "Get analytics",
    "Read stored site views and clicks, social account snapshots, and recent post performance. This does not refresh providers.",
    READ,
    z.object({ range: z.enum(["today", "3d", "7d", "30d", "90d", "all"]).default("30d") }),
    async (input) =>
      textResult("Loaded Bento analytics.", {
        analytics: publicAnalytics(await operations.getAnalyticsWorkspace(creatorContext(), input)),
      }),
  );

  register(
    "list_auto_dm_automations",
    "List Auto-DM automations",
    "List Instagram, Facebook, and X Auto-DM automations and whether the connected account is ready.",
    READ,
    z.object({ platform: platformSchema.optional() }),
    async ({ platform }) =>
      textResult("Loaded Auto-DM automations.", {
        automations: await operations.listAutoDmAutomations(userId, platform),
      }),
  );

  const autoDmCreateSchema = z.object({
    platform: platformSchema,
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
    enabled: z.boolean().default(false),
  });

  register(
    "create_auto_dm_automation",
    "Create Auto-DM automation",
    "Create an Instagram, Facebook, or X Auto-DM automation. It stays paused unless enabled is true. Use set_auto_dm_enabled to turn a paused automation on.",
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    autoDmCreateSchema,
    async ({ platform, ...input }) =>
      textResult(`Created the ${platform} Auto-DM automation.`, {
        platform,
        automation: await operations.saveAutoDmAutomation(userId, platform, input),
      }),
  );

  register(
    "update_auto_dm_automation",
    "Update Auto-DM automation",
    "Change fields on one existing Instagram, Facebook, or X Auto-DM automation. Omitted fields stay as they are.",
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    z.object({
      platform: platformSchema,
      id: z.uuid(),
      connectionId: z.uuid().optional(),
      name: z.string().min(1).max(80).optional(),
      triggerType: z.string().min(1).max(80).optional(),
      keywords: z.array(z.string()).max(20).optional(),
      excludedKeywords: z.array(z.string()).max(20).optional(),
      matchType: z.enum(["contains", "exact"]).optional(),
      mediaScope: z.enum(["any", "specific", "future"]).optional(),
      mediaIds: z.array(z.string()).max(100).optional(),
      replyMessage: z.string().min(1).max(10_000).optional(),
      publicReplyEnabled: z.boolean().optional(),
      publicReplyMessages: z.array(z.string()).max(3).optional(),
      openingMessage: z.string().nullable().optional(),
      confirmationButtonLabel: z.string().nullable().optional(),
      emailCaptureEnabled: z.boolean().optional(),
      emailPromptMessage: z.string().nullable().optional(),
      emailMarketingConsentEnabled: z.boolean().optional(),
      followGateEnabled: z.boolean().optional(),
      followPromptMessage: z.string().optional(),
      followMaxRechecks: z.number().int().min(1).max(3).optional(),
      followFailAction: z.enum(["send_anyway", "withhold"]).optional(),
      replyButtonLabel: z.string().nullable().optional(),
      replyButtonUrl: z.url().nullable().optional(),
      enabled: z.boolean().optional(),
    }),
    async ({ platform, ...input }) =>
      textResult(`Updated the ${platform} Auto-DM automation.`, {
        platform,
        automation: await operations.saveAutoDmAutomation(userId, platform, input),
      }),
  );

  register(
    "set_auto_dm_enabled",
    "Set Auto-DM enabled",
    "Enable or pause one Instagram, Facebook, or X Auto-DM automation. Enabling lets that automation message people on the connected account.",
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    z.object({ platform: platformSchema, id: z.uuid(), enabled: z.boolean() }),
    async ({ platform, id, enabled }) =>
      textResult(`${enabled ? "Enabled" : "Paused"} the ${platform} Auto-DM automation.`, {
        platform,
        automation: await operations.setAutoDmEnabled(userId, platform, id, enabled),
      }),
  );

  register(
    "delete_auto_dm_automation",
    "Delete Auto-DM automation",
    "Permanently delete one Instagram, Facebook, or X Auto-DM automation so it no longer messages people.",
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    z.object({ platform: platformSchema, id: z.uuid() }),
    async ({ platform, id }) =>
      textResult(`Deleted the ${platform} Auto-DM automation.`, {
        platform,
        ...(await operations.deleteAutoDmAutomation(userId, platform, id)),
      }),
  );
}
