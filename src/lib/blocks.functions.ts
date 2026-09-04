import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getPlan } from "./plan.server";
import { blockEntitlement, entitlementUpgradeMessage, planHasEntitlement } from "./plans";
import { safeMediaUrl } from "./safe-url";
import { nextEmptyGridRow } from "./grid-geometry";

export const blockTypeSchema = z.enum([
  "social_link",
  "generic_link",
  "image",
  "image_gallery",
  "video",
  "spotify",
  "link_preview",
  "map",
  "heading",
  "note",
  "quote",
  "email_capture",
  "booking",
  "tip_jar",
  "contact",
  "audio",
  "file_download",
  "divider",
  "section_title",
  "experience",
  "commerce",
]);

export const pageIdInputSchema = z.string().uuid().nullable().optional();
export const blockMediaUrlSchema = z
  .string()
  .max(2_048)
  .refine((value) => Boolean(safeMediaUrl(value)), "Use a public media URL.");

function unsafeStoredValue(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (typeof value === "string") {
    return (
      /^(?:javascript|vbscript):/i.test(value.trim()) || /^data:text\/html/i.test(value.trim())
    );
  }
  if (Array.isArray(value)) {
    return value.length > 200 || value.some((item) => unsafeStoredValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      entries.length > 200 ||
      entries.some(
        ([key, item]) =>
          ["__proto__", "prototype", "constructor"].includes(key) ||
          unsafeStoredValue(item, depth + 1),
      )
    );
  }
  return false;
}

export const blockContentSchema = z
  .record(z.string().max(100), z.any())
  .superRefine((value, context) => {
    if (JSON.stringify(value).length > 100_000) {
      context.addIssue({ code: "custom", message: "Block content is too large." });
    }
    if (unsafeStoredValue(value)) {
      context.addIssue({ code: "custom", message: "Block content contains an unsafe value." });
    }
  });

export const getMyBlocks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({ pageId: pageIdInputSchema })
      .default({})
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    let q = supabase
      .from("blocks")
      .select("*")
      .eq("user_id", userId)
      .order("position", { ascending: true });
    if (data.pageId) q = q.eq("page_id", data.pageId);
    else q = q.is("page_id", null);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

/**
 * The setup checklist is account-wide, not page-specific. Only return the
 * block type it needs so secondary pages count without loading every block's
 * content into the editor.
 */
export const getMySetupBlocks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: rows, error } = await supabase
      .from("blocks")
      .select("type")
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const createBlock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        type: blockTypeSchema,
        content: blockContentSchema.default({}),
        cover_url: blockMediaUrlSchema.nullable().optional(),
        w: z.number().int().min(1).max(4).default(2),
        h: z.number().int().min(1).max(6).default(2),
        x: z.number().int().min(0).optional(),
        y: z.number().int().min(0).optional(),
        pageId: pageIdInputSchema,
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const entitlement = blockEntitlement(data.type);
    if (entitlement && !planHasEntitlement(await getPlan(userId), entitlement)) {
      throw new Error(entitlementUpgradeMessage(entitlement));
    }

    let layoutQ = supabase.from("blocks").select("y,h").eq("user_id", userId);
    if (data.pageId) layoutQ = layoutQ.eq("page_id", data.pageId);
    else layoutQ = layoutQ.is("page_id", null);
    const { data: existingLayout, error: layoutError } = await layoutQ;
    if (layoutError) throw new Error(layoutError.message);

    const { data: row, error } = await supabase
      .from("blocks")
      .insert({
        user_id: userId,
        type: data.type,
        content: data.content,
        cover_url: data.cover_url ?? null,
        w: data.w,
        h: data.h,
        x: data.x ?? 0,
        y: data.y ?? nextEmptyGridRow(existingLayout ?? []),
        position: existingLayout?.length ?? 0,
        page_id: data.pageId ?? null,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const updateBlock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        id: z.string().uuid(),
        content: blockContentSchema.optional(),
        cover_url: blockMediaUrlSchema.nullable().optional(),
        w: z.number().int().min(1).max(4).optional(),
        h: z.number().int().min(1).max(6).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { id, ...patch } = data;
    const { data: existing, error: existingError } = await supabase
      .from("blocks")
      .select("type")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);
    if (!existing) throw new Error("Block not found.");
    const entitlement = blockEntitlement(existing.type);
    if (entitlement && !planHasEntitlement(await getPlan(userId), entitlement)) {
      throw new Error(entitlementUpgradeMessage(entitlement));
    }
    const { data: row, error } = await supabase
      .from("blocks")
      .update(patch)
      .eq("id", id)
      .eq("user_id", userId)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const updateBlockLayout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        items: z
          .array(
            z.object({
              id: z.string().uuid(),
              x: z.number().int().min(0),
              y: z.number().int().min(0),
              w: z.number().int().min(1).max(4),
              h: z.number().int().min(1).max(6),
              position: z.number().int().min(0),
            }),
          )
          .max(200),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await Promise.all(
      data.items.map((item) =>
        supabase
          .from("blocks")
          .update({ x: item.x, y: item.y, w: item.w, h: item.h, position: item.position })
          .eq("id", item.id)
          .eq("user_id", userId),
      ),
    );
    return { ok: true };
  });

export const deleteBlock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("blocks")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
