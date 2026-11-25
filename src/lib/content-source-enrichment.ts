import { sourcePublicationTime } from "./content-source-recency";
import { youtubeVideoIdFromUrl } from "./social-embeds";
import {
  publicSourceUrl,
  sourceCreator,
  type ContentSourceMedia,
  type ContentSourcePresentation,
} from "./content-source-media";
import type { ContentSourceStats } from "./content-sources.server";
import { discoverPostKey } from "./content-discover-identity";
import type { PublicPostMetric } from "./public-post-stats";

export const MAX_METADATA_BYTES = 1_500_000;
export const PUBLIC_UA = "Mozilla/5.0 (compatible; BentoSurfBot/1.0; +http://localhost:8080)";
export type Metadata = ContentSourcePresentation & {
  title?: string;
  summary?: string;
  author?: string;
  thumbnailUrl?: string | null;
  publishedAt?: string | null;
  stats?: ContentSourceStats;
};

function decode(value: string) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#39|#x[0-9a-f]+|#\d+);/gi, (entity) => {
    const named: Record<string, string> = {
      "&amp;": "&",
      "&quot;": '"',
      "&apos;": "'",
      "&#39;": "'",
      "&lt;": "<",
      "&gt;": ">",
    };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const code = entity.toLowerCase().startsWith("&#x")
      ? parseInt(entity.slice(3), 16)
      : parseInt(entity.slice(2), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}
export function text(value: unknown) {
  return typeof value === "string" ? decode(value).trim().slice(0, 10_000) : "";
}
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function objectUrl(value: unknown): string | null {
  if (Array.isArray(value)) return value.map(objectUrl).find(Boolean) || null;
  return publicSourceUrl(
    typeof value === "string" ? decode(value) : record(value).url || record(value).contentUrl,
  );
}
function attributes(tag: string) {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [
      m[1].toLowerCase(),
      decode(m[2] ?? m[3]),
    ]),
  );
}

export function observedCount(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^((?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?)\s*([kmb])?$/i);
  if (!match) return null;
  const count =
    Number(match[1].replaceAll(",", "")) *
    ({ k: 1_000, m: 1_000_000, b: 1_000_000_000 }[match[2]?.toLowerCase()] || 1);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/** A creator profile, never a post, community, search page or a lookalike host. */
export function creatorProfile(value: unknown): string | null {
  const safe = publicSourceUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  let host = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  if (host === "twitter.com") host = "x.com";
  if (host === "threads.net") host = "threads.com";
  let path = url.pathname.replace(/\/+$/, "");
  const valid =
    host === "youtube.com"
      ? /^\/(?:@[\w.-]+|channel\/UC[\w-]+)$/.test(path)
      : host === "linkedin.com"
        ? /^\/(?:in|company)\/[\w%-]+$/.test(path)
        : host === "tiktok.com"
          ? /^\/@[\w.]+$/.test(path)
          : ["instagram.com", "x.com", "threads.com", "facebook.com"].includes(host) &&
            /^\/[\w.-]+$/.test(path) &&
            !/^\/(?:p|reel|reels|explore|home|search|login|accounts|groups|watch|stories|share)$/i.test(
              path,
            );
  if (!valid) return null;
  if (host !== "youtube.com" || !path.startsWith("/channel/")) path = path.toLowerCase();
  return `https://www.${host}${path}`;
}

function creatorFollowers(author: Record<string, unknown>): number | null {
  const counters = Array.isArray(author.interactionStatistic)
    ? author.interactionStatistic
    : [author.interactionStatistic];
  for (const value of counters) {
    const counter = record(value);
    const action =
      typeof counter.interactionType === "string"
        ? counter.interactionType
        : record(counter.interactionType)["@type"];
    if (/(?:Follow|Subscribe)Action$/.test(String(action))) {
      const count = observedCount(counter.userInteractionCount);
      if (count !== null) return count;
    }
  }
  return null;
}

export function youtubeProfileAliases(payload: Record<string, unknown>): string[] {
  const channel = record(record(payload.metadata).channelMetadataRenderer);
  return [
    channel.channelUrl,
    channel.vanityChannelUrl,
    typeof channel.externalId === "string" && /^UC[\w-]+$/.test(channel.externalId)
      ? `https://www.youtube.com/channel/${channel.externalId}`
      : null,
  ]
    .map(creatorProfile)
    .filter(
      (value): value is string => value !== null && new URL(value).hostname === "www.youtube.com",
    );
}

function labelledSubscribers(value: unknown): number | null {
  const content =
    typeof value === "string"
      ? value
      : text(record(value).simpleText) ||
        (Array.isArray(record(value).runs)
          ? (record(value).runs as unknown[]).map((run) => text(record(run).text)).join("")
          : "");
  return observedCount(content.match(/^([\d,.]+\s*[kmb]?)\s+subscribers?$/i)?.[1]);
}

function publicJsonPayloads(html: string, limit = 40): unknown[] {
  const payloads: unknown[] = [];
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (payloads.length >= limit) break;
    const attr = attributes(script[1]);
    if (
      !["application/json", "application/ld+json"].includes(attr.type) &&
      !["SIGI_STATE", "__UNIVERSAL_DATA_FOR_REHYDRATION__"].includes(attr.id)
    )
      continue;
    try {
      payloads.push(JSON.parse(script[2]));
    } catch {
      /* Never execute provider JavaScript. */
    }
  }
  const state = assignedJson(html, "(?:window\\.)?__INITIAL_STATE__");
  if (Object.keys(state).length) payloads.push(state);
  return payloads;
}

