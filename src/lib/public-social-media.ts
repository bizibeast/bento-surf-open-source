import { MEDIA_DOWNLOAD_MAX_ITEMS } from "./media-tools";
import {
  openPublicMedia,
  publicAssetUrl,
  publicMp4Duration,
  PublicSocialError,
  PublicSocialFetch,
  PUBLIC_SOCIAL_ATTEMPT_MS,
  type PublicAssetKind,
  type PublicMediaType,
} from "./public-social-fetch";
import {
  linkedInPostHost,
  pinterestPinId,
  pinterestShortUrl,
  publicSocialHttpsUrl,
  type PublicSocialPlatform,
} from "./public-social-url";

const MAX_SOURCE_CANDIDATES = 100;
const MAX_PUBLIC_REQUESTS = 44;
const PUBLIC_RESOLUTION_MS = 24_000;
const MAX_VIDEO_SECONDS = 24 * 60 * 60;
const REQUESTS_RESERVED_FOR_FALLBACK = 8;
const htmlType = "text/html";
const jsonType = "application/json";

type Candidate = { url: URL; durationSeconds?: number };
type Asset = { kind: PublicAssetKind; candidates: Candidate[] };
type ResolvedAsset = { source: URL; contentType: PublicMediaType };
type Source = { id: string; assets: Asset[]; completeDocument?: boolean; hasPlaylist?: boolean };
type UnknownObject = Record<string, unknown>;

function record(value: unknown): UnknownObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownObject)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, MAX_SOURCE_CANDIDATES) : [];
}

function entries(value: unknown) {
  return Object.entries(record(value)).slice(0, MAX_SOURCE_CANDIDATES);
}

