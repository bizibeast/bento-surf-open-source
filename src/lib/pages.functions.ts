import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getPlan } from "./plan.server";
import { planLimits, planName } from "./plans";
import { parsePublicHttpUrl } from "./safe-url";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { clearPublicProfileCache } from "./public-profile-cache.server";
import { clearPublicBookingCalendarCache } from "./public-booking-calendar-cache.server";

export const pageNameSchema = z.string().trim().min(1).max(40);
export const pageSystemSchema = z.enum(["calendar", "store", "insights", "newsletter"]);
export type PageSystem = z.infer<typeof pageSystemSchema>;

const systemPageNames: Record<PageSystem, string> = {
  calendar: "Calendar",
  store: "Store",
  insights: "Insights",
  newsletter: "Newsletter",
};

export async function invalidateCreatorPageCaches(
  supabase: SupabaseClient<Database>,
  userId: string,
  previousSlugs: string[] = [],
) {
  if (typeof caches === "undefined" || !(caches as CacheStorage & { default?: Cache }).default)
    return;
  const [profile, pages, domains] = await Promise.all([
    supabase.from("profiles").select("username").eq("id", userId).single(),
    supabase.from("pages").select("slug").eq("user_id", userId).is("system", null),
    supabase.from("custom_domains").select("hostname").eq("user_id", userId),
  ]);
  const error = profile.error ?? pages.error ?? domains.error;
  if (error) throw new Error(error.message);
  if (!profile.data?.username) return;
  await Promise.all([
    clearPublicProfileCache(
      profile.data.username,
      [...previousSlugs, ...(pages.data ?? []).map((page) => page.slug)],
      (domains.data ?? []).map((domain) => domain.hostname),
    ),
    clearPublicBookingCalendarCache(profile.data.username),
  ]);
}

async function nextPagePosition(supabase: SupabaseClient<Database>, userId: string) {
  const { data, error } = await supabase
    .from("pages")
    .select("position")
    .eq("user_id", userId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.position ?? -1) + 1;
}

export async function setSystemPageVisibility(
  supabase: SupabaseClient<Database>,
  userId: string,
  system: PageSystem,
  visible: boolean,
  name?: string,
): Promise<Database["public"]["Tables"]["pages"]["Row"]> {
  pageSystemSchema.parse(system);
  const label = name === undefined ? undefined : pageNameSchema.parse(name);
  const { data: existing, error: readError } = await supabase
    .from("pages")
    .select("*")
    .eq("user_id", userId)
    .eq("system", system)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  const updates = { is_visible: visible, ...(label === undefined ? {} : { name: label }) };
  let result;
  if (existing) {
    result = await supabase
      .from("pages")
      .update(updates)
      .eq("user_id", userId)
      .eq("id", existing.id)
      .select("*")
      .single();
  } else {
    result = await supabase
      .from("pages")
      .insert({
        user_id: userId,
        system,
        slug: `__system_${system}`,
        name: label ?? systemPageNames[system],
        is_visible: visible,
        position: await nextPagePosition(supabase, userId),
      })
      .select("*")
      .single();
    // A concurrent enable can insert first; preserve that row's position and layout.
    if (result.error?.code === "23505") {
      result = await supabase
        .from("pages")
        .update(updates)
        .eq("user_id", userId)
        .eq("system", system)
        .select("*")
        .single();
    }
  }
  if (result.error) throw new Error(result.error.message);
  await invalidateCreatorPageCaches(supabase, userId);
  return result.data;
}
export const pageUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .refine((value) => Boolean(parsePublicHttpUrl(value)), "Use a public HTTP or HTTPS URL.");

type SignupBlock = Pick<Database["public"]["Tables"]["blocks"]["Row"], "content">;

export function isHomepageNewsletterSignup(block: {
  type: string;
  page_id: string | null;
  content: unknown;
}) {
  return (
    block.type === "email_capture" &&
    block.page_id === null &&
    Boolean(newsletterSignupPublicationId(block))
  );
}

function newsletterSignupPublicationId(block: { content: unknown }) {
  if (!block.content || typeof block.content !== "object" || Array.isArray(block.content))
    return null;
  const id = z
    .string()
    .uuid()
    .safeParse((block.content as Record<string, unknown>).newsletterPublicationId);
  return id.success ? id.data : null;
}

