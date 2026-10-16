import { z } from "zod";
import { agentBranding } from "./content-agent-branding";
import {
  contentAgentPreferencesInputSchema,
  getContentAgentPreferences,
  getContentPublishingAccounts,
  updateContentAgentPreferences,
} from "./content-agent-preferences.functions";
import {
  deleteContentAgentChat,
  listContentAgentThreads,
  markContentAgentThreadRead,
  prepareContentAgentDraft,
  renameContentAgentChat,
  setContentAgentThreadPinned,
} from "./content-agent.functions";
import {
  attachAgentDraftImage,
  clearAgentDraftBackgrounds,
  getAgentDraftImages,
} from "./content-agent-images.functions";
import { requireWebMcpUserConfirmation, webMcpResult, type WebMcpTool } from "./webmcp";

const draftRef = z
  .object({
    messageId: z.string().uuid(),
    cardId: z.string().min(1).max(100),
    revision: z.number().int().nonnegative(),
  })
  .strict();

function parseEditablePreferences(input: Record<string, unknown>) {
  return contentAgentPreferencesInputSchema
    .pick({
      branding: true,
      destinationAccounts: true,
      displayName: true,
      proactivePaused: true,
      generateImages: true,
      platforms: true,
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, "Choose at least one Agent setting.")
    .parse(input);
}

const visualAction = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("prepare"),
      messageId: z.string().uuid(),
      cardId: z.string().min(1).max(100),
    })
    .strict(),
  z
    .object({
      action: z.literal("attach_existing"),
      draftRef,
      mediaId: z.string().uuid(),
      slideIndex: z.number().int().min(0).max(9).default(0),
    })
    .strict(),
  z.object({ action: z.literal("clear_backgrounds"), draftRef }).strict(),
]);

const chatAction = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("set_pinned"), threadId: z.string().uuid(), pinned: z.boolean() })
    .strict(),
  z
    .object({
      action: z.literal("mark_read"),
      threadId: z.string().uuid(),
      throughMessageId: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("rename"),
      threadId: z.string().uuid(),
      title: z.string().trim().min(1).max(160),
    })
    .strict(),
  z.object({ action: z.literal("delete"), threadId: z.string().uuid() }).strict(),
]);

const draftRefProperties = {
  messageId: { type: "string", format: "uuid" },
  cardId: { type: "string", minLength: 1, maxLength: 100 },
  revision: { type: "integer", minimum: 0 },
};
const draftRefJsonSchema = {
  type: "object",
  properties: draftRefProperties,
  required: ["messageId", "cardId", "revision"],
  additionalProperties: false,
};

