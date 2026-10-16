/* eslint-disable @typescript-eslint/no-explicit-any -- Shared brief table ships with its migration. */
import { createHash } from "node:crypto";
import { fetchSocialSearch, socialSearchPlatforms } from "./content-social-search.server";
import { enrichContentSources } from "./content-source-enrichment.server";
import { discoverTopicMatches } from "./content-discover-personalization";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { reserveBrightDataSeoRequest } from "./seo-bright-data.server";
import { sourceFreshnessTier, sourcePublicationTime } from "./content-source-recency";
import { evaluateDiscoverQuality } from "./content-discover-quality";

export const DISCOVER_BRIEF_VERSION = "social-v14";
import {
  dedupeSourceItems,
  fetchHackerNewsStories,
  fetchRedditStories,
  fetchYouTubeStories,
  type ContentSourceItem,
} from "./content-sources.server";

export type TrendBriefInput = {
  nicheKeywords: string[];
  creatorNames?: string[];
  language: string;
  region: string;
  date: string;
  forceRefresh?: boolean;
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
  enrichSources?(items: ContentSourceItem[]): Promise<ContentSourceItem[]>;
};

export function normalizeNicheKey(keywords: string[], creatorNames: string[] = []) {
  const normalized = [
    ...new Set(keywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean)),
  ]
    .sort()
    .join("|");
  const references = [
    ...new Set(creatorNames.map((name) => name.trim().toLowerCase()).filter(Boolean)),
  ]
    .sort()
    .join("|");
  if (!normalized) return "";
  const key = `${DISCOVER_BRIEF_VERSION}:${normalized}${references ? `:creators:${references}` : ""}`;
  const characters = Array.from(key);
  if (characters.length <= 500) return key;
  // Hash the complete direction before truncation, including the far end of creator lists.
  const digest = createHash("sha256").update(key).digest("hex");
  return `${characters.slice(0, 500 - digest.length - 1).join("")}:${digest}`;
}

const BROAD_TOPICS = new Set([
  "strategy",
  "hustle",
  "journey",
  "content",
  "growth",
  "tips",
  "style",
]);
function focusedTopics(keywords: string[]) {
  const focused = keywords.filter((topic) => !BROAD_TOPICS.has(topic.toLowerCase().trim()));
  return focused.length ? focused : keywords;
}

