import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  exploreCategorySchema,
  explorePreviewUrl,
  normalizeExploreSearch,
  type ExploreCategory,
} from "@/lib/explore";
import { enforceRequestRateLimit } from "@/lib/request-security.server";
import { publicPagePreviewVersion } from "@/lib/open-graph";
import { safePublicMediaUrl } from "@/lib/safe-url";

const EXPLORE_PAGE_SIZE = 24;

const exploreInputSchema = z.object({
  category: exploreCategorySchema.nullable().optional(),
  query: z.string().max(80).optional(),
  page: z.number().int().min(1).max(500).default(1),
});

export type ExploreProfile = {
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  category: ExploreCategory;
  previewUrl: string;
};

type ExplorePreviewProfile = {
  id: string;
  username: string;
  display_name: string;
  bio: string;
  updated_at: string;
};

async function previewUrlsForProfiles(usernames: string[]) {
  const urls = new Map<string, string>();
  if (usernames.length === 0) return urls;

  const profileResult = await supabaseAdmin
    .from("profiles")
    .select("id, username, display_name, bio, updated_at")
    .in("username", usernames);
  if (profileResult.error) {
    console.error("Explore preview profiles query failed", profileResult.error);
    throw new Error("Explore is unavailable right now");
  }

  const previewProfiles = (profileResult.data ?? []) as ExplorePreviewProfile[];
  const userIds = previewProfiles.map((profile) => profile.id);
  if (userIds.length === 0) return urls;

  const [pagesResult, blocksResult] = await Promise.all([
    supabaseAdmin
      .from("pages")
      .select("id, user_id, slug, position, updated_at")
      .in("user_id", userIds)
      .order("position", { ascending: true }),
    supabaseAdmin
      .from("blocks")
      .select("id, user_id, position, updated_at")
      .in("user_id", userIds)
      .is("page_id", null)
      .order("position", { ascending: true }),
  ]);
  if (pagesResult.error || blocksResult.error) {
    console.error("Explore preview content query failed", {
      pages: pagesResult.error,
      blocks: blocksResult.error,
    });
    throw new Error("Explore is unavailable right now");
  }

  const pagesByUser = new Map<string, Array<{ id: string; slug: string; updated_at: string }>>();
  for (const page of pagesResult.data ?? []) {
    const pages = pagesByUser.get(page.user_id) ?? [];
    pages.push({ id: page.id, slug: page.slug, updated_at: page.updated_at });
    pagesByUser.set(page.user_id, pages);
  }

  const blocksByUser = new Map<string, Array<{ id: string; updated_at: string }>>();
  for (const block of blocksResult.data ?? []) {
    const blocks = blocksByUser.get(block.user_id) ?? [];
    blocks.push({ id: block.id, updated_at: block.updated_at });
    blocksByUser.set(block.user_id, blocks);
  }

  for (const profile of previewProfiles) {
    const version = publicPagePreviewVersion({
      profile,
      pages: pagesByUser.get(profile.id) ?? [],
      blocks: blocksByUser.get(profile.id) ?? [],
      activePageId: null,
    });
    urls.set(profile.username, explorePreviewUrl(profile.username, version));
  }
  return urls;
}

export const getExploreProfiles = createServerFn({ method: "GET" })
  .validator((input) => exploreInputSchema.parse(input))
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "explore-directory");

    const queryText = normalizeExploreSearch(data.query ?? "");
    const from = (data.page - 1) * EXPLORE_PAGE_SIZE;

    const { data: profiles, error } = await supabaseAdmin.rpc("get_explore_profiles", {
      p_category: data.category ?? null,
      p_query: queryText,
      p_limit: EXPLORE_PAGE_SIZE,
      p_offset: from,
    });
    if (error) {
      console.error("Explore directory query failed", error);
      throw new Error("Explore is unavailable right now");
    }

    const visibleProfiles = (profiles ?? []).slice(0, EXPLORE_PAGE_SIZE);
    const previewUrls = await previewUrlsForProfiles(
      visibleProfiles.map((profile) => profile.username),
    );
    const items: ExploreProfile[] = visibleProfiles.map((profile) => ({
      username: profile.username,
      displayName: profile.display_name || profile.username,
      bio: profile.bio,
      avatarUrl: safePublicMediaUrl(profile.avatar_url),
      category: exploreCategorySchema.catch("creator").parse(profile.explore_category),
      previewUrl: previewUrls.get(profile.username) ?? explorePreviewUrl(profile.username),
    }));

    return {
      items,
      page: data.page,
      pageSize: EXPLORE_PAGE_SIZE,
      total: Math.max(0, Number(profiles?.[0]?.total_count ?? 0)),
      query: queryText,
      category: data.category ?? null,
    };
  });