export function createContentAgentWebMcpTools({
  refresh,
  openTab,
}: {
  refresh: () => Promise<void>;
  openTab: (tab: "discover" | "agent" | "brain") => void | Promise<void>;
}): WebMcpTool[] {
  return [
    {
      name: "open_content_tab",
      title: "Open a Content workspace tab",
      description: "Opens the visible Discover, Agent, or Brain tab in this Bento workspace.",
      inputSchema: {
        type: "object",
        properties: { tab: { type: "string", enum: ["discover", "agent", "brain"] } },
        required: ["tab"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(input, { signal }) {
        const { tab } = z
          .object({ tab: z.enum(["discover", "agent", "brain"]) })
          .strict()
          .parse(input);
        signal.throwIfAborted();
        await requireWebMcpUserConfirmation("Open this Content tab", { tab });
        signal.throwIfAborted();
        await openTab(tab);
        signal.throwIfAborted();
        return webMcpResult(`Opened the ${tab} tab.`, { path: `/content?tab=${tab}` });
      },
    },
    {
      name: "get_content_agent_settings",
      title: "Get Content Agent settings",
      description:
        "Loads safe Agent defaults and connected publishing accounts. Private connection emails, credentials, and reference-photo URLs are omitted.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input, { signal }) {
        z.object({}).strict().parse(input);
        signal.throwIfAborted();
        const [preferences, accounts] = await Promise.all([
          getContentAgentPreferences(),
          getContentPublishingAccounts(),
        ]);
        signal.throwIfAborted();
        return webMcpResult("Loaded Content Agent settings.", {
          preferences: {
            displayName: preferences.display_name,
            proactivePaused: preferences.proactive_paused,
            generateImages: preferences.generate_images,
            useFaceReferences: preferences.use_face_references,
            selectedReferencePhotoCount: preferences.reference_photo_ids?.length ?? 0,
            branding: agentBranding(preferences.branding),
            destinationAccounts: preferences.destination_accounts ?? {},
            platforms: preferences.platforms,
          },
          publishingAccounts: accounts.slice(0, 20).map(({ id, provider, provider_handle }) => ({
            id,
            provider,
            handle:
              provider_handle && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(provider_handle)
                ? null
                : provider_handle,
          })),
        });
      },
    },
    {
      name: "manage_content_agent_chat",
      title: "Manage Agent chats",
      description:
        "Pins, marks read, renames, or permanently deletes an owned Agent chat by its exact ID. Each change needs browser approval and returns a refreshed, bounded chat list. The named Agent conversation cannot be renamed or deleted.",
      inputSchema: {
        type: "object",
        oneOf: [
          {
            type: "object",
            properties: {
              action: { const: "set_pinned" },
              threadId: { type: "string", format: "uuid" },
              pinned: { type: "boolean" },
            },
            required: ["action", "threadId", "pinned"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              action: { const: "mark_read" },
              threadId: { type: "string", format: "uuid" },
              throughMessageId: { type: "string", format: "uuid" },
            },
            required: ["action", "threadId"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              action: { const: "rename" },
              threadId: { type: "string", format: "uuid" },
              title: { type: "string", minLength: 1, maxLength: 160 },
            },
            required: ["action", "threadId", "title"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              action: { const: "delete" },
              threadId: { type: "string", format: "uuid" },
            },
            required: ["action", "threadId"],
            additionalProperties: false,
          },
        ],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input, { signal }) {
        const action = chatAction.parse(input);
        signal.throwIfAborted();
        await requireWebMcpUserConfirmation(
          action.action === "delete"
            ? "Permanently delete this Agent chat and its messages"
            : "Manage this Agent chat",
          action,
        );
        signal.throwIfAborted();
        if (action.action === "set_pinned") {
          await setContentAgentThreadPinned({
            data: { threadId: action.threadId, pinned: action.pinned },
          });
        } else if (action.action === "mark_read") {
          await markContentAgentThreadRead({
            data: { threadId: action.threadId, throughMessageId: action.throughMessageId },
          });
        } else if (action.action === "rename") {
          await renameContentAgentChat({
            data: { threadId: action.threadId, title: action.title },
          });
        } else {
          await deleteContentAgentChat({ data: { threadId: action.threadId } });
          await openTab("agent");
        }
        signal.throwIfAborted();
        await refresh();
        signal.throwIfAborted();
        const threads = await listContentAgentThreads();
        signal.throwIfAborted();
        return webMcpResult("Agent chats updated.", {
          action: action.action,
          threadId: action.threadId,
          threads: threads.slice(0, 50).map((thread) => ({
            id: thread.id,
            title: thread.title,
            kind: thread.kind,
            pinnedAt: thread.pinned_at,
            unreadCount: thread.unread_count,
            lastMessageAt: thread.last_message_at,
          })),
        });
      },
    },
    {
      name: "update_content_agent_settings",
      title: "Update Content Agent settings",
      description:
        "Updates the Agent name, platforms, publishing defaults, brand colors, or proactive/image settings. Face-photo selection and consent remain in the visible UI. Bento asks for browser approval before saving.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          displayName: { type: "string", minLength: 1, maxLength: 80 },
          proactivePaused: { type: "boolean" },
          generateImages: { type: "boolean" },
          platforms: {
            type: "array",
            maxItems: 3,
            items: { type: "string", enum: ["twitter", "linkedin", "instagram"] },
          },
          destinationAccounts: {
            type: "object",
            additionalProperties: false,
            properties: Object.fromEntries(
              ["twitter", "linkedin", "instagram"].map((provider) => [
                provider,
                { type: "string", format: "uuid" },
              ]),
            ),
          },
          branding: {
            type: "object",
            additionalProperties: false,
            properties: {
              accentColor: { type: "string" },
              backgroundColor: { type: "string" },
              textColor: { type: "string" },
              coverStyle: { type: "string", enum: ["text", "portrait"] },
              heroPhotoId: { type: ["string", "null"], format: "uuid" },
            },
          },
        },
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input, { signal }) {
        const patch = parseEditablePreferences(input);
        signal.throwIfAborted();
        await requireWebMcpUserConfirmation("Update Content Agent settings", patch);
        signal.throwIfAborted();
        await updateContentAgentPreferences({ data: patch });
        signal.throwIfAborted();
        await refresh();
        signal.throwIfAborted();
        return webMcpResult("Content Agent settings saved.", { saved: true });
      },
    },
    {
      name: "get_content_agent_draft_visuals",
      title: "Get Agent draft visual status",
      description:
        "Loads the selected owned draft's attached media IDs and bounded image-job status. Private media URLs and provider details are omitted.",
      inputSchema: draftRefJsonSchema,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input, { signal }) {
        const ref = draftRef.parse(input);
        signal.throwIfAborted();
        const state = await getAgentDraftImages({ data: ref });
        signal.throwIfAborted();
        return webMcpResult("Loaded Agent draft visual status.", {
          attachedMediaIds: Object.keys(state.assets).slice(0, 10),
          missingMediaIds: state.missingMediaIds.slice(0, 10),
          jobs: state.jobs.slice(0, 30).map(({ id, status, mediaId }) => ({ id, status, mediaId })),
          parentPending: state.parentPending,
        });
      },
    },
    {
      name: "manage_content_agent_visuals",
      title: "Manage Agent draft visuals",
      description:
        "Prepares a draft's visuals, attaches an owned Media item, or clears carousel backgrounds. Preparation may use an enabled external image provider. AI image generation and face-photo consent remain in the visible UI. Bento asks for browser approval before applying a change.",
      inputSchema: {
        type: "object",
        oneOf: [
          {
            type: "object",
            properties: {
              action: { const: "prepare" },
              messageId: draftRefProperties.messageId,
              cardId: draftRefProperties.cardId,
            },
            required: ["action", "messageId", "cardId"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              action: { const: "attach_existing" },
              draftRef: draftRefJsonSchema,
              mediaId: { type: "string", format: "uuid" },
              slideIndex: { type: "integer", minimum: 0, maximum: 9 },
            },
            required: ["action", "draftRef", "mediaId"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { action: { const: "clear_backgrounds" }, draftRef: draftRefJsonSchema },
            required: ["action", "draftRef"],
            additionalProperties: false,
          },
        ],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input, { signal }) {
        const action = visualAction.parse(input);
        signal.throwIfAborted();
        await requireWebMcpUserConfirmation(
          action.action === "prepare"
            ? "Prepare visuals; enabled settings may send owned media to API Mart"
            : "Manage Agent draft visuals",
          action,
        );
        signal.throwIfAborted();
        if (action.action === "prepare") {
          await prepareContentAgentDraft({
            data: { messageId: action.messageId, cardId: action.cardId },
          });
        } else if (action.action === "attach_existing") {
          await attachAgentDraftImage({
            data: {
              draftRef: action.draftRef,
              mediaId: action.mediaId,
              slideIndex: action.slideIndex,
            },
          });
        } else {
          await clearAgentDraftBackgrounds({ data: action.draftRef });
        }
        signal.throwIfAborted();
        await refresh();
        signal.throwIfAborted();
        return webMcpResult("Agent draft visuals updated.", { ok: true, action: action.action });
      },
    },
  ];
}
