import { z } from "zod";

export const creatorIntelligencePreferenceFields = [
  { key: "audience", label: "Audience", maxLength: 300 },
  { key: "voice", label: "Brand voice", maxLength: 600 },
  { key: "priorities", label: "Content priorities", maxLength: 400 },
] as const;

const [audience, voice, priorities] = creatorIntelligencePreferenceFields;

export const creatorIntelligencePreferencesSchema = z
  .object({
    audience: z.string().trim().max(audience.maxLength).optional(),
    voice: z.string().trim().max(voice.maxLength).optional(),
    priorities: z.string().trim().max(priorities.maxLength).optional(),
  })
  .strict();

export type CreatorIntelligencePreferences = z.infer<typeof creatorIntelligencePreferencesSchema>;
