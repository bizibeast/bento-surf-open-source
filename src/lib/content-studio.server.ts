import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireContentWorkspace } from "./content-access.server";
import { agentBranding } from "./content-agent-branding";
import { MEDIA_CDN_PATH, validateMediaObjectKey } from "./r2-storage.server";
import {
  studioEntrySchema,
  studioMediaReferences,
  type StudioEntry,
  type StudioMedia,
} from "./content-studio";

// The tables are deployed additively and their documents are validated at the boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any;
export async function requireStudioWorkspace(workspaceId: string) {
  if (process.env.BENTO_V2_STUDIO_ENABLED !== "true")
    throw new Error("Content Studio is unavailable for this workspace.");
  await requireContentWorkspace(workspaceId, "discover");
}

const mediaRowSchema = z.object({
  id: z.string().uuid(),
  caption: z.string().nullable(),
  media_type: z.enum(["image", "video"]),
  storage_key: z.string(),
});

function studioAsset(value: unknown, workspaceId: string): StudioMedia | null {
  const parsed = mediaRowSchema.safeParse(value);
  if (!parsed.success) return null;
  const row = parsed.data;
  const key = validateMediaObjectKey(row.storage_key);
  if (!key?.startsWith(`users/${workspaceId}/`)) return null;
  return {
    id: row.id,
    name: row.caption?.trim().slice(0, 100) || (row.media_type === "image" ? "Photo" : "Video"),
    kind: row.media_type,
    url: `${MEDIA_CDN_PATH}${key}`,
  };
}

function loadStudioMedia(workspaceId: string) {
  return db
    .from("creator_content_media")
    .select("id,caption,media_type,storage_key")
    .eq("user_id", workspaceId)
    .eq("status", "ready")
    .in("mime_type", [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "video/mp4",
      "video/webm",
    ])
    .limit(51);
}

function studioAssets(rows: unknown[], workspaceId: string) {
  return rows.flatMap((row) => {
    const asset = studioAsset(row, workspaceId);
    return asset ? [asset] : [];
  });
}

export async function listContentStudioEntriesForWorkspace(
  workspaceId: string,
): Promise<StudioEntry[]> {
  await requireStudioWorkspace(workspaceId);
  const result = await db
    .from("content_studio_entries")
    .select("id,kind,title,document,revision")
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(100);
  if (result.error) throw new Error("Studio projects could not be loaded.");
  return studioEntrySchema.array().parse(result.data || []);
}

export async function getStudioWorkspaceBrand(workspaceId: string) {
  const preferences = await db
    .from("content_agent_preferences")
    .select("branding")
    .eq("user_id", workspaceId)
    .maybeSingle();
  if (preferences.error) throw new Error("Studio branding could not be loaded.");
  return agentBranding(preferences.data?.branding);
}

export async function listStudioWorkspaceMedia(
  workspaceId: string,
  pageNumber: number,
  selectedIds: string[],
) {
  await requireStudioWorkspace(workspaceId);
  const [page, selected] = await Promise.all([
    loadStudioMedia(workspaceId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(pageNumber * 50, pageNumber * 50 + 50),
    selectedIds.length
      ? loadStudioMedia(workspaceId).in("id", selectedIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (page.error || selected.error) throw new Error("Studio media could not be loaded.");
  const rows = studioAssets([...page.data.slice(0, 50), ...selected.data], workspaceId);
  return {
    assets: [...new Map(rows.map((asset) => [asset.id, asset])).values()],
    hasMore: page.data.length > 50,
  };
}

export async function saveContentStudioEntryForWorkspace(
  workspaceId: string,
  input: StudioEntry,
): Promise<StudioEntry> {
  await requireStudioWorkspace(workspaceId);
  const entry = studioEntrySchema.parse(input);
  const ids = [
    ...new Set(studioMediaReferences(entry.document).filter((id): id is string => Boolean(id))),
  ];
  if (ids.length) {
    const result = await loadStudioMedia(workspaceId).in("id", ids);
    if (result.error) throw new Error("Studio media could not be verified.");
    const assets = studioAssets(result.data, workspaceId);
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    if (ids.some((id) => !byId.has(id)))
      throw new Error("Replace or remove unavailable media before saving.");
    if (entry.document.format === "carousel" && assets.some(({ kind }) => kind !== "image"))
      throw new Error("Carousel slides use images.");
    if (
      entry.document.format === "reel" &&
      entry.document.scenes.some(
        (scene) =>
          scene.kind === "avatar" && scene.mediaId && byId.get(scene.mediaId)?.kind !== "video",
      )
    )
      throw new Error("An avatar scene requires a video.");
  }
  const saved = await db.rpc("save_content_studio_entry", {
    p_workspace_id: workspaceId,
    p_id: entry.id,
    p_kind: entry.kind,
    p_title: entry.title,
    p_revision: entry.revision,
    p_document: entry.document,
  });
  if (saved.error) {
    if (saved.error.message === "Studio project and preset limit reached.")
      throw new Error(saved.error.message);
    throw new Error("This project could not be saved. Retry the save.");
  }
  if (saved.data === null)
    throw new Error("This item changed in another session. Reopen it or save a copy.");
  return { ...entry, revision: z.number().int().positive().parse(saved.data) };
}

export async function deleteStudioWorkspaceEntry(
  workspaceId: string,
  id: string,
  revision: number,
) {
  await requireStudioWorkspace(workspaceId);
  const result = await db
    .from("content_studio_entries")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .eq("revision", revision)
    .select("id")
    .maybeSingle();
  if (result.error) throw new Error("The Studio item could not be deleted.");
  if (!result.data) throw new Error("This item changed in another session. Reopen it.");
  return { id };
}
