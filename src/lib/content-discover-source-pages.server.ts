import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { discoverSearchQuery } from "./content-briefs.server";
import { discoverPostKey } from "./content-discover-identity";
import { sourceFreshnessTier } from "./content-source-recency";
import { ContentRetrievalError } from "./content-retrieval.server";
import {
  dedupeSourceItems,
  fetchHackerNewsStoryPage,
  fetchYouTubeStoryPage,
  type ContentSourceItem,
} from "./content-sources.server";
import { fetchSocialSearchPage, socialSearchPlatforms } from "./content-social-search.server";

export type DiscoverSourcePageInput = {
  nicheKeywords: string[];
  creatorNames?: string[];
  language: string;
  region: string;
  platform: string;
  cursor?: string | null;
  signal?: AbortSignal;
};

export type DiscoverSourcePage = {
  items: ContentSourceItem[];
  nextCursor: string | null;
  hasMore: boolean;
  warnings: string[];
};

type SourcePageDependencies = {
  youtube: typeof fetchYouTubeStoryPage;
  hackerNews: typeof fetchHackerNewsStoryPage;
  search: typeof fetchSocialSearchPage;
  now: () => Date;
  signal?: AbortSignal;
};

type BatchState = {
  continuation: string | number | null;
  exhausted: boolean;
  lastPage?: string;
};
type SourceCursor = {
  version: 1;
  direction: string;
  provider: "youtube" | "search" | "hackernews";
  anchor: string;
  nextBatch: number;
  batches: BatchState[];
};

const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalized = (values: string[], limit: number) =>
  [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))]
    .sort()
    .slice(0, limit);

function queryBatches(input: DiscoverSourcePageInput) {
  const topics = normalized(input.nicheKeywords, 20);
  const hackerNews = input.platform.toLowerCase() === "hacker news";
  const creators = hackerNews ? [] : normalized(input.creatorNames || [], 6);
  const width = hackerNews ? 1 : 3;
  const batches: Array<{ topics: string[]; creators: string[] }> = [];
  for (let index = 0; index < topics.length; index += width)
    batches.push({
      topics: topics.slice(index, index + width),
      creators: index === 0 ? creators.slice(0, 3) : [],
    });
  if (!batches.length)
    throw new ContentRetrievalError("Add a Discover interest before loading more posts.", false);
  if (creators.length > 3) batches.push({ topics: [], creators: creators.slice(3) });
  return batches;
}

