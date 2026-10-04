import { z } from "zod";
import { parsePublicHttpUrl } from "./safe-url";
import { SOCIAL_PROVIDERS } from "./social-scheduler";
import { quoteContentSourcesForAgent, type NormalizedContentSource } from "./content-connections";
import {
  contentMediaAssetSchema,
  relevantContentMedia,
  type ContentMediaAsset,
} from "./content-media";

const cardId = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_-]+$/i);
const publicUrl = z
  .string()
  .trim()
  .url()
  .max(2_000)
  .refine((value) => Boolean(parsePublicHttpUrl(value, { requireHttps: true })), {
    message: "Use a public HTTPS source URL.",
  });

const sourceCardSchema = z
  .object({
    type: z.literal("source"),
    cardId,
    title: z.string().trim().min(1).max(500),
    url: publicUrl,
    sourceName: z.string().trim().min(1).max(160),
    publishedAt: z.string().datetime({ offset: true }),
    summary: z.string().trim().max(4_000),
  })
  .strict();

const ideaCardSchema = z
  .object({
    type: z.literal("idea"),
    cardId,
    title: z.string().trim().min(1).max(300),
    premise: z.string().trim().min(1).max(2_000),
    format: z.string().trim().min(1).max(100),
    takeaway: z.string().trim().min(1).max(1_000),
    sourceUrls: z.array(publicUrl).max(5).default([]),
  })
  .strict();

const draftCardSchema = z
  .object({
    type: z.literal("draft"),
    cardId,
    platform: z.enum(SOCIAL_PROVIDERS),
    format: z.enum(["post", "thread", "carousel", "short_script", "long_script"]),
    title: z.string().trim().max(300).default(""),
    body: z.string().trim().min(1).max(10_000),
    visualBrief: z.string().trim().max(2_000).nullable().default(null),
    sourceUrls: z.array(publicUrl).max(5).default([]),
    rationale: z.string().trim().min(1).max(2_000),
    mediaIds: z.array(z.string().uuid()).max(5).optional(),
  })
  .strict();

const brainProposalCardSchema = z
  .object({
    type: z.literal("brain_proposal"),
    cardId,
    kind: z.enum(["profile", "instruction", "strategy", "story", "inspiration"]),
    title: z.string().trim().min(1).max(160),
    content: z.string().trim().min(1).max(20_000),
    sourceUrl: publicUrl.nullable().default(null),
    sourceRef: z.string().trim().max(500).nullable().default(null),
  })
  .strict();

const weeklyPlanCardSchema = z
  .object({
    type: z.literal("weekly_plan"),
    cardId,
    days: z
      .array(
        z
          .object({
            date: z.string().date(),
            platform: z.enum(SOCIAL_PROVIDERS),
            idea: z.string().trim().min(1).max(1_000),
          })
          .strict(),
      )
      .min(1)
      .max(21),
  })
  .strict();

const scheduleProposalCardSchema = z
  .object({
    type: z.literal("schedule_proposal"),
    cardId,
    draftCardId: cardId,
    connectionId: z.string().uuid(),
    scheduledAt: z.string().datetime({ offset: true }),
    timezone: z.string().trim().min(1).max(100),
  })
  .strict();

export const contentAgentCardSchema = z.discriminatedUnion("type", [
  sourceCardSchema,
  ideaCardSchema,
  draftCardSchema,
  brainProposalCardSchema,
  weeklyPlanCardSchema,
  scheduleProposalCardSchema,
]);

export const contentAgentResultSchema = z
  .object({
    action: z.enum([
      "answer",
      "research",
      "draft",
      "brain_proposal",
      "weekly_plan",
      "schedule_proposal",
    ]),
    message: z.string().trim().min(1).max(5_000),
    cards: z.array(contentAgentCardSchema).max(20).default([]),
    mediaAssets: z.array(contentMediaAssetSchema).max(20).optional(),
    memories: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(160),
            sourceQuote: z.string().trim().min(10).max(2_000),
          })
          .strict(),
      )
      .max(5)
      .optional(),
  })
  .strict();

export type ContentAgentCard = z.infer<typeof contentAgentCardSchema>;
export type ContentAgentResult = z.infer<typeof contentAgentResultSchema>;

