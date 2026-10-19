import { serverSha256 } from "./server-sha256.server";
import { fetchDiscoverSourcePage } from "./content-discover-source-pages.server";
import {
  readDiscoverPage,
  readDiscoverPageCursor,
  saveDiscoverPage,
  type DiscoverPageSourceState,
} from "./content-discover-page-cache.server";
import { enrichContentSources } from "./content-source-enrichment.server";
import { dedupeSourceItems, type ContentSourceItem } from "./content-sources.server";
import { evaluateDiscoverQuality } from "./content-discover-quality";

export const DISCOVER_PAGE_PLATFORMS = [
  "YouTube",
  "Instagram",
  "TikTok",
  "LinkedIn",
  "X",
  "Threads",
  "Facebook",
  "Reddit",
  "Hacker News",
] as const;

export function initialDiscoverPagination(enabled = true) {
  return Object.fromEntries(
    ["all", ...DISCOVER_PAGE_PLATFORMS].map((platform) => [
      platform,
      {
        cursor: null as string | null,
        hasMore: enabled,
      },
    ]),
  );
}

type PageInput = {
  userId: string;
  directionKey: string;
  platform: string;
  cursor?: string;
  nicheKeywords: string[];
  creatorNames: string[];
  language: string;
  region: string;
  preferredPlatforms?: string[];
};
export type DiscoverPageDependencies = {
  read: typeof readDiscoverPage;
  readCursor: typeof readDiscoverPageCursor;
  save: typeof saveDiscoverPage;
  fetch: typeof fetchDiscoverSourcePage;
  enrich: typeof enrichContentSources;
  assertCurrent: () => Promise<void>;
  now: () => Date;
};

/** Owner-bound, immutable page results make a retried request free of provider duplication. */
export async function loadDiscoverSourcePage(
  input: PageInput,
  overrides: Partial<DiscoverPageDependencies> = {},
) {
  const deps: DiscoverPageDependencies = {
    read: readDiscoverPage,
    readCursor: readDiscoverPageCursor,
    save: saveDiscoverPage,
    fetch: fetchDiscoverSourcePage,
    enrich: enrichContentSources,
    assertCurrent: async () => {},
    now: () => new Date(),
    ...overrides,
  };
  if (input.platform !== "all" && !DISCOVER_PAGE_PLATFORMS.some((p) => p === input.platform))
    throw new Error("Choose a supported Discover platform.");
  const now = deps.now();
  const scope = {
    userId: input.userId,
    directionKey: input.directionKey,
    platform: input.platform,
  };
  const requestKey = serverSha256(
    input.cursor || `first:${now.toISOString().slice(0, 10)}`,
  ).toString("hex");
  const cached = await deps.read({ ...scope, requestKey });
  if (cached) {
    // Cache provider results and continuations immutably, but do not freeze a
    // temporary metadata failure for the entire six-hour page lifetime.
    const unknown = cached.items.filter((item) =>
      ["publication_unknown", "followers_unknown", "traction_unknown"].includes(
        evaluateDiscoverQuality(item, now.getTime()).reason,
      ),
    );
    if (!unknown.length) return cached;
    try {
      const enriched = await deps.enrich(unknown, { timeoutMs: 8_000 });
      const refreshed = new Map(enriched.map((item) => [item.canonicalUrl, item]));
      const retryUrls = new Set(unknown.map((item) => item.canonicalUrl));
      return {
        ...cached,
        items: cached.items.map((item) =>
          retryUrls.has(item.canonicalUrl) ? refreshed.get(item.canonicalUrl) || item : item,
        ),
      };
    } catch {
      return cached;
    }
  }
  const prior = input.cursor ? await deps.readCursor({ ...scope, cursor: input.cursor }) : null;
  if (input.cursor && !prior)
    throw new Error("Discover continuation expired. Refresh to continue.");
  if (prior && !prior.hasMore) return prior;
  const preferred = (input.preferredPlatforms || []).filter((platform) =>
    DISCOVER_PAGE_PLATFORMS.some((supported) => supported === platform),
  );
  const platforms =
    input.platform === "all"
      ? [...new Set([...preferred, ...DISCOVER_PAGE_PLATFORMS])]
      : [input.platform];
  const state: DiscoverPageSourceState = prior
    ? { platforms: { ...prior.state.platforms }, offset: prior.state.offset }
    : { platforms: Object.fromEntries(platforms.map((platform) => [platform, null])), offset: 0 };
  const signal = AbortSignal.timeout(42_000);
  const items: ContentSourceItem[] = [];
  const warnings: string[] = [];
  const failed = new Set<string>();
  let advanced = 0;
  // At most three real pages per request, followed by one bounded enrichment batch.
  // Empty qualifying pages still advance; neither old posts nor duplicates fill the gap.
  for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
    let selected: string | undefined;
    for (let scan = 0; scan < platforms.length; scan++) {
      const candidate = platforms[state.offset++ % platforms.length];
      if (state.platforms[candidate] !== false && !failed.has(candidate)) {
        selected = candidate;
        break;
      }
    }
    if (!selected) break;
    try {
      const page = await deps.fetch({
        nicheKeywords: input.nicheKeywords,
        creatorNames: input.creatorNames,
        language: input.language,
        region: input.region,
        platform: selected,
        cursor: state.platforms[selected] || null,
        signal,
      });
      // A malformed response must not reset a previously valid provider token.
      // Other platforms can still make progress and cache their successful pages.
      if (page.hasMore && !page.nextCursor) throw new Error("Source continuation was interrupted.");
      items.push(...page.items);
      warnings.push(...page.warnings);
      state.platforms[selected] = page.hasMore ? page.nextCursor : false;
      advanced++;
      // One full page usually suffices; sparse/empty pages continue within this budget.
      if (
        dedupeSourceItems(items).filter(
          (item) => evaluateDiscoverQuality(item, now.getTime()).eligible,
        ).length >= 18
      )
        break;
    } catch (error) {
      failed.add(selected);
      warnings.push(`${selected}: ${error instanceof Error ? error.message : "Source timed out."}`);
    }
  }
  if (!advanced && failed.size)
    throw new Error(
      `More posts are temporarily unavailable. ${warnings.join(" ")} Please try again.`,
    );
  const enriched = await deps.enrich(dedupeSourceItems(items).slice(0, 150));
  await deps.assertCurrent();
  return deps.save({
    ...scope,
    requestKey,
    items: enriched,
    state,
    hasMore: Object.values(state.platforms).some((cursor) => cursor !== false),
    warnings: [...new Set(warnings)].slice(0, 32).map((warning) => warning.slice(0, 2000)),
  });
}
