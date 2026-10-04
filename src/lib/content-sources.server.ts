/* eslint-disable @typescript-eslint/no-explicit-any -- Public provider payloads are normalized at the boundary. */
import { readResponseText } from "./request-security.server";
import { parsePublicHttpUrl } from "./safe-url";

export type ContentSourceKind = "rss" | "gdelt" | "hackernews" | "youtube" | "reddit";

export type ContentSourceStats = {
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  engagementRate?: number | null;
};

export type ContentSourceItem = {
  canonicalUrl: string;
  title: string;
  summary: string;
  sourceName: string;
  publishedAt: string;
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
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
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
  if (value === null || value === undefined || value === "") return null;
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
    return [
      {
        canonicalUrl,
        title,
        summary: tagText(block, ["description", "summary", "content"]).slice(0, 4_000),
        sourceName: sourceName.slice(0, 160) || new URL(source).hostname,
        publishedAt,
        retrievedAt,
        kind: "rss",
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
    if (!title || urls.has(canonicalUrl) || titles.has(title)) return false;
    urls.add(canonicalUrl);
    titles.add(title);
    item.canonicalUrl = canonicalUrl;
    return true;
  });
}

async function jsonResponse(url: string, fetcher: typeof fetch) {
  const response = await fetcher(url, {
    headers: { Accept: "application/json", "User-Agent": "bento.surf-content-research" },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await readResponseText(response, MAX_SOURCE_RESPONSE_BYTES);
  if (!response.ok) throw new Error(`Content source returned ${response.status}.`);
  return text ? JSON.parse(text) : {};
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
      const seen = String(article.seendate || "").replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
        "$1-$2-$3T$4:$5:$6Z",
      );
      const publishedAt = isoDate(seen);
      const title = String(article.title || "")
        .trim()
        .slice(0, 500);
      if (!publishedAt || !title) return [];
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

export async function fetchHackerNewsStories(
  query: string,
  options: { fetcher?: typeof fetch; limit?: number } = {},
): Promise<ContentSourceItem[]> {
  const fetcher = options.fetcher || fetch;
  const ids = await jsonResponse("https://hacker-news.firebaseio.com/v0/topstories.json", fetcher);
  const limit = Math.max(1, Math.min(50, options.limit || 30));
  const items = await Promise.all(
    (Array.isArray(ids) ? ids.slice(0, limit) : []).map((id) =>
      jsonResponse(
        `https://hacker-news.firebaseio.com/v0/item/${encodeURIComponent(String(id))}.json`,
        fetcher,
      ),
    ),
  );
  const terms = normalizedHeadline(query)
    .split(" ")
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
  const retrievedAt = new Date().toISOString();
  return items.flatMap((item: Record<string, unknown>): ContentSourceItem[] => {
    const title = String(item.title || "").trim();
    const titleTerms = new Set(normalizedHeadline(title).split(" "));
    if (!title || (terms.length && !terms.some((term) => titleTerms.has(term)))) {
      return [];
    }
    const publishedAt = isoDate(Number(item.time) * 1_000);
    if (!publishedAt) return [];
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
}

export async function fetchYouTubeStories(
  query: string,
  options: { fetcher?: typeof fetch; apiKey?: string; limit?: number } = {},
): Promise<ContentSourceItem[]> {
  const apiKey = options.apiKey?.trim() || process.env.YOUTUBE_API_KEY?.trim();
  if (!apiKey) return [];
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("order", "viewCount");
  url.searchParams.set("maxResults", String(Math.max(1, Math.min(10, options.limit || 5))));
  url.searchParams.set("q", query.slice(0, 300));
  url.searchParams.set("key", apiKey);
  const payload = await jsonResponse(url.toString(), options.fetcher || fetch);
  const retrievedAt = new Date().toISOString();
  const items = Array.isArray(payload.items) ? payload.items : [];
  const videoIds = items.map((item: any) => String(item.id?.videoId || "")).filter(Boolean);
  const statisticsUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  statisticsUrl.searchParams.set("part", "statistics");
  statisticsUrl.searchParams.set("id", videoIds.join(","));
  statisticsUrl.searchParams.set("key", apiKey);
  const statisticsPayload = videoIds.length
    ? await jsonResponse(statisticsUrl.toString(), options.fetcher || fetch)
    : { items: [] };
  const statistics = new Map(
    (Array.isArray(statisticsPayload.items) ? statisticsPayload.items : []).map((item: any) => [
      String(item.id),
      item.statistics || {},
    ]),
  );
  return items.flatMap(
    (item: {
      id?: { videoId?: unknown };
      snippet?: {
        title?: unknown;
        description?: unknown;
        channelTitle?: unknown;
        publishedAt?: unknown;
      };
    }): ContentSourceItem[] => {
      const videoId = String(item.id?.videoId || "");
      const title = String(item.snippet?.title || "").trim();
      const publishedAt = isoDate(item.snippet?.publishedAt);
      if (!videoId || !title || !publishedAt) return [];
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
          },
        },
      ];
    },
  );
}

export async function fetchRedditStories(
  query: string,
  options: { fetcher?: typeof fetch; limit?: number } = {},
): Promise<ContentSourceItem[]> {
  const limit = Math.max(1, Math.min(25, options.limit || 10));
  const url = new URL("https://www.reddit.com/search.json");
  url.searchParams.set("q", query.slice(0, 300));
  url.searchParams.set("sort", "top");
  url.searchParams.set("t", "month");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("type", "link");
  const payload = await jsonResponse(url.toString(), options.fetcher || fetch);
  const retrievedAt = new Date().toISOString();
  const children = Array.isArray(payload?.data?.children) ? payload.data.children : [];
  return children.flatMap((child: any): ContentSourceItem[] => {
    const item = child?.data || {};
    const title = String(item.title || "").trim();
    const publishedAt = isoDate(Number(item.created_utc) * 1_000);
    if (!title || !publishedAt || !item.permalink) return [];
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

export async function fetchSyndicationFeed(sourceUrl: string, fetcher: typeof fetch = fetch) {
  const safeUrl = canonicalizeContentSourceUrl(sourceUrl);
  const response = await fetcher(safeUrl, {
    headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await readResponseText(response, MAX_SOURCE_RESPONSE_BYTES);
  if (!response.ok) throw new Error(`Content feed returned ${response.status}.`);
  return parseSyndicationFeed(text, safeUrl);
}
