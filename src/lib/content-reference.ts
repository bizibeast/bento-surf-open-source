import { z } from "zod";
import { studioDocumentSchema, type StudioEntry } from "./content-studio";
import { applyGeneratedStudioDraft } from "./content-studio-generation";
import { bennyModelSchema, bennyProviderIdSchema } from "./benny-byok";
import { isBennyEditingModel } from "./benny-models";
import { normalizeCustomerCopy } from "./text/dashes";

export const REFERENCE_ASSET_PATH = "/api/content-reference/asset";
export const REFERENCE_MAX_BYTES = 24 * 1024 * 1024;
export const referenceSourceUrl = z
  .string()
  .url()
  .max(2000)
  .transform((source, context) => {
    const url = new URL(source);
    const match = /^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]{1,64})\/?$/.exec(url.pathname);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !["instagram.com", "www.instagram.com", "m.instagram.com"].includes(url.hostname) ||
      !match
    ) {
      context.addIssue({
        code: "custom",
        message: "Use a public Instagram post, carousel or Reel link.",
      });
      return z.NEVER;
    }
    // Keep the video intent: cover-only Reel embeds must not become image references.
    return `https://www.instagram.com/${match[1] === "p" ? "p" : "reel"}/${match[2]}/`;
  });

export const contentReferenceInput = z
  .object({
    workspaceId: z.uuid(),
    requestId: z.uuid(),
    rightsConfirmed: z.literal(true),
    sourceUrl: referenceSourceUrl.optional(),
    mediaId: z.uuid().optional(),
    mode: z.enum(["overview", "all"]).default("overview"),
  })
  .strict()
  .refine(
    (input) => Boolean(input.sourceUrl) !== Boolean(input.mediaId),
    "Choose one public reference link or one owned video.",
  );

export const referenceDraftInput = z
  .object({
    workspaceId: z.uuid(),
    requestId: z.uuid(),
    analysisId: z.uuid(),
    prompt: z.string().trim().min(3).max(3000),
    kind: z.enum(["project", "preset"]).default("project"),
    document: studioDocumentSchema,
    aiProviderId: bennyProviderIdSchema.optional(),
    aiModel: bennyModelSchema.optional(),
  })
  .strict()
  .refine((input) => input.aiProviderId || !input.aiModel || isBennyEditingModel(input.aiModel), {
    path: ["aiModel"],
    message: "This editing model is unavailable.",
  });

export const referenceJobIdInput = z.object({ workspaceId: z.uuid(), jobId: z.uuid() }).strict();
export const referenceEvidenceSchema = z
  .object({
    sourceUrl: referenceSourceUrl.optional(),
    owner: z.string().max(100).optional(),
    caption: z.string().max(5000).optional(),
    format: z.enum(["reel", "carousel", "image"]),
    durationSeconds: z.number().nonnegative().max(90).optional(),
    visuals: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative().max(19),
            description: z.string().max(4000),
          })
          .strict(),
      )
      .max(20),
    transcript: z.string().max(16000).optional(),
    segments: z
      .array(
        z
          .object({
            start: z.number().nonnegative().max(90),
            end: z.number().nonnegative().max(90),
            text: z.string().max(1000),
          })
          .strict(),
      )
      .max(300)
      .optional(),
    grid: z
      .object({
        mode: z.enum(["overview", "all"]),
        decodedFrameCount: z.number().int().positive(),
        includedFrameCount: z.number().int().positive(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict()
      .optional(),
    warnings: z.array(z.string().max(500)).max(24),
  })
  .strict();
export type ReferenceEvidence = z.infer<typeof referenceEvidenceSchema>;

/** New copy never inherits footage, audio, subtitles or stale provider jobs from its seed. */
export function referenceDraftFromEvidence(
  input: z.infer<typeof referenceDraftInput>,
  generated: unknown,
): StudioEntry {
  const seed = structuredClone(input.document);
  if (seed.format === "reel") {
    seed.scenes = seed.scenes.map((scene) => ({
      ...scene,
      kind: "card",
      mediaId: null,
      avatarJobId: null,
      narrationJobId: null,
      avatarScript: "",
      sourceStart: 0,
    }));
    delete seed.subtitles;
    delete seed.audio;
  } else seed.slides = seed.slides.map(({ heading, body }) => ({ heading, body }));
  const next = applyGeneratedStudioDraft(seed, normalizeCustomerCopy(generated));
  return { id: input.requestId, revision: 0, kind: input.kind, ...next };
}
