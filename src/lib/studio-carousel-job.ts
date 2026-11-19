import { z } from "zod";

export const studioCarouselJobInput = z
  .object({
    workspaceId: z.uuid(),
    entryId: z.uuid(),
    revision: z.number().int().positive(),
    format: z.enum(["carousel", "reel"]).optional(),
  })
  .strict();

export const studioCarouselMessage = z
  .object({ kind: z.literal("studio_carousel_render"), jobId: z.uuid() })
  .strict();
export type StudioCarouselMessage = z.infer<typeof studioCarouselMessage>;
