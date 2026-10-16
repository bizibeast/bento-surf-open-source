import { reserveProviderUsage } from "./provider-budget.server";
import { readResponseText } from "./request-security.server";
import { reserveBrightDataSeoRequest, type BrightDataSeoEnv } from "./seo-bright-data.server";
import { canonicalizeContentSourceUrl, type ContentSourceItem } from "./content-sources.server";
import { publicSourceUrl, sourceCreator, sourceThumbnail } from "./content-source-media";
import { normalizeDiscoverCreator } from "./content-discover-creators";
import {
  ContentRetrievalError,
  retryContentRequest,
  retryableContentStatus,
} from "./content-retrieval.server";
import { sourcePublicationTime } from "./content-source-recency";

export type DiscoverProfileSearchResult = {
  name: string;
  profileUrl: string;
  platform: string;
  description: string;
};

export function socialProfileSearchResults(payload: unknown): DiscoverProfileSearchResult[] {
  if (!payload || typeof payload !== "object") return [];
  const organic = (payload as { organic?: unknown }).organic;
  if (!Array.isArray(organic)) return [];
  const seen = new Set<string>();
  return organic.slice(0, 20).flatMap((row): DiscoverProfileSearchResult[] => {
    if (!row || typeof row.link !== "string" || typeof row.title !== "string") return [];
    try {
      const creator = normalizeDiscoverCreator(row.link);
      const key = creator.profileUrl.toLowerCase();
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          ...creator,
          name: row.title.trim().slice(0, 200),
          description: typeof row.description === "string" ? row.description.slice(0, 600) : "",
        },
      ];
    } catch {
      return [];
    }
  });
}

// A platform gets its own quota; LinkedIn must not consume X's search results.
export const socialSearchPlatforms = [
  { platform: "Instagram", group: "site:instagram.com/p/ OR site:instagram.com/reel/" },
  {
    platform: "YouTube",
    group: "site:youtube.com/watch OR site:youtube.com/shorts/ OR site:youtu.be/",
  },
  { platform: "TikTok", group: "site:tiktok.com/@" },
  { platform: "LinkedIn", group: "site:linkedin.com/posts/ OR site:linkedin.com/feed/update/" },
  { platform: "X", group: "site:x.com/*/status/ OR site:twitter.com/*/status/" },
  { platform: "Threads", group: "site:threads.net/@ OR site:threads.com/@" },
  { platform: "Facebook", group: "site:facebook.com/*/posts/ OR site:facebook.com/reel/" },
  { platform: "Reddit", group: "site:reddit.com/r/" },
];
export const socialSearchGroups = socialSearchPlatforms.map(({ group }) => group);

/** Some platforms encode the actual creation time in their public post ID. */
export function socialPostPublicationDate(url: URL, now: number): string | null {
  const host = url.hostname.replace(/^www\./, "");
  const match = ["x.com", "twitter.com"].includes(host)
    ? url.pathname.match(/\/status\/(\d{15,20})/)
    : host === "linkedin.com"
      ? url.pathname.match(/(?:activity[-:]|ugcPost[-:])(\d{15,20})/)
      : host === "tiktok.com"
        ? url.pathname.match(/\/video\/(\d{15,20})/)
        : null;
  if (!match) return null;
  try {
    const id = BigInt(match[1]);
    const timestamp =
      host === "tiktok.com"
        ? Number(id >> 32n) * 1000
        : Number(id >> 22n) + (["x.com", "twitter.com"].includes(host) ? 1288834974657 : 0);
    if (timestamp < Date.UTC(2005, 0, 1) || timestamp > now + 5 * 60_000) return null;
    return new Date(timestamp).toISOString();
  } catch {
    return null;
  }
}

function publicationDate(row: Record<string, unknown>, url: URL, retrievedAt: string) {
  const now = Date.parse(retrievedAt);
  // Do not infer a post's age from Google's crawl/snippet date or query window.
  for (const value of [row.published_at, row.publishedAt, row.datePublished]) {
    if (typeof value !== "string") continue;
    const timestamp = sourcePublicationTime(value, now);
    if (timestamp !== null) return new Date(timestamp).toISOString();
  }
  return socialPostPublicationDate(url, now);
}

