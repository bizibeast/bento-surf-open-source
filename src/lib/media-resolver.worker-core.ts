import {
  BASIC_MEDIA_PATH,
  resolveBasicMedia,
  tunnelBasicMedia,
  type BasicMediaBindings,
} from "./basic-media";
import { readBoundedBytes } from "./media-stream";
import { fetchTikTokPublicPost, tiktokPublicPost, TikTokPublicError } from "./tiktok-public";
import {
  MEDIA_DOWNLOAD_EXPIRES_IN_SECONDS,
  MEDIA_DOWNLOAD_MAX_BYTES,
  PUBLIC_SOCIAL_MEDIA_PATH,
} from "./media-tools";
import {
  isPublicMediaType,
  openPublicMedia,
  publicAssetUrl,
  publicMediaTypes,
  PublicMediaTooLarge,
  PublicSocialError,
  PublicSocialFetch,
  type PublicMediaType,
} from "./public-social-fetch";
import { resolvePublicSocialAssets } from "./public-social-media";
import { extractPublicPostStats, PostStatsExtractionError } from "./public-post-extractors";
import {
  isPublicSocialPlatform,
  normalizePublicSocialPost,
  type PublicSocialPlatform,
} from "./public-social-url";
import { socialEmbedSourceUrl, youtubeVideoIdFromUrl } from "./social-embeds";
import {
  fetchInstagramEmbed,
  fetchInstagramMedia,
  instagramCdnUrl,
  instagramMediaFilenameContentType,
  instagramPostFromUrl,
  InstagramVideoUnavailable,
  MAX_INSTAGRAM_EMBED_BYTES,
  parseInstagramEmbed,
  type InstagramMediaKind,
} from "./instagram-embed";

export { readBoundedBytes } from "./media-stream";

const MAX_JSON_BYTES = 64 * 1024;
const MAX_TUNNEL_BYTES = MEDIA_DOWNLOAD_MAX_BYTES;
const MAX_COVER_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TUNNEL_MILLISECONDS = 30 * 60 * 1_000;
const UPSTREAM_ATTEMPT_MILLISECONDS = 9_000;
const PUBLIC_MEDIA_LIMITS = {
  video: MAX_TUNNEL_BYTES,
  image: MAX_COVER_IMAGE_BYTES,
  document: MAX_TUNNEL_BYTES,
};
const COVER_LINK_LIFESPAN_SECONDS = 90;
const INSTAGRAM_MEDIA_LINK_LIFESPAN_SECONDS = 90;
const YOUTUBE_STREAM_LIFESPAN_SECONDS = 90;
const YOUTUBE_PLAYER_RESPONSE_BYTES = 512 * 1024;
const YOUTUBE_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const YOUTUBE_ANDROID_USER_AGENT = "com.google.android.youtube/20.10.38 (Linux; U; Android 14)";
const YOUTUBE_IOS_USER_AGENT =
  "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X)";
const MEDIA_EXTENSIONS = new Map([
  ["audio/mpeg", "mp3"],
  ["audio/mp4", "m4a"],
  ["audio/ogg", "ogg"],
  ["image/gif", "gif"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["video/mp4", "mp4"],
  ["video/webm", "webm"],
]);

type CoverPlatform = "instagram" | "tiktok" | "youtube";

function isCoverPlatform(value: unknown): value is CoverPlatform {
  return value === "youtube" || value === "instagram" || value === "tiktok";
}

type RateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type MediaResolverEnv = BasicMediaBindings & {
  COBALT_UPSTREAM_API_KEY?: string;
  COBALT_UPSTREAM_URL?: string;
  COBALT_PROXY_URL?: string;
  COBALT_YOUTUBE_SESSION_URL?: string;
  RESOLVER_SHARED_SECRET?: string;
  TIKTOK_METADATA_URL?: string;
  TUNNEL_RATE_LIMITER?: RateLimitBinding;
};

function noStoreJson(value: unknown, status = 200, extraHeaders?: HeadersInit) {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function constantTimeEqual(left: string, right: string) {
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function isAuthorized(request: Request, env: MediaResolverEnv) {
  const secret = env.RESOLVER_SHARED_SECRET?.trim();
  if (!secret || secret.length < 32) return false;
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.match(/^(?:Bearer|Api-Key) (.+)$/u)?.[1] ?? "";
  return constantTimeEqual(supplied, secret);
}

async function readBoundedJson(response: Response) {
  const bytes = await readBoundedBytes(response, MAX_JSON_BYTES);
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export function streamWithByteLimit(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
) {
  const reader = body.getReader();
  let total = 0;
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted) {
        signal.removeEventListener("abort", abort);
        await reader.cancel(signal.reason).catch(() => undefined);
        controller.error(signal.reason);
        return;
      }
      try {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) {
          signal.removeEventListener("abort", abort);
          controller.close();
          return;
        }
        total += value.byteLength;
        if (total > maxBytes) {
          signal.removeEventListener("abort", abort);
          await reader.cancel("media-too-large").catch(() => undefined);
          controller.error(new Error("media-too-large"));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        signal.removeEventListener("abort", abort);
        controller.error(error);
      }
    },
    cancel(reason) {
      signal.removeEventListener("abort", abort);
      return reader.cancel(reason);
    },
  });
}

export class StreamConcurrencyGate {
  private active = 0;

  constructor(private readonly maximum: number) {}

