/* eslint-disable @typescript-eslint/no-explicit-any -- Shared brief table ships with its migration. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  dedupeSourceItems,
  fetchGdeltStories,
  fetchHackerNewsStories,
  fetchRedditStories,
  fetchYouTubeStories,
  type ContentSourceItem,
} from "./content-sources.server";

export type TrendBriefInput = {
  nicheKeywords: string[];
  language: string;
  region: string;
  date: string;
};

export type TrendBrief = TrendBriefInput & {
  id: string;
  nicheKey: string;
  items: ContentSourceItem[];
  warnings: string[];
};

export type TrendBriefDependencies = {
  readBrief(input: TrendBriefInput & { nicheKey: string }): Promise<TrendBrief | null>;
  fetchSources(input: TrendBriefInput): Promise<PromiseSettledResult<ContentSourceItem[]>[]>;
  saveBrief(input: Omit<TrendBrief, "id">): Promise<TrendBrief>;
};

export function normalizeNicheKey(keywords: string[]) {
  const normalized = [
    ...new Set(keywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean)),
  ]
    .sort()
    .join("|")
    .slice(0, 480);
  return normalized ? `social-v5:${normalized}` : "";
}

const defaultDependencies: TrendBriefDependencies = {
  async readBrief(input) {
    const { data, error } = await (supabaseAdmin as any)
      .from("content_trend_briefs")
      .select("*")
      .eq("niche_key", input.nicheKey)
      .eq("language", input.language)
      .eq("region", input.region)
      .eq("brief_date", input.date)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (error) throw new Error("The niche brief could not be loaded.");
    if (!data) return null;
    return {
      id: data.id,
      nicheKey: data.niche_key,
      nicheKeywords: input.nicheKeywords,
      language: data.language,
      region: data.region,
      date: data.brief_date,
      items: data.items,
      warnings: data.warnings,
    };
  },
  async fetchSources(input) {
    const query = input.nicheKeywords.join(" ").slice(0, 300);
    return Promise.allSettled([
      fetchGdeltStories(query),
      fetchHackerNewsStories(query),
      fetchYouTubeStories(query),
      fetchRedditStories(query),
    ]);
  },
  async saveBrief(input) {
    const { data, error } = await (supabaseAdmin as any)
      .from("content_trend_briefs")
      .upsert(
        {
          niche_key: input.nicheKey,
          language: input.language,
          region: input.region,
          brief_date: input.date,
          items: input.items,
          warnings: input.warnings,
          fetched_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "niche_key,language,region,brief_date" },
      )
      .select("id")
      .single();
    if (error || !data) throw new Error("The niche brief could not be saved.");
    return { id: data.id, ...input };
  },
};

export async function getOrBuildTrendBrief(
  input: TrendBriefInput,
  dependencies: TrendBriefDependencies = defaultDependencies,
): Promise<TrendBrief> {
  const nicheKey = normalizeNicheKey(input.nicheKeywords);
  if (!nicheKey) throw new Error("Add at least one niche topic before researching trends.");
  const existing = await dependencies.readBrief({ ...input, nicheKey });
  if (existing) return existing;

  const results = await dependencies.fetchSources(input);
  const items = dedupeSourceItems(
    results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
  )
    .sort((left, right) => {
      const platformOrder = Number(Boolean(right.platform)) - Number(Boolean(left.platform));
      if (platformOrder) return platformOrder;
      const popularity = sourcePopularity(right) - sourcePopularity(left);
      return popularity || Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
    })
    .slice(0, 50);
  const failed = results.filter((result) => result.status === "rejected").length;
  const warnings = failed
    ? [`${failed === 1 ? "One source was" : `${failed} sources were`} unavailable.`]
    : [];
  return dependencies.saveBrief({ ...input, nicheKey, items, warnings });
}

function sourcePopularity(item: ContentSourceItem) {
  const stats = item.stats || {};
  return (
    (stats.views || 0) +
    (stats.likes || 0) * 4 +
    (stats.comments || 0) * 8 +
    (stats.shares || 0) * 12 +
    (stats.saves || 0) * 12
  );
}
