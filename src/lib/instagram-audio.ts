import { z } from "zod";

export const instagramAudioCatalogInputSchema = z.object({
  connectionId: z.string().uuid(),
  type: z.enum(["music", "original_sound"]).default("music"),
  query: z.string().trim().max(100).default(""),
});

export const INSTAGRAM_AUDIO_TOOL_DESCRIPTION =
  "Search Meta’s eligible Instagram Reel audio catalog for a connected account by title, artist or keyword, or browse trending tracks. The type is music or original_sound. Requires linked Facebook audio authorization. Catalog availability may differ from the Instagram app. Track previews are temporary. Catalog audio is available for Reels, with no custom catalog start offset. Returned track details include ID, title and creator.";
