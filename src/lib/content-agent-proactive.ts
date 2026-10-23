import { agentAppActionSchema } from "./content-agent-app-actions";
import { z } from "zod";
import { agentDraftStateSchema } from "./content-carousel";
import { contentAgentResultSchema } from "./content-agent";

/** Persisted server metadata only. The model response schema intentionally excludes it. */
export const proactiveMetadataSchema = z.object({
  signalId: z.string(),
  signalKey: z.string(),
  whyNow: z.string(),
  topicKeys: z.array(z.string()).max(8).default([]),
  sourceKeys: z.array(z.string()).default([]),
  gap: z
    .object({ platform: z.enum(["twitter", "linkedin", "instagram"]), scheduledAt: z.string() })
    .optional(),
  feedback: z.enum(["useful", "not_relevant", "less_like_this"]).nullable().default(null),
  feedbackActions: z.array(z.enum(["useful", "not_relevant", "less_like_this"])),
  draftBindings: z
    .array(
      z.object({
        cardId: z.string(),
        socialPostId: z.string().uuid(),
        runId: z.string().uuid(),
        body: z.string(),
        title: z.string(),
        postUpdatedAt: z.string().datetime({ offset: true }).optional(),
      }),
    )
    .default([]),
});
export const storedContentAgentResultSchema = contentAgentResultSchema.extend({
  appActions: z.array(agentAppActionSchema).max(3).optional(),
  proactive: proactiveMetadataSchema.optional(),
  draftStates: z.record(z.string(), agentDraftStateSchema).optional(),
  rejectedDraftIds: z.array(z.string().max(120)).max(20).optional(),
});
export type ProactivePayload = z.infer<typeof storedContentAgentResultSchema>;

/** Bounded lexical subject identities. Source URLs and event IDs never become topics. */
export function contentTopicKeys(...subjects: string[]): string[] {
  const stop = new Set(
    "about after again also before better could draft from have into more news original post recent source that their these this useful what when which with would your".split(
      " ",
    ),
  );
  const keys: string[] = [];
  for (const subject of subjects) {
    const words = subject
      .normalize("NFKD")
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !stop.has(word))
      .slice(0, 20);
    for (let i = 0; i + 1 < words.length; i++)
      keys.push(`subject:${words[i]} ${words[i + 1]}`.slice(0, 120));
  }
  return [...new Set(keys)].slice(0, 8);
}
export function topicIsSuppressed(keys: string[], suppressed: string[]) {
  const blocked = new Set(suppressed);
  return keys.some((key) => blocked.has(key));
}
