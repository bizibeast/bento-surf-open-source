import { normalizePublicPostUrl, type PublicPostMetric } from "./public-post-stats";
import { discoverPostKey } from "./content-discover-identity";
import { publicPostCountEvidence, publicPostMetadata } from "./content-source-enrichment";
import {
  instagramPostFromUrl,
  fetchInstagramEmbed,
  parseInstagramEmbedStats,
  parseInstagramEmbedAuthor,
} from "./instagram-embed";
import { readBoundedBytes } from "./media-stream";
import type { BasicMediaBindings } from "./basic-media";
import { fetchTikTokPublicPost } from "./tiktok-public";

export type ExtractedPostStats = {
  sourceUrl: string;
  counts: Partial<Record<PublicPostMetric, number>>;
  method: string;
  resolvedFromRepost?: boolean;
  authorHandle?: string;
};
type Options = { fetcher?: typeof fetch; signal?: AbortSignal };
export class PostStatsExtractionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const json = async (r: Response, max = 256_000) =>
  JSON.parse(new TextDecoder().decode(await readBoundedBytes(r, max))) as Record<string, unknown>;
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const count = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0
    ? v
    : typeof v === "string" && /^\d+$/.test(v) && Number.isSafeInteger(Number(v))
      ? Number(v)
      : null;

