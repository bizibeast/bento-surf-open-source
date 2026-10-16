import { discoverPostKey } from "./content-discover-identity";
/* eslint-disable @typescript-eslint/no-explicit-any -- Public provider payloads are normalized at the boundary. */
import { readResponseText } from "./request-security.server";
import { parsePublicHttpUrl } from "./safe-url";
import {
  ContentRetrievalError,
  retryContentRequest,
  retryableContentStatus,
} from "./content-retrieval.server";
import { sourcePublishedWithin } from "./content-source-recency";
import {
  publicSourceUrl,
  sourcePresentation,
  type ContentSourcePresentation,
} from "./content-source-media";

export type ContentSourceKind =
  "rss" | "gdelt" | "hackernews" | "youtube" | "reddit" | "social_search";

export type ContentSourceStats = {
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  engagementRate?: number | null;
  followers?: number | null;
};

export type ContentSourceItem = ContentSourcePresentation & {
  canonicalUrl: string;
  title: string;
  summary: string;
  sourceName: string;
  publishedAt: string | null;
  retrievedAt: string;
  kind: ContentSourceKind;
  platform?: string;
  author?: string | null;
  thumbnailUrl?: string | null;
  stats?: ContentSourceStats;
};

const MAX_SOURCE_RESPONSE_BYTES = 2 * 1024 * 1024;
const TRACKING_PARAMETERS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid", "ref", "source"]);

export function canonicalizeContentSourceUrl(value: string) {
  const parsed = parsePublicHttpUrl(value, { requireHttps: true });
  if (!parsed) throw new Error("Content source must use a public HTTPS URL.");
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) {
      parsed.searchParams.delete(key);
    }
  }
  parsed.searchParams.sort();
  if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString();
}

function decodeXml(value: string) {
  return value
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagText(block: string, names: string[]) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
    if (match) return decodeXml(match[1]);
  }
  return "";
}

function entryLink(block: string) {
  const atom = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)?.[1];
  return atom || tagText(block, ["link"]);
}

