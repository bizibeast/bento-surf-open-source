/* eslint-disable @typescript-eslint/no-explicit-any -- Registry rows are validated at this boundary. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getMediaBucket, mediaObjectUrl, validateMediaObjectKey } from "./r2-storage.server";
import type { SchedulerMedia } from "./social-scheduler";

/** Uses R2 metadata, never a client URL, MIME, or claimed byte size. No social connection needed. */
export async function registerAgentMedia(
  userId: string,
  key: string,
  source: "carousel_export" | "generated" | "uploaded" | "stock",
  provenance: { messageId: string | null; cardId: string; revision: number; slideIndex: number },
) {
  if (!validateMediaObjectKey(key) || !key.startsWith(`users/${userId}/`))
    throw new Error("This media belongs to a different workspace.");
  const object = await getMediaBucket().head(key);
  const mime = object?.httpMetadata?.contentType;
  if (
    !object ||
    !["image/jpeg", "image/png", "image/webp"].includes(mime || "") ||
    object.size <= 0 ||
    object.size > 8 * 1024 * 1024
  )
    throw new Error("Upload a complete JPEG, PNG or WebP image under 8 MB.");
  const { data, error } = await (supabaseAdmin as any)
    .from("content_agent_media")
    .upsert(
      {
        user_id: userId,
        storage_key: key,
        mime_type: mime,
        byte_size: object.size,
        source,
        message_id: provenance.messageId,
        card_id: provenance.cardId,
        draft_revision: provenance.revision,
        slide_index: provenance.slideIndex,
      },
      { onConflict: "user_id,storage_key" },
    )
    .select("id")
    .single();
  if (error || !data) throw new Error("The exported image could not be registered. Retry export.");
  return String(data.id);
}
/** Ordered registry + imported media resolver. Storage existence/metadata are rechecked at handoff. */
export async function resolveOwnedAgentMedia(
  userId: string,
  ids: string[],
): Promise<SchedulerMedia[]> {
  if (!ids.length) return [];
  if (ids.length > 10 || new Set(ids).size !== ids.length)
    throw new Error("Use a complete ordered set of unique images.");
  const db = supabaseAdmin as any;
  const [registered, imported] = await Promise.all([
    db
      .from("content_agent_media")
      .select("id,storage_key,mime_type,byte_size")
      .eq("user_id", userId)
      .in("id", ids),
    db
      .from("creator_content_media")
      .select("id,storage_key,mime_type,byte_size")
      .eq("user_id", userId)
      .eq("status", "ready")
      .in("id", ids),
  ]);
  if (registered.error || imported.error) throw new Error("Your media library is unavailable.");
  const rows = [...(registered.data || []), ...(imported.data || [])];
  return Promise.all(
    ids.map(async (id, index) => {
      const row = rows.find((item) => item.id === id);
      if (
        !row ||
        !validateMediaObjectKey(row.storage_key) ||
        !row.storage_key.startsWith(`users/${userId}/`)
      )
        throw new Error("The reviewed media is no longer owned by this workspace.");
      const object = await getMediaBucket().head(row.storage_key);
      if (
        !object ||
        object.size <= 0 ||
        object.size !== Number(row.byte_size) ||
        object.httpMetadata?.contentType !== row.mime_type
      )
        throw new Error("The saved image changed or is missing. Export it again.");
      return {
        key: row.storage_key,
        url: mediaObjectUrl(row.storage_key),
        name: `Slide ${index + 1}`,
        mimeType: row.mime_type,
        size: object.size,
      };
    }),
  );
}
