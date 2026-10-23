/* eslint-disable @typescript-eslint/no-explicit-any -- Normalize private shared research rows. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { normalizeNicheKey, sourceMatchesDiscoverNiche } from "./content-briefs.server";
import { selectFreshEditorialSignals, type ContentSourceItem } from "./content-sources.server";

export async function loadStoredDiscoverProfile(userId: string) {
  const { data: profile, error: profileError } = await (supabaseAdmin as any)
    .from("creator_content_profiles")
    .select("niche_keywords,language,region")
    .eq("user_id", userId)
    .maybeSingle();
  if (profileError) throw new Error("Agent research preferences could not load.");
  return {
    nicheKeywords: Array.isArray(profile?.niche_keywords)
      ? profile.niche_keywords.filter(
          (topic: unknown): topic is string => typeof topic === "string",
        )
      : [],
    language: profile?.language || "en",
    region: profile?.region || "global",
  };
}

/** Filter ambient cached research; explicitly requested saved evidence remains readable. */
export function filterAgentDiscoverSources<T extends Record<string, unknown>>(
  rows: T[],
  nicheKeywords: string[],
  request = "",
): T[] {
  const normalize = (value: string) =>
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const requested = normalize(request);
  return rows.filter((row) => {
    const title = typeof row.title === "string" ? row.title : "";
    const summary = typeof row.summary === "string" ? row.summary : "";
    const url =
      typeof row.sourceUrl === "string"
        ? row.sourceUrl
        : typeof row.source_url === "string"
          ? row.source_url
          : "";
    const bookmark = row.saved === true || row.feedback === "saved";
    const normalizedTitle = normalize(title);
    if (
      bookmark &&
      request &&
      ((url && request.includes(url)) ||
        (normalizedTitle.length >= 16 && requested.includes(normalizedTitle)))
    )
      return true;
    return sourceMatchesDiscoverNiche({ title, summary }, nicheKeywords);
  });
}

/** Read only cached preferences and a shared daily brief; never starts provider work. */
export async function loadAgentDiscoverResearch(userId: string) {
  const profile = await loadStoredDiscoverProfile(userId);
  const nicheKey = normalizeNicheKey(profile.nicheKeywords);
  if (!nicheKey) return { nicheKeywords: profile.nicheKeywords, sources: [] };
  const { data: brief, error: briefError } = await (supabaseAdmin as any)
    .from("content_trend_briefs")
    .select("items")
    .eq("niche_key", nicheKey)
    .eq("language", profile.language || "en")
    .eq("region", profile.region || "global")
    .gte("brief_date", new Date(Date.now() - 86400000).toISOString().slice(0, 10))
    .order("brief_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (briefError) {
    console.warn("agent_discover_brief_unavailable");
    return { nicheKeywords: profile.nicheKeywords, sources: [] };
  }
  const items: ContentSourceItem[] = Array.isArray(brief?.items)
    ? brief.items.filter(
        (item: any) =>
          typeof item?.canonicalUrl === "string" &&
          typeof item?.title === "string" &&
          typeof item?.summary === "string" &&
          typeof item?.publishedAt === "string" &&
          typeof item?.kind === "string",
      )
    : [];
  const sources = selectFreshEditorialSignals(
    items.filter((item) => sourceMatchesDiscoverNiche(item, profile.nicheKeywords)),
  ).map((item) => ({
    title: item.title,
    summary: item.summary,
    source_name: item.sourceName,
    source_url: item.canonicalUrl,
    source_published_at: item.publishedAt,
    reason: `Current ${item.sourceName || "source"} report related to this creator's niche.`,
    feedback: "pending",
  }));
  return { nicheKeywords: profile.nicheKeywords, sources };
}

/** Preserve the array contract used by proactive source scans. */
export async function loadFreshBriefSources(userId: string) {
  return (await loadAgentDiscoverResearch(userId)).sources;
}
