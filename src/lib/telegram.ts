import { z } from "zod";
import type { ContentAgentCard, ContentAgentResult } from "./content-agent";

const safeInteger = z.number().int().safe();
const chatSchema = z
  .object({
    id: safeInteger,
    type: z.literal("private"),
    username: z.string().trim().min(1).max(64).optional(),
    first_name: z.string().trim().min(1).max(160).optional(),
    last_name: z.string().trim().min(1).max(160).optional(),
  })
  .passthrough();
const fromSchema = z
  .object({
    id: safeInteger,
    username: z.string().trim().min(1).max(64).optional(),
    first_name: z.string().trim().min(1).max(160).optional(),
    last_name: z.string().trim().min(1).max(160).optional(),
  })
  .passthrough();
const messageSchema = z
  .object({
    message_id: safeInteger,
    chat: chatSchema,
    from: fromSchema.optional(),
    text: z.string().min(1).max(4_096),
  })
  .passthrough();
const callbackSchema = z
  .object({
    id: z.string().min(1).max(256),
    from: fromSchema,
    message: z
      .object({
        message_id: safeInteger,
        chat: chatSchema,
      })
      .passthrough(),
    data: z.string().min(1).max(64),
  })
  .passthrough();
const updateSchema = z
  .object({
    update_id: safeInteger.nonnegative(),
    message: messageSchema.optional(),
    callback_query: callbackSchema.optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (Number(Boolean(value.message)) + Number(Boolean(value.callback_query)) !== 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Unsupported Telegram update." });
    }
  });

export type TelegramUpdate = z.infer<typeof updateSchema>;

export function parseTelegramUpdate(value: unknown): TelegramUpdate {
  return updateSchema.parse(value);
}

const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const startPattern = new RegExp(`^/start(?:@[a-z0-9_]{5,32})?\\s+(${uuidPattern})$`, "i");
const actionPattern = new RegExp(`^tg:(${uuidPattern})$`, "i");

export function telegramStartState(text: string) {
  return startPattern.exec(text.trim())?.[1]?.toLowerCase() || null;
}

export function telegramActionId(data: string) {
  return actionPattern.exec(data.trim())?.[1]?.toLowerCase() || null;
}

function renderCard(card: ContentAgentCard) {
  switch (card.type) {
    case "source":
      return `Source: ${card.title}\n${card.sourceName} · ${card.publishedAt}\n${card.url}${card.summary ? `\n${card.summary}` : ""}`;
    case "idea":
      return `Idea: ${card.title}\n${card.premise}\nFormat: ${card.format}\nTakeaway: ${card.takeaway}${card.sourceUrls.length ? `\nSources: ${card.sourceUrls.join(" ")}` : ""}`;
    case "draft":
      return `Draft for ${card.platform} (${card.format})${card.title ? `\n${card.title}` : ""}\n${card.body}${card.visualBrief ? `\nVisual: ${card.visualBrief}` : ""}${card.sourceUrls.length ? `\nSources: ${card.sourceUrls.join(" ")}` : ""}`;
    case "brain_proposal":
      return `Brain suggestion: ${card.title}\n${card.content}${card.sourceUrl ? `\nSource: ${card.sourceUrl}` : ""}`;
    case "weekly_plan":
      return `Weekly plan\n${card.days.map((day) => `${day.date} · ${day.platform}: ${day.idea}`).join("\n")}`;
    case "schedule_proposal":
      return `Schedule proposal\n${card.scheduledAt} (${card.timezone})`;
  }
}

function splitTelegramText(text: string) {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > 4_096) {
    const newline = remaining.lastIndexOf("\n", 4_096);
    const splitAt = newline >= 2_048 ? newline : 4_096;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function renderTelegramAgentResult(result: ContentAgentResult) {
  return splitTelegramText([result.message, ...result.cards.map(renderCard)].join("\n\n"));
}