function visitObjects(
  payload: unknown,
  visitor: (item: Record<string, unknown>) => void,
  limits = { depth: 14, objects: 2_000 },
) {
  let visited = 0;
  const visit = (value: unknown, depth = 0) => {
    if (depth > limits.depth || ++visited > limits.objects) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    const item = record(value);
    visitor(item);
    Object.values(item).forEach((child) => {
      if (child && typeof child === "object") visit(child, depth + 1);
    });
  };
  visit(payload);
}

function publicationDate(value: unknown, unixSeconds = false) {
  if (unixSeconds) {
    const seconds = observedCount(value);
    if (seconds === null || seconds < 946684800 || seconds > 32_503_680_000) return null;
    value = new Date(seconds * 1_000).toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return null;
  // Public captions often provide only a calendar day. Interpret that day in
  // UTC so its stored date does not shift with the Worker's or test host's zone.
  const day = value.trim();
  const timestamp = sourcePublicationTime(
    /^[A-Za-z]+ \d{1,2}, \d{4}$/.test(day) ? `${day} UTC` : day,
    Date.now(),
  );
  return timestamp !== null && timestamp >= 946684800000 ? new Date(timestamp).toISOString() : null;
}

function interactionStats(post: Record<string, unknown>): ContentSourceStats {
  const stats: ContentSourceStats = {};
  const counters = Array.isArray(post.interactionStatistic)
    ? post.interactionStatistic
    : [post.interactionStatistic];
  for (const value of counters) {
    const counter = record(value);
    const action =
      typeof counter.interactionType === "string"
        ? counter.interactionType
        : record(counter.interactionType)["@type"];
    const metric = /(?:Watch|View)Action$/.test(String(action))
      ? "views"
      : /LikeAction$/.test(String(action))
        ? "likes"
        : /CommentAction$/.test(String(action))
          ? "comments"
          : /ShareAction$/.test(String(action))
            ? "shares"
            : null;
    const count = observedCount(counter.userInteractionCount);
    if (metric && count !== null) stats[metric] = count;
  }
  const comments = observedCount(post.commentCount);
  if (comments !== null) stats.comments = comments;
  return stats;
}

/** Read a JSON assignment without executing provider JavaScript or matching unrelated counters. */
export function assignedJson(html: string, name: string): Record<string, unknown> {
  const match = new RegExp(`(?:var\\s+)?${name}\\s*=\\s*`).exec(html);
  if (!match) return {};
  const start = match.index + match[0].length;
  if (html[start] !== "{") return {};
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < html.length; index++) {
    const character = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) {
      try {
        return record(JSON.parse(html.slice(start, index + 1)));
      } catch {
        return {};
      }
    }
  }
  return {};
}