export async function reconcileNewsletterPageVisibility(
  supabase: SupabaseClient<Database>,
  userId: string,
  knownSignupBlocks?: SignupBlock[],
) {
  let blocks = knownSignupBlocks;
  if (!blocks) {
    const { data, error } = await supabase
      .from("blocks")
      .select("content")
      .eq("user_id", userId)
      .eq("type", "email_capture")
      .is("page_id", null);
    if (error) throw new Error(error.message);
    blocks = data ?? [];
  }
  const ids = [
    ...new Set(blocks.map(newsletterSignupPublicationId).filter((id): id is string => id !== null)),
  ];
  let visible = false;
  if (ids.length) {
    const { data, error } = await supabase
      .from("newsletter_publications")
      .select("id")
      .eq("creator_id", userId)
      .eq("status", "published")
      .in("id", ids)
      .limit(1);
    if (error) throw new Error(error.message);
    visible = Boolean(data?.length);
  }
  return setSystemPageVisibility(supabase, userId, "newsletter", visible);
}

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
      .eq("is_visible", true)
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
    const { data, error } = await q.maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return slug;
    i += 1;
    slug = `${availableBase}-${i}`;
  }
}

const createPageSchema = z.object({
  name: pageNameSchema,
  url: pageUrlSchema.nullable().optional(),
});

export const createPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => createPageSchema.parse(input))
  .handler(({ data, context }) => createPageForCreator(context.supabase, context.userId, data));

export async function createPageForCreator(
  supabase: SupabaseClient<Database>,
  userId: string,
  input: z.infer<typeof createPageSchema>,
) {
  const data = createPageSchema.parse(input);
  const { count, error: countError } = await supabase
    .from("pages")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("system", null)
    .is("url", null);
  if (countError) throw new Error(countError.message);

  const plan = await getPlan(userId);
  const limits = planLimits(plan);
  const totalPages = (count ?? 0) + 1;
  if (!data.url && limits.maxPages !== null && totalPages >= limits.maxPages) {
    throw new Error(
      `${planName(plan)} includes ${limits.maxPages} pages. Delete an existing page before creating another.`,
    );
  }

  const position = await nextPagePosition(supabase, userId);
  const slug = await uniquePageSlug(supabase, userId, slugifyPageName(data.name));
  const { data: row, error } = await supabase
    .from("pages")
    .insert({
      user_id: userId,
      name: data.name.trim(),
      slug,
      position,
      system: null,
      is_visible: true,
      url: data.url ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  await invalidateCreatorPageCaches(supabase, userId);
  return row;
}

export const renamePage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid(), name: pageNameSchema }).parse(input))
  .handler(({ data, context }) => renamePageForCreator(context.supabase, context.userId, data));

export async function renamePageForCreator(
  supabase: SupabaseClient<Database>,
  userId: string,
  input: { id: string; name: string },
) {
  const data = z.object({ id: z.string().uuid(), name: pageNameSchema }).parse(input);
  const { data: page, error: readError } = await supabase
    .from("pages")
    .select("system,slug")
    .eq("id", data.id)
    .eq("user_id", userId)
    .single();
  if (readError) throw new Error(readError.message);
  if (!page) throw new Error("Page not found.");
  const updates = page.system
    ? { name: data.name.trim() }
    : {
        name: data.name.trim(),
        slug: await uniquePageSlug(supabase, userId, slugifyPageName(data.name), data.id),
      };
  const { data: row, error } = await supabase
    .from("pages")
    .update(updates)
    .eq("id", data.id)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  await invalidateCreatorPageCaches(supabase, userId, page.system ? [] : [page.slug]);
  return row;
}

export const deletePage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(({ data, context }) => deletePageForCreator(context.supabase, context.userId, data.id));

export async function deletePageForCreator(
  supabase: SupabaseClient<Database>,
  userId: string,
  id: string,
) {
  const data = { id: z.string().uuid().parse(id) };
  const { data: page, error: readError } = await supabase
    .from("pages")
    .select("system,slug")
    .eq("id", data.id)
    .eq("user_id", userId)
    .single();
  if (readError) throw new Error(readError.message);
  if (!page) throw new Error("Page not found.");
  if (page.system) throw new Error("Hide system pages from their page settings.");
  const { error } = await supabase.from("pages").delete().eq("id", data.id).eq("user_id", userId);
  if (error) throw new Error(error.message);
  await invalidateCreatorPageCaches(supabase, userId, [page.slug]);
  return { ok: true };
}

export const reorderMyPages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        pageIds: z
          .array(z.string().uuid())
          .max(100)
          .refine((ids) => new Set(ids).size === ids.length, "Page IDs must be unique."),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("reorder_creator_pages", {
      page_ids: data.pageIds,
    });
    if (error) throw new Error(error.message);
    await invalidateCreatorPageCaches(context.supabase, context.userId);
    return { ok: true as const };
  });