  acquire() {
    if (this.active >= this.maximum) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}

export function releaseWhenStreamEnds(response: Response, release: () => void) {
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function safeAttachmentFilename(value: string | null, extension: string) {
  const basename = (value ?? "bento-media")
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}/\\"]/gu, "-")
    .replace(/\.[A-Za-z0-9]{1,8}$/u, "")
    .replace(/[^A-Za-z0-9._ -]+/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
  return `${basename || "bento-media"}.${extension}`;
}

type YouTubeFormat = {
  bitrate?: unknown;
  height?: unknown;
  itag?: unknown;
  mimeType?: unknown;
  url?: unknown;
};

type YouTubePlayerResponse = {
  playabilityStatus?: { status?: unknown };
  videoDetails?: { lengthSeconds?: unknown };
  streamingData?: {
    adaptiveFormats?: YouTubeFormat[];
    formats?: YouTubeFormat[];
  };
};

function safeGoogleVideoUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      (host !== "googlevideo.com" && !host.endsWith(".googlevideo.com")) ||
      url.pathname !== "/videoplayback"
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

async function youtubePlayer(videoId: string, signal: AbortSignal) {
  const clients = [
    {
      name: "ANDROID",
      version: "20.10.38",
      userAgent: YOUTUBE_ANDROID_USER_AGENT,
      extra: { androidSdkVersion: 34 },
    },
    {
      name: "IOS",
      version: "20.10.4",
      userAgent: YOUTUBE_IOS_USER_AGENT,
      extra: { deviceModel: "iPhone16,2" },
    },
  ] as const;
  for (const client of clients) {
    try {
      const response = await fetch(YOUTUBE_PLAYER_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": client.userAgent },
        body: JSON.stringify({
          context: {
            client: {
              clientName: client.name,
              clientVersion: client.version,
              ...client.extra,
              hl: "en",
              gl: "US",
            },
          },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(UPSTREAM_ATTEMPT_MILLISECONDS)]),
      });
      if (!response.ok) continue;
      const bytes = await readBoundedBytes(response, YOUTUBE_PLAYER_RESPONSE_BYTES);
      const payload = JSON.parse(new TextDecoder().decode(bytes)) as YouTubePlayerResponse;
      if (payload.playabilityStatus?.status !== "OK") continue;
      const duration = Number(payload.videoDetails?.lengthSeconds);
      if (Number.isFinite(duration) && duration > 86_400) throw new Error("youtube-video-too-long");
      return { payload, userAgent: client.userAgent };
    } catch (error) {
      if (error instanceof Error && error.message === "youtube-video-too-long") throw error;
    }
  }
  throw new Error("youtube-video-unavailable");
}

function youtubeFormat(payload: YouTubePlayerResponse, request: CobaltRequestBody) {
  const audioOnly = request.downloadMode === "audio";
  const candidates = audioOnly
    ? (payload.streamingData?.adaptiveFormats ?? []).filter(
        (format) =>
          typeof format.mimeType === "string" &&
          format.mimeType.startsWith("audio/") &&
          Number.isInteger(format.itag) &&
          safeGoogleVideoUrl(format.url),
      )
    : (payload.streamingData?.formats ?? []).filter(
        (format) =>
          typeof format.mimeType === "string" &&
          format.mimeType.startsWith("video/") &&
          Number.isInteger(format.itag) &&
          safeGoogleVideoUrl(format.url),
      );
  if (!candidates.length) return null;
  if (audioOnly) {
    return candidates.sort((left, right) => Number(left.bitrate) - Number(right.bitrate))[0];
  }
  const maximum = request.videoQuality === "max" ? Infinity : Number(request.videoQuality);
  const ordered = candidates.sort((left, right) => Number(right.height) - Number(left.height));
  return Number.isFinite(maximum)
    ? (ordered.find((format) => Number(format.height) <= maximum) ?? ordered.at(-1))
    : ordered[0];
}

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function youtubeStreamSignature(
  secret: string,
  videoId: string,
  itag: number,
  expires: number,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${videoId}:${itag}:${expires}`),
  );
  return base64Url(new Uint8Array(signature));
}

async function youtubeFallbackPayload(
  request: CobaltRequestBody,
  env: MediaResolverEnv,
  publicOrigin: string,
  signal: AbortSignal,
) {
  const secret = env.RESOLVER_SHARED_SECRET?.trim();
  const videoId = typeof request.url === "string" ? youtubeVideoIdFromUrl(request.url) : null;
  if (!secret || !videoId) return null;
  const { payload } = await youtubePlayer(videoId, signal);
  const format = youtubeFormat(payload, request);
  const itag = Number(format?.itag);
  const mimeType = typeof format?.mimeType === "string" ? format.mimeType.split(";", 1)[0] : "";
  const extension = MEDIA_EXTENSIONS.get(mimeType);
  if (!format || !Number.isInteger(itag) || !extension) return null;
  const expires = Math.floor(Date.now() / 1_000) + YOUTUBE_STREAM_LIFESPAN_SECONDS;
  const signature = await youtubeStreamSignature(secret, videoId, itag, expires);
  const url = new URL("/youtube-stream", publicOrigin);
  url.searchParams.set("v", videoId);
  url.searchParams.set("itag", String(itag));
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("signature", signature);
  return {
    status: "tunnel",
    url: url.toString(),
    filename: `youtube_${videoId}.${extension}`,
  };
}

type CobaltUpstream = { key: string; url: URL };
type OracleMetadataUpstream = { key: string; url: URL };
type CobaltRouteName = "direct" | "youtube-session" | "webshare";
type CobaltCandidate = {
  name: CobaltRouteName;
  upstream: CobaltUpstream;
  body: Uint8Array;
};
type HealthRoute =
  | { kind: "cobalt"; name: CobaltRouteName; upstream: CobaltUpstream; url: URL }
  | {
      kind: "metadata";
      name: "tiktok-metadata";
      upstream: OracleMetadataUpstream;
      url: URL;
    };

function cobaltUpstream(env: MediaResolverEnv, rawUrl = env.COBALT_UPSTREAM_URL) {
  const key = env.COBALT_UPSTREAM_API_KEY?.trim();
  if (!key || key.length < 32) throw new Error("invalid-cobalt-key");

  const url = new URL(rawUrl?.trim() ?? "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("invalid-cobalt-url");
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return { key, url };
}

function optionalCobaltUpstream(env: MediaResolverEnv, rawUrl: string | undefined) {
  if (!rawUrl?.trim()) return null;
  try {
    return cobaltUpstream(env, rawUrl);
  } catch {
    return null;
  }
}

function tiktokMetadataUpstream(env: MediaResolverEnv): OracleMetadataUpstream {
  const cobalt = cobaltUpstream(env);
  const url = new URL(env.TIKTOK_METADATA_URL?.trim() ?? "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.origin !== cobalt.url.origin ||
    url.pathname !== "/metadata/tiktok-cover"
  ) {
    throw new Error("invalid-tiktok-metadata-url");
  }
  return { key: cobalt.key, url };
}

function optionalTiktokMetadataUpstream(env: MediaResolverEnv) {
  if (!env.TIKTOK_METADATA_URL?.trim()) return null;
  try {
    return tiktokMetadataUpstream(env);
  } catch {
    return null;
  }
}

function cobaltHealthRoute(
  env: MediaResolverEnv,
  name: CobaltRouteName,
  rawUrl?: string,
): HealthRoute {
  const upstream = cobaltUpstream(env, rawUrl);
  return { kind: "cobalt", name, upstream, url: upstream.url };
}

function tiktokMetadataHealthRoute(env: MediaResolverEnv): HealthRoute {
  const upstream = tiktokMetadataUpstream(env);
  return {
    kind: "metadata",
    name: "tiktok-metadata",
    upstream,
    url: new URL("/metadata/health", upstream.url),
  };
}

type CobaltRequestBody = Record<string, unknown> & {
  downloadMode?: unknown;
  url?: unknown;
  videoQuality?: unknown;
};

function parseCobaltRequestBody(body: Uint8Array): CobaltRequestBody | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(body)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as CobaltRequestBody)
      : null;
  } catch {
    return null;
  }
}

function sessionCanHelp(request: CobaltRequestBody) {
  if (typeof request.url !== "string" || !youtubeVideoIdFromUrl(request.url)) return false;
  if (request.downloadMode === "audio") return true;
  if (request.videoQuality === "max") return true;
  const numericQuality = Number(request.videoQuality);
  return Number.isFinite(numericQuality) && numericQuality > 1080;
}

function youtubeSessionRequestBody(body: Uint8Array, request: CobaltRequestBody) {
  if (request.downloadMode !== "audio") return body;
  return new TextEncoder().encode(JSON.stringify({ ...request, videoQuality: "max" }));
}

function cobaltUpstreamCandidates(env: MediaResolverEnv, body: Uint8Array): CobaltCandidate[] {
  const request = parseCobaltRequestBody(body);
  const upstreams: CobaltCandidate[] = [{ name: "direct", upstream: cobaltUpstream(env), body }];
  if (request && sessionCanHelp(request)) {
    const session = optionalCobaltUpstream(env, env.COBALT_YOUTUBE_SESSION_URL);
    if (session) {
      upstreams.push({
        name: "youtube-session",
        upstream: session,
        body: youtubeSessionRequestBody(body, request),
      });
    }
  }
  const proxy = optionalCobaltUpstream(env, env.COBALT_PROXY_URL);
  if (proxy) upstreams.push({ name: "webshare", upstream: proxy, body });
  return upstreams;
}

function upstreamHeaders(key: string, initial?: HeadersInit) {
  const headers = new Headers(initial);
  headers.set("authorization", `Api-Key ${key}`);
  headers.set("user-agent", "bento-media-gateway/1.0");
  return headers;
}

function cobaltTunnelUrl(value: unknown, upstream: CobaltUpstream) {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== upstream.url.origin) return null;
  const basePath = upstream.url.pathname.replace(/\/$/u, "");
  const tunnelPath = `${basePath}/tunnel`;
  const isRootTunnel = url.pathname === "/tunnel" || url.pathname.startsWith("/tunnel/");
  if (!isRootTunnel && url.pathname !== tunnelPath && !url.pathname.startsWith(`${tunnelPath}/`)) {
    throw new Error("unexpected-cobalt-url");
  }
  const relativePath = isRootTunnel ? url.pathname : url.pathname.slice(basePath.length);
  return new URL(`${basePath}${relativePath}${url.search}`, upstream.url.origin);
}

function rewriteTunnelUrl(value: unknown, publicOrigin: string, upstream: CobaltUpstream) {
  const tunnel = cobaltTunnelUrl(value, upstream);
  return tunnel instanceof URL ? `${publicOrigin}${tunnel.pathname}${tunnel.search}` : value;
}

function rewriteCobaltPayload(
  value: unknown,
  publicOrigin: string,
  upstream: CobaltUpstream,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteCobaltPayload(item, publicOrigin, upstream));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "url" || key === "audio"
        ? rewriteTunnelUrl(item, publicOrigin, upstream)
        : rewriteCobaltPayload(item, publicOrigin, upstream),
    ]),
  );
}

function isSuccessfulCobaltPayload(value: unknown) {
  return isCobaltPayload(value) && value.status !== "error";
}

function isRetryableCobaltError(value: unknown) {
  if (!isCobaltPayload(value) || value.status !== "error") return false;
  const error = (value as { error?: unknown }).error;
  const code =
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
  return /(?:api[_-]?error|bot|fetch|internal|login|network|rate[_-]?limit|timeout|token|unavailable|unknown)/iu.test(
    code,
  );
}

async function requestCobalt(
  upstream: CobaltUpstream,
  body: Uint8Array,
  publicOrigin: string,
  requestSignal: AbortSignal,
) {
  const signal = AbortSignal.any([
    requestSignal,
    AbortSignal.timeout(UPSTREAM_ATTEMPT_MILLISECONDS),
  ]);
  const response = await fetch(upstream.url, {
    method: "POST",
    redirect: "manual",
    headers: upstreamHeaders(upstream.key, {
      accept: "application/json",
      "content-type": "application/json",
    }),
    body: new Uint8Array(body).buffer as ArrayBuffer,
    signal,
  });
  const rawPayload = await readBoundedJson(response);
  const payload = rewriteCobaltPayload(rawPayload, publicOrigin, upstream);
  if (!isCobaltPayload(payload)) throw new Error("invalid-cobalt-payload");
  return { payload, rawPayload };
}

function isCobaltPayload(value: unknown): value is Record<string, unknown> & { status: string } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { status?: unknown }).status === "string"
  );
}

function hasCobaltAudioTunnel(value: unknown, upstream: CobaltUpstream) {
  if (!isCobaltPayload(value)) return false;
  const { status, url, audio } = value;
  const source =
    status === "picker" ? audio : status === "tunnel" || status === "redirect" ? url : null;
  return cobaltTunnelUrl(source, upstream) !== null;
}

function cobaltTunnelUrls(value: unknown, upstream: CobaltUpstream) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const values: string[] = [];
  for (const key of ["url", "audio"] as const) {
    if (!(key in payload)) continue;
    if (typeof payload[key] !== "string") return null;
    values.push(payload[key]);
  }
  if ("picker" in payload) {
    if (!Array.isArray(payload.picker)) return null;
    for (const item of payload.picker) {
      if (!item || typeof item !== "object" || Array.isArray(item) || !("url" in item)) return null;
      const url = (item as { url?: unknown }).url;
      if (typeof url !== "string") return null;
      values.push(url);
    }
  }

  const tunnels = values.map((item) => cobaltTunnelUrl(item, upstream));
  const validTunnels = tunnels.filter((tunnel): tunnel is URL => tunnel instanceof URL);
  if (validTunnels.length !== tunnels.length) return null;
  return Array.from(
    new Map(validTunnels.map((tunnel) => [tunnel.toString(), tunnel] as const)).values(),
  );
}

async function probeCobaltTunnel(
  payload: unknown,
  upstream: CobaltUpstream,
  requestSignal: AbortSignal,
  expectedKind?: "video",
) {
  const tunnels = cobaltTunnelUrls(payload, upstream);
  if (!tunnels || tunnels.length === 0) return false;

  for (const tunnel of tunnels) {
    const response = await fetch(tunnel, {
      method: "GET",
      redirect: "manual",
      headers: upstreamHeaders(upstream.key, { accept: "*/*", range: "bytes=0-1023" }),
      signal: AbortSignal.any([requestSignal, AbortSignal.timeout(UPSTREAM_ATTEMPT_MILLISECONDS)]),
    });
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (
      !response.ok ||
      !contentType ||
      !MEDIA_EXTENSIONS.has(contentType) ||
      (expectedKind && !contentType.startsWith(expectedKind + "/")) ||
      !response.body
    ) {
      await response.body?.cancel("invalid-tunnel-probe").catch(() => undefined);
      return false;
    }

    const reader = response.body.getReader();
    let hasBytes = false;
    try {
      const first = await reader.read();
      hasBytes = !first.done && Boolean(first.value?.byteLength);
    } finally {
      await reader.cancel("tunnel-probe-complete").catch(() => undefined);
    }
    if (!hasBytes) return false;
  }
  return true;
}

async function verifiedInstagramVideo(
  raw: unknown,
  upstream: CobaltUpstream,
  publicOrigin: string,
  signal: AbortSignal,
) {
  if (!isCobaltPayload(raw)) return null;
  let candidate;
  if (raw.status === "picker" && Array.isArray(raw.picker)) {
    // A Reel needs one video. Keep a single probe per upstream, and omit any unverified extras.
    const video = raw.picker.find(
      (item) => item?.type === "video" && cobaltTunnelUrl(item.url, upstream),
    );
    if (!video) return null;
    candidate = { status: "picker", picker: [video] };
  } else if (raw.status === "tunnel" || raw.status === "redirect") {
    if (typeof raw.filename === "string" && /\.(?:jpe?g|png|gif|webp)$/iu.test(raw.filename))
      return null;
    candidate = { status: raw.status, url: raw.url, filename: raw.filename };
  } else {
    return null;
  }
  return (await probeCobaltTunnel(candidate, upstream, signal, "video"))
    ? rewriteCobaltPayload(candidate, publicOrigin, upstream)
    : null;
}

async function resolveMedia(request: Request, env: MediaResolverEnv, url: URL) {
  if (!isAuthorized(request, env)) return noStoreJson({ error: "Unauthorized" }, 401);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return noStoreJson({ error: "Expected application/json" }, 415);
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    return noStoreJson({ error: "Request is too large" }, 413);
  }
  let body: Uint8Array;
  try {
    body = await readBoundedBytes(request, MAX_JSON_BYTES);
  } catch {
    return noStoreJson({ error: "Request is too large" }, 413);
  }

  try {
    const parsedRequest = parseCobaltRequestBody(body);
    if (parsedRequest && parsedRequest.downloadMode !== "audio") {
      const tiktok = tiktokPublicPost(parsedRequest.url);
      if (tiktok?.photo) {
        try {
          const post = await fetchTikTokPublicPost(String(parsedRequest.url), request.signal);
          if (!post.images.length)
            return noStoreJson({
              status: "error",
              error: { code: "error.api.content.unavailable" },
            });
          const picker = await Promise.all(
            post.images.map(async (source, index) => {
              const filename = `tiktok-${post.id}-${String(index + 1).padStart(2, "0")}.jpg`;
              return {
                type: "photo",
                filename,
                url: await signedCoverUrl(url.origin, env, "tiktok", source, filename),
              };
            }),
          );
          return noStoreJson({ status: "picker", picker });
        } catch (error) {
          if (error instanceof TikTokPublicError && error.reason !== "unavailable")
            return noStoreJson({
              status: "error",
              error: { code: "error.api.content.unavailable" },
            });
          // Retain the existing origin when the public page cannot be reached.
        }
      }
      const publicSource = publicSocialSource(parsedRequest.url);
      if (publicSource) {
        return resolvePublicSocialPost(
          publicSource,
          parsedRequest.videoQuality,
          parsedRequest.mediaFilter === "image" || parsedRequest.mediaFilter === "video"
            ? parsedRequest.mediaFilter
            : undefined,
          env,
          url.origin,
          request.signal,
        );
      }
    }
    if (parsedRequest) {
      const managed = await resolveBasicMedia(parsedRequest, env, url.origin, request.signal);
      if (managed) {
        const code = "error" in managed ? managed.error?.code : undefined;
        // Preserve the existing origin when a platform refuses the new host.
        // Authorization, public-only decisions and budget denials never fall through.
        if (
          !code ||
          ![
            "error.api.fetch.fail",
            "error.api.content.unavailable",
            "error.api.tiktok.blocked",
          ].includes(code)
        )
          return noStoreJson(managed);
      }
    }
    const probeYouTube =
      typeof parsedRequest?.url === "string" && Boolean(youtubeVideoIdFromUrl(parsedRequest.url));
    const preferYouTubeStream = probeYouTube && parsedRequest?.downloadMode === "audio";
    const instagramPost = instagramPostFromUrl(parsedRequest?.url);
    const instagramAudio = instagramPost && parsedRequest?.downloadMode === "audio";
    const instagramVideo = instagramPost?.requiresVideo && !instagramAudio;
    let lastErrorPayload: unknown = null;
    let candidates: CobaltCandidate[] = [];
    try {
      candidates = cobaltUpstreamCandidates(env, body);
    } catch (error) {
      if (!instagramPost) throw error;
    }
    for (const candidate of candidates) {
      try {
        const { payload, rawPayload } = await requestCobalt(
          candidate.upstream,
          candidate.body,
          url.origin,
          request.signal,
        );
        if (isSuccessfulCobaltPayload(payload)) {
          if (instagramVideo) {
            const video = await verifiedInstagramVideo(
              rawPayload,
              candidate.upstream,
              url.origin,
              request.signal,
            );
            if (video) return noStoreJson(video);
            lastErrorPayload = {
              status: "error",
              error: { code: "error.api.instagram.video_unavailable" },
            };
            continue;
          }
          if (instagramAudio && !hasCobaltAudioTunnel(rawPayload, candidate.upstream)) continue;
          if (!probeYouTube) return noStoreJson(payload);
          if (!(await probeCobaltTunnel(rawPayload, candidate.upstream, request.signal))) continue;
          if (!preferYouTubeStream) return noStoreJson(payload);
          const fresh = await requestCobalt(
            candidate.upstream,
            candidate.body,
            url.origin,
            request.signal,
          );
          if (isSuccessfulCobaltPayload(fresh.payload)) return noStoreJson(fresh.payload);
          lastErrorPayload = fresh.payload;
          continue;
        }
        lastErrorPayload = payload;
        if (!probeYouTube && !isRetryableCobaltError(payload)) return noStoreJson(payload);
      } catch {
        // Try the next configured zero-cost route.
      }
    }
    if (parsedRequest && probeYouTube) {
      try {
        const fallback = await youtubeFallbackPayload(
          parsedRequest,
          env,
          url.origin,
          request.signal,
        );
        if (fallback) return noStoreJson(fallback);
      } catch (error) {
        if (error instanceof Error && error.message === "youtube-video-too-long") {
          return noStoreJson({ status: "error", error: { code: "error.api.content.too_long" } });
        }
      }
    }
    if (instagramPost) {
      try {
        const { items } = await resolveInstagramEmbed(
          instagramPost,
          env,
          url.origin,
          request.signal,
        );
        if (instagramAudio) {
          const video = items.find((item) => item.kind === "video");
          if (!video) throw new InstagramVideoUnavailable();
          return noStoreJson({ status: "tunnel", url: video.url, filename: video.filename });
        }
        const downloads = instagramVideo ? items.filter((item) => item.kind === "video") : items;
        const picker = downloads.map(({ kind, ...item }) => ({
          ...item,
          type: kind === "image" ? "photo" : "video",
        }));
        return noStoreJson({ status: "picker", picker });
      } catch (error) {
        if (error instanceof InstagramVideoUnavailable) {
          return noStoreJson({
            status: "error",
            error: { code: "error.api.instagram.video_unavailable" },
          });
        }
      }
    }
    return lastErrorPayload
      ? noStoreJson(lastErrorPayload)
      : noStoreJson({ error: "Media resolver is temporarily unavailable" }, 503);
  } catch {
    return noStoreJson({ error: "Media resolver is temporarily unavailable" }, 503);
  }
}

function parseCoverRequest(body: Uint8Array) {
  try {
    const value = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      typeof value.url !== "string" ||
      !isCoverPlatform(value.platform)
    ) {
      return null;
    }
    const platform = value.platform;
    const source = new URL(value.url);
    const isShortTikTok =
      platform === "tiktok" &&
      (source.hostname === "vm.tiktok.com" || source.hostname === "vt.tiktok.com") &&
      /^\/[A-Za-z0-9_-]{5,64}\/?$/u.test(source.pathname);
    if (
      source.protocol !== "https:" ||
      source.username ||
      source.password ||
      (!isShortTikTok && !socialEmbedSourceUrl(platform, source.toString()))
    ) {
      return null;
    }
    source.hash = "";
    return { platform, url: source.toString() };
  } catch {
    return null;
  }
}

function hostnameMatches(hostname: string, suffix: string) {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function validCoverSource(platform: CoverPlatform, value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    const allowed =
      platform === "youtube"
        ? hostnameMatches(hostname, "ytimg.com")
        : platform === "instagram"
          ? hostnameMatches(hostname, "cdninstagram.com") || hostnameMatches(hostname, "fbcdn.net")
          : [
              "byteimg.com",
              "ibyteimg.com",
              "muscdn.com",
              "tiktokcdn.com",
              "tiktokcdn-eu.com",
              "tiktokcdn-us.com",
            ].some((suffix) => hostnameMatches(hostname, suffix));
    return allowed ? url.toString() : null;
  } catch {
    return null;
  }
}

function signaturePayload(
  expiresAt: number,
  platform: CoverPlatform,
  filename: string,
  source: string,
) {
  return `${expiresAt}\n${platform}\n${filename}\n${source}`;
}

async function coverSignature(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function publicSocialSource(value: unknown) {
  for (const platform of ["twitter", "pinterest", "linkedin"] as const) {
    const normalized = normalizePublicSocialPost(platform, value);
    if (normalized) return { platform, source: new URL(normalized) };
  }
  return null;
}

function publicMediaSignature(
  secret: string,
  expiry: number,
  platform: PublicSocialPlatform,
  type: PublicMediaType,
  filename: string,
  source: string,
) {
  return coverSignature(
    secret,
    `public-media\n${expiry}\n${platform}\n${type}\n${filename}\n${source}`,
  );
}

async function resolvePublicSocialPost(
  { platform, source }: NonNullable<ReturnType<typeof publicSocialSource>>,
  quality: unknown,
  mediaFilter: "image" | "video" | undefined,
  env: MediaResolverEnv,
  origin: string,
  signal: AbortSignal,
) {
  const secret = env.RESOLVER_SHARED_SECRET?.trim();
  if (!secret || secret.length < 32) return noStoreJson({ error: "Unauthorized" }, 401);

  try {
    const { id, items } = await resolvePublicSocialAssets(
      platform,
      source,
      quality,
      signal,
      PUBLIC_MEDIA_LIMITS,
      mediaFilter,
    );
    const expires = Math.floor(Date.now() / 1_000) + MEDIA_DOWNLOAD_EXPIRES_IN_SECONDS;
    const picker = await Promise.all(
      items.map(async ({ source, contentType }, index) => {
        const { extension, pickerType } = publicMediaTypes[contentType];
        const suffix =
          items.length > 1 && pickerType !== "document"
            ? `-${String(index + 1).padStart(2, "0")}`
            : "";
        const filename = `${platform}-${id}${suffix}.${extension}`;
        const url = new URL(PUBLIC_SOCIAL_MEDIA_PATH, origin);
        url.searchParams.set("src", source.href);
        url.searchParams.set("platform", platform);
        url.searchParams.set("type", contentType);
        url.searchParams.set("expires", String(expires));
        url.searchParams.set("bento_filename", filename);
        url.searchParams.set(
          "signature",
          await publicMediaSignature(secret, expires, platform, contentType, filename, source.href),
        );
        if (url.href.length > 2_048) throw new PublicSocialError("unavailable");
        return { type: pickerType, url: url.href, filename };
      }),
    );
    return noStoreJson({ status: "picker", picker });
  } catch (error) {
    const reason = error instanceof PublicSocialError ? error.reason : "unavailable";
    const code = reason === "too_long" ? "error.api.content.too_long" : `public_media_${reason}`;
    return noStoreJson({ status: "error", error: { code } });
  }
}

async function verifiedPublicMediaLink(url: URL, env: MediaResolverEnv) {
  const secret = env.RESOLVER_SHARED_SECRET?.trim();
  const platform = url.searchParams.get("platform");
  const type = url.searchParams.get("type");
  const rawSource = url.searchParams.get("src");
  const filename = url.searchParams.get("bento_filename") ?? "";
  const expires = url.searchParams.get("expires") ?? "";
  const signature = url.searchParams.get("signature") ?? "";
  const now = Math.floor(Date.now() / 1_000);
  const expiry = Number(expires);
  if (
    !secret ||
    secret.length < 32 ||
    !isPublicSocialPlatform(platform) ||
    !isPublicMediaType(type) ||
    !/^(?:twitter|pinterest|linkedin)-\d{1,24}(?:-\d{2})?\.[a-z0-9]+$/u.test(filename) ||
    !filename.startsWith(`${platform}-`) ||
    !filename.endsWith(`.${publicMediaTypes[type].extension}`) ||
    !/^\d+$/u.test(expires) ||
    !Number.isSafeInteger(expiry) ||
    expiry <= now ||
    expiry > now + MEDIA_DOWNLOAD_EXPIRES_IN_SECONDS ||
    !/^[A-Za-z0-9_-]{43}$/u.test(signature)
  )
    return null;
  const parameters = ["src", "platform", "type", "expires", "bento_filename", "signature"];
  if (parameters.some((key) => url.searchParams.getAll(key).length !== 1)) return null;
  if (url.searchParams.has("bento_download")) {
    if (
      url.searchParams.getAll("bento_download").length !== 1 ||
      url.searchParams.get("bento_download") !== "1"
    )
      return null;
    parameters.push("bento_download");
  }
  if ([...url.searchParams.keys()].some((key) => !parameters.includes(key))) return null;

  const kind = publicMediaTypes[type].kind;
  const source = publicAssetUrl(platform, kind, rawSource);
  if (!source || source.href !== rawSource) return null;
  const expected = await publicMediaSignature(
    secret,
    expiry,
    platform,
    type,
    filename,
    source.href,
  );
  return constantTimeEqual(signature, expected) ? { platform, source, type, kind, filename } : null;
}

async function tunnelPublicMedia(request: Request, env: MediaResolverEnv, url: URL) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return noStoreJson({ error: "Method not allowed" }, 405, { allow: "GET, HEAD" });
  }
  const item = await verifiedPublicMediaLink(url, env);
  if (!item) return noStoreJson({ error: "This download link is invalid or expired" }, 404);
  const rateLimited = await downloadRateLimitResponse(request, env);
  if (rateLimited) return rateLimited;

  const probe = request.method === "HEAD";
  const maxBytes = PUBLIC_MEDIA_LIMITS[item.kind];
  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(probe ? UPSTREAM_ATTEMPT_MILLISECONDS : MAX_TUNNEL_MILLISECONDS),
  ]);
  try {
    const client = new PublicSocialFetch(signal, 4);
    const media = await openPublicMedia(
      client,
      item.platform,
      item.kind,
      item.source,
      maxBytes,
      signal,
      probe,
    );
    if (media.contentType !== item.type) {
      void media.body.cancel().catch(() => undefined);
      return noStoreJson(
        { error: "Download unavailable. Resolve the post again for a new link." },
        502,
      );
    }
    const disposition =
      item.kind === "image" && item.type !== "image/gif" && !url.searchParams.has("bento_download")
        ? "inline"
        : "attachment";
    const headers = new Headers({
      "cache-control": "private, no-store",
      "content-disposition": `${disposition}; filename="${item.filename}"`,
      "content-type": item.type,
      "cross-origin-resource-policy": "same-site",
      "x-content-type-options": "nosniff",
    });
    if (media.contentLength !== null) headers.set("content-length", String(media.contentLength));
    if (probe) {
      void media.body.cancel().catch(() => undefined);
      return new Response(null, { headers });
    }
    return new Response(streamWithByteLimit(media.body, maxBytes, signal), { headers });
  } catch (error) {
    if (error instanceof PublicMediaTooLarge)
      return noStoreJson({ error: "This media file is too large" }, 413);
    return noStoreJson(
      { error: "Download unavailable. Resolve the post again for a new link." },
      502,
    );
  }
}

async function signedCoverUrl(
  publicOrigin: string,
  env: MediaResolverEnv,
  platform: CoverPlatform,
  source: string,
  filename: string,
) {
  const secret = env.RESOLVER_SHARED_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("invalid-resolver-secret");
  const expiresAt = Math.floor(Date.now() / 1_000) + COVER_LINK_LIFESPAN_SECONDS;
  const url = new URL("/image", publicOrigin);
  url.searchParams.set("src", source);
  url.searchParams.set("platform", platform);
  url.searchParams.set("expires", String(expiresAt));
  url.searchParams.set("bento_filename", filename);
  url.searchParams.set(
    "signature",
    await coverSignature(secret, signaturePayload(expiresAt, platform, filename, source)),
  );
  return url.toString();
}

function instagramMediaSignature(
  secret: string,
  expiresAt: number,
  kind: InstagramMediaKind,
  filename: string,
  source: string,
) {
  return coverSignature(secret, `instagram-media\n${expiresAt}\n${kind}\n${filename}\n${source}`);
}

async function resolveInstagramEmbed(
  post: NonNullable<ReturnType<typeof instagramPostFromUrl>>,
  env: MediaResolverEnv,
  publicOrigin: string,
  requestSignal: AbortSignal,
) {
  const secret = env.RESOLVER_SHARED_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("invalid-resolver-secret");
  const signal = AbortSignal.any([
    requestSignal,
    AbortSignal.timeout(UPSTREAM_ATTEMPT_MILLISECONDS),
  ]);
  const response = await fetchInstagramEmbed(post, signal);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (!response.ok || contentType !== "text/html") {
    await response.body?.cancel("instagram-embed-unavailable").catch(() => undefined);
    throw new Error("instagram-embed-unavailable");
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBytes(response, MAX_INSTAGRAM_EMBED_BYTES);
  } catch (error) {
    if (!response.bodyUsed) await response.body?.cancel(error).catch(() => undefined);
    throw error;
  }
  const parsed = parseInstagramEmbed(new TextDecoder().decode(bytes), post);
  const expiresAt = Math.floor(Date.now() / 1_000) + INSTAGRAM_MEDIA_LINK_LIFESPAN_SECONDS;
  const items = await Promise.all(
    parsed.items.map(async ({ kind, source }, index) => {
      const extension =
        kind === "video"
          ? "mp4"
          : (/\.(png|webp|jpeg|jpg)$/iu.exec(source.pathname)?.[1].toLowerCase() ?? "jpg");
      const sequence = parsed.items.length > 1 ? `-${String(index + 1).padStart(2, "0")}` : "";
      const filename = `instagram-${post.shortcode}${sequence}.${extension}`;
      const url = new URL("/instagram-media", publicOrigin);
      url.searchParams.set("src", source.toString());
      url.searchParams.set("kind", kind);
      url.searchParams.set("expires", String(expiresAt));
      url.searchParams.set("bento_filename", filename);
      url.searchParams.set(
        "signature",
        await instagramMediaSignature(secret, expiresAt, kind, filename, source.toString()),
      );
      const signedUrl = url.toString();
      if (signedUrl.length > 2_048) throw new Error("oversized-instagram-media-link");
      return { kind, filename, url: signedUrl };
    }),
  );
  return { source: parsed.source, items, expiresInSeconds: INSTAGRAM_MEDIA_LINK_LIFESPAN_SECONDS };
}

async function instagramReference(request: Request, env: MediaResolverEnv, url: URL) {
  if (!isAuthorized(request, env)) return noStoreJson({ error: "Unauthorized" }, 401);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json")
    return noStoreJson({ error: "Expected application/json" }, 415);
  let body: Uint8Array;
  try {
    body = await readBoundedBytes(request, MAX_JSON_BYTES);
  } catch {
    return noStoreJson({ error: "Request is too large" }, 413);
  }
  const parsed = parseCobaltRequestBody(body);
  const post = parsed && Object.keys(parsed).length === 1 ? instagramPostFromUrl(parsed.url) : null;
  if (!post) return noStoreJson({ error: "Invalid Instagram post URL" }, 400);
  try {
    return noStoreJson(await resolveInstagramEmbed(post, env, url.origin, request.signal));
  } catch (error) {
    return noStoreJson(
      {
        error:
          error instanceof InstagramVideoUnavailable
            ? error.message
            : "Instagram embed unavailable",
      },
      502,
    );
  }
}

function instagramMediaRequest(url: URL, env: MediaResolverEnv) {
  const secret = env.RESOLVER_SHARED_SECRET?.trim();
  const rawSource = url.searchParams.get("src");
  const source = instagramCdnUrl(rawSource);
  const kind = url.searchParams.get("kind");
  const filename = url.searchParams.get("bento_filename") ?? "";
  if (kind !== "image" && kind !== "video") return null;
  const contentType = instagramMediaFilenameContentType(filename, kind);
  const expires = url.searchParams.get("expires") ?? "";
  const expiresAt = Number(expires);
  const signature = url.searchParams.get("signature") ?? "";
  const now = Math.floor(Date.now() / 1_000);
  if (
    !secret ||
    secret.length < 32 ||
    !source ||
    source.toString() !== rawSource ||
    !contentType ||
    !/^\d+$/u.test(expires) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + INSTAGRAM_MEDIA_LINK_LIFESPAN_SECONDS ||
    !/^[A-Za-z0-9_-]{43}$/u.test(signature) ||
    ["src", "kind", "bento_filename", "expires", "signature"].some(
      (name) => url.searchParams.getAll(name).length !== 1,
    )
  )
    return null;
  return { secret, source, kind, filename, contentType, expiresAt, signature } as const;
}

async function downloadRateLimitResponse(request: Request, env: MediaResolverEnv) {
  if (!env.TUNNEL_RATE_LIMITER) {
    return noStoreJson({ error: "Media resolver is temporarily unavailable" }, 503);
  }
  const clientAddress = request.headers.get("cf-connecting-ip")?.trim() || "missing-cloudflare-ip";
  const limited = await env.TUNNEL_RATE_LIMITER.limit({
    key: `media-tunnel:${clientAddress}`.slice(0, 512),
  });
  if (!limited.success) {
    return noStoreJson({ error: "Too many downloads. Please wait a minute and try again." }, 429, {
      "retry-after": "60",
    });
  }
  return null;
}

async function tunnelInstagramMedia(request: Request, env: MediaResolverEnv, url: URL) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return noStoreJson({ error: "Method not allowed" }, 405, { allow: "GET, HEAD" });
  }
  const parsed = instagramMediaRequest(url, env);
  if (
    !parsed ||
    !constantTimeEqual(
      parsed.signature,
      await instagramMediaSignature(
        parsed.secret,
        parsed.expiresAt,
        parsed.kind,
        parsed.filename,
        parsed.source.toString(),
      ),
    )
  )
    return noStoreJson({ error: "This download link is invalid or expired" }, 404);

  const rateLimited = await downloadRateLimitResponse(request, env);
  if (rateLimited) return rateLimited;

  const maxBytes = parsed.kind === "video" ? MAX_TUNNEL_BYTES : MAX_COVER_IMAGE_BYTES;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(MAX_TUNNEL_MILLISECONDS)]);
  try {
    const response = await fetchInstagramMedia(
      parsed.source,
      parsed.contentType,
      request.method,
      signal,
    );
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (
      response.status !== 200 ||
      contentType !== parsed.contentType ||
      (request.method === "GET" && !response.body)
    ) {
      console.warn("instagram_media_read_failed", {
        status: response.status,
        expected: parsed.contentType,
        received: contentType?.slice(0, 64),
        kind: parsed.kind,
      });
      await response.body?.cancel("invalid-instagram-media-response").catch(() => undefined);
      return noStoreJson({ error: "Download unavailable" }, 502);
    }
    const contentLength = response.headers.get("content-length");
    if (
      contentLength !== null &&
      (!/^\d+$/u.test(contentLength) || Number(contentLength) > maxBytes)
    ) {
      await response.body?.cancel("instagram-media-too-large").catch(() => undefined);
      return noStoreJson({ error: "This media file is too large" }, 413);
    }
    const disposition =
      parsed.kind === "video" || url.searchParams.get("bento_download") === "1"
        ? "attachment"
        : "inline";
    const headers = new Headers({
      "cache-control": "private, no-store",
      "content-disposition": `${disposition}; filename="${parsed.filename}"`,
      "content-type": contentType,
      "cross-origin-resource-policy": "same-site",
      "x-content-type-options": "nosniff",
    });
    const body =
      request.method === "GET" && response.body
        ? streamWithByteLimit(response.body, maxBytes, signal)
        : null;
    if (contentLength !== null && !response.headers.has("content-encoding")) {
      headers.set("content-length", contentLength);
    }
    if (!body) await response.body?.cancel().catch(() => undefined);
    return new Response(body, { headers });
  } catch {
    return noStoreJson({ error: "Download unavailable" }, 502);
  }
}

async function metadataJson(url: URL, requestSignal: AbortSignal) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "bento-media-gateway/1.0",
    },
    signal: AbortSignal.any([requestSignal, AbortSignal.timeout(UPSTREAM_ATTEMPT_MILLISECONDS)]),
  });
  if (!response.ok) throw new Error("metadata-unavailable");
  return readBoundedJson(response);
}

async function youtubeCoverSources(sourceUrl: string, requestSignal: AbortSignal) {
  const id = youtubeVideoIdFromUrl(sourceUrl);
  if (!id) return [];
  const candidates = [
    {
      source: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
      filename: `youtube-${id}-maxres.jpg`,
    },
    { source: `https://i.ytimg.com/vi/${id}/sddefault.jpg`, filename: `youtube-${id}-sd.jpg` },
    { source: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, filename: `youtube-${id}-hq.jpg` },
  ];
  const available = [];
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate.source, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.any([
          requestSignal,
          AbortSignal.timeout(UPSTREAM_ATTEMPT_MILLISECONDS),
        ]),
      });
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim();
      if (response.ok && contentType === "image/jpeg") available.push(candidate);
      await response.body?.cancel("cover-probe-complete").catch(() => undefined);
    } catch {
      // A lower-resolution thumbnail may still be available.
    }
  }
  return available;
}

