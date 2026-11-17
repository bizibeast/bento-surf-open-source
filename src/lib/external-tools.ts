import { z } from "zod";

export const externalProviderSchema = z.enum(["heygen", "github_mcp"]);
export type ExternalProvider = z.infer<typeof externalProviderSchema>;

export const externalToolNames = {
  heygen: ["avatars", "voices", "prepare_generation", "start_generation", "generation_status"],
  github_mcp: ["get_me"],
} as const;

export const githubRepositorySchema = z
  .string()
  .trim()
  .regex(/^[\da-z][\da-z-]{0,38}\/[\da-z_.-]{1,100}$/i)
  .refine(
    (name) => ![".", ".."].includes(name.split("/")[1]),
    "Enter a GitHub owner and repository.",
  )
  .transform((name) => name.toLowerCase());

export const githubPullRequestSchema = z
  .object({
    repository: githubRepositorySchema,
    number: z.number().int().positive().max(2_147_483_647),
  })
  .strict();

export const externalCredentialSchema = z
  .object({
    provider: externalProviderSchema,
    credential: z
      .string()
      .trim()
      .min(16)
      .max(512)
      .regex(/^[\x21-\x7e]+$/),
    consent: z.literal(true),
    githubRepository: githubRepositorySchema.optional(),
  })
  .strict()
  .refine((input) => !input.githubRepository || input.provider === "github_mcp");

export const heyGenIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_-]+$/);

export const heyGenCatalogInput = z
  .object({
    scope: z.enum(["private", "public"]).default("private"),
    token: z.string().min(1).max(1024).optional(),
  })
  .strict();

export const heyGenGenerationInput = z
  .object({
    avatarId: heyGenIdSchema,
    voiceId: heyGenIdSchema,
    script: z
      .string()
      .trim()
      .min(1)
      .max(600)
      .refine((value) => !/<\/?[a-z][^>]*>/i.test(value), "Use plain speech text without markup."),
    requestedSeconds: z.number().int().min(1).max(60),
    requestKey: z.uuid(),
  })
  .strict();

export const heyGenJobInput = z.object({ jobId: z.uuid() }).strict();

export type HeyGenGenerationInput = z.infer<typeof heyGenGenerationInput>;
export type HeyGenCatalogInput = z.infer<typeof heyGenCatalogInput>;

export const HEYGEN_ENGINE = "avatar_iv";
export const HEYGEN_MODEL_DESCRIPTION = "HeyGen Avatar IV · 720p · portrait";

export function heyGenEstimateUsd(seconds: number, usdPerMinute: number) {
  return Math.ceil((seconds * usdPerMinute * 100) / 60) / 100;
}

export function heyGenEstimateRenderSeconds(requestedSeconds: number, script: string) {
  const characters = Array.from(script).length;
  const words = script.split(/\s+/).length;
  return Math.max(requestedSeconds, Math.ceil(characters / 8), Math.ceil(words / 2));
}
