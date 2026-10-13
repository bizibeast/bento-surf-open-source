/* eslint-disable @typescript-eslint/no-explicit-any -- Media rows are validated at the service boundary. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireContentWorkspace } from "./content-access.server";
import { BRAIN_MEDIA_BUDGET_BYTES, MANUAL_MEDIA_LIMIT, MEDIA_FOLDER_LIMIT } from "./content-media";
import {
  enqueueDueContentMediaImports,
  type ContentMediaImportMessage,
} from "./content-media.server";
import { getMediaBucket, mediaObjectUrl } from "./r2-storage.server";
import { parsePublicHttpUrl } from "./safe-url";
import { getPlan } from "./plan.server";
import { uploadLimitMb } from "./plans";

const uuid = z.string().uuid();
const folderName = z.string().trim().min(1).max(80);
const folderId = z.object({ id: uuid });
const mediaId = z.object({ id: uuid });

export const previewOldContentMedia = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId);
    const { data, error } = await (supabaseAdmin as any).rpc(
      "creator_legacy_media_cleanup_preview",
      { p_user_id: context.userId },
    );
    if (error) throw new Error("Old Media could not be reviewed.");
    return {
      itemCount: Number(data?.[0]?.item_count || 0),
      possibleBytes: Number(data?.[0]?.possible_bytes || 0),
      items: (data?.[0]?.items || []).map((item: any) => ({
        id: String(item.id),
        title: String(item.title || item.provider || "Media"),
        provider: String(item.provider),
        byteSize: Number(item.byte_size || 0),
      })),
    };
  });

async function manualMediaAvailability(userId: string) {
  const db = supabaseAdmin as any;
  const [count, usage] = await Promise.all([
    db
      .from("creator_content_media")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .in("import_origin", ["requested", "upload"]),
    db.rpc("creator_brain_media_used_bytes", { p_user_id: userId }),
  ]);
  if (count.error || usage.error) throw new Error("Media library limits could not be checked.");
  return { count: Number(count.count || 0), bytes: Number(usage.data || 0) };
}

export const checkContentMediaUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ bytes: z.number().int().min(1), kind: z.enum(["image", "video"]) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const plan = await getPlan(context.userId);
    if (data.bytes > uploadLimitMb(data.kind, plan) * 1024 * 1024)
      throw new Error("This file exceeds your plan's upload size limit.");
    const usage = await manualMediaAvailability(context.userId);
    if (usage.count >= MANUAL_MEDIA_LIMIT)
      throw new Error("Your Media library has 50 manual items.");
    if (usage.bytes + data.bytes > BRAIN_MEDIA_BUDGET_BYTES)
      throw new Error("Your Brain Media library has reached its 1 GB limit.");
    return { allowed: true };
  });

export const registerContentMediaUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ key: z.string().max(500), name: z.string().trim().min(1).max(160) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    if (
      !data.key.startsWith(`users/${context.userId}/image/`) &&
      !data.key.startsWith(`users/${context.userId}/video/`)
    )
      throw new Error("This upload is not in your Media library.");
    const object = await getMediaBucket().head(data.key);
    const mime = object?.httpMetadata?.contentType || "";
    if (!object || !/^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm))$/.test(mime))
      throw new Error("This Media upload is unavailable or unsupported.");
    const plan = await getPlan(context.userId);
    if (
      object.size >
      uploadLimitMb(mime.startsWith("video/") ? "video" : "image", plan) * 1024 * 1024
    )
      throw new Error("This file exceeds your plan's upload size limit.");
    const usage = await manualMediaAvailability(context.userId);
    if (usage.bytes + object.size > BRAIN_MEDIA_BUDGET_BYTES)
      throw new Error("Your Brain Media library has reached its 1 GB limit.");
    const { data: id, error } = await (supabaseAdmin as any).rpc(
      "register_creator_uploaded_media",
      {
        p_user_id: context.userId,
        p_key: data.key,
        p_url: mediaObjectUrl(data.key),
        p_name: data.name,
        p_mime: mime,
        p_bytes: object.size,
      },
    );
    if (error || !id) throw new Error(error?.message || "This upload could not be added to Media.");
    return { id: String(id) };
  });

export const requestContentMediaFromPost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ url: z.string().trim().max(2000) }).parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const url = parsePublicHttpUrl(data.url, { requireHttps: true });
    if (!url) throw new Error("Enter a valid HTTPS link to your connected post.");
    const db = supabaseAdmin as any;
    const canonical = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    const { data: post, error: postError } = await db
      .from("social_content_insights")
      .select("id")
      .eq("user_id", context.userId)
      .in("remote_post_url", [...new Set([data.url, canonical, `${canonical}/`])])
      .limit(1)
      .maybeSingle();
    if (postError) throw new Error("This connected post could not be found.");
    if (!post)
      throw new Error("Refresh Social Insights for this post, or upload its file instead.");
    const { data: id, error } = await db.rpc("request_creator_media_from_post", {
      p_user_id: context.userId,
      p_post_id: post.id,
    });
    if (error || !id) throw new Error(error?.message || "This post could not be queued.");
    const queue = (
      globalThis.__env__ as { CONTENT_MEDIA_QUEUE?: Queue<ContentMediaImportMessage> } | undefined
    )?.CONTENT_MEDIA_QUEUE;
    if (queue) await enqueueDueContentMediaImports(queue, 1).catch(() => undefined);
    return { id: String(id), queued: true };
  });

export const createContentMediaFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ name: folderName }).parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const db = supabaseAdmin as any;
    const { count, error: countError } = await db
      .from("creator_media_folders")
      .select("id", { count: "exact", head: true })
      .eq("user_id", context.userId);
    if (countError) throw new Error("Media folders could not be counted.");
    if ((count || 0) >= MEDIA_FOLDER_LIMIT)
      throw new Error("You can create up to 20 Media folders.");
    const { data: folder, error } = await db
      .from("creator_media_folders")
      .insert({ user_id: context.userId, name: data.name })
      .select("id,name")
      .single();
    if (error || !folder) throw new Error("This Media folder could not be created.");
    return folder;
  });

export const renameContentMediaFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => folderId.extend({ name: folderName }).parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const { data: folder, error } = await (supabaseAdmin as any)
      .from("creator_media_folders")
      .update({ name: data.name })
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error || !folder) throw new Error("This Media folder could not be renamed.");
    return { renamed: true };
  });

export const deleteContentMediaFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => folderId.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const { data: folder, error } = await (supabaseAdmin as any)
      .from("creator_media_folders")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error || !folder) throw new Error("This Media folder could not be deleted.");
    return { deleted: true };
  });

export const moveContentMediaToFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => mediaId.extend({ folderId: uuid.nullable() }).parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const db = supabaseAdmin as any;
    if (data.folderId) {
      const { data: folder, error } = await db
        .from("creator_media_folders")
        .select("id")
        .eq("id", data.folderId)
        .eq("user_id", context.userId)
        .maybeSingle();
      if (error || !folder) throw new Error("This Media folder is unavailable.");
    }
    const { data: media, error } = await db
      .from("creator_content_media")
      .update({ folder_id: data.folderId })
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .eq("status", "ready")
      .select("id")
      .maybeSingle();
    if (error || !media) throw new Error("This Media item could not be moved.");
    return { moved: true };
  });

export const setContentHeroImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ slot: z.number().int().min(1).max(4), id: uuid.nullable() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const { error } = await (supabaseAdmin as any).rpc("set_creator_hero_media", {
      p_user_id: context.userId,
      p_media_id: data.id,
      p_slot: data.slot,
    });
    if (error) throw new Error("This hero image could not be saved.");
    return { saved: true };
  });
