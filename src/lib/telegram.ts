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

type TelegramTextEntity = {
  type: "bold" | "italic" | "code" | "text_link";
  offset: number;
  length: number;
  url?: string;
};

/** Native entities avoid Telegram Markdown escaping failures and never interpret raw HTML. */
export function formatTelegramText(markdown: string) {
  let text = "";
  const entities: TelegramTextEntity[] = [];
  for (const [index, rawLine] of markdown.replace(/\r\n/g, "\n").split("\n").entries()) {
    if (index) text += "\n";
    const heading = /^\s{0,3}#{1,6}\s+/.test(rawLine);
    const line = rawLine.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/^(\s*)[-*]\s+/, "$1• ");
    const start = text.length;
    let from = 0;
    const tokens =
      /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(?<!\w)\*([^*\n]+)\*(?!\w)/g;
    for (const match of line.matchAll(tokens)) {
      text += line.slice(from, match.index);
      const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[6];
      const type = match[1] ? "code" : match[4] ? "text_link" : match[6] ? "italic" : "bold";
      // Telegram rejects code entities nested inside a bold heading.
      if (!heading || (type !== "bold" && type !== "code"))
        entities.push({
          type,
          offset: text.length,
          length: value.length,
          ...(match[5] ? { url: match[5] } : {}),
        });
      text += value;
      from = match.index! + match[0].length;
    }
    text += line.slice(from);
    if (heading && text.length > start)
      entities.push({ type: "bold", offset: start, length: text.length - start });
  }
  return { text, entities: entities.sort((a, b) => a.offset - b.offset || b.length - a.length) };
}

function renderCard(card: ContentAgentCard) {
  switch (card.type) {
    case "source":
      return `Source: ${card.title}\n${card.sourceName} · ${card.publishedAt}\n${card.url}${card.summary ? `\n${card.summary}` : ""}`;
    case "idea":
      return `Idea: ${card.title}\n${card.premise}\nFormat: ${card.format}\nTakeaway: ${card.takeaway}${card.sourceUrls.length ? `\nSources: ${card.sourceUrls.join(" ")}` : ""}`;
    case "draft":
      return `**Draft for ${card.platform === "twitter" ? "X" : card.platform} (${card.format})**${card.title ? `\n${card.title}` : ""}\n\n${card.body}${card.slides?.length ? `\n\n${card.slides.map((slide, index) => `**Slide ${index + 1}: ${slide.heading}**\n${slide.body}`).join("\n\n")}` : ""}${card.sourceUrls.length ? `\n\nSources: ${card.sourceUrls.join(" ")}` : ""}`;
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
    let splitAt = newline >= 2_048 ? newline : 4_096;
    // JavaScript and Telegram entities use UTF-16; do not split an emoji surrogate pair.
    if (/[\uD800-\uDBFF]/.test(remaining[splitAt - 1])) splitAt--;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function renderTelegramAgentResult(result: ContentAgentResult) {
  return splitTelegramText([result.message, ...result.cards.map(renderCard)].join("\n\n"));
}