async function oEmbedCoverSource(
  platform: "instagram" | "tiktok",
  sourceUrl: string,
  requestSignal: AbortSignal,
) {
  const endpoint = new URL(
    platform === "instagram"
      ? "https://www.instagram.com/api/v1/oembed/"
      : "https://www.tiktok.com/oembed",
  );
  endpoint.searchParams.set("url", sourceUrl);
  const payload = (await metadataJson(endpoint, requestSignal)) as { thumbnail_url?: unknown };
  if (typeof payload.thumbnail_url !== "string") return [];
  const source = validCoverSource(platform, payload.thumbnail_url);
  if (!source) return [];
  const id =
    platform === "instagram"
      ? new URL(sourceUrl).pathname.split("/").filter(Boolean).at(1)
      : new URL(sourceUrl).pathname.match(/\/video\/(\d{8,24})(?:\/|$)/u)?.[1];
  return [{ source, filename: `${platform}-${id || "cover"}-cover.jpg` }];
}

async function oracleTikTokCoverSource(
  env: MediaResolverEnv,
  sourceUrl: string,
  requestSignal: AbortSignal,
) {
  const upstream = optionalTiktokMetadataUpstream(env);
  if (!upstream) return [];
  const response = await fetch(upstream.url, {
    method: "POST",
    redirect: "manual",
    headers: upstreamHeaders(upstream.key, {
      accept: "application/json",
      "content-type": "application/json",
    }),
    body: JSON.stringify({ url: sourceUrl }),
    signal: AbortSignal.any([requestSignal, AbortSignal.timeout(UPSTREAM_ATTEMPT_MILLISECONDS)]),
  });
  if (!response.ok) {
    await response.body?.cancel("metadata-unavailable").catch(() => undefined);
    return [];
  }
  const payload = (await readBoundedJson(response)) as { thumbnail_url?: unknown };
  if (typeof payload.thumbnail_url !== "string") return [];
  const source = validCoverSource("tiktok", payload.thumbnail_url);
  if (!source) return [];
  const id = new URL(sourceUrl).pathname.match(/\/video\/(\d{8,24})(?:\/|$)/u)?.[1];
  return [{ source, filename: `tiktok-${id || "cover"}-cover.jpg` }];
}