function providerEvidence(
  html: string,
  sourceUrl: string,
  expectedAuthorUrl?: string | null,
): Pick<Metadata, "publishedAt" | "stats" | "authorUrl" | "author"> {
  const url = new URL(sourceUrl);
  const host = url.hostname.replace(/^www\./, "");
  const stats: ContentSourceStats = {};
  let publishedAt: string | null = null;
  let authorUrl: string | null = null;
  let author: string | undefined;
  const set = (metric: keyof ContentSourceStats, value: unknown) => {
    const count = observedCount(value);
    if (count !== null) stats[metric] = count;
  };
  const expectedOwner =
    expectedAuthorUrl ||
    (["x.com", "twitter.com", "tiktok.com"].includes(host) ? sourceCreator(sourceUrl)?.url : null);
  const ownerMatches = (candidate: unknown) =>
    !expectedOwner ||
    (creatorProfile(candidate) !== null &&
      creatorProfile(candidate) === creatorProfile(expectedOwner));
  if (["youtube.com", "m.youtube.com", "youtu.be"].includes(host)) {
    const payload = assignedJson(html, "ytInitialPlayerResponse");
    const details = record(payload.videoDetails);
    // Related videos and channel totals must never become this video's evidence.
    if (details.videoId === youtubeVideoIdFromUrl(sourceUrl)) {
      const microformat = record(record(payload.microformat).playerMicroformatRenderer);
      publishedAt =
        publicationDate(microformat.publishDate) || publicationDate(microformat.uploadDate);
      set("views", details.viewCount);
    }
  }
  if (["tiktok.com", "instagram.com"].includes(host)) {
    const id =
      host === "tiktok.com"
        ? url.pathname.match(/\/video\/(\d+)/)?.[1]
        : url.pathname.match(/\/(?:p|reels?)\/([\w-]+)/)?.[1];
    for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const attr = attributes(script[1]);
      if (
        attr.type !== "application/json" &&
        !["SIGI_STATE", "__UNIVERSAL_DATA_FOR_REHYDRATION__"].includes(attr.id)
      )
        continue;
      try {
        let visited = 0;
        const visit = (value: unknown, depth = 0) => {
          if (depth > 14 || ++visited > 2_000) return;
          if (Array.isArray(value)) {
            value.forEach((item) => visit(item, depth + 1));
            return;
          }
          const item = record(value);
          if (id && host === "tiktok.com" && item.id === id) {
            const counts = record(item.stats);
            publishedAt ||= publicationDate(item.createTime, true);
            set("views", counts.playCount);
            set("likes", counts.diggCount);
            set("comments", counts.commentCount);
            set("shares", counts.shareCount);
            set("saves", counts.collectCount);
            const owner = record(item.author);
            if (owner.uniqueId) {
              authorUrl = creatorProfile(`https://www.tiktok.com/@${owner.uniqueId}`);
              author = text(owner.nickname) || `@${owner.uniqueId}`;
            }
            if (authorUrl && ownerMatches(authorUrl))
              set("followers", record(item.authorStats).followerCount);
          }
          if (id && host === "instagram.com" && (item.shortcode === id || item.code === id)) {
            publishedAt ||= publicationDate(item.taken_at_timestamp ?? item.taken_at, true);
            const owner = record(item.owner || item.user);
            if (item.is_private === true || owner.is_private === true) return;
            if (item.like_and_view_counts_disabled !== true) {
              set(
                "views",
                item.video_play_count ??
                  item.play_count ??
                  item.video_view_count ??
                  item.view_count,
              );
              set("likes", record(item.edge_media_preview_like).count ?? item.like_count);
            }
            set("comments", record(item.edge_media_to_comment).count ?? item.comment_count);
            if (owner.username) {
              authorUrl = creatorProfile(`https://www.instagram.com/${owner.username}/`);
              author = text(owner.full_name) || `@${owner.username}`;
            }
            if (authorUrl && ownerMatches(authorUrl))
              set("followers", record(owner.edge_followed_by).count ?? owner.follower_count);
          }
          Object.values(item).forEach((child) => {
            if (child && typeof child === "object") visit(child, depth + 1);
          });
        };
        visit(JSON.parse(script[2]));
      } catch {
        /* Only parse public JSON, never provider JavaScript. */
      }
    }
  }
  if (host === "reddit.com") {
    const id = url.pathname.match(/\/comments\/([a-z0-9]+)(?:\/|$)/i)?.[1];
    for (const tag of html.match(/<shreddit-post\b[^>]*>/gi) || []) {
      const attr = attributes(tag);
      if (!id || ![attr.id, attr["post-id"]].includes(`t3_${id}`)) continue;
      publishedAt ||= publicationDate(attr["created-timestamp"]);
      set("likes", attr.score);
      set("comments", attr["comment-count"]);
      break;
    }
  }
  if (["x.com", "twitter.com"].includes(host)) {
    const id = url.pathname.match(/\/status\/(\d+)/)?.[1];
    for (const payload of publicJsonPayloads(html))
      visitObjects(payload, (item) => {
        const legacy = record(item.legacy);
        if (!id || (item.rest_id !== id && legacy.id_str !== id && item.id_str !== id)) return;
        const post = Object.keys(legacy).length ? legacy : item;
        publishedAt ||= publicationDate(post.created_at);
        set("likes", post.favorite_count);
        set("comments", post.reply_count);
        set("shares", post.retweet_count);
        set("views", record(item.views).count ?? post.view_count);
        const candidate = record(record(record(item.core).user_results).result || item.user);
        const owner =
          candidate.__typename === "UserWithVisibilityResults"
            ? record(candidate.user || candidate.result)
            : candidate;
        const account = owner.legacy ? record(owner.legacy) : owner;
        const screenName = account.screen_name || record(owner.core).screen_name;
        if (screenName) {
          authorUrl = creatorProfile(`https://www.x.com/${screenName}`);
          author = text(account.name || record(owner.core).name) || `@${screenName}`;
        }
        if (authorUrl && ownerMatches(authorUrl)) set("followers", account.followers_count);
      });
  }
  return { publishedAt, stats, authorUrl, author };
}