export const contentAgentResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "content_agent_result",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: [
            "answer",
            "research",
            "draft",
            "brain_proposal",
            "weekly_plan",
            "schedule_proposal",
          ],
        },
        message: { type: "string" },
        memories: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            additionalProperties: false,
            properties: { title: { type: "string" }, sourceQuote: { type: "string" } },
            required: ["title", "sourceQuote"],
          },
        },
        cards: {
          type: "array",
          maxItems: 20,
          items: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { const: "source" },
                  cardId: { type: "string" },
                  title: { type: "string" },
                  url: { type: "string" },
                  sourceName: { type: "string" },
                  publishedAt: { type: "string" },
                  summary: { type: "string" },
                },
                required: [
                  "type",
                  "cardId",
                  "title",
                  "url",
                  "sourceName",
                  "publishedAt",
                  "summary",
                ],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { const: "idea" },
                  cardId: { type: "string" },
                  title: { type: "string" },
                  premise: { type: "string" },
                  format: { type: "string" },
                  takeaway: { type: "string" },
                  sourceUrls: { type: "array", maxItems: 5, items: { type: "string" } },
                },
                required: [
                  "type",
                  "cardId",
                  "title",
                  "premise",
                  "format",
                  "takeaway",
                  "sourceUrls",
                ],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { const: "draft" },
                  cardId: { type: "string" },
                  platform: {
                    type: "string",
                    enum: [
                      "instagram",
                      "facebook",
                      "threads",
                      "tiktok",
                      "linkedin",
                      "twitter",
                      "youtube",
                      "reddit",
                    ],
                  },
                  format: {
                    type: "string",
                    enum: ["post", "thread", "carousel", "short_script", "long_script"],
                  },
                  title: { type: "string" },
                  body: { type: "string" },
                  visualBrief: { type: ["string", "null"] },
                  sourceUrls: { type: "array", maxItems: 5, items: { type: "string" } },
                  rationale: { type: "string" },
                  mediaIds: { type: "array", maxItems: 5, items: { type: "string" } },
                },
                required: [
                  "type",
                  "cardId",
                  "platform",
                  "format",
                  "title",
                  "body",
                  "visualBrief",
                  "sourceUrls",
                  "rationale",
                  "mediaIds",
                ],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { const: "brain_proposal" },
                  cardId: { type: "string" },
                  kind: {
                    type: "string",
                    enum: ["profile", "instruction", "strategy", "story", "inspiration"],
                  },
                  title: { type: "string" },
                  content: { type: "string" },
                  sourceUrl: { type: ["string", "null"] },
                  sourceRef: { type: ["string", "null"] },
                },
                required: ["type", "cardId", "kind", "title", "content", "sourceUrl", "sourceRef"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { const: "weekly_plan" },
                  cardId: { type: "string" },
                  days: {
                    type: "array",
                    minItems: 1,
                    maxItems: 21,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        date: { type: "string" },
                        platform: {
                          type: "string",
                          enum: [
                            "instagram",
                            "facebook",
                            "threads",
                            "tiktok",
                            "linkedin",
                            "twitter",
                            "youtube",
                            "reddit",
                          ],
                        },
                        idea: { type: "string" },
                      },
                      required: ["date", "platform", "idea"],
                    },
                  },
                },
                required: ["type", "cardId", "days"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { const: "schedule_proposal" },
                  cardId: { type: "string" },
                  draftCardId: { type: "string" },
                  connectionId: { type: "string" },
                  scheduledAt: { type: "string" },
                  timezone: { type: "string" },
                },
                required: [
                  "type",
                  "cardId",
                  "draftCardId",
                  "connectionId",
                  "scheduledAt",
                  "timezone",
                ],
              },
            ],
          },
        },
      },
      required: ["action", "message", "cards", "memories"],
    },
  },
} as const;

const secretKey = /(token|secret|password|authorization|cookie|credential)/i;

function safePromptValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safePromptValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !secretKey.test(key))
      .map(([key, child]) => [key, safePromptValue(child)]),
  );
}

export function buildContentAgentInput(input: {
  userText: string;
  brain: Array<Record<string, unknown> & { status?: string }>;
  recommendations: Array<Record<string, unknown>>;
  sources?: NormalizedContentSource[];
  scheduler: Record<string, unknown>;
  performance: Record<string, unknown>;
  feedback: Array<Record<string, unknown>>;
  history?: Array<Record<string, unknown>>;
  media?: ContentMediaAsset[];
}) {
  return JSON.stringify({
    request: input.userText.slice(0, 20_000),
    confirmedBrain: input.brain
      .filter((item) => item.status === "confirmed")
      .map(safePromptValue)
      .slice(0, 100),
    recommendations: input.recommendations.map(safePromptValue).slice(0, 50),
    connectedKnowledge: quoteContentSourcesForAgent(input.sources || []),
    scheduler: safePromptValue(input.scheduler),
    performance: safePromptValue(input.performance),
    priorFeedback: input.feedback.map(safePromptValue).slice(-50),
    recentConversation: (input.history || []).map(safePromptValue).slice(-20),
    relevantMedia: relevantContentMedia(input.userText, input.media || []),
  });
}