function decodeCursor(
  value: string,
  direction: string,
  batchCount: number,
  now: number,
): SourceCursor {
  try {
    if (value.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const state = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as SourceCursor;
    if (
      state.version !== 1 ||
      state.direction !== direction ||
      !["youtube", "search", "hackernews"].includes(state.provider) ||
      typeof state.anchor !== "string" ||
      !Number.isFinite(Date.parse(state.anchor)) ||
      Date.parse(state.anchor) > now + 300_000 ||
      Date.parse(state.anchor) < now - 7 * 86_400_000 ||
      !Number.isInteger(state.nextBatch) ||
      state.nextBatch < 0 ||
      state.nextBatch >= batchCount ||
      !Array.isArray(state.batches) ||
      state.batches.length !== batchCount ||
      state.batches.some(
        (batch) =>
          !batch ||
          typeof batch.exhausted !== "boolean" ||
          (batch.lastPage !== undefined &&
            (typeof batch.lastPage !== "string" || !/^[a-f0-9]{64}$/.test(batch.lastPage))) ||
          (batch.continuation !== null &&
            (state.provider === "youtube"
              ? typeof batch.continuation !== "string" || batch.continuation.length > 1024
              : !Number.isSafeInteger(batch.continuation) || Number(batch.continuation) < 0)),
      )
    )
      throw new Error();
    return state;
  } catch {
    throw new ContentRetrievalError(
      "Discover continuation is invalid or expired. Refresh to continue.",
      false,
    );
  }
}

/** One real provider page; callers may follow nextCursor to fill a quality-filtered UI page. */
export async function fetchDiscoverSourcePage(
  input: DiscoverSourcePageInput,
  overrides: Partial<SourcePageDependencies> = {},
): Promise<DiscoverSourcePage> {
  const dependencies: SourcePageDependencies = {
    youtube: fetchYouTubeStoryPage,
    hackerNews: fetchHackerNewsStoryPage,
    search: fetchSocialSearchPage,
    now: () => new Date(),
    ...overrides,
  };
  const platform = [...socialSearchPlatforms, { platform: "Hacker News", group: "" }].find(
    (entry) => entry.platform.toLowerCase() === input.platform.toLowerCase(),
  );
  if (!platform)
    throw new ContentRetrievalError("This platform does not support Discover continuation.", false);
  const batches = queryBatches(input);
  const now = dependencies.now();
  const direction = fingerprint({
    platform: platform.platform,
    batches,
    language: input.language.toLowerCase(),
    region: input.region.toLowerCase(),
  });
  const state: SourceCursor = input.cursor
    ? decodeCursor(input.cursor, direction, batches.length, now.getTime())
    : {
        version: 1,
        direction,
        provider:
          platform.platform === "YouTube"
            ? "youtube"
            : platform.platform === "Hacker News"
              ? "hackernews"
              : "search",
        anchor: now.toISOString(),
        nextBatch: 0,
        batches: batches.map(() => ({ continuation: null, exhausted: false })),
      };
  if (state.provider === "youtube" && platform.platform !== "YouTube")
    throw new ContentRetrievalError("Invalid Discover provider continuation.", false);
  if ((state.provider === "hackernews") !== (platform.platform === "Hacker News"))
    throw new ContentRetrievalError("Invalid Discover provider continuation.", false);
  const batchIndex = Array.from(
    { length: batches.length },
    (_, index) => (state.nextBatch + index) % batches.length,
  ).find((index) => !state.batches[index].exhausted);
  if (batchIndex === undefined)
    return { items: [], nextCursor: null, hasMore: false, warnings: [] };
  const batch = batches[batchIndex];
  const progress = state.batches[batchIndex];
  const previousContinuation = progress.continuation;
  const signal = AbortSignal.any([
    AbortSignal.timeout(32_000),
    ...(input.signal ? [input.signal] : []),
    ...(dependencies.signal ? [dependencies.signal] : []),
  ]);
  signal.throwIfAborted();
  const publishedBefore = state.anchor;
  const publishedAfter = new Date(Date.parse(state.anchor) - 30 * 86_400_000).toISOString();
  const quotedCreators = batch.creators.map((name) => `"${name.replace(/["()|]/g, " ")}"`);
  let items: ContentSourceItem[];
  let continuation: string | number | null = null;
  if (state.provider === "youtube") {
    // YouTube's q supports | for alternatives. Every topic in this batch participates.
    const topics = batch.topics.flatMap((topic) =>
      topic === "startup journey" ? ["startup founder", "founder story"] : [topic],
    );
    const query = [
      ...topics.map((topic) => `"${topic.replace(/["()|]/g, " ")}"`),
      ...quotedCreators,
    ].join(" | ");
    const page = await dependencies.youtube(query, {
      limit: 50,
      windowDays: 30,
      now,
      language: input.language,
      region: input.region,
      publishedAfter,
      publishedBefore,
      pageToken: typeof progress.continuation === "string" ? progress.continuation : undefined,
      signal,
    });
    signal.throwIfAborted();
    items = page.items;
    continuation = page.nextPageToken;
    if (!page.configured) {
      // No official API key: use the same topic batches through real SERP pagination.
      state.provider = "search";
      state.batches = state.batches.map(() => ({ continuation: null, exhausted: false }));
    }
  } else items = [];
  if (state.provider === "hackernews") {
    const page = await dependencies.hackerNews(batch.topics[0] || "", {
      limit: 30,
      now,
      windowDays: 30,
      publishedAfter,
      publishedBefore,
      page: typeof progress.continuation === "number" ? progress.continuation : 0,
      signal,
    });
    signal.throwIfAborted();
    items = page.items;
    continuation = page.nextPage;
  }
  if (state.provider === "search") {
    const query = [discoverSearchQuery(batch.topics), ...quotedCreators]
      .filter(Boolean)
      .join(" OR ");
    const page = await dependencies.search(
      {
        query,
        group: platform.group,
        language: input.language,
        region: input.region,
        windowDays: 30,
        publishedAfter,
        publishedBefore,
        start: typeof progress.continuation === "number" ? progress.continuation : 0,
        limit: 40,
      },
      { signal },
    );
    signal.throwIfAborted();
    items = page.items;
    continuation = page.nextOffset;
  }
  const active = state.batches[batchIndex];
  const pageFingerprint = fingerprint(
    [...new Set(items.map((item) => discoverPostKey(item)))].sort(),
  );
  // Some providers ignore pagination. Do not advertise endless repeated pages.
  const repeated = Boolean(active.lastPage && active.lastPage === pageFingerprint);
  active.lastPage = pageFingerprint;
  active.continuation = continuation;
  active.exhausted = continuation === null || repeated || continuation === previousContinuation;
  state.nextBatch = (batchIndex + 1) % batches.length;
  const hasMore = state.batches.some((entry) => !entry.exhausted);
  const relevant = repeated
    ? []
    : dedupeSourceItems(
        items
          .filter(
            (item) =>
              item.platform === platform.platform &&
              sourceFreshnessTier(item.publishedAt, now.getTime()) > 0,
          )
          .sort(
            (left, right) =>
              sourceFreshnessTier(right.publishedAt, now.getTime()) -
              sourceFreshnessTier(left.publishedAt, now.getTime()),
          ),
      );
  return {
    items: relevant,
    nextCursor: hasMore ? Buffer.from(JSON.stringify(state)).toString("base64url") : null,
    hasMore,
    warnings: repeated
      ? ["This source repeated its previous page; continuing with other interests."]
      : [],
  };
}
