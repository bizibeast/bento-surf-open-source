import { z } from "zod";

export const instagramAudioCatalogInputSchema = z.object({
  connectionId: z.string().uuid(),
  type: z.enum(["music", "original_sound"]).default("music"),
  query: z.string().trim().max(100).default(""),
});

export const INSTAGRAM_AUDIO_TOOL_DESCRIPTION =
  "Browse Meta's eligible Instagram Reel audio for one connected account. Omit query for trending tracks, or search by title, artist or keyword; type is music or original_sound. Requires the account's linked Facebook audio authorization. This is a read and never publishes. The catalog may differ from the Instagram app. Track previews are temporary; Meta does not provide a preview of the finished Reel with attached catalog audio. After the creator chooses, pass the returned track id/title/creator in providerSettings.instagram.catalogAudio with audioId, title, creator, connectionId, sourceKey equal to the one uploaded video's media.key, trackVolume and originalVolume (integers 1-100). Reels only; no photo, carousel or Story audio. Meta exposes no custom catalog start offset. The picker can seek a listening preview, but that preview position must not be represented as publishing timing. For an uploaded track, the Scheduler can render and preview the chosen trackStartSeconds. MCP callers must supply the already mixed MP4 in reelAudio.video; trackStartSeconds records its source offset and does not itself trigger rendering; never use a temporary catalog preview as publishing media. Keep the existing publishing approval.";
