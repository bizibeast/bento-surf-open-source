const INSTAGRAM_ORIGIN = "https://www.instagram.com";
const SHORTCODE_PATTERN = "[A-Za-z0-9_-]{1,64}";
const POST_PATH = new RegExp(`^/(p|reel|reels|tv)/(${SHORTCODE_PATTERN})/?$`, "u");
const MAX_URL_LENGTH = 2_048;
const MAX_ITEMS = 20;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MEDIA_CONTENT_TYPES = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
  ["mp4", "video/mp4"],
]);

export const MAX_INSTAGRAM_EMBED_BYTES = 2 * 1024 * 1024;
export type InstagramMediaKind = "image" | "video";

export function instagramMediaFilenameContentType(filename: string, kind: InstagramMediaKind) {
  const extension = /^instagram-[A-Za-z0-9_-]{1,67}\.([a-z0-9]{3,4})$/u.exec(filename)?.[1];
  const contentType = extension ? MEDIA_CONTENT_TYPES.get(extension) : undefined;
  return contentType?.startsWith(`${kind}/`) ? contentType : null;
}

type InstagramPost = {
  url: string;
  shortcode: string;
  requiresVideo: boolean;
};

type InstagramMediaSource = {
  kind: InstagramMediaKind;
  source: URL;
};

function httpsUrl(value: unknown, base?: URL) {
  if (typeof value !== "string" || !value || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url : null;
  } catch {
    return null;
  }
}

export function instagramPostFromUrl(value: unknown): InstagramPost | null {
  const url = httpsUrl(value);
  if (!url || !["www.instagram.com", "instagram.com", "m.instagram.com"].includes(url.hostname)) {
    return null;
  }
  const path = POST_PATH.exec(url.pathname);
  if (!path) return null;
  const [, kind, shortcode] = path;
  return { url: `${INSTAGRAM_ORIGIN}/p/${shortcode}/`, shortcode, requiresVideo: kind !== "p" };
}

function isInstagramCdn(url: URL) {
  return ["cdninstagram.com", "fbcdn.net"].some(
    (hostname) => url.hostname === hostname || url.hostname.endsWith(`.${hostname}`),
  );
}

export function instagramCdnUrl(value: unknown) {
  const url = httpsUrl(value);
  return url && !url.hash && isInstagramCdn(url) ? url : null;
}