async function coverSources(
  env: MediaResolverEnv,
  platform: CoverPlatform,
  sourceUrl: string,
  requestSignal: AbortSignal,
) {
  if (platform === "youtube") return youtubeCoverSources(sourceUrl, requestSignal);
  try {
    const direct = await oEmbedCoverSource(platform, sourceUrl, requestSignal);
    if (direct.length > 0 || platform === "instagram") return direct;
  } catch {
    if (platform === "instagram") return [];
  }
  try {
    const post = await fetchTikTokPublicPost(sourceUrl, requestSignal);
    if (post.cover) return [{ source: post.cover, filename: `tiktok-${post.id}-cover.jpg` }];
  } catch (error) {
    if (error instanceof TikTokPublicError && error.reason !== "unavailable") return [];
  }
  return oracleTikTokCoverSource(env, sourceUrl, requestSignal);
}

async function resolveCover(request: Request, env: MediaResolverEnv, url: URL) {
  if (!isAuthorized(request, env)) return noStoreJson({ error: "Unauthorized" }, 401);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return noStoreJson({ error: "Expected application/json" }, 415);
  }
  let body: Uint8Array;
  try {
    body = await readBoundedBytes(request, MAX_JSON_BYTES);
  } catch {
    return noStoreJson({ error: "Request is too large" }, 413);
  }
  const parsed = parseCoverRequest(body);
  if (!parsed) return noStoreJson({ error: "Invalid cover request" }, 400);

  try {
    const sources = await coverSources(env, parsed.platform, parsed.url, request.signal);
    const picker = await Promise.all(
      sources.map(async ({ source, filename }) => ({
        type: "photo",
        filename,
        url: await signedCoverUrl(url.origin, env, parsed.platform, source, filename),
      })),
    );
    return picker.length
      ? noStoreJson({ status: "picker", picker })
      : noStoreJson({ status: "error", error: { code: "error.api.cover.unavailable" } });
  } catch {
    return noStoreJson({ status: "error", error: { code: "error.api.cover.unavailable" } });
  }
}

