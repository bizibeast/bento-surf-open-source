import { readResponseText, RequestBodyTooLargeError } from "./request-security.server";
import {
  ContentRetrievalError,
  retryContentRequest,
  retryableContentStatus,
} from "./content-retrieval.server";
import { sourcePublicationTime } from "./content-source-recency";
import {
  publicSourceUrl,
  sourceCreator,
  sourcePostEmbed,
  sourcePresentation,
  sourceThumbnail,
} from "./content-source-media";
import type { ContentSourceItem } from "./content-sources.server";

import {
  MAX_METADATA_BYTES,
  PUBLIC_UA,
  creatorProfile,
  youtubeProfileAliases,
  assignedJson,
  record,
  text,
  observedCount,
  publicPostMetadata,
  publicCreatorMetadata,
  type Metadata,
} from "./content-source-enrichment";
export {
  publicPostMetadata,
  publicCreatorMetadata,
  publicPostCountEvidence,
} from "./content-source-enrichment";
async function publicResponse(
  initial: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
  expectedProfile?: string,
) {
  return retryContentRequest(
    async (attemptSignal) => {
      let url = publicSourceUrl(initial);
      for (let count = 0; url && count <= 3; count++) {
        if (
          expectedProfile &&
          creatorProfile(url) !== creatorProfile(expectedProfile) &&
          !(
            creatorProfile(url)?.startsWith("https://www.youtube.com/") &&
            creatorProfile(expectedProfile)?.startsWith("https://www.youtube.com/")
          )
        )
          throw new ContentRetrievalError(
            "Creator profile redirect does not match the requested account",
            false,
          );
        const response = await fetcher(url, {
          headers: {
            Accept: "text/html,application/json",
            "User-Agent": PUBLIC_UA,
            "Accept-Language": "en-US,en;q=0.9",
          },
          redirect: "manual",
          signal: attemptSignal,
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          try {
            url = location ? publicSourceUrl(new URL(location, url).toString()) : null;
          } catch {
            url = null;
          }
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new ContentRetrievalError(
            "Post metadata unavailable",
            retryableContentStatus(response.status),
          );
        }
        try {
          const body = await readResponseText(response, MAX_METADATA_BYTES);
          if (expectedProfile && creatorProfile(url) !== creatorProfile(expectedProfile)) {
            const aliases = youtubeProfileAliases(assignedJson(body, "ytInitialData"));
            if (
              !aliases.includes(creatorProfile(expectedProfile) || "") ||
              !aliases.includes(creatorProfile(url) || "")
            )
              throw new ContentRetrievalError(
                "Creator profile redirect identity could not be verified",
                false,
              );
          }
          return body;
        } catch (error) {
          if (error instanceof RequestBodyTooLargeError) {
            await response.body?.cancel().catch(() => undefined);
            throw new ContentRetrievalError("Post metadata is too large", false);
          }
          throw error;
        }
      }
      throw new ContentRetrievalError("Post metadata redirect unavailable", false);
    },
    { timeoutMs: 2_000, signal },
  );
}

/** Public counters for an exact post; never the first related post or an account total. */
function oEmbedEndpoint(sourceUrl: string) {
  const host = new URL(sourceUrl).hostname.replace(/^www\./, "");
  const origin = ["youtube.com", "m.youtube.com", "youtu.be"].includes(host)
    ? "https://www.youtube.com/oembed"
    : host === "tiktok.com"
      ? "https://www.tiktok.com/oembed"
      : ["x.com", "twitter.com"].includes(host)
        ? "https://publish.twitter.com/oembed"
        : null;
  if (!origin) return null;
  const url = new URL(origin);
  url.searchParams.set("url", sourceUrl);
  url.searchParams.set("format", "json");
  return url.toString();
}

export async function enrichContentSources(
  items: ContentSourceItem[],
  options: { fetcher?: typeof fetch; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ContentSourceItem[]> {
  const fetcher = options.fetcher || fetch;
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 12_000, 30_000));
  const deadline = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  // Fetch publication/performance evidence before optional profile photos can consume the budget.
  const metadataDeadline = AbortSignal.any([
    deadline,
    AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs * 0.6))),
  ]);
  const result = items.map((item) => ({ ...item, thumbnailUrl: sourceThumbnail(item) }));
  const hasStats = (item: ContentSourceItem) =>
    [item.stats?.views, item.stats?.likes].some(
      (value) => typeof value === "number" && Number.isFinite(value),
    );
  const needsFollowers = (item: ContentSourceItem) => observedCount(item.stats?.followers) === null;
  const merge = (index: number, metadata: Metadata) => {
    const item = result[index];
    const embed = sourcePostEmbed(item.canonicalUrl);
    const presentation = Object.fromEntries(
      Object.entries(metadata).filter(
        ([, value]) =>
          value !== null &&
          value !== undefined &&
          value !== "" &&
          (!Array.isArray(value) || value.length),
      ),
    );
    result[index] = {
      ...item,
      ...sourcePresentation({ ...item, ...presentation }),
      title: metadata.title?.slice(0, 500) || item.title,
      summary: metadata.summary || item.summary,
      author:
        (metadata.author === sourceCreator(item.canonicalUrl)?.name ? item.author : null) ||
        metadata.author ||
        item.author,
      thumbnailUrl: metadata.thumbnailUrl || item.thumbnailUrl,
      mediaType:
        (item.kind === "rss" || item.kind === "gdelt" || item.platform === "Hacker News"
          ? "article"
          : metadata.mediaType === "text" && item.mediaType
            ? item.mediaType
            : metadata.mediaType) ||
        item.mediaType ||
        (embed?.label === "Video" || embed?.label === "Reel" ? "video" : null),
      publishedAt: metadata.publishedAt || item.publishedAt,
      ...(item.stats || metadata.stats ? { stats: { ...item.stats, ...metadata.stats } } : {}),
    };
  };
  const pool = async (
    indices: number[],
    concurrency: number,
    signal: AbortSignal,
    run: (index: number) => Promise<void>,
  ) => {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, indices.length) }, async () => {
        while (next < indices.length && !signal.aborted) {
          const index = indices[next++];
          try {
            await run(index);
          } catch {
            /* Keep every usable source if a provider fails. */
          }
        }
      }),
    );
  };
  const priority = (item: ContentSourceItem) =>
    (!sourcePublicationTime(item.publishedAt, Date.now()) ? 4 : 0) +
    (!hasStats(item) && ["social_search", "youtube"].includes(item.kind) ? 2 : 0);
  const indices = result
    .map((_, index) => index)
    .filter((index) => publicSourceUrl(result[index].canonicalUrl))
    .sort((a, b) => priority(result[b]) - priority(result[a]));
  await pool(indices, 8, metadataDeadline, async (index) => {
    const item = result[index];
    const endpoint = oEmbedEndpoint(item.canonicalUrl);
    const needPresentation = !item.thumbnailUrl || !item.author;
    const community = item.platform === "Reddit" || item.platform === "Hacker News";
    const needEvidence =
      !sourcePublicationTime(item.publishedAt, Date.now()) ||
      (community
        ? observedCount(item.stats?.likes) === null || observedCount(item.stats?.comments) === null
        : (!hasStats(item) || needsFollowers(item)) &&
          ["social_search", "youtube"].includes(item.kind));
    if (!needPresentation && !needEvidence) return;
    // oEmbed describes presentation; it does not prove when a post was published or how it performed.
    const [page, embed] = await Promise.allSettled([
      publicResponse(item.canonicalUrl, fetcher, metadataDeadline).then((html) =>
        publicPostMetadata(html, item.canonicalUrl, item.authorUrl),
      ),
      endpoint && needPresentation
        ? publicResponse(endpoint, fetcher, metadataDeadline).then((body): Metadata => {
            const payload = record(JSON.parse(body));
            return {
              title: text(payload.title),
              author: text(payload.author_name),
              authorUrl: publicSourceUrl(payload.author_url),
              authorAvatarUrl: publicSourceUrl(payload.author_avatar_url),
              thumbnailUrl: publicSourceUrl(payload.thumbnail_url),
              mediaType: payload.type === "video" ? "video" : null,
            };
          })
        : Promise.resolve({} as Metadata),
    ]);
    const metadata: Metadata = page.status === "fulfilled" ? page.value : {};
    if (embed.status === "fulfilled")
      Object.assign(
        metadata,
        Object.fromEntries(
          Object.entries(embed.value).filter(
            ([key, value]) =>
              value !== null &&
              value !== undefined &&
              value !== "" &&
              !(
                metadata.authorUrl &&
                observedCount(metadata.stats?.followers) !== null &&
                ["author", "authorUrl"].includes(key)
              ),
          ),
        ),
      );
    merge(index, metadata);
  });
  const profiles = new Map<string, Promise<Metadata>>();
  const observedProfiles = new Map<string, Metadata>();
  const profileMetadata = (authorUrl: string) => {
    const key = creatorProfile(authorUrl);
    if (!key) return Promise.resolve({} as Metadata);
    if (!profiles.has(key))
      profiles.set(
        key,
        (async () => {
          try {
            const metadata = publicCreatorMetadata(
              await publicResponse(authorUrl, fetcher, deadline, key),
              authorUrl,
            );
            observedProfiles.set(key, metadata);
            return metadata;
          } catch {
            return {};
          }
        })(),
      );
    return profiles.get(key)!;
  };
  const applyProfile = (index: number, metadata: Metadata) => {
    const item = result[index];
    result[index] = {
      ...item,
      authorAvatarUrl: item.authorAvatarUrl || metadata.authorAvatarUrl,
      ...(needsFollowers(item) && observedCount(metadata.stats?.followers) !== null
        ? { stats: { ...item.stats, followers: metadata.stats!.followers } }
        : {}),
    };
  };
  const queuedProfiles = new Set<string>();
  const profileIndices = indices.filter((index) => {
    const item = result[index];
    if (item.authorAvatarUrl && !needsFollowers(item)) return false;
    const key = creatorProfile(item.authorUrl);
    if (!key) return !item.authorAvatarUrl;
    if (queuedProfiles.has(key)) return false;
    queuedProfiles.add(key);
    return true;
  });
  await pool(profileIndices, 6, deadline, async (index) => {
    const item = result[index];
    if (item.authorUrl) applyProfile(index, await profileMetadata(item.authorUrl));
    if (
      !result[index].authorAvatarUrl &&
      /^(www\.)?instagram\.com$/.test(new URL(item.canonicalUrl).hostname) &&
      !deadline.aborted
    ) {
      const embed = sourcePostEmbed(item.canonicalUrl);
      if (embed) {
        try {
          const owner = publicPostMetadata(
            await publicResponse(embed.url, fetcher, deadline),
            item.canonicalUrl,
            item.authorUrl,
          );
          merge(index, {
            authorAvatarUrl: owner.authorAvatarUrl,
            authorUrl: item.authorUrl || owner.authorUrl,
            author: item.author || owner.author,
            publishedAt: item.publishedAt || owner.publishedAt,
            stats: { ...owner.stats, ...item.stats },
          });
        } catch {
          /* The visible-card resolver can retry a failed owner lookup later. */
        }
      }
    }
    const author = result[index];
    if (
      (!author.authorAvatarUrl || needsFollowers(author)) &&
      author.authorUrl &&
      !deadline.aborted
    )
      applyProfile(index, await profileMetadata(author.authorUrl));
  });
  // Share verified audience evidence with every post by this owner, including rows the deadline skipped.
  result.forEach((item, index) => {
    const key = creatorProfile(item.authorUrl);
    const metadata = key && observedProfiles.get(key);
    if (metadata) applyProfile(index, metadata);
  });
  return result;
}
