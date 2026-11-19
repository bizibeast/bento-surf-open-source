import { z } from "zod";
import { studioReelSchema } from "./content-studio";

export const STUDIO_REEL_INPUT_LIMIT = 24 * 1024 * 1024;
export const STUDIO_REEL_OUTPUT_LIMIT = 32 * 1024 * 1024;
export const STUDIO_REEL_TIMEOUT_MS = 100_000;
export const STUDIO_REEL_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
export const STUDIO_REEL_VIDEO_TYPES = ["video/mp4", "video/webm"];

export const studioReelRequestSchema = z
  .object({
    document: studioReelSchema,
    assets: z
      .array(
        z
          .object({
            id: z.uuid(),
            kind: z.enum(["image", "video"]),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

export type StudioReelRequest = z.infer<typeof studioReelRequestSchema>;