export function publicPostMetadata(
  html: string,
  sourceUrl: string,
  expectedAuthorUrl?: string | null,
): Metadata {
  // Callers also use this parser directly; keep its work bounded for public HTML.
  if (html.length > MAX_METADATA_BYTES || !publicSourceUrl(sourceUrl)) return {};
  const meta = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attr = attributes(tag);
    const key = attr.property || attr.name || attr.itemprop;
    if (key && attr.content && !meta.has(key.toLowerCase()))
      meta.set(key.toLowerCase(), attr.content);
  }
  const get = (...keys: string[]) => keys.map((key) => meta.get(key)).find(Boolean) || "";
  const title = get("og:title", "twitter:title");
  // A sign-in/error page is not metadata for the requested post.
  if (/^(log in|login|sign in|page not found|access denied|just a moment|Instagram$)/i.test(title))
    return {};
  const schema: Record<string, unknown>[] = [];
  for (const match of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const visit = (value: unknown, depth = 0) => {
        if (depth > 3 || schema.length >= 50) return;
        if (Array.isArray(value)) {
          value.forEach((item) => visit(item, depth + 1));
          return;
        }
        const item = record(value);
        if (!Object.keys(item).length) return;
        schema.push(item);
        if (item["@graph"]) visit(item["@graph"], depth + 1);
        if (item.mainEntity) visit(item.mainEntity, depth + 1);
      };
      visit(JSON.parse(match[1]));
    } catch {
      /* Malformed structured data must not discard usable Open Graph metadata. */
    }
  }
  const post =
    schema.find((item) => /Article|Posting|VideoObject/.test(String(item["@type"]))) ||
    schema.find((item) => /ImageObject/.test(String(item["@type"]))) ||
    {};
  const attribution = post.author || post.creator;
  const declaredAuthor = record(Array.isArray(attribution) ? attribution[0] : attribution);
  const author = declaredAuthor["@id"]
    ? schema.find((item) => item["@id"] === declaredAuthor["@id"] && item !== declaredAuthor) ||
      declaredAuthor
    : declaredAuthor;
  const byline = text(author.name) || get("author", "twitter:creator");
  const description =
    text(post.articleBody) ||
    text(post.description) ||
    get("og:description", "twitter:description", "description");
  const thumbnail =
    objectUrl(post.thumbnailUrl) ||
    objectUrl(post.image) ||
    publicSourceUrl(get("og:image", "twitter:image"));
  const video =
    (String(post["@type"]).includes("VideoObject") ? publicSourceUrl(post.contentUrl) : null) ||
    (/^video\//.test(get("og:video:type"))
      ? publicSourceUrl(get("og:video:secure_url", "og:video"))
      : null);
  const media: ContentSourceMedia[] = [];
  if (
    video &&
    (String(post["@type"]).includes("VideoObject") || /^video\//.test(get("og:video:type")))
  )
    media.push({ type: "video", url: video, thumbnailUrl: thumbnail });
  const images = Array.isArray(post.image) ? post.image : post.image ? [post.image] : [];
  for (const image of images) {
    const url = objectUrl(image);
    if (url && !media.some((item) => item.url === url)) media.push({ type: "image", url });
  }
  if (!media.length && thumbnail) media.push({ type: "image", url: thumbnail });
  const provider = providerEvidence(html, sourceUrl, expectedAuthorUrl);
  const publishedAt =
    provider.publishedAt ||
    publicationDate(post.datePublished) ||
    publicationDate(post.uploadDate) ||
    publicationDate(
      get("article:published_time", "og:published_time", "datepublished", "uploaddate"),
    );
  const stats = { ...interactionStats(post), ...provider.stats };
  const authorProfile = creatorProfile(author.url);
  const expectedProfile = creatorProfile(expectedAuthorUrl);
  if (!expectedAuthorUrl || (authorProfile && authorProfile === expectedProfile)) {
    const followers = creatorFollowers(author);
    if (followers !== null && stats.followers === undefined) stats.followers = followers;
  }
  const videoViews = observedCount(
    get("og:video:views", "video:views", "ya:ovs:views_total", "interactioncount"),
  );
  if (
    (String(post["@type"]).includes("VideoObject") || youtubeVideoIdFromUrl(sourceUrl)) &&
    videoViews !== null &&
    stats.views === undefined
  )
    stats.views = videoViews;
  const fallbackCreator = sourceCreator(sourceUrl);
  const result: Metadata = {
    title: text(post.headline || post.name) || title,
    summary: description,
    author: provider.author || byline || fallbackCreator?.name,
    authorUrl:
      provider.authorUrl ||
      objectUrl(author.url) ||
      publicSourceUrl(get("article:author")) ||
      fallbackCreator?.url,
    authorAvatarUrl: objectUrl(author.image),
    thumbnailUrl: thumbnail,
    media,
    mediaType:
      video || /\/(reels?|shorts|video)\//.test(new URL(sourceUrl).pathname)
        ? "video"
        : media.length > 1
          ? "carousel"
          : thumbnail
            ? "image"
            : "text",
    publishedAt,
  };
  if (new URL(sourceUrl).hostname.replace(/^www\./, "") === "instagram.com") {
    const name = title.match(/^(.+?) on Instagram:/)?.[1];
    const handle = description.match(/ - ([\w.]+) on [^:]+:/)?.[1];
    if (name && !provider.author) result.author = name;
    if (handle && !provider.authorUrl) result.authorUrl = `https://www.instagram.com/${handle}/`;
    const descriptionDate = description.match(/ - [\w.]+ on ([^:]+):/)?.[1];
    result.publishedAt ||= publicationDate(descriptionDate);
    // These are observed counts from Instagram's own preview, not inferred popularity.
    const previewCounts = descriptionDate ? description.split(/ - [\w.]+ on /)[0] : "";
    for (const match of previewCounts.matchAll(
      /\b([\d,]+(?:\.\d+)?\s*[kmb]?)\s+(likes?|comments?|views?)\b/gi,
    )) {
      const count = observedCount(match[1]);
      const metric = /^like/i.test(match[2])
        ? "likes"
        : /^comment/i.test(match[2])
          ? "comments"
          : "views";
      if (count !== null && stats[metric] === undefined) stats[metric] = count;
    }
    const caption = description.match(/: "([\s\S]+)"\.?\s*$/)?.[1];
    if (caption) {
      result.summary = caption;
      result.title =
        caption
          .split("\n")
          .find((line) => line.trim())
          ?.slice(0, 300) || title;
    }
    // Instagram's public embed identifies the owner beside their actual profile image.
    // Collaboration embeds list several owners. Match the requested profile (or
    // Instagram's original-owner link) instead of assigning the first co-author's photo.
    const owners: Array<{ handle: string; profile: string; picture: string }> = [];
    let ownerHint: string | null = null;
    for (const anchor of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const attr = attributes(anchor[1]);
      const classes = (attr.class || "").split(/\s+/);
      if (!classes.includes("Avatar") && !classes.includes("CollabAvatar")) continue;
      ownerHint ||= new URLSearchParams((attr["data-ios-link"] || "").split("?")[1] || "").get(
        "username",
      );
      const profile = publicSourceUrl(attr.href);
      const imageTag = anchor[2].match(/<img\b[^>]*>/i)?.[0];
      const picture = imageTag && publicSourceUrl(attributes(imageTag).src);
      if (!profile || !picture) continue;
      const parsed = new URL(profile);
      const handle = parsed.pathname.match(/^\/(?:stories\/)?([\w.]+)\/?$/)?.[1];
      if (!/^(www\.)?instagram\.com$/.test(parsed.hostname) || !handle) continue;
      parsed.pathname = `/${handle}/`;
      parsed.search = "";
      parsed.hash = "";
      owners.push({ handle, profile: parsed.toString(), picture });
    }
    const knownProfile = publicSourceUrl(expectedAuthorUrl || result.authorUrl);
    const expectedHandle = knownProfile
      ? new URL(knownProfile).pathname.match(/^\/([\w.]+)\/?$/)?.[1]
      : null;
    const preferred = expectedHandle || ownerHint;
    const owner = preferred
      ? owners.find((candidate) => candidate.handle.toLowerCase() === preferred.toLowerCase())
      : owners.length === 1
        ? owners[0]
        : undefined;
    if (owner) {
      result.authorUrl = owner.profile;
      result.authorAvatarUrl = owner.picture;
      result.author ||= `@${owner.handle}`;
    }
  }
  if (new URL(sourceUrl).hostname.replace(/^www\./, "") === "facebook.com") {
    const name = title.split(" | ").at(-1)?.trim();
    if (name && name !== title && name.length < 160) result.author = name;
    const caption = (name && name !== title ? title.slice(0, title.lastIndexOf(" | ")) : title)
      .replace(/^\d+[\d,.KMB]* reactions? \| /i, "")
      .trim();
    if (caption) {
      result.summary = caption;
      result.title =
        caption
          .split("\n")
          .find((line) => line.trim())
          ?.slice(0, 300) || title;
    }
  }
  if (String(post["@type"]).includes("Article")) result.mediaType = "article";
  if (Object.keys(stats).length) result.stats = stats;
  return result;
}