function coverImageRequest(url: URL, env: MediaResolverEnv) {
  const source = url.searchParams.get("src") ?? "";
  const platform = url.searchParams.get("platform");
  const filename = url.searchParams.get("bento_filename") ?? "";
  const expires = url.searchParams.get("expires") ?? "";
  const signature = url.searchParams.get("signature") ?? "";
  const secret = env.RESOLVER_SHARED_SECRET?.trim();
  if (
    !secret ||
    secret.length < 32 ||
    !isCoverPlatform(platform) ||
    !/^\d{10}$/u.test(expires) ||
    !/^[A-Za-z0-9._ -]{1,180}\.(?:jpe?g|png|webp)$/iu.test(filename) ||
    !validCoverSource(platform, source) ||
    url.searchParams.getAll("src").length !== 1 ||
    url.searchParams.getAll("signature").length !== 1
  ) {
    return null;
  }
  const expiresAt = Number(expires);
  const now = Math.floor(Date.now() / 1_000);
  if (expiresAt < now || expiresAt > now + COVER_LINK_LIFESPAN_SECONDS + 5) return null;
  return { source, platform, filename, expiresAt, signature, secret };
}

async function tunnelCoverImage(request: Request, env: MediaResolverEnv, url: URL) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return noStoreJson({ error: "Method not allowed" }, 405, { allow: "GET, HEAD" });
  }
  const parsed = coverImageRequest(url, env);
  if (!parsed) return noStoreJson({ error: "This cover link is invalid or expired" }, 404);
  const expected = await coverSignature(
    parsed.secret,
    signaturePayload(parsed.expiresAt, parsed.platform, parsed.filename, parsed.source),
  );
  if (!constantTimeEqual(expected, parsed.signature)) {
    return noStoreJson({ error: "This cover link is invalid or expired" }, 404);
  }
  if (!env.TUNNEL_RATE_LIMITER) {
    return noStoreJson({ error: "Media resolver is temporarily unavailable" }, 503);
  }
  const clientAddress = request.headers.get("cf-connecting-ip")?.trim() || "missing-cloudflare-ip";
  const limited = await env.TUNNEL_RATE_LIMITER.limit({
    key: `cover-image:${clientAddress}`.slice(0, 512),
  });
  if (!limited.success) {
    return noStoreJson({ error: "Too many downloads. Please wait a minute and try again." }, 429, {
      "retry-after": "60",
    });
  }

  const timeoutSignal = AbortSignal.timeout(MAX_TUNNEL_MILLISECONDS);
  const signal = AbortSignal.any([request.signal, timeoutSignal]);
  const response = await fetch(parsed.source, {
    method: request.method,
    headers: {
      accept: "image/avif,image/webp,image/png,image/jpeg,image/*",
      "user-agent": "bento-media-gateway/1.0",
    },
    redirect: "follow",
    signal,
  });
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const extension = contentType ? MEDIA_EXTENSIONS.get(contentType) : undefined;
  if (
    !response.ok ||
    !contentType?.startsWith("image/") ||
    !extension ||
    !validCoverSource(parsed.platform, response.url || parsed.source)
  ) {
    await response.body?.cancel("invalid-cover-response").catch(() => undefined);
    return noStoreJson({ error: "Cover image unavailable" }, 502);
  }
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_COVER_IMAGE_BYTES)
  ) {
    await response.body?.cancel("cover-too-large").catch(() => undefined);
    return noStoreJson({ error: "This cover image is larger than Bento's 20 MB limit" }, 413);
  }

  const download = url.searchParams.get("bento_download") === "1";
  const outputHeaders = new Headers({
    "cache-control": "private, no-store",
    "content-disposition": `${download ? "attachment" : "inline"}; filename="${safeAttachmentFilename(parsed.filename, extension)}"`,
    "content-type": contentType,
    "cross-origin-resource-policy": "same-site",
    "x-content-type-options": "nosniff",
  });
  if (contentLength) outputHeaders.set("content-length", contentLength);
  const responseBody =
    request.method === "HEAD" || !response.body
      ? null
      : streamWithByteLimit(response.body, MAX_COVER_IMAGE_BYTES, signal);
  return new Response(responseBody, { status: response.status, headers: outputHeaders });
}