export async function extractPublicPostStats(
  input: string,
  env: BasicMediaBindings = {},
  options: Options = {},
): Promise<ExtractedPostStats> {
  const source = normalizePublicPostUrl(input);
  if (!source) throw new PostStatsExtractionError(400, "Use a supported public post link.");
  const fetcher = options.fetcher ?? fetch;
  const signal = AbortSignal.any([
    options.signal ?? AbortSignal.timeout(45_000),
    AbortSignal.timeout(45_000),
  ]);
  if (source.platform === "TikTok" && /\/photo\//.test(source.url)) {
    const post = await fetchTikTokPublicPost(source.url, signal);
    return { sourceUrl: source.url, counts: post.counts, method: "tiktok-download-metadata" };
  }
  const facebookVideo =
    source.platform === "Facebook" &&
    (/\/(?:reel|videos)\/\d+/.test(new URL(source.url).pathname) ||
      new URL(source.url).pathname === "/watch");
  if (source.platform === "YouTube" || source.platform === "TikTok" || facebookVideo) {
    if (!env.BASIC_MEDIA_RESOLVER || !env.BASIC_MEDIA_TOKEN)
      throw new PostStatsExtractionError(503, "Video statistics extraction is not configured.");
    const r = await env.BASIC_MEDIA_RESOLVER.fetch(
      new Request("https://basic-media.internal/stats", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.BASIC_MEDIA_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: source.url }),
        signal,
      }),
    );
    const body = await json(r, 8192);
    if (!r.ok)
      throw new PostStatsExtractionError(
        r.status === 429 ? 429 : 502,
        typeof body.code === "string" ? body.code : "Video metadata extraction failed.",
      );
    const expected =
      source.platform === "YouTube"
        ? new URL(source.url).searchParams.get("v")
        : facebookVideo
          ? new URL(source.url).searchParams.get("v") ||
            new URL(source.url).pathname.match(/\/(?:videos|reel)\/(\d+)/)?.[1]
          : new URL(source.url).pathname.match(/\/video\/(\d+)/)?.[1];
    if (
      (expected && body.id !== expected) ||
      body.platform !==
        (source.platform === "YouTube" ? "youtube" : facebookVideo ? "facebook" : "tiktok")
    )
      throw new PostStatsExtractionError(502, "Video metadata did not match the requested post.");
    const counts: ExtractedPostStats["counts"] = {};
    for (const [key, v] of Object.entries(object(body.counts))) {
      const n = count(v);
      if (
        n !== null &&
        ["views", "likes", "comments", "shares", "reposts", "quotes", "saves"].includes(key)
      )
        counts[key as PublicPostMetric] = n;
    }
    return { sourceUrl: source.url, counts, method: "native-video-extractor" };
  }
  if (source.platform === "Reddit") {
    const id = new URL(source.url).pathname.match(/\/comments\/([a-z0-9]+)/i)?.[1];
    try {
      const r = await fetcher(
        `https://www.reddit.com/comments/${id}.json?raw_json=1&limit=1&depth=0`,
        {
          headers: {
            accept: "application/json",
            "user-agent": "BentoSurf/1.0 public-post-statistics",
          },
          redirect: "manual",
          signal,
        },
      );
      const payload = JSON.parse(new TextDecoder().decode(await readBoundedBytes(r, 512_000)));
      const post = payload?.[0]?.data?.children?.find(
        (p: Record<string, unknown>) => p.kind === "t3" && object(p.data).id === id,
      )?.data;
      if (r.ok && post && !post.is_private && !post.quarantine) {
        const counts: ExtractedPostStats["counts"] = {};
        if (!post.score_hidden && Number.isSafeInteger(post.score)) counts.score = post.score;
        const comments = count(post.num_comments);
        if (comments !== null) counts.comments = comments;
        return { sourceUrl: source.url, counts, method: "reddit-post-data" };
      }
    } catch {
      /* Fall through to identity-matched public metadata. */
    }
  }
  if (source.platform === "X") {
    const id = new URL(source.url).pathname.match(/\/status\/(\d+)/)?.[1];
    const r = await fetcher(`https://api.fxtwitter.com/status/${id}`, {
      headers: { accept: "application/json", "user-agent": "Bento public post statistics" },
      redirect: "manual",
      signal,
    });
    const payload = await json(r);
    const tweet = object(payload.tweet);
    const resolved = normalizePublicPostUrl(tweet.url);
    const resolvedId = resolved && new URL(resolved.url).pathname.match(/\/status\/(\d+)/)?.[1];
    if (
      !r.ok ||
      payload.code !== 200 ||
      !resolved ||
      resolved.platform !== "X" ||
      String(tweet.id) !== resolvedId ||
      (resolvedId !== id && !tweet.reposted_by)
    )
      throw new PostStatsExtractionError(
        502,
        "X metadata could not be resolved to the requested post.",
      );
    const counts: ExtractedPostStats["counts"] = {};
    for (const [key, field] of [
      ["views", "views"],
      ["likes", "likes"],
      ["comments", "replies"],
      ["reposts", "retweets"],
      ["quotes", "quotes"],
      ["saves", "bookmarks"],
    ] as const) {
      const n = count(tweet[field]);
      if (n !== null) counts[key] = n;
    }
    return {
      sourceUrl: resolved.url,
      counts,
      method: "public-post-api",
      ...(resolvedId !== id ? { resolvedFromRepost: true } : {}),
    };
  }
  if (source.platform === "Instagram") {
    const post = instagramPostFromUrl(source.url)!;
    try {
      const r = await fetchInstagramEmbed(post, signal);
      if (r.ok) {
        const html = new TextDecoder().decode(await readBoundedBytes(r, 2 * 1024 * 1024));
        const counts = parseInstagramEmbedStats(html, post);
        if (Object.keys(counts).length)
          return {
            sourceUrl: source.url,
            counts,
            method: "instagram-download-metadata",
            authorHandle: parseInstagramEmbedAuthor(html, post),
          };
      } else await r.body?.cancel();
    } catch {
      /* A blocked embed, invalid redirect or oversized body must not prevent
       * the independent, identity-matched canonical-page fallback. */
    }
  }
  const alternatives =
    source.platform === "LinkedIn"
      ? [
          `https://www.linkedin.com/embed/feed/update/urn:li:activity:${new URL(source.url).pathname.match(/(?:activity-|activity:)(\d+)/)?.[1]}`,
          source.url,
        ]
      : [source.url];
  const counts: ExtractedPostStats["counts"] = {};
  let authorHandle: string | undefined;
  for (const initial of alternatives) {
    let target = initial;
    try {
      for (let redirects = 0; redirects < 4; redirects++) {
        const r = await fetcher(target, {
          headers: {
            accept: "text/html,application/json",
            "user-agent": "Mozilla/5.0",
            "accept-language": "en-US,en;q=0.9",
          },
          redirect: "manual",
          signal,
        });
        if (r.status >= 300 && r.status < 400) {
          const location = r.headers.get("location");
          await r.body?.cancel();
          const next = location ? normalizePublicPostUrl(new URL(location, target).href) : null;
          if (
            !next ||
            discoverPostKey({ sourceUrl: next.url }) !== discoverPostKey({ sourceUrl: source.url })
          )
            break;
          target = new URL(location!, target).href;
          continue;
        }
        if (!r.ok) {
          await r.body?.cancel();
          break;
        }
        const html = new TextDecoder().decode(await readBoundedBytes(r, 4 * 1024 * 1024));
        Object.assign(counts, publicPostCountEvidence(html, source.url));
        if (source.platform === "Instagram") {
          const author = publicPostMetadata(html.slice(0, 1_500_000), source.url).authorUrl;
          if (author) {
            const handle = new URL(author).pathname.replace(/^\/|\/$/g, "");
            if (/^[A-Za-z0-9._]{1,30}$/.test(handle)) authorHandle = handle;
          }
        }
        break;
      }
    } catch {
      /* Bounded alternative, never a paid provider. */
    }
    if (Object.keys(counts).length) break;
  }
  return {
    sourceUrl: source.url,
    counts,
    method: "platform-public-metadata",
    ...(authorHandle ? { authorHandle } : {}),
  };
}