/** Public profile evidence is scoped to the requested account, not recommendations on its page. */
export function publicCreatorMetadata(html: string, profileUrl: string): Metadata {
  const profile = creatorProfile(profileUrl);
  if (!profile || html.length > MAX_METADATA_BYTES) return {};
  const url = new URL(profile);
  const host = url.hostname.replace(/^www\./, "");
  const handle = url.pathname.split("/").at(-1)?.replace(/^@/, "").toLowerCase();
  const meta = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attr = attributes(tag);
    const key = attr.property || attr.name;
    if (key && attr.content && !meta.has(key.toLowerCase()))
      meta.set(key.toLowerCase(), attr.content);
  }
  const title = meta.get("og:title") || meta.get("twitter:title") || "";
  if (/^(log in|login|sign in|page not found|access denied|just a moment|Instagram$)/i.test(title))
    return {};
  if (host === "instagram.com" && / on Instagram:/i.test(title)) return {};
  const canonical = meta.get("og:url");
  const youtube = host === "youtube.com" ? assignedJson(html, "ytInitialData") : {};
  const channelAliases = youtubeProfileAliases(youtube);
  const matchingYouTubeChannel = channelAliases.includes(profile);
  if (channelAliases.length && !matchingYouTubeChannel) return {};
  // A redirect or authentication response must never provide another account's evidence.
  if (
    canonical &&
    creatorProfile(canonical) !== profile &&
    !(matchingYouTubeChannel && channelAliases.includes(creatorProfile(canonical) || ""))
  )
    return {};
  let followers: number | null = null;
  const accept = (value: unknown) => {
    const count = observedCount(value);
    if (count !== null && followers === null) followers = count;
  };
  const matches = (value: unknown) => creatorProfile(value) === profile;
  for (const payload of publicJsonPayloads(html))
    visitObjects(payload, (item) => {
      const sameAs = Array.isArray(item.sameAs) ? item.sameAs : [item.sameAs];
      if (
        /Person|Organization|ProfilePage/.test(String(item["@type"])) &&
        (matches(item.url) || sameAs.some(matches))
      )
        accept(creatorFollowers(item));
      if (host === "instagram.com" && String(item.username || "").toLowerCase() === handle)
        accept(record(item.edge_followed_by).count ?? item.follower_count);
      if (host === "tiktok.com") {
        const user = record(item.user);
        if (String(user.uniqueId || "").toLowerCase() === handle)
          accept(record(item.stats).followerCount);
        if (String(item.uniqueId || "").toLowerCase() === handle)
          accept(record(item.authorStats).followerCount);
        for (const [key, candidate] of Object.entries(record(item.users))) {
          if (String(record(candidate).uniqueId || "").toLowerCase() === handle)
            accept(record(record(item.stats)[key]).followerCount);
        }
      }
      if (host === "x.com") {
        const legacy = item.legacy ? record(item.legacy) : item;
        const screenName = legacy.screen_name || record(item.core).screen_name;
        if (String(screenName || "").toLowerCase() === handle) accept(legacy.followers_count);
      }
    });
  if (matchingYouTubeChannel) {
    const header = record(youtube.header);
    accept(labelledSubscribers(record(header.c4TabbedHeaderRenderer).subscriberCountText));
    const viewModel = record(record(record(header.pageHeaderRenderer).content).pageHeaderViewModel);
    const rows = record(record(viewModel.metadata).contentMetadataViewModel).metadataRows;
    for (const row of Array.isArray(rows) ? rows : []) {
      const parts = record(row).metadataParts;
      for (const part of Array.isArray(parts) ? parts : [])
        accept(labelledSubscribers(record(record(part).text).content));
    }
  }
  // Instagram and LinkedIn include an explicitly labelled owner audience in profile previews.
  const description = meta.get("og:description") || meta.get("description") || "";
  if (followers === null && canonical && ["instagram.com", "linkedin.com"].includes(host)) {
    const count =
      host === "instagram.com"
        ? description.match(/^([\d,.]+\s*[kmb]?)\s+followers\s*,/i)?.[1]
        : description.match(/^[^|]*\|\s*([\d,.]+\s*[kmb]?)\s+followers\s+on\s+LinkedIn\b/i)?.[1];
    accept(count);
  }
  const thumbnailUrl = publicSourceUrl(meta.get("og:image") || meta.get("twitter:image"));
  return {
    authorUrl: profile,
    authorAvatarUrl: thumbnailUrl,
    ...(followers !== null ? { stats: { followers } } : {}),
  };
}