function socialPlatform(url: URL) {
  const host = url.hostname.replace(/^www\./, "");
  if (["x.com", "twitter.com"].includes(host) && /\/status\/\d+/.test(url.pathname)) return "X";
  if (host === "linkedin.com" && /\/(posts|feed\/update)\//.test(url.pathname)) return "LinkedIn";
  if (host === "instagram.com" && /^\/(p|reel)\//.test(url.pathname)) return "Instagram";
  if (["threads.net", "threads.com"].includes(host) && /\/post\//.test(url.pathname))
    return "Threads";
  if (
    (host === "youtube.com" && (url.searchParams.has("v") || /^\/shorts\//.test(url.pathname))) ||
    host === "youtu.be"
  )
    return "YouTube";
  if (host === "tiktok.com" && /\/video\/\d+/.test(url.pathname)) return "TikTok";
  if (host === "reddit.com" && /\/comments\//.test(url.pathname)) return "Reddit";
  if (
    host === "facebook.com" &&
    (/\/(posts|reel|videos)\//.test(url.pathname) || /\/(story|permalink)\.php$/.test(url.pathname))
  )
    return "Facebook";
  return null;
}

export function socialSearchItems(payload: unknown, retrievedAt: string): ContentSourceItem[] {
  if (!payload || typeof payload !== "object") return [];
  const organic = (payload as { organic?: unknown }).organic;
  if (!Array.isArray(organic)) return [];
  return organic.slice(0, 40).flatMap((row): ContentSourceItem[] => {
    if (!row || typeof row.link !== "string" || typeof row.title !== "string") return [];
    try {
      const canonicalUrl = canonicalizeContentSourceUrl(row.link);
      const platform = socialPlatform(new URL(canonicalUrl));
      const creator = sourceCreator(canonicalUrl);
      if (!platform || !row.title.trim()) return [];
      return [
        {
          canonicalUrl,
          title: row.title.trim().slice(0, 500),
          summary: typeof row.description === "string" ? row.description.slice(0, 2000) : "",
          sourceName: platform,
          platform,
          author: creator?.name || null,
          authorUrl: creator?.url || null,
          thumbnailUrl:
            publicSourceUrl(row.thumbnail) ||
            publicSourceUrl(row.image) ||
            sourceThumbnail({ canonicalUrl }),
          mediaType:
            /\/(reels?|shorts|video)\//.test(new URL(canonicalUrl).pathname) ||
            platform === "YouTube"
              ? "video"
              : null,
          kind: "social_search",
          retrievedAt,
          // Only explicit publication metadata or the platform post ID establishes age.
          publishedAt: publicationDate(row, new URL(canonicalUrl), retrievedAt),
          stats: {},
        },
      ];
    } catch {
      return [];
    }
  });
}

async function fetchSocialSearchPayload(
  input: {
    query: string;
    group: string;
    language: string;
    region: string;
    windowDays?: 7 | 30;
    limit?: number;
    start?: number;
    publishedAfter?: string;
    publishedBefore?: string;
  },
  options: {
    fetcher?: typeof fetch;
    reserve?: () => Promise<boolean>;
    env?: BrightDataSeoEnv;
    signal?: AbortSignal;
    delay?: (ms: number) => Promise<void>;
  } = {},
) {
  const env = options.env || process.env;
  if (!env.BRIGHT_DATA_API_KEY) throw new Error("Social discovery search is not configured.");
  const reserve =
    options.reserve ||
    (() => reserveBrightDataSeoRequest(env, new Date().toISOString().slice(0, 7)));
  const target = new URL("https://www.google.com/search");
  target.searchParams.set("q", `(${input.group}) (${input.query})`);
  target.searchParams.set("num", String(Math.max(1, Math.min(40, input.limit || 20))));
  if (input.start !== undefined) {
    if (!Number.isSafeInteger(input.start) || input.start < 0)
      throw new ContentRetrievalError("Invalid social search continuation.", false);
    target.searchParams.set("start", String(input.start));
  }
  target.searchParams.set("hl", /^[a-z]{2}$/i.test(input.language) ? input.language : "en");
  if (/^[a-z]{2}$/i.test(input.region)) target.searchParams.set("gl", input.region);
  if (input.windowDays) target.searchParams.set("tbs", input.windowDays === 7 ? "qdr:w" : "qdr:m");
  if (input.publishedAfter && input.publishedBefore) {
    const date = (value: string) => {
      const parsed = new Date(value);
      if (!Number.isFinite(parsed.getTime()))
        throw new ContentRetrievalError("Invalid search date window.", false);
      return `${parsed.getUTCMonth() + 1}/${parsed.getUTCDate()}/${parsed.getUTCFullYear()}`;
    };
    target.searchParams.set(
      "tbs",
      `cdr:1,cd_min:${date(input.publishedAfter)},cd_max:${date(input.publishedBefore)}`,
    );
  }
  if (input.windowDays && /^[a-z]{2}$/i.test(input.language))
    target.searchParams.set("lr", `lang_${input.language.toLowerCase()}`);
  return retryContentRequest(
    async (signal) => {
      if (!(await reserve()))
        throw new ContentRetrievalError("Social discovery search budget reached.", false);
      signal.throwIfAborted();
      await reserveProviderUsage("bright_data_requests");
      const response = await (options.fetcher || fetch)("https://api.brightdata.com/request", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.BRIGHT_DATA_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          zone: env.BRIGHT_DATA_SERP_ZONE || "serp_api1",
          url: target.toString(),
          format: "json",
          data_format: "parsed",
        }),
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ContentRetrievalError(
          `Social discovery search unavailable (${response.status}).`,
          retryableContentStatus(response.status),
        );
      }
      let payload = JSON.parse(await readResponseText(response, 2 * 1024 * 1024));
      // The provider can return HTTP 200 around a failed upstream request.
      if (payload?.status_code !== undefined) {
        const status = Number(payload.status_code);
        if (status !== 200 || (!payload.body && !Array.isArray(payload.organic)))
          throw new ContentRetrievalError(
            `Social search upstream unavailable (${status || "empty response"}).`,
            status === 200 || retryableContentStatus(status),
          );
        if (payload.body)
          payload = typeof payload.body === "string" ? JSON.parse(payload.body) : payload.body;
      }
      if (
        !payload ||
        typeof payload !== "object" ||
        payload.error ||
        (Array.isArray(payload.errors) ? payload.errors.length > 0 : payload.errors) ||
        !Array.isArray(payload.organic)
      )
        throw new ContentRetrievalError(
          "Social search returned an unavailable result payload.",
          true,
        );
      return payload as unknown;
    },
    // Cold SERP requests can take ~24s; restarting after 10s discards valid answers.
    // The caller's shared deadline still bounds retries and every attempt reserves quota.
    { timeoutMs: 25_000, signal: options.signal, delay: options.delay },
  );
}

export async function fetchSocialSearch(
  input: Parameters<typeof fetchSocialSearchPayload>[0],
  options: Parameters<typeof fetchSocialSearchPayload>[1] = {},
) {
  return socialSearchItems(
    await fetchSocialSearchPayload(input, options),
    new Date().toISOString(),
  );
}

/** Bright Data documents next_page_start; never follow an arbitrary provider URL. */
export function socialSearchNextOffset(payload: unknown, currentOffset: number): number | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const raw = row.pagination;
  const pagination = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const valid = (value: unknown) => {
    const number =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^\d+$/.test(value)
          ? Number(value)
          : NaN;
    return Number.isSafeInteger(number) && number > currentOffset ? number : null;
  };
  if (pagination) {
    const explicit = valid(pagination.next_page_start);
    if (explicit !== null) return explicit;
    if (typeof pagination.next_page_link === "string") {
      try {
        const next = new URL(pagination.next_page_link, "https://www.google.com");
        if (
          next.protocol === "https:" &&
          /^(www\.)?google\.com$/.test(next.hostname) &&
          next.pathname === "/search"
        ) {
          const offset = valid(next.searchParams.get("start"));
          if (offset !== null) return offset;
        }
      } catch {
        /* A malformed next link is not a continuation. */
      }
    }
    if (Array.isArray(pagination.pages)) {
      const offsets = pagination.pages.flatMap((page) => {
        const offset = valid(page?.start);
        return offset === null ? [] : [offset];
      });
      if (offsets.length) return Math.min(...offsets);
    }
    return null;
  }
  // Google ignores num and normally returns ten rows. A full page allows one
  // genuine offset request when metadata is absent; an empty/short page ends it.
  return Array.isArray(row.organic) && row.organic.length >= 10
    ? currentOffset + row.organic.length
    : null;
}

export async function fetchSocialSearchPage(
  input: Parameters<typeof fetchSocialSearchPayload>[0],
  options: Parameters<typeof fetchSocialSearchPayload>[1] = {},
) {
  const payload = await fetchSocialSearchPayload(input, options);
  return {
    items: socialSearchItems(payload, new Date().toISOString()),
    nextOffset: socialSearchNextOffset(payload, input.start || 0),
  };
}

export async function fetchDiscoverCreatorProfiles(
  input: { name: string; language: string; region: string },
  options: Parameters<typeof fetchSocialSearchPayload>[1] = {},
) {
  const payload = await fetchSocialSearchPayload(
    {
      query: `"${input.name.replace(/["()]/g, " ")}"`,
      group:
        "site:youtube.com/@ OR site:instagram.com OR site:tiktok.com/@ OR site:x.com OR site:linkedin.com/in/",
      language: input.language,
      region: input.region,
    },
    options,
  );
  return socialProfileSearchResults(payload);
}
