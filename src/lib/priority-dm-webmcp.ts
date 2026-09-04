import { z } from "zod";
import {
  sendCreatorPriorityDmMessage,
  setPriorityDmConversationClosed,
} from "./priority-dm.functions";
import type { PriorityDmConversationSummary } from "./priority-dm.server";
import { requireWebMcpUserConfirmation, webMcpResult, type WebMcpTool } from "./webmcp";

const uuid = z.string().uuid();
const readInput = z
  .object({
    filter: z.enum(["open", "closed"]).default("open"),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
const sendInput = z
  .object({ requestId: uuid, body: z.string().trim().min(1).max(10_000) })
  .strict();
const closeInput = z.object({ requestId: uuid, closed: z.boolean() }).strict();
const idSchema = { type: "string", format: "uuid" } as const;

function safeConversationSummary(conversation: PriorityDmConversationSummary) {
  return {
    id: conversation.id,
    productId: conversation.productId,
    productTitle: conversation.productTitle,
    buyerName: conversation.buyerName,
    status: conversation.status,
    lastMessageAt: conversation.lastMessageAt,
    lastMessagePreview: conversation.lastMessagePreview,
  };
}

export function createPriorityDmWebMcpTools({
  conversations,
  refresh,
}: {
  conversations: PriorityDmConversationSummary[];
  refresh: () => Promise<unknown>;
}): WebMcpTool[] {
  return [
    {
      name: "bento_get_priority_dm_conversations",
      title: "Get Priority DM conversations",
      description:
        "Lists bounded Priority DM inbox summaries for the signed-in creator. Buyer emails, messages, orders, payments, and links are omitted.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          filter: { type: "string", enum: ["open", "closed"], default: "open" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (rawInput, { signal }) => {
        signal.throwIfAborted();
        const input = readInput.parse(rawInput);
        const matching = conversations.filter((conversation) =>
          input.filter === "closed"
            ? conversation.status === "closed"
            : conversation.status !== "closed",
        );
        const projected = matching.slice(0, input.limit).map(safeConversationSummary);
        return webMcpResult(`Loaded ${projected.length} Priority DM conversation(s).`, {
          conversations: projected,
          loadedCount: matching.length,
        });
      },
    },
    {
      name: "bento_send_priority_dm_message",
      title: "Send Priority DM message",
      description:
        "Appends and emails a creator reply to an owned Priority DM conversation after browser approval.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          requestId: idSchema,
          body: { type: "string", minLength: 1, maxLength: 10_000 },
        },
        required: ["requestId", "body"],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (rawInput, { signal }) => {
        signal.throwIfAborted();
        const input = sendInput.parse(rawInput);
        await requireWebMcpUserConfirmation("Send this Priority DM message", input);
        signal.throwIfAborted();
        const message = await sendCreatorPriorityDmMessage({ data: input });
        signal.throwIfAborted();
        await refresh();
        signal.throwIfAborted();
        return webMcpResult("Priority DM message sent.", {
          requestId: input.requestId,
          messageId: message.id,
        });
      },
    },
    {
      name: "bento_set_priority_dm_closed",
      title: "Close or reopen Priority DM conversation",
      description: "Closes or reopens an owned Priority DM conversation after browser approval.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { requestId: idSchema, closed: { type: "boolean" } },
        required: ["requestId", "closed"],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (rawInput, { signal }) => {
        signal.throwIfAborted();
        const input = closeInput.parse(rawInput);
        await requireWebMcpUserConfirmation(
          input.closed
            ? "Close this Priority DM conversation"
            : "Reopen this Priority DM conversation",
          input,
        );
        signal.throwIfAborted();
        await setPriorityDmConversationClosed({ data: input });
        signal.throwIfAborted();
        await refresh();
        signal.throwIfAborted();
        return webMcpResult(
          input.closed ? "Priority DM conversation closed." : "Priority DM conversation reopened.",
          { requestId: input.requestId, closed: input.closed },
        );
      },
    },
  ];
}
