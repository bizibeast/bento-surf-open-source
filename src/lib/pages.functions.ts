import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getPlan } from "./plan.server";
import { planLimits, planName } from "./plans";
import { parsePublicHttpUrl } from "./safe-url";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export const pageNameSchema = z.string().min(1).max(40);
export const pageUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .refine((value) => Boolean(parsePublicHttpUrl(value)), "Use a public HTTP or HTTPS URL.");

export const RESERVED_CREATOR_PAGE_SLUGS = new Set([
  "calendar",
  "insights",
  "newsletter",
  "products",
]);

export function slugifyPageName(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "page"
  );
}

export const getMyPages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("pages")
      .select("*")
      .eq("user_id", userId)
      .order("position", { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export async function uniquePageSlug(
  supabase: SupabaseClient<Database>,
  userId: string,
  base: string,
  ignoreId?: string,
) {
  const availableBase = RESERVED_CREATOR_PAGE_SLUGS.has(base) ? `${base}-page` : base;
  let slug = availableBase;
  let i = 1;
  while (true) {
    let q = supabase.from("pages").select("id").eq("user_id", userId).eq("slug", slug);
    if (ignoreId) q = q.neq("id", ignoreId);
    const { data } = await q.maybeSingle();
    if (!data) return slug;
    i += 1;
    slug = `${availableBase}-${i}`;
  }
}

export const createPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ name: pageNameSchema, url: pageUrlSchema.nullable().optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { count } = await supabase
      .from("pages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);

    const plan = await getPlan(userId);
    const limits = planLimits(plan);
    const totalPages = (count ?? 0) + 1;
    if (limits.maxPages !== null && totalPages >= limits.maxPages) {
      throw new Error(
        `${planName(plan)} includes ${limits.maxPages} pages. Delete an existing page before creating another.`,
      );
    }

    const slug = await uniquePageSlug(supabase, userId, slugifyPageName(data.name));
    const { data: row, error } = await supabase
      .from("pages")
      .insert({
        user_id: userId,
        name: data.name.trim(),
        slug,
        position: count ?? 0,
        url: data.url ?? null,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const renamePage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid(), name: pageNameSchema }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const slug = await uniquePageSlug(supabase, userId, slugifyPageName(data.name), data.id);
    const { data: row, error } = await supabase
      .from("pages")
      .update({ name: data.name.trim(), slug })
      .eq("id", data.id)
      .eq("user_id", userId)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const deletePage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase.from("pages").delete().eq("id", data.id).eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