export function publicPostCountEvidence(
  html: string,
  sourceUrl: string,
): Partial<Record<PublicPostMetric, number>> {
  if (html.length > 4 * 1024 * 1024 || !publicSourceUrl(sourceUrl)) return {};
  const expected = discoverPostKey({ sourceUrl });
  const matches = (value: unknown) =>
    typeof value === "string" &&
    publicSourceUrl(value) &&
    discoverPostKey({ sourceUrl: value }) === expected;
  const counts: Partial<Record<PublicPostMetric, number>> = {};
  const payloads = publicJsonPayloads(html, 160);
  const visitStats = (payload: unknown, visitor: (item: Record<string, unknown>) => void) =>
    visitObjects(payload, visitor, { depth: 24, objects: 6_000 });
  for (const payload of payloads)
    visitStats(payload, (item) => {
      if (!/Article|Posting|VideoObject|ImageObject/.test(String(item["@type"]))) return;
      if (![item.url, item["@id"], objectUrl(item.mainEntityOfPage)].some(matches)) return;
      const stats = interactionStats(item);
      for (const key of ["views", "likes", "comments", "shares"] as const) {
        const value = stats[key];
        if (typeof value === "number") counts[key] = value;
      }
    });
  const provider = providerEvidence(html, sourceUrl).stats;
  for (const key of ["views", "likes", "comments", "shares", "saves"] as const) {
    const value = provider?.[key];
    if (typeof value === "number") counts[key] = value;
  }
  const host = new URL(sourceUrl).hostname.replace(/^www\./, "");
  let instagramPrivate = false;
  let instagramLikesHidden = false;
  let instagramSharesHidden = false;
  if (["threads.com", "threads.net", "facebook.com"].includes(host)) {
    const url = new URL(sourceUrl);
    const id =
      host === "facebook.com"
        ? url.pathname.match(/\/(?:posts|videos|reel)\/([^/]+)/)?.[1] ||
          url.searchParams.get("v") ||
          url.searchParams.get("story_fbid")
        : url.pathname.match(/\/post\/([^/]+)/)?.[1];
    for (const payload of payloads)
      visitStats(payload, (item) => {
        const attachments = Array.isArray(item.attachments) ? item.attachments.slice(0, 4) : [];
        const attachedVideo =
          host === "facebook.com" &&
          (record(item.video).id === id ||
            attachments.some((attachment) => record(record(attachment).media).id === id));
        if (
          !id ||
          (![item.code, item.shortcode, item.post_id, item.legacy_fbid, item.id].includes(id) &&
            !attachedVideo)
        )
          return;
        const info = record(item.text_post_app_info),
          feedback = record(item.feedback);
        const reelFeedback = record(record(record(item.fb_reel_react_button).story).feedback);
        const fields = {
          views: item.view_count ?? item.video_view_count ?? item.threads_view_count,
          likes:
            item.like_count ??
            record(feedback.reaction_count).count ??
            record(feedback.unified_reactors).count ??
            record(reelFeedback.unified_reactors).count ??
            record(reelFeedback.likers).count,
          comments:
            info.direct_reply_count ??
            item.reply_count ??
            item.comment_count ??
            record(feedback.comment_count).count ??
            feedback.total_comment_count,
          reposts: info.repost_count ?? item.repost_count,
          quotes: info.quote_count ?? item.quote_count,
          shares:
            item.share_count ?? record(feedback.share_count).count ?? feedback.share_count_reduced,
        };
        for (const [key, value] of Object.entries(fields)) {
          const n = observedCount(value);
          if (n !== null) counts[key as PublicPostMetric] = n;
        }
      });
  }
  if (host === "instagram.com") {
    const id = new URL(sourceUrl).pathname.match(/\/(?:p|reels?)\/([\w-]+)/)?.[1];
    for (const payload of payloads)
      visitStats(payload, (item) => {
        if (!id || (item.shortcode !== id && item.code !== id)) return;
        instagramPrivate ||=
          item.is_private === true || record(item.user || item.owner).is_private === true;
        instagramLikesHidden ||= item.like_and_view_counts_disabled === true;
        instagramSharesHidden ||= item.share_count_disabled === true;
        for (const [key, value] of Object.entries({
          views:
            item.video_play_count ?? item.play_count ?? item.video_view_count ?? item.view_count,
          likes:
            record(item.edge_media_preview_like).count ??
            record(item.edge_liked_by).count ??
            item.like_count,
          comments: record(item.edge_media_to_comment).count ?? item.comment_count,
        })) {
          const n = observedCount(value);
          if (n !== null) counts[key as PublicPostMetric] = n;
        }
        const shares = observedCount(item.reshare_count ?? item.share_count);
        const saves = observedCount(item.save_count);
        const reposts = observedCount(item.media_repost_count ?? item.repost_count);
        if (shares !== null) counts.shares = shares;
        if (saves !== null) counts.saves = saves;
        if (reposts !== null) counts.reposts = reposts;
      });
  }
  if (["threads.com", "threads.net"].includes(host)) {
    // Threads' logged-out permalink shell publishes its visible view total in
    // a route-specific module, separate from the post's engagement object.
    const tags = [...html.matchAll(/<(?:meta|link)\b([^>]+)>/gi)].map((m) => attributes(m[1]));
    const canonical =
      tags.find((a) => a.property === "og:url")?.content ||
      tags.find((a) => a.rel === "canonical")?.href;
    const shortcode = new URL(sourceUrl).pathname.match(/\/post\/([^/]+)/)?.[1];
    if (shortcode && matches(canonical))
      for (const payload of payloads)
        visitStats(payload, (item) => {
          if (!Array.isArray(item.define) || !Array.isArray(item.require)) return;
          let matchingRoute = false;
          visitObjects(item.require, (child) => {
            if (record(record(record(child.initialRouteInfo).route).params).shortcode === shortcode)
              matchingRoute = true;
          });
          if (!matchingRoute) return;
          for (const module of item.define) {
            if (!Array.isArray(module) || module[0] !== "BarcelonaLoggedOutExpansionGating")
              continue;
            const views = observedCount(record(module[2]).view_counts);
            if (views !== null) counts.views ??= views;
          }
        });
  }
  if (["youtube.com", "m.youtube.com", "youtu.be"].includes(host)) {
    const data = assignedJson(html, "ytInitialData");
    const id = youtubeVideoIdFromUrl(sourceUrl);
    if (id && record(record(data.currentVideoEndpoint).watchEndpoint).videoId === id) {
      const main = record(record(record(data.contents).twoColumnWatchNextResults).results).results;
      const contents = record(main).contents;
      for (const entry of Array.isArray(contents) ? contents : []) {
        const primary = record(record(entry).videoPrimaryInfoRenderer);
        const buttons = record(record(primary.videoActions).menuRenderer).topLevelButtons;
        for (const button of Array.isArray(buttons) ? buttons : []) {
          const segmented = record(record(button).segmentedLikeDislikeButtonViewModel);
          const entity = record(segmented.likeCountEntity);
          const likes = observedCount(
            entity.likeCountIfIndifferentNumber ??
              record(entity.expandedLikeCountIfIndifferent).content,
          );
          if (likes !== null) counts.likes = likes;
        }
        const header = record(
          record(record(entry).itemSectionRenderer).header,
        ).commentsHeaderRenderer;
        const runs = record(record(header).countText).runs;
        const label = Array.isArray(runs)
          ? runs.map((run) => text(record(run).text)).join(" ")
          : "";
        const comments = observedCount(label.match(/^([\d,]+)\s+Comments?$/i)?.[1]);
        if (comments !== null) counts.comments = comments;
      }
    }
  }
  if (["x.com", "twitter.com", "linkedin.com"].includes(host)) {
    if (counts.shares !== undefined) {
      counts.reposts = counts.shares;
      delete counts.shares;
    }
  }
  if (["x.com", "twitter.com"].includes(host)) {
    const id = new URL(sourceUrl).pathname.match(/\/status\/(\d+)/)?.[1];
    for (const payload of payloads)
      visitStats(payload, (item) => {
        const legacy = record(item.legacy);
        if (!id || (item.rest_id !== id && legacy.id_str !== id && item.id_str !== id)) return;
        const quotes = observedCount((Object.keys(legacy).length ? legacy : item).quote_count);
        if (quotes !== null) counts.quotes = quotes;
      });
  }
  if (host === "reddit.com" && counts.likes !== undefined) {
    counts.score = counts.likes;
    delete counts.likes;
  }
  if (host === "reddit.com") {
    const id = new URL(sourceUrl).pathname.match(/\/comments\/([a-z0-9]+)/i)?.[1];
    for (const tag of html.match(/<shreddit-post\b[^>]*>/gi) || []) {
      const attr = attributes(tag);
      if (!id || ![attr.id, attr["post-id"]].includes(`t3_${id}`)) continue;
      const score = /^-?\d+$/.test(attr.score || "") ? Number(attr.score) : NaN;
      if (Number.isSafeInteger(score)) counts.score = score;
    }
  }
  // Instagram's own description is useful only when its canonical post identity matches.
  if (host === "instagram.com") {
    const tags = [...html.matchAll(/<(?:meta|link)\b([^>]+)>/gi)].map((m) => attributes(m[1]));
    const canonical =
      tags.find((a) => a.property === "og:url")?.content ||
      tags.find((a) => a.rel === "canonical")?.href;
    if (matches(canonical)) {
      const preview = publicPostMetadata(html, sourceUrl).stats;
      for (const key of ["views", "likes", "comments"] as const)
        if (counts[key] === undefined && typeof preview?.[key] === "number")
          counts[key] = preview[key];
    }
  }
  if (host === "instagram.com") {
    if (instagramPrivate) return {};
    if (instagramLikesHidden) {
      delete counts.likes;
      delete counts.views;
    }
    if (instagramSharesHidden) delete counts.shares;
  }
  return counts;
}
