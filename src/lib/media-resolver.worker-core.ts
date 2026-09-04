import { socialEmbedSourceUrl, youtubeVideoIdFromUrl } from "./social-embeds";

const MAX_JSON_BYTES = 64 * 1024;
const MAX_TUNNEL_BYTES = 512 * 1024 * 1024;
const MAX_COVER_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TUNNEL_MILLISECONDS = 30 * 60 * 1_000;
const UPSTREAM_ATTEMPT_MILLISECONDS = 9_000;
const COVER_LINK_LIFESPAN_SECONDS = 90;
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

export type MediaResolverEnv = {
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

export async function readBoundedBytes(
  source: Pick<Request | Response, "body" | "headers">,
  maxBytes: number,
) {
  const contentLength = source.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength) || Number(contentLength) > maxBytes) {
      throw new Error("oversized");
    }
  }
  if (!source.body) return new Uint8Array();

  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("oversized");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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

function isCobaltPayload(value: unknown): value is { status: string } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { status?: unknown }).status === "string"
  );
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
    if (!response.ok || !contentType || !MEDIA_EXTENSIONS.has(contentType) || !response.body) {
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
    const probeYouTube =
      typeof parsedRequest?.url === "string" && Boolean(youtubeVideoIdFromUrl(parsedRequest.url));
    let lastErrorPayload: unknown = null;
    for (const candidate of cobaltUpstreamCandidates(env, body)) {
      try {
        const { payload, rawPayload } = await requestCobalt(
          candidate.upstream,
          candidate.body,
          url.origin,
          request.signal,
        );
        if (isSuccessfulCobaltPayload(payload)) {
          if (
            !probeYouTube ||
            (await probeCobaltTunnel(rawPayload, candidate.upstream, request.signal))
          ) {
            return noStoreJson(payload);
          }
          continue;
        }
        lastErrorPayload = payload;
        if (!isRetryableCobaltError(payload)) return noStoreJson(payload);
      } catch {
        // Try the next configured zero-cost route.
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
    if (url.pathname === "/cover" && request.method === "POST") {
      return resolveCover(request, env, url);
    }
    if ((url.pathname === "/" || url.pathname === "/resolve") && request.method === "POST") {
      return resolveMedia(request, env, url);
    }
    if (url.pathname === "/image") return tunnelCoverImage(request, env, url);
    if (/^(?:\/(?:youtube-session|webshare))?\/tunnel(?:\/|$)/u.test(url.pathname)) {
      return tunnelMedia(request, env, url);
    }
    return noStoreJson({ error: "Not found" }, 404);
  },
};
