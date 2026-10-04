/* eslint-disable @typescript-eslint/no-explicit-any -- New tables ship with the paired migration. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireContentWorkspace } from "./content-access.server";
import {
  brainItemFromRow,
  brainItemInputSchema,
  contentProfileFromRow,
  contentProfileSchema,
  contentProfileToRow,
} from "./content-brain";
import { isPublicSocialProvider } from "./social-scheduler";
import { recordContentEvent } from "./content-workspace-analytics.server";
import { requestContentIndex } from "./content-index.server";
import { contentMediaSearchTerms } from "./content-media";
import { parsePublicHttpUrl } from "./safe-url";

const brainItemIdSchema = z.object({ id: z.string().uuid() });
const lockBrainItemSchema = brainItemIdSchema.extend({ locked: z.boolean() });

async function loadContentBrain(userId: string) {
  const db = supabaseAdmin as any;
  const [
    profileResult,
    itemsResult,
    sourcesResult,
    knowledgeSourcesResult,
    calendarSourcesResult,
    fathomSourcesResult,
    photosResult,
    indexResult,
  ] = await Promise.all([
    db.from("creator_content_profiles").select("*").eq("user_id", userId).maybeSingle(),
    db
      .from("creator_brain_items")
      .select("*")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false }),
    db
      .from("social_connections")
      .select("id,provider,provider_handle,provider_display_name,status,reauth_required,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: true }),
    db
      .from("content_connections")
      .select("id,provider,display_name,status,last_success_at,created_at")
      .eq("user_id", userId)
      .in("provider", ["notion", "granola", "github", "slack"])
      .order("created_at", { ascending: true }),
    db
      .from("booking_calendar_connections")
      .select("id,provider,display_name,email,status,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: true }),
    db
      .from("booking_fathom_connections")
      .select("id,display_name,email,status,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: true }),
    db
      .from("creator_content_media")
      .select("id,connection_id,provider,caption,public_url,source_url,media_type,tags")
      .eq("user_id", userId)
      .eq("status", "ready")
      .in("media_type", ["image", "video", "thumbnail"])
      .order("created_at", { ascending: false })
      .limit(300),
    db
      .from("creator_content_index_jobs")
      .select("status,indexed_at,error_message,source_count,media_count")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  if (
    profileResult.error ||
    itemsResult.error ||
    sourcesResult.error ||
    knowledgeSourcesResult.error ||
    calendarSourcesResult.error ||
    fathomSourcesResult.error ||
    photosResult.error ||
    indexResult.error
  ) {
    throw new Error("The Content Brain could not be loaded.");
  }

  const profile = profileResult.data
    ? contentProfileFromRow(profileResult.data)
    : contentProfileSchema.parse({});
  const items = (itemsResult.data || []).map(brainItemFromRow);
  const socialSources = (sourcesResult.data || [])
    .filter((source: any) => isPublicSocialProvider(String(source.provider)))
    .map((source: any) => ({
      id: String(source.id),
      provider: String(source.provider),
      handle: String(source.provider_handle || "")
        .trim()
        .replace(/^@+/, ""),
      displayName: String(source.provider_display_name || source.provider_handle || ""),
      status: source.reauth_required ? "expired" : String(source.status || "error"),
    }));
  const knowledgeSources = (knowledgeSourcesResult.data || []).map((source: any) => ({
    id: String(source.id),
    provider: String(source.provider),
    handle: "",
    displayName: String(source.display_name || source.provider),
    status: String(source.status || "error"),
  }));
  const calendarSources = (calendarSourcesResult.data || []).map((source: any) => ({
    id: String(source.id),
    provider: "google_calendar",
    handle: "",
    displayName: String(source.display_name || source.email || "Google Calendar"),
    status: String(source.status || "error"),
  }));
  const fathomSources = (fathomSourcesResult.data || []).map((source: any) => ({
    id: String(source.id),
    provider: "fathom",
    handle: "",
    displayName: String(source.display_name || source.email || "Fathom"),
    status: String(source.status || "error"),
  }));
  const sources = [...socialSources, ...knowledgeSources, ...calendarSources, ...fathomSources];
  const photos = contentBrainMediaRows(photosResult.data || []);
  const indexing = indexResult.data
    ? {
        status: String(indexResult.data.status),
        indexedAt: indexResult.data.indexed_at || null,
        error: indexResult.data.error_message || null,
        sourceCount: Number(indexResult.data.source_count || 0),
        mediaCount: Number(indexResult.data.media_count || 0),
      }
    : null;
  return { profile, items, sources, photos, indexing };
}

function contentBrainMediaRows(rows: any[]) {
  return (rows || [])
    .filter((photo: any) => parsePublicHttpUrl(photo.public_url, { requireHttps: true }))
    .map((photo: any) => ({
      id: String(photo.id),
      title: String(photo.caption || `${photo.provider} media`)
        .split("\n")[0]
        .slice(0, 160),
      caption: String(photo.caption || ""),
      url: String(photo.public_url),
      provider: String(photo.provider),
      type: (photo.media_type === "video" ? "video" : "image") as "image" | "video",
      role: (photo.media_type === "thumbnail" ? "thumbnail" : "attachment") as
        "thumbnail" | "attachment",
      tags: Array.isArray(photo.tags) ? photo.tags : [],
      sourceUrl: parsePublicHttpUrl(photo.source_url, { requireHttps: true })
        ? String(photo.source_url)
        : null,
    }));
}

export const getContentBrain = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId);
    return loadContentBrain(context.userId);
  });

export const searchContentBrainMedia = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ query: z.string().trim().max(300) }).parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const terms = contentMediaSearchTerms(data.query);
    let query = (supabaseAdmin as any)
      .from("creator_content_media")
      .select("id,connection_id,provider,caption,public_url,source_url,media_type,tags")
      .eq("user_id", context.userId)
      .eq("status", "ready");
    if (terms.length)
      query = query.textSearch("search_document", terms.join(" OR "), {
        type: "websearch",
        config: "simple",
      });
    const { data: media, error } = await query.order("created_at", { ascending: false }).limit(100);
    if (error) throw new Error("Your media library could not be searched.");
    return contentBrainMediaRows(media || []);
  });

export const saveContentProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => contentProfileSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const { error } = await (supabaseAdmin as any).from("creator_content_profiles").upsert({
      user_id: context.userId,
      ...contentProfileToRow(data),
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error("The Content profile could not be saved.");
    await requestContentIndex(context.userId, true);
    return loadContentBrain(context.userId);
  });

export const saveBrainItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => brainItemInputSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const db = supabaseAdmin as any;
    const row = {
      user_id: context.userId,
      kind: data.kind,
      title: data.title,
      content: data.content,
      provenance: data.provenance,
      source_url: data.sourceUrl || null,
      source_ref: data.sourceRef || null,
      status: data.status,
      locked: data.locked,
      ...(data.tags ? { tags: data.tags } : {}),
      updated_at: new Date().toISOString(),
    };
    const result = data.id
      ? await db
          .from("creator_brain_items")
          .update(row)
          .eq("id", data.id)
          .eq("user_id", context.userId)
          .select("id")
          .maybeSingle()
      : await db.from("creator_brain_items").insert(row).select("id").maybeSingle();
    if (result.error || !result.data) throw new Error("The Brain item could not be saved.");
    return loadContentBrain(context.userId);
  });

export const confirmBrainItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => brainItemIdSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const { data: updated, error } = await (supabaseAdmin as any)
      .from("creator_brain_items")
      .update({ status: "confirmed", locked: true, updated_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("id,kind")
      .maybeSingle();
    if (error || !updated) throw new Error("The Brain item could not be confirmed.");
    void recordContentEvent(context.userId, "content_brain_confirmed", { kind: updated.kind });
    return loadContentBrain(context.userId);
  });

export const setBrainItemLocked = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => lockBrainItemSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const { data: updated, error } = await (supabaseAdmin as any)
      .from("creator_brain_items")
      .update({ locked: data.locked, updated_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error || !updated) throw new Error("The Brain item lock could not be changed.");
    return loadContentBrain(context.userId);
  });

export const deleteBrainItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => brainItemIdSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const { data: deleted, error } = await (supabaseAdmin as any)
      .from("creator_brain_items")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error || !deleted) throw new Error("The Brain item could not be deleted.");
    return loadContentBrain(context.userId);
  });