function tunnelUpstream(env: MediaResolverEnv, pathname: string) {
  const rawUrl = pathname.startsWith("/youtube-session/tunnel")
    ? env.COBALT_YOUTUBE_SESSION_URL
    : pathname.startsWith("/webshare/tunnel")
      ? env.COBALT_PROXY_URL
      : pathname === "/tunnel" || pathname.startsWith("/tunnel/")
        ? env.COBALT_UPSTREAM_URL
        : undefined;
  if (!rawUrl) return null;
  try {
    const upstream = cobaltUpstream(env, rawUrl);
    const basePath = upstream.url.pathname.replace(/\/$/u, "");
    const tunnelPath = `${basePath}/tunnel`;
    if (pathname !== tunnelPath && !pathname.startsWith(`${tunnelPath}/`)) return null;
    return { upstream, relativePath: pathname.slice(basePath.length).replace(/^\//u, "") };
  } catch {
    return null;
  }
}

async function tunnelMedia(request: Request, env: MediaResolverEnv, url: URL) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return noStoreJson({ error: "Method not allowed" }, 405, { allow: "GET, HEAD" });
  }
  if (!env.TUNNEL_RATE_LIMITER) {
    return noStoreJson({ error: "Media resolver is temporarily unavailable" }, 503);
  }
  const clientAddress = request.headers.get("cf-connecting-ip")?.trim() || "missing-cloudflare-ip";
  const limited = await env.TUNNEL_RATE_LIMITER.limit({
    key: `media-tunnel:${clientAddress}`.slice(0, 512),
  });
  if (!limited.success) {
    return noStoreJson({ error: "Too many downloads. Please wait a minute and try again." }, 429, {
      "retry-after": "60",
    });
  }

  const headers = new Headers();
  for (const name of ["accept", "range", "if-range", "user-agent", "cf-connecting-ip"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const route = tunnelUpstream(env, url.pathname);
  if (!route) {
    return noStoreJson({ error: "Media resolver is temporarily unavailable" }, 503);
  }
  const { upstream, relativePath } = route;
  const providerUrl = new URL(`${relativePath}${url.search}`, upstream.url);
  const requestedFilename = providerUrl.searchParams.get("bento_filename");
  providerUrl.searchParams.delete("bento_filename");
  const timeoutSignal = AbortSignal.timeout(MAX_TUNNEL_MILLISECONDS);
  const signal = AbortSignal.any([request.signal, timeoutSignal]);
  const response = await fetch(providerUrl, {
    method: request.method,
    headers: upstreamHeaders(upstream.key, headers),
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel("upstream-error").catch(() => undefined);
    return noStoreJson(
      { error: response.status === 404 ? "This download link expired" : "Download unavailable" },
      response.status === 404 ? 404 : 502,
    );
  }

  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const extension = contentType ? MEDIA_EXTENSIONS.get(contentType) : undefined;
  if (!contentType || !extension) {
    await response.body?.cancel("unsupported-media-type").catch(() => undefined);
    return noStoreJson({ error: "The media service returned an unsupported file type" }, 502);
  }
  for (const name of ["content-length", "estimated-content-length"]) {
    const value = response.headers.get(name);
    if (value !== null && (!/^\d+$/u.test(value) || Number(value) > MAX_TUNNEL_BYTES)) {
      await response.body?.cancel("media-too-large").catch(() => undefined);
      return noStoreJson({ error: "This media file is larger than Bento's 512 MB limit" }, 413);
    }
  }

  const outputHeaders = new Headers({
    "cache-control": "private, no-store",
    "content-disposition": `attachment; filename="${safeAttachmentFilename(requestedFilename, extension)}"`,
    "content-type": contentType,
    "cross-origin-resource-policy": "same-site",
    "x-content-type-options": "nosniff",
  });
  for (const name of [
    "accept-ranges",
    "content-length",
    "content-range",
    "estimated-content-length",
    "etag",
    "last-modified",
  ]) {
    const value = response.headers.get(name);
    if (value) outputHeaders.set(name, value);
  }
  const body =
    request.method === "HEAD" || !response.body
      ? null
      : streamWithByteLimit(response.body, MAX_TUNNEL_BYTES, signal);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: outputHeaders,
  });
}

async function tunnelYouTubeStream(request: Request, env: MediaResolverEnv, url: URL) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return noStoreJson({ error: "Method not allowed" }, 405, { allow: "GET, HEAD" });
  }
  const secret = env.RESOLVER_SHARED_SECRET?.trim();
  const videoId = url.searchParams.get("v") ?? "";
  const itag = Number(url.searchParams.get("itag"));
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature") ?? "";
  const now = Math.floor(Date.now() / 1_000);
  if (
    !secret ||
    !/^[A-Za-z0-9_-]{11}$/u.test(videoId) ||
    !Number.isSafeInteger(itag) ||
    itag <= 0 ||
    !Number.isSafeInteger(expires) ||
    expires < now ||
    expires > now + YOUTUBE_STREAM_LIFESPAN_SECONDS ||
    !/^[A-Za-z0-9_-]{43}$/u.test(signature) ||
    !constantTimeEqual(signature, await youtubeStreamSignature(secret, videoId, itag, expires))
  ) {
    return noStoreJson({ error: "This download link expired" }, 404);
  }
  if (!env.TUNNEL_RATE_LIMITER) {
    return noStoreJson({ error: "Media resolver is temporarily unavailable" }, 503);
  }
  const clientAddress = request.headers.get("cf-connecting-ip")?.trim() || "missing-cloudflare-ip";
  const limited = await env.TUNNEL_RATE_LIMITER.limit({
    key: `media-tunnel:${clientAddress}`.slice(0, 512),
  });
  if (!limited.success) {
    return noStoreJson({ error: "Too many downloads. Please wait a minute and try again." }, 429, {
      "retry-after": "60",
    });
  }

  try {
    const { payload: player, userAgent } = await youtubePlayer(videoId, request.signal);
    const format = [
      ...(player.streamingData?.formats ?? []),
      ...(player.streamingData?.adaptiveFormats ?? []),
    ].find((candidate) => candidate.itag === itag);
    const initialProviderUrl = safeGoogleVideoUrl(format?.url);
    if (!initialProviderUrl) throw new Error("youtube-format-unavailable");
    let providerUrl: URL = initialProviderUrl;

    const headers = new Headers({ accept: "*/*", "user-agent": userAgent });
    for (const name of ["range", "if-range"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await fetch(providerUrl, {
        method: request.method,
        headers,
        redirect: "manual",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(MAX_TUNNEL_MILLISECONDS)]),
      });
      if (response.status < 300 || response.status >= 400) break;
      const location: string | null = response.headers.get("location");
      const nextUrl: URL | null = location
        ? safeGoogleVideoUrl(new URL(location, providerUrl).toString())
        : null;
      await response.body?.cancel("youtube-redirect").catch(() => undefined);
      if (!nextUrl) throw new Error("invalid-youtube-redirect");
      providerUrl = nextUrl;
    }
    if (!response?.ok || response.status >= 300) {
      await response?.body?.cancel("youtube-upstream-error").catch(() => undefined);
      throw new Error("youtube-stream-unavailable");
    }

    const contentType = response.headers.get("content-type")?.split(";", 1)[0].toLowerCase();
    const extension = contentType ? MEDIA_EXTENSIONS.get(contentType) : undefined;
    if (!contentType || !extension) {
      await response.body?.cancel("unsupported-youtube-media").catch(() => undefined);
      throw new Error("unsupported-youtube-media");
    }
    const contentLength = response.headers.get("content-length");
    if (
      contentLength &&
      (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_TUNNEL_BYTES)
    ) {
      await response.body?.cancel("youtube-media-too-large").catch(() => undefined);
      return noStoreJson({ error: "This media file is larger than Bento's 512 MB limit" }, 413);
    }

    const requestedFilename = url.searchParams.get("bento_filename");
    const outputHeaders = new Headers({
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="${safeAttachmentFilename(requestedFilename, extension)}"`,
      "content-type": contentType,
      "cross-origin-resource-policy": "same-site",
      "x-content-type-options": "nosniff",
    });
    for (const name of [
      "accept-ranges",
      "content-length",
      "content-range",
      "etag",
      "last-modified",
    ]) {
      const value = response.headers.get(name);
      if (value) outputHeaders.set(name, value);
    }
    const body =
      request.method === "HEAD" || !response.body
        ? null
        : streamWithByteLimit(response.body, MAX_TUNNEL_BYTES, request.signal);
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: outputHeaders,
    });
  } catch {
    return noStoreJson({ error: "Download unavailable" }, 502);
  }
}

async function health(request: Request, env: MediaResolverEnv) {
  if (!isAuthorized(request, env)) return noStoreJson({ ok: false }, 401);
  try {
    const configured: HealthRoute[] = [
      cobaltHealthRoute(env, "direct"),
      ...(env.COBALT_YOUTUBE_SESSION_URL?.trim()
        ? [cobaltHealthRoute(env, "youtube-session", env.COBALT_YOUTUBE_SESSION_URL)]
        : []),
      ...(env.COBALT_PROXY_URL?.trim()
        ? [cobaltHealthRoute(env, "webshare", env.COBALT_PROXY_URL)]
        : []),
      ...(env.TIKTOK_METADATA_URL?.trim() ? [tiktokMetadataHealthRoute(env)] : []),
    ];
    const configuredUrls = configured.map(({ url }) => url.toString());
    if (new Set(configuredUrls).size !== configuredUrls.length) {
      return noStoreJson(
        {
          ok: false,
          version: null,
          services: [],
          routes: configured.map(({ name }) => ({
            name,
            ok: false,
            version: null,
            services: [],
          })),
        },
        503,
      );
    }
    const routes = await Promise.all(
      configured.map(async ({ kind, name, upstream, url }) => {
        const response = await fetch(url, {
          headers: upstreamHeaders(upstream.key, { accept: "application/json" }),
          redirect: "manual",
          signal: AbortSignal.timeout(UPSTREAM_ATTEMPT_MILLISECONDS),
        });
        const payload = (await readBoundedJson(response)) as {
          cobalt?: { url?: unknown; version?: unknown; services?: unknown };
          error?: { code?: unknown };
          ok?: unknown;
          services?: unknown;
        };
        if (!response.ok) {
          console.error("media health upstream rejected", {
            route: name,
            status: response.status,
            code: typeof payload.error?.code === "string" ? payload.error.code : null,
          });
        }
        if (kind === "metadata") {
          return {
            name,
            ok: response.ok && payload.ok === true,
            version: null,
            services: Array.isArray(payload.services) ? payload.services : [],
          };
        }
        return {
          name,
          ok: response.ok && payload.cobalt?.url === url.toString(),
          version: typeof payload.cobalt?.version === "string" ? payload.cobalt.version : null,
          services: Array.isArray(payload.cobalt?.services) ? payload.cobalt.services : [],
        };
      }),
    );
    const direct = routes[0];
    const ok = routes.every((route) => route.ok);
    return noStoreJson(
      {
        ok,
        version: direct?.version ?? null,
        services: direct?.services ?? [],
        routes,
      },
      ok ? 200 : 503,
    );
  } catch (error) {
    console.error("cobalt health upstream failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "Unknown failure",
    });
    return noStoreJson({ ok: false }, 503);
  }
}

export default {
  async fetch(request: Request, env: MediaResolverEnv) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return health(request, env);
    if (url.pathname === "/post-stats" && request.method === "POST") {
      if (!isAuthorized(request, env)) return noStoreJson({ error: "Unauthorized" }, 401);
      try {
        const body = JSON.parse(new TextDecoder().decode(await readBoundedBytes(request, 4096)));
        if (!body || Object.keys(body).length !== 1 || typeof body.url !== "string")
          return noStoreJson({ error: "Invalid post link" }, 400);
        return noStoreJson(await extractPublicPostStats(body.url, env, { signal: request.signal }));
      } catch (error) {
        console.warn("Public post metadata extraction failed", {
          code: error instanceof PostStatsExtractionError ? error.message : "unknown",
          status: error instanceof PostStatsExtractionError ? error.status : 502,
        });
        return noStoreJson(
          {
            error:
              error instanceof PostStatsExtractionError
                ? error.message
                : "Post statistics extraction failed",
          },
          error instanceof PostStatsExtractionError ? error.status : 502,
        );
      }
    }
    if (url.pathname === "/cover" && request.method === "POST") {
      return resolveCover(request, env, url);
    }
    if (url.pathname === "/instagram-reference" && request.method === "POST") {
      return instagramReference(request, env, url);
    }
    if ((url.pathname === "/" || url.pathname === "/resolve") && request.method === "POST") {
      return resolveMedia(request, env, url);
    }
    if (url.pathname === BASIC_MEDIA_PATH)
      return tunnelBasicMedia(request, env, () => downloadRateLimitResponse(request, env));
    if (url.pathname === "/image") return tunnelCoverImage(request, env, url);
    if (url.pathname === PUBLIC_SOCIAL_MEDIA_PATH) return tunnelPublicMedia(request, env, url);
    if (url.pathname === "/instagram-media") return tunnelInstagramMedia(request, env, url);
    if (url.pathname === "/youtube-stream") return tunnelYouTubeStream(request, env, url);
    if (/^(?:\/(?:youtube-session|webshare))?\/tunnel(?:\/|$)/u.test(url.pathname)) {
      return tunnelMedia(request, env, url);
    }
    return noStoreJson({ error: "Not found" }, 404);
  },
};