export function discoverSearchQuery(keywords: string[]) {
  const anchor = focusedTopics(keywords)[0]?.replace(/["()]/g, " ").trim();
  return keywords
    .slice(0, 8)
    .map((topic) =>
      BROAD_TOPICS.has(topic.toLowerCase().trim()) && topic !== anchor
        ? `("${anchor}" "${topic.replace(/["()]/g, " ").trim()}")`
        : topic.toLowerCase().trim() === "startup journey"
          ? '("startup journey" OR "founder story" OR "bootstrapped founder")'
          : `"${topic.replace(/["()]/g, " ").trim()}"`,
    )
    .join(" OR ");
}

export function sourceMatchesDiscoverNiche(source: ContentSourceItem, keywords: string[]) {
  const normalize = (value: string) =>
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\bstand[ -]+up\b/g, "standup");
  const text = normalize(`${source.title} ${source.summary}`);
  const words: string[] = text.match(/[\p{L}\p{N}]+/gu) || [];
  return focusedTopics(keywords).some((topic) => {
    const terms = (normalize(topic).match(/[\p{L}\p{N}]+/gu) || []).filter(
      (term) => term.length > 1 && !BROAD_TOPICS.has(term),
    );
    if (!terms.length) return true;
    if (terms.includes("startup")) {
      terms.push("founder", "entrepreneur", "bootstrapp");
      // A startup interest must refer to a business, not an engine or a computer.
      const business = [
        "founder",
        "entrepreneur",
        "business",
        "company",
        "companies",
        "customer",
        "revenue",
        "funding",
        "investor",
        "venture",
        "bootstrapp",
        "saas",
        "startups",
        "product",
      ];
      if (!words.some((word) => business.some((context) => word.startsWith(context)))) return false;
    }
    if (discoverTopicMatches(text, normalize(topic))) return true;
    if (terms.length > 1 && terms.join("").length >= 6 && words.includes(terms.join("")))
      return true;
    if (terms.some((term) => term.startsWith("writ")))
      return words.some((word) =>
        ["writ", "copywrit", "storytell", "newsletter"].some((term) => word.startsWith(term)),
      );
    if (topic.toLowerCase().includes("startup"))
      return words.some((word) => terms.some((term) => word.startsWith(term)));
    // A compound niche needs the full subject: reef restoration isn't car restoration.
    return terms.every((term) =>
      words.some((word) => (term.length <= 2 ? word === term : word.startsWith(term))),
    );
  });
}

export function discoverSourceWarnings(
  warnings: string[],
  items: Array<{ platform?: string | null }>,
) {
  const available = new Set(items.map((item) => item.platform));
  // Grouped searches are alternatives: a usable result satisfies that source query.
  return warnings.filter(
    (warning) =>
      !warning
        .split(":")[0]
        .split(" / ")
        .some((platform) => available.has(platform)),
  );
}

type TrendSourceDependencies = {
  search: typeof fetchSocialSearch;
  youtube: typeof fetchYouTubeStories;
  reddit: typeof fetchRedditStories;
  hackerNews: typeof fetchHackerNewsStories;
  reserveSearch: () => Promise<boolean>;
};

/** Free sources first; at most four paid searches/retries for a shared daily brief. */
export async function fetchTrendSources(
  input: TrendBriefInput,
  overrides: Partial<TrendSourceDependencies> = {},
): Promise<PromiseSettledResult<ContentSourceItem[]>[]> {
  const dependencies: TrendSourceDependencies = {
    search: fetchSocialSearch,
    youtube: fetchYouTubeStories,
    reddit: fetchRedditStories,
    hackerNews: fetchHackerNewsStories,
    reserveSearch: () =>
      reserveBrightDataSeoRequest(process.env, new Date().toISOString().slice(0, 7)),
    ...overrides,
  };
  const signal = AbortSignal.timeout(28_000);
  let reserved = 0;
  const reserve = async () => {
    // Reserve before awaiting the shared database counter to make concurrent requests safe.
    if (reserved >= 4 || signal.aborted) return false;
    reserved++;
    return dependencies.reserveSearch();
  };
  const references = (input.creatorNames || [])
    .slice(0, 3)
    .map((name) => `"${name.replace(/["()]/g, " ").trim()}"`)
    .filter((name) => name !== '""');
  const query = [discoverSearchQuery(input.nicheKeywords), ...references].join(" OR ");
  const primaryTopic =
    input.nicheKeywords[0]?.toLowerCase() === "startup journey"
      ? "startup founder"
      : input.nicheKeywords[0] || "";
  const named = async (name: string, fetchSource: () => Promise<ContentSourceItem[]>) => {
    try {
      return await fetchSource();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Request failed.";
      console.warn("Discover source failed", { source: name, reason });
      throw new Error(`${name}: ${reason}`);
    }
  };
  // Rotate two social sources across dates/niches instead of paying for eight on every refresh.
  const rotation =
    createHash("sha256").update(`${input.date}:${query}`).digest()[0] %
    socialSearchPlatforms.length;
  const selectedPlatforms = [rotation, (rotation + 1) % socialSearchPlatforms.length];
  const social = async () => {
    const search = (index: number, windowDays: 7 | 30) => {
      const { group, platform } = socialSearchPlatforms[index];
      return named(platform, () =>
        dependencies.search(
          {
            query,
            group,
            language: input.language,
            region: input.region,
            windowDays,
            limit: 20,
          },
          { reserve, signal },
        ),
      );
    };
    const results = await Promise.allSettled(selectedPlatforms.map((index) => search(index, 7)));
    // Never fall back to an all-time search. Sparse platforms widen only to the last month.
    const sparse = results
      .flatMap((result, index) =>
        result.status === "fulfilled" && result.value.length < 8 ? [index] : [],
      )
      .slice(0, Math.max(0, 4 - reserved));
    if (signal.aborted) return results;
    const wider = await Promise.allSettled(
      sparse.map((index) => search(selectedPlatforms[index], 30)),
    );
    wider.forEach((result, offset) => {
      const index = sparse[offset];
      const original = results[index];
      if (result.status === "fulfilled") {
        results[index] = {
          status: "fulfilled",
          value: dedupeSourceItems(
            [...(original.status === "fulfilled" ? original.value : []), ...result.value]
              .filter((item) => sourceFreshnessTier(item.publishedAt, Date.now()) > 0)
              .sort(
                (left, right) =>
                  sourceFreshnessTier(right.publishedAt, Date.now()) -
                    sourceFreshnessTier(left.publishedAt, Date.now()) ||
                  sourcePopularity(right, Date.now()) - sourcePopularity(left, Date.now()),
              ),
          ),
        };
      } else if (original.status === "fulfilled" && original.value.length === 0) {
        results[index] = result;
      }
    });
    return results;
  };
  const technicalNiche = input.nicheKeywords.some((topic) =>
    /\b(ai|artificial intelligence|tech|technology|software|programming|developer|startup|founder|science|engineering|cybersecurity|saas)\b/i.test(
      topic,
    ),
  );
  const officialResults = await Promise.allSettled([
    named("YouTube", () =>
      dependencies.youtube(primaryTopic, {
        limit: 50,
        windowDays: 30,
        signal,
        language: input.language,
        region: input.region,
      }),
    ),
    named("Reddit", () => dependencies.reddit(primaryTopic, { limit: 25, windowDays: 30, signal })),
    ...(technicalNiche
      ? [
          named("Hacker News", () =>
            dependencies.hackerNews(primaryTopic, { limit: 6, windowDays: 30, signal }),
          ),
        ]
      : []),
  ]);
  const freeItems = dedupeSourceItems(
    officialResults.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
  ).filter(
    (item) =>
      sourceMatchesDiscoverNiche(item, input.nicheKeywords) &&
      sourceFreshnessTier(item.publishedAt, Date.now()) > 0,
  );
  if (freeItems.length >= 12 || signal.aborted) return officialResults;
  const socialResults = await social();
  // Official APIs carry reliable dates/statistics, so prefer them over overlapping search snippets.
  return [...officialResults, ...socialResults];
}

const defaultDependencies: TrendBriefDependencies = {
  enrichSources: enrichContentSources,
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
  fetchSources: fetchTrendSources,
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
          expires_at: new Date(
            Date.now() +
              (input.warnings.length ||
              !input.items.some((item) => evaluateDiscoverQuality(item).eligible)
                ? 10 * 60_000
                : 6 * 60 * 60_000),
          ).toISOString(),
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
  const nicheKey = normalizeNicheKey(input.nicheKeywords, input.creatorNames);
  if (!nicheKey) throw new Error("Add at least one niche topic before researching trends.");
  const existing = await dependencies.readBrief({ ...input, nicheKey });
  if (existing && existing.items.length && !input.forceRefresh) return existing;

  const results = await dependencies.fetchSources(input);
  const now = Math.min(Date.now(), Date.parse(`${input.date}T23:59:59.999Z`) || Date.now());
  const ranked = dedupeSourceItems(
    results
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .filter((item) => sourceFreshnessTier(item.publishedAt, now) > 0)
      .sort(
        (left, right) =>
          Number(sourceMatchesDiscoverNiche(right, input.nicheKeywords)) -
            Number(sourceMatchesDiscoverNiche(left, input.nicheKeywords)) ||
          sourceFreshnessTier(right.publishedAt, now) -
            sourceFreshnessTier(left.publishedAt, now) ||
          sourcePopularity(right, now) - sourcePopularity(left, now),
      ),
  );
  const groups = new Map<string, ContentSourceItem[]>();
  for (const item of ranked) {
    const key = item.platform || item.kind;
    const group = groups.get(key) || [];
    // News is useful supporting context, not a substitute for creator posts.
    if (group.length < (key === "Hacker News" ? 4 : item.platform ? 20 : 8)) group.push(item);
    groups.set(key, group);
  }
  const items: ContentSourceItem[] = [];
  const queues = [...groups]
    .sort(([a], [b]) => Number(a === "Hacker News") - Number(b === "Hacker News"))
    .map(([, values]) => values);
  while (queues.some((queue) => queue.length) && items.length < 96) {
    for (const queue of queues) {
      const item = queue.shift();
      if (item && items.length < 96) items.push(item);
    }
  }
  const warnings = results.flatMap((result) =>
    result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason.message : "A source could not be reached."]
      : [],
  );
  const enriched = dependencies.enrichSources
    ? await dependencies.enrichSources(items).catch(() => items)
    : items;
  const relevant = dedupeSourceItems(
    enriched
      .filter(
        (item) =>
          sourceMatchesDiscoverNiche(item, input.nicheKeywords) &&
          sourceFreshnessTier(item.publishedAt, now) > 0,
      )
      .sort(
        (left, right) =>
          sourceFreshnessTier(right.publishedAt, now) -
            sourceFreshnessTier(left.publishedAt, now) ||
          sourcePopularity(right, now) - sourcePopularity(left, now),
      ),
  );
  return dependencies.saveBrief({
    ...input,
    nicheKey,
    items: relevant,
    // A failed adapter is recovered when another adapter supplies the same platform.
    warnings: discoverSourceWarnings(warnings, relevant),
  });
}

function sourcePopularity(item: ContentSourceItem, now: number) {
  const stats = item.stats || {};
  const engagement =
    (stats.views || 0) +
    (stats.likes || 0) * 4 +
    (stats.comments || 0) * 8 +
    (stats.shares || 0) * 12 +
    (stats.saves || 0) * 12;
  const published = sourcePublicationTime(item.publishedAt, now);
  const days = published === null ? 30 : Math.max(1, (now - published) / 86_400_000);
  // Within a freshness tier, prefer observed momentum over lifetime totals.
  return Math.log1p(engagement / days);
}