async function fetchInstagramResource(
  start: URL,
  isAllowed: (url: URL) => boolean,
  options: { accept: string; signal: AbortSignal; method: "GET" | "HEAD" },
) {
  let url = start;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(url, {
      method: options.method,
      headers: { accept: options.accept, "user-agent": "bento-media-gateway/1.0" },
      credentials: "omit",
      redirect: "manual",
      signal: options.signal,
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const next = httpsUrl(response.headers.get("location"), url);
    await response.body?.cancel("instagram-redirect").catch(() => undefined);
    if (!next || next.hash || !isAllowed(next)) throw new Error("invalid-instagram-redirect");
    url = next;
  }
  throw new Error("too-many-instagram-redirects");
}

export function fetchInstagramEmbed(post: InstagramPost, signal: AbortSignal) {
  const url = new URL(`${post.url}embed/captioned/`);
  return fetchInstagramResource(
    url,
    (next) =>
      (next.origin === INSTAGRAM_ORIGIN || next.origin === "https://instagram.com") &&
      next.pathname === url.pathname,
    { accept: "text/html", signal, method: "GET" },
  );
}

export async function fetchInstagramMedia(
  source: URL,
  contentType: string,
  method: "GET" | "HEAD",
  signal: AbortSignal,
) {
  const options = { accept: contentType, method, signal };
  const response = await fetchInstagramResource(source, isInstagramCdn, options);
  // Retry one failed read of the same public file. Never retry a permission
  // denial, invalid redirect, changed MIME type or aborted transfer.
  if (method === "GET" && [502, 503, 504].includes(response.status) && !signal.aborted) {
    await response.body?.cancel("instagram-transient-read").catch(() => undefined);
    return fetchInstagramResource(source, isInstagramCdn, options);
  }
  return response;
}

export class InstagramVideoUnavailable extends Error {
  constructor() {
    super("Instagram video unavailable");
  }
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function edgesOf(value: unknown): unknown[] | undefined {
  const edges = jsonObject(value)?.edges;
  return Array.isArray(edges) ? edges : undefined;
}

function nonnegativeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function countFrom(value: unknown) {
  const count = nonnegativeNumber(jsonObject(value)?.count);
  return Number.isSafeInteger(count) ? count : undefined;
}

function boundedText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.slice(0, maxLength) : undefined;
}

function largestDisplayResource(node: Record<string, unknown>) {
  let source = instagramCdnUrl(node.display_url);
  let largestWidth = -1;
  if (!Array.isArray(node.display_resources)) return source;

  for (const candidate of node.display_resources) {
    const resource = jsonObject(candidate);
    const url = instagramCdnUrl(resource?.src);
    const width = nonnegativeNumber(resource?.config_width) ?? 0;
    if (url && width > largestWidth) {
      source = url;
      largestWidth = width;
    }
  }
  return source;
}

function mediaFromNode(node: Record<string, unknown> | undefined, requiresVideo: boolean) {
  if (!node || node.is_private === true) throw new Error("invalid-instagram-media");
  const isVideo =
    requiresVideo ||
    node.is_video === true ||
    node.media_type === 2 ||
    node.product_type === "clips" ||
    (typeof node.__typename === "string" && node.__typename.endsWith("GraphVideo")) ||
    typeof node.video_url === "string";
  if (isVideo) {
    if (typeof node.video_url !== "string" || !node.video_url)
      throw new InstagramVideoUnavailable();
    const source = instagramCdnUrl(node.video_url);
    if (!source) throw new Error("invalid-instagram-video-url");
    return { kind: "video", source } satisfies InstagramMediaSource;
  }

  const source = largestDisplayResource(node);
  if (!source) throw new Error("invalid-instagram-image-url");
  return { kind: "image", source } satisfies InstagramMediaSource;
}

export function parseInstagramEmbed(html: string, post: InstagramPost) {
  // Match a complete JSON string literal, including its quotes, and decode both JSON layers.
  const contextLiteral = /"contextJSON"\s*:\s*("(?:\\[^]|[^"\\])*")/u.exec(html)?.[1];
  if (!contextLiteral) throw new Error("missing-instagram-embed-context");
  const context = jsonObject(JSON.parse(JSON.parse(contextLiteral)));
  const media = jsonObject(jsonObject(context?.gql_data)?.shortcode_media);
  const owner = jsonObject(media?.owner);
  if (
    !media ||
    media.is_private === true ||
    owner?.is_private === true ||
    (media.shortcode !== undefined && media.shortcode !== post.shortcode)
  ) {
    throw new Error("invalid-instagram-embed-context");
  }

  const children = edgesOf(media.edge_sidecar_to_children);
  if (
    !children?.length &&
    typeof media.__typename === "string" &&
    media.__typename.endsWith("GraphSidecar")
  ) {
    throw new Error("empty-instagram-carousel");
  }
  const items = children?.length
    ? children
        .slice(0, MAX_ITEMS)
        .map((edge) => mediaFromNode(jsonObject(jsonObject(edge)?.node), false))
    : [mediaFromNode(media, post.requiresVideo)];
  if (post.requiresVideo && !items.some((item) => item.kind === "video")) {
    throw new InstagramVideoUnavailable();
  }

  const captionEdge = edgesOf(media.edge_media_to_caption)?.[0];
  const caption = jsonObject(jsonObject(captionEdge)?.node)?.text;
  return {
    source: {
      url: post.url,
      shortcode: post.shortcode,
      owner: boundedText(owner?.username, 100),
      caption: boundedText(caption, 2_200),
      durationSeconds: nonnegativeNumber(media.video_duration),
      views: nonnegativeNumber(media.video_view_count ?? media.video_play_count),
      likes: countFrom(media.edge_liked_by ?? media.edge_media_preview_like),
      comments: countFrom(media.edge_media_to_comment ?? media.edge_media_to_parent_comment),
      takenAt: nonnegativeNumber(media.taken_at_timestamp),
    },
    items,
  };
}