function json(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function positive(value: unknown) {
  if (typeof value !== "number" && typeof value !== "string") return 0;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function uniqueUrls(urls: URL[]) {
  return [...new Map(urls.map((url) => [url.href, url])).values()];
}

function asset(kind: PublicAssetKind, ...urls: URL[]): Asset {
  return { kind, candidates: urls.map((url) => ({ url })) };
}

function rankedVideo(
  candidates: ReturnType<typeof videoCandidate>[],
  maxHeight: number,
  preferBitrate: boolean,
): Asset | null {
  const qualityBand = (resolution: number) =>
    !maxHeight || (resolution > 0 && resolution <= maxHeight) ? 0 : resolution ? 1 : 2;
  const sorted = candidates.sort((a, b) => {
    const band = qualityBand(a.resolution);
    const compatibility = Number(a.h265) - Number(b.h265);
    const byQualityBand = band - qualityBand(b.resolution);
    const byBitrate = b.bitrate - a.bitrate;
    const byResolution = (band === 1 ? -1 : 1) * (b.resolution - a.resolution);
    return (
      compatibility ||
      byQualityBand ||
      (band === 1 ? byResolution : 0) ||
      (preferBitrate ? byBitrate || byResolution : byResolution || byBitrate) ||
      b.preference - a.preference
    );
  });
  const ranked = new Map<string, Candidate>();
  for (const { url, durationSeconds } of sorted) {
    if (!ranked.has(url.href)) ranked.set(url.href, { url, durationSeconds });
    if (ranked.size === 4) break;
  }
  return ranked.size ? { kind: "video", candidates: [...ranked.values()] } : null;
}

function videoCandidate(
  url: URL,
  bitrate: unknown,
  height: unknown,
  codec?: unknown,
  width?: unknown,
  preference = 0,
  durationSeconds = 0,
) {
  const size = /\/(\d{2,5})x(\d{2,5})\//iu.exec(url.pathname);
  const quality = /\/(?:mp4-)?(\d{2,5})p(?:\/|-|$)/iu.exec(url.pathname)?.[1];
  const dimensions = [
    positive(height) || positive(size?.[2]),
    positive(width) || positive(size?.[1]),
  ].filter(Boolean);
  return {
    url,
    bitrate: positive(bitrate),
    resolution: dimensions.length ? Math.min(...dimensions) : positive(quality),
    preference,
    durationSeconds,
    h265: /(?:h[._]?265|hevc|hvc1|hev1)/iu.test(
      `${url.pathname} ${typeof codec === "string" ? codec : ""}`,
    ),
  };
}

async function twitterSource(
  client: PublicSocialFetch,
  post: URL,
  maxHeight: number,
): Promise<Source> {
  const id = post.pathname.split("/").at(-1) ?? "";
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/[0.]/gu, "");
  const endpoint = new URL("https://cdn.syndication.twimg.com/tweet-result");
  endpoint.search = new URLSearchParams({ id, token, lang: "en" }).toString();
  const { body } = await client.text(endpoint, (url) => url.href === endpoint.href, jsonType);
  const payload = record(json(body));
  if (payload.__typename === "TweetTombstone" || payload.__typename === "TweetUnavailable") {
    throw new PublicSocialError("missing");
  }
  // The syndication response can identify the original post of a requested retweet.
  if (typeof payload.id_str !== "string" || !/^\d{1,24}$/u.test(payload.id_str)) {
    throw new PublicSocialError("unavailable");
  }

  const parent = list(payload.mediaDetails);
  const media = parent.length ? parent : list(record(payload.quoted_tweet).mediaDetails);
  const assets = media.flatMap((item) => {
    const detail = record(item);
    if (detail.type === "photo") {
      const photo = publicAssetUrl("twitter", "image", detail.media_url_https);
      if (!photo) return [];
      photo.searchParams.set("name", "orig");
      return [asset("image", photo)];
    }
    if (detail.type !== "video" && detail.type !== "animated_gif") return [];
    const info = record(detail.video_info);
    const variants = list(info.variants).flatMap((value) => {
      const variant = record(value);
      const url = publicAssetUrl("twitter", "video", variant.url);
      return url && variant.content_type === "video/mp4" && /\.mp4$/iu.test(url.pathname)
        ? [
            videoCandidate(
              url,
              variant.bitrate,
              variant.height,
              variant.codec,
              variant.width,
              0,
              positive(info.duration_millis) / 1000,
            ),
          ]
        : [];
    });
    const video = rankedVideo(variants, maxHeight, true);
    return video ? [video] : [];
  });
  if (!assets.length) throw new PublicSocialError("unsupported");
  return { id, assets };
}

function pinterestImageAlternates(url: URL) {
  const extensions = [".png", ".jpg", ".webp", ".gif"];
  const candidates = [url];
  if (/\.(?:jpe?g|png|webp|gif)$/iu.test(url.pathname)) {
    for (const extension of extensions) {
      const alternate = new URL(url);
      alternate.pathname = alternate.pathname.replace(/\.[^./]+$/u, extension);
      candidates.push(alternate);
    }
  }
  if (url.pathname.startsWith("/originals/")) {
    candidates.push(
      ...candidates.map((source) => {
        const alternate = new URL(source);
        alternate.pathname = alternate.pathname.replace(/^\/originals\//u, "/736x/");
        return alternate;
      }),
    );
  }
  return uniqueUrls(candidates).slice(0, 8);
}

function pinterestImage(values: unknown) {
  const images = entries(values).flatMap(([name, value]) => {
    const image = record(value);
    const url = publicAssetUrl("pinterest", "image", image.url);
    return url
      ? [{ url, original: name === "orig" || name === "originals", width: positive(image.width) }]
      : [];
  });
  const highest = images.sort(
    (a, b) => Number(b.original) - Number(a.original) || b.width - a.width,
  )[0];
  return highest ? asset("image", ...pinterestImageAlternates(highest.url)) : null;
}

function pinterestVideo(values: unknown, maxHeight: number) {
  const variants = entries(record(values).video_list);
  const trusted = variants.flatMap(([name, value]) => {
    const variant = record(value);
    const url = publicAssetUrl("pinterest", "video", variant.url);
    return url ? [{ name, variant, url }] : [];
  });
  const direct = trusted.flatMap(({ name, variant, url }) => {
    if (!/\.mp4$/iu.test(url.pathname)) return [];
    const label = positive(/^V_(\d+)P$/u.exec(name)?.[1]);
    const tier = positive(/^V_EXP(\d+)$/u.exec(name)?.[1]);
    return [
      videoCandidate(
        url,
        variant.bitrate,
        positive(variant.height) || label,
        variant.codec,
        variant.width,
        label ? 100 : tier,
        positive(variant.duration) / 1000,
      ),
    ];
  });
  const video = rankedVideo(direct, maxHeight, false);
  const hls = trusted.some(({ url }) => /\.m3u8$/iu.test(url.pathname));
  return { video, hls };
}

const namedEntities: Record<string, string> = {
  quot: '"',
  apos: "'",
  amp: "&",
  lt: "<",
  gt: ">",
};

function decodeHtml(value: string) {
  return value.replace(
    /&(#x[\da-f]{1,6}|#\d{1,7}|quot|apos|amp|lt|gt);/giu,
    (full, entity: string) => {
      const key = entity.toLowerCase();
      if (Object.hasOwn(namedEntities, key)) return namedEntities[key];
      const code = key.startsWith("#x") ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
    },
  );
}

function attribute(html: string, name: string) {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "iu");
  const match = pattern.exec(html);
  return match ? decodeHtml(match[1] ?? match[2]) : "";
}

function* pageVideoObjects(html: string) {
  const markup = html.replace(/<!--[\s\S]*?-->/gu, "");
  for (const [, attrs, raw] of markup.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)) {
    if (attribute(attrs, "type") !== "application/ld+json") continue;
    const schema = record(json(raw.trim()));
    if (schema["@type"] === "VideoObject") yield schema;
  }
}

function evidencedFailure(error: unknown) {
  return error instanceof PublicSocialError ? error : new PublicSocialError("unavailable");
}

function pinterestResourceAssets(pinData: UnknownObject, maxHeight: number) {
  const items: Asset[] = [];
  let hls = false;
  const addVideo = (value: unknown) => {
    const result = pinterestVideo(value, maxHeight);
    if (result.video) items.push(result.video);
    if (result.hls) hls = true;
    return Boolean(result.video || result.hls);
  };
  const addImage = (value: unknown) => {
    const image = pinterestImage(value);
    if (image) items.push(image);
  };
  addVideo(pinData.videos);
  for (const page of list(record(pinData.story_pin_data).pages)) {
    for (const block of list(record(page).blocks)) {
      const item = record(block);
      if (!addVideo(item.video)) addImage(record(item.image).images);
      if (items.length >= MEDIA_DOWNLOAD_MAX_ITEMS) break;
    }
    if (items.length >= MEDIA_DOWNLOAD_MAX_ITEMS) break;
  }
  for (const slot of list(record(pinData.carousel_data).carousel_slots)) {
    if (items.length >= MEDIA_DOWNLOAD_MAX_ITEMS) break;
    addImage(record(slot).images);
  }
  if (!items.length && !hls) addImage(pinData.images);
  return { assets: items, hasPlaylist: hls };
}

function pinterestPageAssets(
  html: string,
  id: string,
  maxHeight: number,
  resourceVideo: { direct: boolean; playlist: boolean },
) {
  if (/data-test-id=["']login-form|<title[^>]*>[^<]*(?:log in|sign in)/iu.test(html)) {
    throw new PublicSocialError("blocked");
  }
  const markup = html.replace(
    /<!--[\s\S]*?-->|<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu,
    "",
  );
  const head = /<head\b[^>]*>[\s\S]*?<\/head\s*>/iu.exec(markup);
  const identities: string[] = [];
  const videoUrls: string[] = [];
  let imageUrl = "";
  for (const match of markup.matchAll(/<(meta|link)\b[^>]*>/giu)) {
    const [tag, element] = match;
    if (element.toLowerCase() === "link") {
      if (attribute(tag, "rel").toLowerCase() === "canonical")
        identities.push(attribute(tag, "href"));
      continue;
    }
    const inHead = head && match.index >= head.index && match.index < head.index + head[0].length;
    // Pinterest's app can emit its page metadata in the body.
    if (!inHead && attribute(tag, "data-app") !== "true") continue;
    const property = attribute(tag, "property").toLowerCase();
    const content = attribute(tag, "content");
    if (property === "og:url") identities.push(content);
    if (["og:video", "og:video:url", "og:video:secure_url"].includes(property))
      videoUrls.push(content);
    if (property === "og:image" && !imageUrl) imageUrl = content;
  }
  // A canonical/OG ID ties page metadata to the requested pin.
  if (
    !identities.length ||
    identities.some((value) => {
      const url = publicSocialHttpsUrl(value);
      return !url || pinterestPinId(url) !== id;
    })
  )
    return { assets: [], hasPlaylist: resourceVideo.playlist };

  for (const schema of pageVideoObjects(html)) {
    if (videoUrls.length >= MAX_SOURCE_CANDIDATES) break;
    const pin = publicSocialHttpsUrl(schema["@id"]);
    if (pin && pinterestPinId(pin) === id && typeof schema.contentUrl === "string") {
      videoUrls.push(schema.contentUrl);
    }
  }
  const trustedVideos = videoUrls.slice(0, MAX_SOURCE_CANDIDATES).flatMap((value) => {
    const url = publicAssetUrl("pinterest", "video", value);
    return url ? [url] : [];
  });
  const direct = trustedVideos
    .filter(({ pathname }) => /\.mp4$/iu.test(pathname))
    .map((url) => videoCandidate(url, 0, 0));
  const video = rankedVideo(direct, maxHeight, false);
  const playlist =
    resourceVideo.playlist || trustedVideos.some(({ pathname }) => /\.m3u8$/iu.test(pathname));
  if (video) return { assets: [video], hasPlaylist: playlist };
  if (playlist || resourceVideo.direct) return { assets: [], hasPlaylist: playlist };
  const image = publicAssetUrl("pinterest", "image", imageUrl);
  return { assets: image ? [asset("image", ...pinterestImageAlternates(image))] : [] };
}

async function pinterestSources(client: PublicSocialFetch, post: URL, maxHeight: number) {
  const allowedPin = (url: URL) => Boolean(pinterestPinId(url)) && !url.hash;
  const pin = pinterestShortUrl(post)
    ? await client.redirectTarget(
        post,
        (url) =>
          pinterestShortUrl(url) ||
          allowedPin(url) ||
          (url.hostname === "api.pinterest.com" &&
            !url.hash &&
            /^\/url_shortener\/[\w-]{3,64}\/redirect\/$/u.test(url.pathname)),
        allowedPin,
      )
    : post;
  const id = pinterestPinId(pin);
  if (!id) throw new PublicSocialError("unavailable");

  const canonical = new URL(`https://www.pinterest.com/pin/${id}/`);
  const resource = new URL("https://www.pinterest.com/resource/PinResource/get/");
  resource.searchParams.set("data", JSON.stringify({ options: { id, field_set_key: "detailed" } }));
  let resourceVideo = { direct: false, playlist: false };
  return [
    async (): Promise<Source> => {
      const { body } = await client.text(resource, (url) => url.href === resource.href, jsonType, {
        "X-Pinterest-PWS-Handler": "www/pin/[id].js",
      });
      const pinData = record(record(record(json(body)).resource_response).data);
      if (Object.hasOwn(pinData, "id") && pinData.id !== id)
        throw new PublicSocialError("unavailable");
      const result = pinterestResourceAssets(pinData, maxHeight);
      resourceVideo = {
        direct: result.assets.some(({ kind }) => kind === "video"),
        playlist: result.hasPlaylist,
      };
      return { id, ...result };
    },
    async (): Promise<Source> => {
      const { body } = await client.text(
        canonical,
        (url) => pinterestPinId(url) === id && !url.hash,
        htmlType,
      );
      return { id, ...pinterestPageAssets(body, id, maxHeight, resourceVideo) };
    },
  ];
}

function linkedInDocumentUrl(value: unknown) {
  const url = publicAssetUrl("linkedin", "document", value);
  return url?.pathname.startsWith("/dms/document/") ? url : null;
}

async function linkedInDocument(client: PublicSocialFetch, config: UnknownObject) {
  const manifest = linkedInDocumentUrl(config.manifestUrl);
  if (!manifest) throw new PublicSocialError("file_unavailable");

  const allowed = (url: URL) => Boolean(linkedInDocumentUrl(url.href));
  let document: UnknownObject;
  try {
    const { body } = await client.text(manifest, allowed, jsonType);
    document = record(json(body));
  } catch {
    throw new PublicSocialError("file_unavailable");
  }
  const pdf = linkedInDocumentUrl(document.transcribedDocumentUrl);
  const assets = pdf ? [asset("document", pdf)] : [];
  const maximumPages = MEDIA_DOWNLOAD_MAX_ITEMS - assets.length;
  const expectedPages = positive(config.totalPageCount);
  if (expectedPages > maximumPages) return assets;
  const largest = list(document.perResolutions)
    .map(record)
    .flatMap((entry) => {
      const url = linkedInDocumentUrl(entry.imageManifestUrl);
      return url ? [{ url, width: positive(entry.width) }] : [];
    })
    .sort((a, b) => b.width - a.width)[0];
  if (!largest) return assets;

  try {
    const { body } = await client.text(largest.url, allowed, jsonType);
    const images = record(json(body));
    const pages = list(images.pages ?? images.imageUrls);
    if (pages.length > maximumPages || (expectedPages && expectedPages !== pages.length))
      return assets;
    const urls = pages.map((page) =>
      publicAssetUrl(
        "linkedin",
        "image",
        typeof page === "string" ? page : (record(page).url ?? record(page).imageUrl),
      ),
    );
    if (urls.some((url) => !url)) return assets;
    return [...assets, ...urls.flatMap((url) => (url ? [asset("image", url)] : []))];
  } catch {
    if (assets.length) return assets;
    throw new PublicSocialError("file_unavailable");
  }
}

function linkedInArticle(markup: string, id: string) {
  let start = -1;
  let depth = 0;
  for (const match of markup.matchAll(/<article\b[^>]*>|<\/article\s*>/giu)) {
    const tag = match[0];
    if (tag.startsWith("</")) {
      if (start >= 0 && --depth === 0) return markup.slice(start, match.index);
      continue;
    }
    if (start >= 0) {
      depth += 1;
      continue;
    }
    const urn = attribute(tag, "data-activity-urn");
    if (urn === `urn:li:activity:${id}`) {
      start = match.index + tag.length;
      depth = 1;
    }
  }
  return "";
}

function linkedInActivityId(url: URL) {
  if (!linkedInPostHost(url) || url.hash) return null;
  const path = url.pathname;
  return (
    /^\/posts\/[^/]*activity-(\d{15,24})(?:-[^/]*)?\/?$/u.exec(path)?.[1] ??
    /^\/(?:embed\/)?feed\/update\/urn:li:activity:(\d{15,24})\/?$/u.exec(path)?.[1] ??
    null
  );
}

function linkedInVideoKey(url: URL) {
  return /^\/(?:dms\/video|playlist\/vid)\/v2\/([^/]+)\//u.exec(url.pathname)?.[1] ?? url.href;
}

function linkedInDurations(html: string, id: string) {
  const durations = new Map<string, number>();
  for (const schema of pageVideoObjects(html)) {
    const identities = [schema["@id"], schema.embedUrl].filter((value) => value !== undefined);
    if (
      !identities.length ||
      identities.some((value) => {
        const url = publicSocialHttpsUrl(value);
        return !url || linkedInActivityId(url) !== id;
      })
    )
      continue;
    const media = publicAssetUrl("linkedin", "video", schema.contentUrl);
    if (!media || typeof schema.duration !== "string") continue;
    const duration = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/iu.exec(schema.duration);
    if (!duration) continue;
    const seconds =
      positive(duration[1]) * 3600 + positive(duration[2]) * 60 + positive(duration[3]);
    if (!seconds) continue;
    const key = linkedInVideoKey(media);
    durations.set(key, Math.max(seconds, durations.get(key) ?? 0));
  }
  return durations;
}

async function linkedInPage(
  client: PublicSocialFetch,
  article: string,
  html: string,
  id: string,
  maxHeight: number,
) {
  const variants = list(json(attribute(article, "data-sources"))).flatMap((value) => {
    const variant = record(value);
    const url = publicAssetUrl("linkedin", "video", variant.src);
    return url && typeof variant.type === "string" && /^video\/mp4(?:;|$)/iu.test(variant.type)
      ? [
          videoCandidate(
            url,
            variant["data-bitrate"] ?? variant.bitrate,
            variant.height,
            variant.type,
          ),
        ]
      : [];
  });
  if (variants.length) {
    const durations = linkedInDurations(html, id);
    for (const variant of variants) {
      variant.durationSeconds = durations.get(linkedInVideoKey(variant.url)) ?? 0;
    }
    const video = rankedVideo(variants, maxHeight, true);
    if (video) return { assets: [video] };
  }

  const docConfig = attribute(article, "data-native-document-config");
  if (docConfig) {
    const assets = await linkedInDocument(client, record(record(json(docConfig)).doc));
    if (!assets.length) throw new PublicSocialError("file_unavailable");
    return { assets, completeDocument: true };
  }

  const photos = new Map<string, { url: URL; size: number }>();
  const decoded = decodeHtml(article);
  for (const [value] of decoded.matchAll(
    /https:\/\/media\.licdn\.com\/dms\/image\/[^"'\s<>,]+/gu,
  )) {
    const url = publicAssetUrl("linkedin", "image", value);
    const id = /\/image\/(?:v2\/)?([^/]+)\//u.exec(url?.pathname ?? "")?.[1];
    const size = positive(/\/feedshare-shrink_(\d+)/u.exec(url?.pathname ?? "")?.[1]);
    if (!url || !id || !size) continue;
    if (photos.size < MAX_SOURCE_CANDIDATES || photos.has(id)) {
      if (size > (photos.get(id)?.size ?? 0)) photos.set(id, { url, size });
    }
  }
  return { assets: [...photos.values()].map(({ url }) => asset("image", url)) };
}

function linkedInAccessPage(url: URL) {
  return /^\/(?:authwall|login|signup)(?:\/|$)/u.test(url.pathname);
}

function linkedInSources(client: PublicSocialFetch, post: URL, maxHeight: number) {
  const id = linkedInActivityId(post);
  if (!id) throw new PublicSocialError("unavailable");
  const embed = new URL(`https://www.linkedin.com/embed/feed/update/urn:li:activity:${id}`);
  const allowed = (url: URL) =>
    linkedInPostHost(url) &&
    !url.hash &&
    (linkedInActivityId(url) === id || linkedInAccessPage(url));
  return [post, embed].map((source) => async (): Promise<Source> => {
    const { body, url } = await client.text(source, allowed, htmlType);
    if (linkedInAccessPage(url)) throw new PublicSocialError("blocked");
    const markup = body.replace(
      /<!--[\s\S]*?-->|<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu,
      "",
    );
    const signInTitle =
      /<title[^>]*>\s*(?:LinkedIn(?::\s*|\s+))?(?:log in|login|sign in|sign up|join linkedin)(?:\s*[|\u2013\u2014-]|\s+or\s+|\s*<\/title>)/iu.test(
        markup,
      );
    if (
      signInTitle ||
      /<(?:main|body|div|form|section)\b[^>]*\bid\s*=\s*["']authwall["']/iu.test(markup) ||
      /^LinkedIn authwall$/iu.test(markup.trim())
    )
      throw new PublicSocialError("blocked");
    const article = linkedInArticle(markup, id);
    if (!article) return { id, assets: [] };
    return { id, ...(await linkedInPage(client, article, body, id, maxHeight)) };
  });
}

const failurePriority: PublicSocialError["reason"][] = [
  "unavailable",
  "unsupported",
  "missing",
  "blocked",
  "file_unavailable",
  "stream_only",
  "too_long",
];

function preferredFailure(current: PublicSocialError, error: unknown) {
  const next = evidencedFailure(error);
  return failurePriority.indexOf(next.reason) > failurePriority.indexOf(current.reason)
    ? next
    : current;
}

export async function resolvePublicSocialAssets(
  platform: PublicSocialPlatform,
  source: URL,
  quality: unknown,
  requestSignal: AbortSignal,
  limits: Record<PublicAssetKind, number>,
  mediaFilter?: "image" | "video",
) {
  const maxHeight =
    typeof quality === "string" && /^(?:1080|720|480|360)$/u.test(quality) ? Number(quality) : 0;
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(PUBLIC_RESOLUTION_MS)]);
  const client = new PublicSocialFetch(signal, MAX_PUBLIC_REQUESTS);
  const sources =
    platform === "twitter"
      ? [() => twitterSource(client, source, maxHeight)]
      : platform === "pinterest"
        ? await pinterestSources(client, source, maxHeight)
        : linkedInSources(client, source, maxHeight);
  let failure = new PublicSocialError("unavailable");
  for (const [index, read] of sources.entries()) {
    client.reserveRequests(index < sources.length - 1 ? REQUESTS_RESERVED_FOR_FALLBACK : 0);
    try {
      const selected = await read();
      const items = await verifyAssets(client, platform, selected, limits, signal, mediaFilter);
      return { id: selected.id, items };
    } catch (error) {
      failure = preferredFailure(failure, error);
    }
  }
  throw failure;
}

async function verifyAssets(
  client: PublicSocialFetch,
  platform: PublicSocialPlatform,
  selected: Source,
  limits: Record<PublicAssetKind, number>,
  signal: AbortSignal,
  mediaFilter?: "image" | "video",
) {
  const candidates = mediaFilter
    ? selected.assets.filter(({ kind }) => kind === mediaFilter)
    : selected.assets;
  if (!candidates.length) {
    throw new PublicSocialError(selected.hasPlaylist ? "stream_only" : "unsupported");
  }
  const unique = new Map<string, Asset>();
  for (const item of candidates) {
    const key = item.candidates[0].url.href;
    if (!unique.has(key)) unique.set(key, item);
    if (unique.size === MEDIA_DOWNLOAD_MAX_ITEMS) break;
  }
  const selectedAssets = selected.completeDocument ? candidates : [...unique.values()];
  const verified: (ResolvedAsset | null)[] = [];
  let failure = new PublicSocialError(selected.hasPlaylist ? "stream_only" : "file_unavailable");
  // Probes share the request cap and deadline, with at most four files in flight.
  for (let index = 0; index < selectedAssets.length; index += 4) {
    const batch = selectedAssets.slice(index, index + 4);
    verified.push(
      ...(await Promise.all(
        batch.map(async (item) => {
          for (const candidate of item.candidates) {
            try {
              return await verifyAsset(
                client,
                platform,
                item.kind,
                candidate,
                limits[item.kind],
                signal,
              );
            } catch (error) {
              if (error instanceof PublicSocialError && error.reason === "too_long")
                failure = error;
            }
          }
          return null;
        }),
      )),
    );
  }
  let items = verified.filter((item): item is ResolvedAsset => item !== null);
  if (
    selected.completeDocument &&
    verified.some((item, index) => item === null && selectedAssets[index].kind === "image")
  ) {
    items = items.filter((item) => item.contentType === "application/pdf");
  }
  if (!items.length) throw failure;
  return items;
}

async function verifyAsset(
  client: PublicSocialFetch,
  platform: PublicSocialPlatform,
  kind: PublicAssetKind,
  candidate: Candidate,
  maxBytes: number,
  signal: AbortSignal,
) {
  const duration = candidate.durationSeconds ?? 0;
  if (duration > MAX_VIDEO_SECONDS) throw new PublicSocialError("too_long");
  const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(PUBLIC_SOCIAL_ATTEMPT_MS)]);
  const inspectDuration = kind === "video" && !duration;
  const media = await openPublicMedia(
    client,
    platform,
    kind,
    candidate.url,
    maxBytes,
    probeSignal,
    true,
    inspectDuration,
  );
  void media.body.cancel().catch(() => undefined);
  if (
    inspectDuration &&
    (await publicMp4Duration(
      client,
      platform,
      candidate.url,
      media.prefix,
      media.totalLength,
      maxBytes,
      probeSignal,
    )) > MAX_VIDEO_SECONDS
  ) {
    throw new PublicSocialError("too_long");
  }
  return { source: candidate.url, contentType: media.contentType };
}
