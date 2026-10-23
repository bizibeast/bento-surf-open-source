/* eslint-disable @typescript-eslint/no-explicit-any -- Shared brief table ships with its migration. */
import { serverSha256 } from "./server-sha256.server";
import { fetchSocialSearch, socialSearchPlatforms } from "./content-social-search.server";
import { enrichContentSources } from "./content-source-enrichment.server";
import { discoverTopicMatches, isDiscoverSubjectTopic } from "./content-discover-personalization";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { reserveBrightDataSeoRequest } from "./seo-bright-data.server";
import { sourceFreshnessTier, sourcePublicationTime } from "./content-source-recency";
import { evaluateDiscoverQuality } from "./content-discover-quality";

export const DISCOVER_BRIEF_VERSION = "social-v16";
export const DISCOVER_PROGRESS_WARNING =
  "Checking remaining sources. New posts appear as they are verified.";
import {
  dedupeSourceItems,
  fetchHackerNewsStories,
  fetchNewsStories,
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
  fetchSources(
    input: TrendBriefInput,
    onBatch?: (items: ContentSourceItem[]) => void,
  ): Promise<PromiseSettledResult<ContentSourceItem[]>[]>;
  saveBrief(
    input: Omit<TrendBrief, "id">,
    options?: { onlyIfMissing?: boolean },
  ): Promise<TrendBrief>;
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
  const digest = serverSha256(key).toString("hex");
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
const DOCUMENT_METADATA_TOPIC =
  /^(?:factual[- ]correction|correction|ownership|profile|instruction|writing[- ]voice|brand[- ]voice)$/i;
function focusedTopics(keywords: string[]) {
  const focused = keywords.filter(
    (topic) =>
      !BROAD_TOPICS.has(topic.toLowerCase().trim()) &&
      isDiscoverSubjectTopic(topic) &&
      !DOCUMENT_METADATA_TOPIC.test(topic.trim()),
  );
  return focused;
}

export function discoverSearchQuery(keywords: string[]) {
  const anchor = focusedTopics(keywords)[0]?.replace(/["()]/g, " ").trim();
  return keywords
    .filter((topic) => !DOCUMENT_METADATA_TOPIC.test(topic.trim()))
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

export function sourceMatchesDiscoverNiche(
  source: Pick<ContentSourceItem, "title" | "summary">,
  keywords: string[],
) {
  const normalize = (value: string) =>
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\bstand[ -]+up\b/g, "standup");
  const text = normalize(`${source.title} ${source.summary}`);
  const prose = text.replace(/(?:^|\s)#[\p{L}\p{N}_]+/gu, " ");
  // Role labels in fictional twist stories are not evidence of a business topic.
  // Keep fiction/storytelling niches available; this guard targets business feeds.
  const fictionNiche = keywords.some((topic) =>
    /\b(fiction|drama|storytelling|creative writing|short stories|moral stories)\b/i.test(topic),
  );
  const explicitFiction =
    /\b(fiction(?:al)? (?:story|tale|drama)|moral story|inspirational story|short drama)\b/i.test(
      prose,
    );
  const genericRichRole =
    /\b(?:rich|wealthy|billionaire|millionaire|ruthless|arrogant)(?:\s+(?:rich|wealthy|billionaire|millionaire|ruthless|arrogant))?\s+(?:ceo|boss|founder|businessman|businesswoman)\b/i.test(
      source.title,
    );
  const humiliation = /\b(?:humiliat\w*|mock\w*|insult\w*|belittl\w*)\b/i.test(source.title);
  const dramaticReveal =
    /\b(?:then|until|secret|secretly|really owned|real owner|turns? out)\b/i.test(source.title);
  const educationalTool =
    /\b(?:how to|tutorial|guide|demo|build|building|code|prompt)\b/i.test(prose) &&
    /\b(?:ai|app|tool|code|prompt|model|software)\b/i.test(source.title);
  if (
    !fictionNiche &&
    ((explicitFiction && !educationalTool) || (genericRichRole && humiliation && dramaticReveal))
  )
    return false;
  const proseWords = prose.match(/[\p{L}\p{N}]+/gu) || [];
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
      if (!proseWords.some((word) => business.some((context) => word.startsWith(context))))
        return false;
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
    return terms.every((term) => {
      // Match an ordinary plural topic to its exact singular noun, without
      // turning "tools" into a loose prefix that also accepts "toolbox".
      const singular =
        term.length > 4 && term.endsWith("s") && !/(?:ss|us|is)$/.test(term)
          ? term.slice(0, -1)
          : null;
      return words.some(
        (word) => (term.length <= 2 ? word === term : word.startsWith(term)) || word === singular,
      );
    });
  });
}

export function discoverSourceWarnings(
  warnings: string[],
  items: Array<{ platform?: string | null }>,
) {
  const available = new Set(items.map((item) => item.platform));
  // A result from one platform never hides another platform's failed request.
  return warnings.flatMap((warning) => {
    const separator = warning.indexOf(":");
    if (separator < 0) return [warning];
    const platforms = warning.slice(0, separator).split(" / ");
    return platforms
      .filter((platform) => !available.has(platform))
      .map((platform) => `${platform}${warning.slice(separator)}`);
  });
}

type TrendSourceDependencies = {
  search: typeof fetchSocialSearch;
  news: typeof fetchNewsStories;
  youtube: typeof fetchYouTubeStories;
  reddit: typeof fetchRedditStories;
  hackerNews: typeof fetchHackerNewsStories;
  reserveSearch: () => Promise<boolean>;
};

/** One bounded batch across all platforms; at most four paid attempts, including retries. */
export async function fetchTrendSources(
  input: TrendBriefInput,
  overrides: Partial<TrendSourceDependencies> = {},
  onBatch?: (items: ContentSourceItem[]) => void,
): Promise<PromiseSettledResult<ContentSourceItem[]>[]> {
  const dependencies: TrendSourceDependencies = {
    search: fetchSocialSearch,
    news: fetchNewsStories,
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
      const items = await fetchSource();
      onBatch?.(items);
      return items;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Request failed.";
      console.warn("Discover source failed", { source: name, reason });
      throw new Error(`${name}: ${reason}`);
    }
  };
  // Every supported social platform is queried on every refresh. Pairing domains
  // retains the existing four-request ceiling; no single free platform cancels
  // the rest. A per-platform continuation can search deeper when requested.
  const platformGroups = [
    [0, 5],
    [3, 4],
    [2, 6],
    [1, 7],
  ];
  const socialRequests = platformGroups.map((indices) => {
    const sources = indices.map((index) => socialSearchPlatforms[index]);
    return named(sources.map((source) => source.platform).join(" / "), () =>
      dependencies.search(
        {
          query,
          group: sources.map((source) => source.group).join(" OR "),
          language: input.language,
          region: input.region,
          windowDays: 30,
          limit: 40,
        },
        { reserve, signal },
      ),
    );
  });
  const technicalNiche = input.nicheKeywords.some((topic) =>
    /\b(ai|artificial intelligence|tech|technology|software|programming|developer|startup|founder|science|engineering|cybersecurity|saas)\b/i.test(
      topic,
    ),
  );
  const results = await Promise.allSettled([
    ...socialRequests,
    named("News", () =>
      dependencies.news(primaryTopic, {
        limit: 25,
        signal,
        language: input.language,
        region: input.region,
      }),
    ),
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
  // Prefer official APIs for dates and statistics when both find the same post.
  return [...results.slice(socialRequests.length), ...results.slice(0, socialRequests.length)];
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
  fetchSources: (input, onBatch) => fetchTrendSources(input, {}, onBatch),
  async saveBrief(input, options) {
    const db = supabaseAdmin as any;
    let { data, error } = await db
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
        {
          onConflict: "niche_key,language,region,brief_date",
          ignoreDuplicates: options?.onlyIfMissing === true,
        },
      )
      .select("id")
      .maybeSingle();
    if (!error && !data && options?.onlyIfMissing) {
      ({ data, error } = await db
        .from("content_trend_briefs")
        .select("id")
        .eq("niche_key", input.nicheKey)
        .eq("language", input.language)
        .eq("region", input.region)
        .eq("brief_date", input.date)
        .maybeSingle());
    }
    if (error || !data) throw new Error("The niche brief could not be saved.");
    return { id: data.id, ...input };
  },
};

export async function getOrBuildTrendBrief(
  input: TrendBriefInput,
  dependencies: TrendBriefDependencies = defaultDependencies,
  onProgress?: (brief: TrendBrief) => Promise<void>,
): Promise<TrendBrief> {
  const nicheKey = normalizeNicheKey(input.nicheKeywords, input.creatorNames);
  if (!nicheKey) throw new Error("Add at least one niche topic before researching trends.");
  const existing = await dependencies.readBrief({ ...input, nicheKey });
  if (
    existing &&
    existing.items.length &&
    !existing.warnings.includes(DISCOVER_PROGRESS_WARNING) &&
    !input.forceRefresh
  )
    return {
      ...existing,
      items: existing.items.filter((item) => sourceMatchesDiscoverNiche(item, input.nicheKeywords)),
    };

  const now = Math.min(Date.now(), Date.parse(`${input.date}T23:59:59.999Z`) || Date.now());
  let partialItems: ContentSourceItem[] = [];
  let previewBriefId = existing?.id;
  let progress = Promise.resolve();
  const results = await dependencies.fetchSources(
    input,
    onProgress
      ? (batch) => {
          const eligible = batch.filter(
            (item) =>
              sourceMatchesDiscoverNiche(item, input.nicheKeywords) &&
              evaluateDiscoverQuality(item, now).eligible,
          );
          if (!eligible.length) return;
          partialItems = dedupeSourceItems([...partialItems, ...eligible]).slice(0, 96);
          const snapshot = partialItems;
          // Serialize writes so an earlier, smaller batch cannot overwrite a later one.
          // A failed preview must not retry paid providers or hide the final result.
          progress = progress
            .then(async () => {
              const partial = {
                ...input,
                nicheKey,
                items: snapshot,
                warnings: [DISCOVER_PROGRESS_WARNING],
              };
              // A late partial refresh must never replace a complete shared brief
              // produced by another workspace. Reserve its identity only once.
              if (!previewBriefId)
                previewBriefId = (await dependencies.saveBrief(partial, { onlyIfMissing: true }))
                  .id;
              await onProgress({ ...partial, id: previewBriefId });
            })
            .catch((error) => {
              console.warn("Discover preview could not be saved", error);
            });
        }
      : undefined,
  );
  await progress;
  const ranked = dedupeSourceItems(
    results
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .filter(
        (item) =>
          sourceFreshnessTier(item.publishedAt, now) > 0 &&
          sourceMatchesDiscoverNiche(item, input.nicheKeywords),
      )
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
  const final = await dependencies.saveBrief({
    ...input,
    nicheKey,
    items: relevant,
    // A failed adapter is recovered only when its own platform has usable evidence.
    warnings: discoverSourceWarnings(warnings, relevant),
  });
  // Let the UI show enriched posts before optional AI inspiration finishes.
  if (onProgress) await onProgress(final);
  return final;
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