function isoDate(value: unknown) {
  const timestamp = typeof value === "number" ? value : Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function numberOrNull(value: unknown) {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "string" && !value.trim())
  )
    return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function parseSyndicationFeed(xml: string, sourceUrl: string): ContentSourceItem[] {
  if (xml.length > MAX_SOURCE_RESPONSE_BYTES) throw new Error("Content feed is too large.");
  const source = canonicalizeContentSourceUrl(sourceUrl);
  const sourceName = tagText(xml.match(/<channel[\s\S]*?<item/i)?.[0] || xml, ["title"]);
  const blocks = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(
    (match) => match[2],
  );
  const retrievedAt = new Date().toISOString();
  return blocks.flatMap((block): ContentSourceItem[] => {
    const title = tagText(block, ["title"]).slice(0, 500);
    const publishedAt = isoDate(tagText(block, ["pubDate", "published", "updated"]));
    if (!title || !publishedAt) return [];
    let canonicalUrl: string;
    try {
      canonicalUrl = canonicalizeContentSourceUrl(new URL(entryLink(block), source).toString());
    } catch {
      return [];
    }
    const reddit = /^(www\.)?reddit\.com$/.test(new URL(source).hostname);
    const authorBlock = block.match(/<author\b[^>]*>([\s\S]*?)<\/author>/i)?.[1] || "";
    const thumbnail = block.match(/<media:thumbnail\b[^>]*\burl=["']([^"']+)["']/i)?.[1];
    return [
      {
        canonicalUrl,
        title,
        summary: tagText(block, ["description", "summary", "content"]).slice(0, 4_000),
        sourceName: reddit
          ? `r/${new URL(canonicalUrl).pathname.split("/")[2] || "reddit"}`
          : sourceName.slice(0, 160) || new URL(source).hostname,
        publishedAt,
        retrievedAt,
        kind: reddit ? "reddit" : "rss",
        ...(reddit
          ? {
              platform: "Reddit",
              author: tagText(authorBlock, ["name"]).replace(/^\/?u\//, "") || null,
              authorUrl: publicSourceUrl(tagText(authorBlock, ["uri"])),
              thumbnailUrl: publicSourceUrl(thumbnail?.replaceAll("&amp;", "&")),
              mediaType: thumbnail ? ("image" as const) : ("text" as const),
            }
          : {}),
      },
    ];
  });
}

function normalizedHeadline(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function dedupeSourceItems(items: ContentSourceItem[]) {
  const urls = new Set<string>();
  const titles = new Set<string>();
  return items.filter((item) => {
    let canonicalUrl: string;
    try {
      canonicalUrl = canonicalizeContentSourceUrl(item.canonicalUrl);
    } catch {
      return false;
    }
    const title = normalizedHeadline(item.title);
    const key = discoverPostKey({ canonicalUrl });
    const summary = normalizedHeadline(item.summary);
    const titleWords = title.split(" ").length;
    const article =
      !item.platform ||
      item.platform === "Hacker News" ||
      item.kind === "rss" ||
      item.kind === "gdelt";
    // Generic social captions ("Instagram photo", a creator's name, recurring hooks)
    // are not identities. Only substantial duplicated copy supports cross-URL dedupe.
    const copyKey =
      article && titleWords >= 4 && title.length >= 20
        ? title
        : titleWords >= 8 && title.length >= 50 && summary.length >= 80
          ? `${title}|${summary}`
          : null;
    if (!title || urls.has(key) || (copyKey && titles.has(copyKey))) return false;
    urls.add(key);
    if (copyKey) titles.add(copyKey);
    item.canonicalUrl = canonicalUrl;
    return true;
  });
}

async function jsonResponse(
  url: string,
  fetcher: typeof fetch,
  timeoutMs = 5_000,
  signal?: AbortSignal,
) {
  return retryContentRequest(
    async (attemptSignal) => {
      const response = await fetcher(url, {
        headers: { Accept: "application/json", "User-Agent": "bento.surf-content-research" },
        signal: attemptSignal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ContentRetrievalError(
          `Content source returned ${response.status}.`,
          retryableContentStatus(response.status),
        );
      }
      const text = await readResponseText(response, MAX_SOURCE_RESPONSE_BYTES);
      return text ? JSON.parse(text) : {};
    },
    { timeoutMs, signal },
  );
}

export async function fetchGdeltStories(
  query: string,
  options: { fetcher?: typeof fetch; now?: Date; limit?: number } = {},
): Promise<ContentSourceItem[]> {
  const fetcher = options.fetcher || fetch;
  const limit = Math.max(1, Math.min(25, options.limit || 10));
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", query.slice(0, 300));
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("maxrecords", String(limit));
  url.searchParams.set("format", "json");
  const payload = await jsonResponse(url.toString(), fetcher);
  const retrievedAt = (options.now || new Date()).toISOString();
  return (Array.isArray(payload.articles) ? payload.articles : []).flatMap(
    (article: Record<string, unknown>): ContentSourceItem[] => {
      // GDELT's seendate is a crawl timestamp, not the article's publication date.
      const publishedAt = isoDate(article.datePublished || article.published_at);
      const title = String(article.title || "")
        .trim()
        .slice(0, 500);
      if (!title) return [];
      try {
        return [
          {
            canonicalUrl: canonicalizeContentSourceUrl(String(article.url || "")),
            title,
            summary: "",
            sourceName: String(article.domain || new URL(String(article.url)).hostname).slice(
              0,
              160,
            ),
            publishedAt,
            retrievedAt,
            kind: "gdelt",
          },
        ];
      } catch {
        return [];
      }
    },
  );
}

export async function fetchHackerNewsStoryPage(
  query: string,
  options: {
    fetcher?: typeof fetch;
    limit?: number;
    now?: Date;
    windowDays?: number;
    signal?: AbortSignal;
    page?: number;
    publishedAfter?: string;
    publishedBefore?: string;
  } = {},
): Promise<{ items: ContentSourceItem[]; nextPage: number | null }> {
  const fetcher = options.fetcher || fetch;
  const now = options.now || new Date();
  const windowDays = Math.max(1, Math.min(30, options.windowDays || 30));
  const limit = Math.max(1, Math.min(50, options.limit || 30));
  const page = options.page || 0;
  if (!Number.isSafeInteger(page) || page < 0)
    throw new ContentRetrievalError("Invalid Hacker News continuation.", false);
  let nextPage: number | null = null;
  let items: Record<string, unknown>[];
  try {
    const search = new URL("https://hn.algolia.com/api/v1/search");
    search.searchParams.set("query", query.slice(0, 300));
    search.searchParams.set("tags", "story");
    search.searchParams.set("hitsPerPage", String(limit));
    search.searchParams.set("page", String(page));
    search.searchParams.set(
      "numericFilters",
      [
        `created_at_i>${options.publishedAfter ? Math.floor(Date.parse(options.publishedAfter) / 1000) : Math.floor(now.getTime() / 1000) - windowDays * 86400}`,
        ...(options.publishedBefore
          ? [`created_at_i<${Math.floor(Date.parse(options.publishedBefore) / 1000)}`]
          : []),
      ].join(","),
    );
    const payload = await jsonResponse(search.toString(), fetcher, 5_000, options.signal);
    if (!Array.isArray(payload.hits)) throw new Error("Hacker News search unavailable.");
    const totalPages = Number(payload.nbPages);
    nextPage =
      Number.isSafeInteger(totalPages) && totalPages >= 0
        ? page + 1 < totalPages
          ? page + 1
          : null
        : payload.hits.length >= limit
          ? page + 1
          : null;
    items = payload.hits.map((hit: any) => ({
      id: hit.objectID,
      title: hit.title,
      url: hit.url,
      time: hit.created_at_i,
      by: hit.author,
      score: hit.points,
      descendants: hit.num_comments,
    }));
  } catch (error) {
    // Continuations must not silently return the first top-stories page again.
    if (page > 0 || options.signal?.aborted) throw error;
    const ids = await jsonResponse(
      "https://hacker-news.firebaseio.com/v0/topstories.json",
      fetcher,
      3_000,
      options.signal,
    );
    const results = await Promise.allSettled(
      (Array.isArray(ids) ? ids.slice(0, Math.min(limit, 6)) : []).map((id) =>
        jsonResponse(
          `https://hacker-news.firebaseio.com/v0/item/${encodeURIComponent(String(id))}.json`,
          fetcher,
          3_000,
          options.signal,
        ),
      ),
    );
    items = results.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : [],
    );
    if (!items.length && results.some((result) => result.status === "rejected"))
      throw new Error("Hacker News could not be reached. Try refreshing.");
  }
  const terms = normalizedHeadline(query)
    .split(" ")
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
  const retrievedAt = new Date().toISOString();
  const sources = items.flatMap((item: Record<string, unknown>): ContentSourceItem[] => {
    const title = String(item.title || "").trim();
    const titleTerms = new Set(normalizedHeadline(title).split(" "));
    if (!title || (terms.length && !terms.some((term) => titleTerms.has(term)))) {
      return [];
    }
    const publishedAt = isoDate(Number(item.time) * 1_000);
    if (!publishedAt || !sourcePublishedWithin(publishedAt, now.getTime(), windowDays)) return [];
    try {
      return [
        {
          canonicalUrl: canonicalizeContentSourceUrl(
            String(item.url || `https://news.ycombinator.com/item?id=${item.id}`),
          ),
          title: title.slice(0, 500),
          summary: "",
          sourceName: "Hacker News",
          publishedAt,
          retrievedAt,
          kind: "hackernews",
          platform: "Hacker News",
          author: String(item.by || "").slice(0, 160) || null,
          stats: {
            likes: numberOrNull(item.score),
            comments: numberOrNull(item.descendants),
          },
        },
      ];
    } catch {
      return [];
    }
  });
  return { items: sources, nextPage };
}

export async function fetchHackerNewsStories(
  query: string,
  options: Parameters<typeof fetchHackerNewsStoryPage>[1] = {},
): Promise<ContentSourceItem[]> {
  return (await fetchHackerNewsStoryPage(query, { ...options, limit: options.limit || 6 })).items;
}

export async function fetchYouTubeStoryPage(
  query: string,
  options: {
    fetcher?: typeof fetch;
    apiKey?: string;
    limit?: number;
    now?: Date;
    windowDays?: number;
    signal?: AbortSignal;
    language?: string;
    region?: string;
    pageToken?: string;
    publishedAfter?: string;
    publishedBefore?: string;
  } = {},
): Promise<{ items: ContentSourceItem[]; nextPageToken: string | null; configured: boolean }> {
  const apiKey = options.apiKey?.trim() || process.env.YOUTUBE_API_KEY?.trim();
  if (!apiKey) return { items: [], nextPageToken: null, configured: false };
  const now = options.now || new Date();
  const windowDays = Math.max(1, Math.min(30, options.windowDays || 30));
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  // Candidate relevance comes first; observed statistics rank the recent matches later.
  url.searchParams.set("order", "relevance");
  if (/^[a-z]{2,3}$/i.test(options.language || ""))
    url.searchParams.set("relevanceLanguage", options.language!.toLowerCase());
  if (/^[a-z]{2}$/i.test(options.region || ""))
    url.searchParams.set("regionCode", options.region!.toUpperCase());
  url.searchParams.set(
    "publishedAfter",
    options.publishedAfter || new Date(now.getTime() - windowDays * 86_400_000).toISOString(),
  );
  if (options.publishedBefore) url.searchParams.set("publishedBefore", options.publishedBefore);
  if (options.pageToken) url.searchParams.set("pageToken", options.pageToken);
  url.searchParams.set("maxResults", String(Math.max(1, Math.min(50, options.limit || 50))));
  url.searchParams.set("q", query.slice(0, 300));
  url.searchParams.set("key", apiKey);
  const payload = await jsonResponse(
    url.toString(),
    options.fetcher || fetch,
    5_000,
    options.signal,
  );
  const retrievedAt = new Date().toISOString();
  if (!Array.isArray(payload.items))
    throw new ContentRetrievalError("YouTube search returned an unavailable result payload.", true);
  const items = payload.items;
  const videoIds = items.map((item: any) => String(item.id?.videoId || "")).filter(Boolean);
  const statisticsUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  statisticsUrl.searchParams.set("part", "statistics");
  statisticsUrl.searchParams.set("id", videoIds.join(","));
  statisticsUrl.searchParams.set("key", apiKey);
  const channelIds = [
    ...new Set(items.map((item: any) => String(item.snippet?.channelId || "")).filter(Boolean)),
  ];
  const channelsUrl = new URL("https://www.googleapis.com/youtube/v3/channels");
  channelsUrl.searchParams.set("part", "snippet,statistics");
  channelsUrl.searchParams.set("id", channelIds.join(","));
  channelsUrl.searchParams.set("key", apiKey);
  const [statisticsPayload, channelPayload] = await Promise.all([
    videoIds.length
      ? jsonResponse(
          statisticsUrl.toString(),
          options.fetcher || fetch,
          5_000,
          options.signal,
        ).catch(() => ({ items: [] }))
      : { items: [] },
    channelIds.length
      ? jsonResponse(channelsUrl.toString(), options.fetcher || fetch, 5_000, options.signal).catch(
          () => ({ items: [] }),
        )
      : { items: [] },
  ]);
  const channels = new Map<string, any>(
    (Array.isArray(channelPayload.items) ? channelPayload.items : []).map((channel: any) => [
      String(channel.id),
      channel,
    ]),
  );
  const statistics = new Map(
    (Array.isArray(statisticsPayload.items) ? statisticsPayload.items : []).map((item: any) => [
      String(item.id),
      item.statistics || {},
    ]),
  );
  const sources = items.flatMap(
    (item: {
      id?: { videoId?: unknown };
      snippet?: {
        title?: unknown;
        description?: unknown;
        channelTitle?: unknown;
        channelId?: unknown;
        publishedAt?: unknown;
      };
    }): ContentSourceItem[] => {
      const videoId = String(item.id?.videoId || "");
      const title = String(item.snippet?.title || "").trim();
      const publishedAt = isoDate(item.snippet?.publishedAt);
      if (
        !videoId ||
        !title ||
        !publishedAt ||
        !sourcePublishedWithin(publishedAt, now.getTime(), windowDays)
      )
        return [];
      const stats = statistics.get(videoId) as Record<string, unknown> | undefined;
      return [
        {
          canonicalUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
          title: decodeXml(title).slice(0, 500),
          summary: decodeXml(String(item.snippet?.description || "")).slice(0, 4_000),
          sourceName: String(item.snippet?.channelTitle || "YouTube").slice(0, 160),
          publishedAt,
          retrievedAt,
          kind: "youtube",
          platform: "YouTube",
          author: String(item.snippet?.channelTitle || "").slice(0, 160) || null,
          authorUrl: item.snippet?.channelId
            ? `https://www.youtube.com/channel/${encodeURIComponent(String(item.snippet.channelId))}`
            : null,
          authorAvatarUrl: publicSourceUrl(
            channels.get(String(item.snippet?.channelId))?.snippet?.thumbnails?.default?.url,
          ),
          mediaType: "video",
          thumbnailUrl:
            String(
              (item.snippet as any)?.thumbnails?.high?.url ||
                (item.snippet as any)?.thumbnails?.medium?.url ||
                "",
            ) || null,
          stats: {
            views: numberOrNull(stats?.viewCount),
            likes: numberOrNull(stats?.likeCount),
            comments: numberOrNull(stats?.commentCount),
            followers:
              channels.get(String(item.snippet?.channelId))?.statistics?.hiddenSubscriberCount ===
              true
                ? null
                : numberOrNull(
                    channels.get(String(item.snippet?.channelId))?.statistics?.subscriberCount,
                  ),
          },
        },
      ];
    },
  );
  return {
    items: sources,
    nextPageToken:
      typeof payload.nextPageToken === "string" &&
      payload.nextPageToken &&
      payload.nextPageToken.length <= 1024
        ? payload.nextPageToken
        : null,
    configured: true,
  };
}

export async function fetchYouTubeStories(
  query: string,
  options: Parameters<typeof fetchYouTubeStoryPage>[1] = {},
): Promise<ContentSourceItem[]> {
  return (await fetchYouTubeStoryPage(query, options)).items;
}

export async function fetchRedditStories(
  query: string,
  options: {
    fetcher?: typeof fetch;
    limit?: number;
    profileUrl?: string;
    now?: Date;
    windowDays?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ContentSourceItem[]> {
  const limit = Math.max(1, Math.min(50, options.limit || 25));
  const now = options.now || new Date();
  const windowDays = Math.max(1, Math.min(30, options.windowDays || 30));
  const profile = options.profileUrl ? new URL(options.profileUrl) : null;
  if (
    profile &&
    (!/^(www\.)?reddit\.com$/.test(profile.hostname) ||
      !/^\/(r|user)\/[\w-]+\/?$/.test(profile.pathname))
  )
    throw new Error("Invalid Reddit creator URL.");
  const url = new URL(
    profile
      ? `https://www.reddit.com${profile.pathname.replace(/\/$/, "")}/${profile.pathname.startsWith("/r/") ? "new" : "submitted"}.json`
      : "https://www.reddit.com/search.json",
  );
  url.searchParams.set("q", query.slice(0, 300));
  url.searchParams.set("sort", "top");
  url.searchParams.set("t", windowDays <= 7 ? "week" : "month");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("type", "link");
  let payload;
  try {
    payload = await jsonResponse(url.toString(), options.fetcher || fetch, 5_000, options.signal);
  } catch {
    const rssUrl = new URL(url);
    rssUrl.pathname = rssUrl.pathname
      .replace(/\.json$/, "/.rss")
      .replace("/search/.rss", "/search.rss");
    return (
      await fetchSyndicationFeed(rssUrl.toString(), options.fetcher || fetch, 5_000, options.signal)
    )
      .filter((item) => sourcePublishedWithin(item.publishedAt, now.getTime(), windowDays))
      .slice(0, limit);
  }
  const retrievedAt = new Date().toISOString();
  const children = Array.isArray(payload?.data?.children) ? payload.data.children : [];
  return children.flatMap((child: any): ContentSourceItem[] => {
    const item = child?.data || {};
    const title = String(item.title || "").trim();
    const publishedAt = isoDate(Number(item.created_utc) * 1_000);
    if (
      !title ||
      !publishedAt ||
      !item.permalink ||
      !sourcePublishedWithin(publishedAt, now.getTime(), windowDays)
    )
      return [];
    try {
      return [
        {
          canonicalUrl: canonicalizeContentSourceUrl(
            new URL(String(item.permalink), "https://www.reddit.com").toString(),
          ),
          title: title.slice(0, 500),
          summary: String(item.selftext || "")
            .trim()
            .slice(0, 4_000),
          sourceName: `r/${String(item.subreddit || "reddit")}`.slice(0, 160),
          publishedAt,
          retrievedAt,
          kind: "reddit",
          platform: "Reddit",
          author: String(item.author || "").slice(0, 160) || null,
          ...sourcePresentation({
            authorUrl:
              item.author && item.author !== "[deleted]"
                ? `https://www.reddit.com/user/${encodeURIComponent(item.author)}/`
                : null,
            mediaType: item.is_video
              ? "video"
              : item.is_gallery
                ? "carousel"
                : item.post_hint === "image"
                  ? "image"
                  : "text",
            media: [
              ...(item.secure_media?.reddit_video?.fallback_url
                ? [{ type: "video" as const, url: item.secure_media.reddit_video.fallback_url }]
                : []),
              ...Object.values(item.media_metadata || {}).flatMap((asset: any) =>
                asset?.s?.u
                  ? [{ type: "image" as const, url: String(asset.s.u).replaceAll("&amp;", "&") }]
                  : [],
              ),
              ...(item.post_hint === "image" && item.url
                ? [{ type: "image" as const, url: item.url }]
                : []),
            ],
          }),
          thumbnailUrl: /^https:\/\//.test(String(item.thumbnail || ""))
            ? String(item.thumbnail)
            : null,
          stats: {
            likes: numberOrNull(item.score),
            comments: numberOrNull(item.num_comments),
            engagementRate: numberOrNull(item.upvote_ratio),
          },
        },
      ];
    } catch {
      return [];
    }
  });
}

export async function fetchSyndicationFeed(
  sourceUrl: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 5_000,
  signal?: AbortSignal,
) {
  const safeUrl = canonicalizeContentSourceUrl(sourceUrl);
  return retryContentRequest(
    async (attemptSignal) => {
      let url = safeUrl;
      for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await fetcher(url, {
          headers: {
            Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
            "User-Agent": "bento.surf-content-research",
          },
          // Workers supports follow/manual; validate each redirect instead of using error.
          redirect: "manual",
          signal: attemptSignal,
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location || redirects === 3)
            throw new ContentRetrievalError("Content feed redirect unavailable.", false);
          try {
            url = canonicalizeContentSourceUrl(new URL(location, url).toString());
          } catch {
            throw new ContentRetrievalError(
              "Content feed redirect must use a public HTTPS URL.",
              false,
            );
          }
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new ContentRetrievalError(
            `Content feed returned ${response.status}.`,
            retryableContentStatus(response.status),
          );
        }
        return parseSyndicationFeed(
          await readResponseText(response, MAX_SOURCE_RESPONSE_BYTES),
          url,
        );
      }
      throw new ContentRetrievalError("Content feed redirect unavailable.", false);
    },
    { timeoutMs, signal },
  );
}
