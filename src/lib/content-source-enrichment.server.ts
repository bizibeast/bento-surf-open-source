import { readResponseText, RequestBodyTooLargeError } from "./request-security.server";
import {
  ContentRetrievalError,
  retryContentRequest,
  retryableContentStatus,
} from "./content-retrieval.server";
import { sourcePublicationTime } from "./content-source-recency";
import { youtubeVideoIdFromUrl } from "./social-embeds";
import {
  publicSourceUrl,
  sourceCreator,
  sourcePostEmbed,
  sourcePresentation,
  sourceThumbnail,
  type ContentSourceMedia,
  type ContentSourcePresentation,
} from "./content-source-media";
import type { ContentSourceItem, ContentSourceStats } from "./content-sources.server";

const MAX_METADATA_BYTES = 1_500_000;
const PUBLIC_UA = "Mozilla/5.0 (compatible; BentoSurfBot/1.0; +http://localhost:8080)";
type Metadata = ContentSourcePresentation & {
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
function text(value: unknown) {
  return typeof value === "string" ? decode(value).trim().slice(0, 10_000) : "";
}
function record(value: unknown): Record<string, unknown> {
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

function observedCount(value: unknown): number | null {
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
function creatorProfile(value: unknown): string | null {
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

function youtubeProfileAliases(payload: Record<string, unknown>): string[] {
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

function publicJsonPayloads(html: string): unknown[] {
  const payloads: unknown[] = [];
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (payloads.length >= 40) break;
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

function visitObjects(payload: unknown, visitor: (item: Record<string, unknown>) => void) {
  let visited = 0;
  const visit = (value: unknown, depth = 0) => {
    if (depth > 14 || ++visited > 2_000) return;
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
  const timestamp = sourcePublicationTime(value, Date.now());
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
function assignedJson(html: string, name: string): Record<string, unknown> {
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
            set("views", item.video_view_count ?? item.play_count);
            set("likes", record(item.edge_media_preview_like).count ?? item.like_count);
            set("comments", record(item.edge_media_to_comment).count ?? item.comment_count);
            const owner = record(item.owner || item.user);
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
  if (["x.com", "twitter.com"].includes(host)) {
    const id = url.pathname.match(/\/status\/(\d+)/)?.[1];
    for (const payload of publicJsonPayloads(html))
      visitObjects(payload, (item) => {
        const legacy = record(item.legacy);
        if (!id || (item.rest_id !== id && legacy.id_str !== id && item.id_str !== id)) return;
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
    const needEvidence =
      !sourcePublicationTime(item.publishedAt, Date.now()) ||
      ((!hasStats(item) || needsFollowers(item)) &&
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
