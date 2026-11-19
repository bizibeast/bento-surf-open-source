import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { studioSchedulerDraftSchema } from "./content-studio";
import { requireStudioWorkspace } from "./content-studio.server";
import { mediaObjectUrl, validateMediaObjectKey } from "./r2-storage.server";
import { saveSocialPostForUser } from "./social-scheduler.functions";
import { socialPostInputSchema } from "./social-scheduler";

const schedulerAssetSchema = z.object({
  id: z.string().uuid(),
  caption: z.string(),
  storage_key: z.string(),
  mime_type: z.enum(["image/jpeg", "image/png", "image/webp", "video/mp4"]),
  byte_size: z.number().int().positive(),
});

type StudioSchedulerDraft = z.infer<typeof studioSchedulerDraftSchema>;

export async function saveStudioSchedulerDraft({
  workspaceId,
  requestId,
  title,
  mediaIds,
}: StudioSchedulerDraft) {
  await requireStudioWorkspace(workspaceId);
  // The generated database types predate the ready Brain Media table.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const assets = await (supabaseAdmin as any)
    .from("creator_content_media")
    .select("id,caption,storage_key,mime_type,byte_size")
    .eq("user_id", workspaceId)
    .eq("status", "ready")
    .eq("import_origin", "upload")
    .in("id", mediaIds)
    .limit(mediaIds.length);
  if (assets.error) throw new Error("The exported media could not be loaded.");
  const rows = schedulerAssetSchema.array().safeParse(assets.data);
  if (!rows.success) throw new Error("A Studio export is unavailable or unsupported.");
  const byId = new Map(rows.data.map((asset) => [asset.id, asset]));
  const media = mediaIds.map((id) => {
    const asset = byId.get(id);
    const key = asset && validateMediaObjectKey(asset.storage_key);
    if (!asset || !key || !key.startsWith(`users/${workspaceId}/`)) {
      throw new Error("A Studio export is unavailable in this workspace.");
    }
    return {
      key,
      url: mediaObjectUrl(key),
      name: asset.caption.trim().slice(0, 255) || "Studio export",
      mimeType: asset.mime_type,
      size: asset.byte_size,
    };
  });
  const draft = await saveSocialPostForUser(
    workspaceId,
    socialPostInputSchema.parse({
      title,
      body: "",
      scheduledAt: null,
      connectionIds: [],
      asDraft: true,
      media,
    }),
    undefined,
    requestId,
  );
  if (!draft.savedPostId) throw new Error("The Scheduler draft could not be created.");
  return { postId: draft.savedPostId };
}
