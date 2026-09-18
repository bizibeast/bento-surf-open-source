import {
  MEDIA_DOWNLOAD_EXPIRES_IN_SECONDS,
  MEDIA_DOWNLOAD_MAX_ITEMS,
  MEDIA_TOOLS_API_PATH,
  isMediaDownloadQuality,
  isMediaToolSlug,
  mediaToolSpecsBySlug,
  type MediaDownloadQuality,
  type MediaToolFilter,
  type MediaToolDownloadItem,
  type MediaToolDownloadResult,
  type MediaToolOperation,
  type MediaToolPlatform,
  type MediaToolRequest,
  type MediaToolTranscriptResult,
  type ResolvedMediaToolPlatform,
} from "./media-tools";
import {
  RequestBodyTooLargeError,
  RequestHttpError,
  enforceTurnstileRequest,
  readRequestText,
  readResponseBytes,
  readResponseText,
} from "./request-security.server";
import { parsePublicHttpUrl } from "./safe-url";
import { socialEmbedSourceUrl, tiktokPhotoSourceUrl } from "./social-embeds";
import {
  canonicalAudioContentType,
  detectTranscriptionAudioFormat,
  isTranscriptionProviderConfigured,
  transcribeAudioBytes,
  type TranscriptionEnv,
} from "./transcription-tool.server";
import {
  MAX_TRANSCRIPTION_BYTES,
  MAX_TRANSCRIPTION_SIZE_LABEL,
  type TranscriptionResult,
} from "./transcription-tool";

export { MEDIA_TOOLS_API_PATH } from "./media-tools";

const MAX_MEDIA_REQUEST_BYTES = 4 * 1024;
const MAX_COBALT_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_TIMEOUT_MS = 60_000;
const TRANSCRIPT_DOWNLOAD_TIMEOUT_MS = 90_000;
const MIN_TRANSCRIPTION_BYTES = 32;
export const MAX_MEDIA_DOWNLOAD_ITEMS = MEDIA_DOWNLOAD_MAX_ITEMS;

type RateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type MediaToolsEnv = TranscriptionEnv & {
  COBALT_API_KEY?: string;
  COBALT_API_URL?: string;
  FREE_TOOLS_MEDIA_RATE_LIMITER?: RateLimitBinding;
};

type MediaTranscriber = (
  bytes: Uint8Array,
  contentType: string,
  env: TranscriptionEnv,
  signal: AbortSignal,
) => Promise<TranscriptionResult | null>;

export type MediaToolsDependencies = {
  fetcher?: typeof fetch;
  providerTimeoutMs?: number;
  transcriptDownloadTimeoutMs?: number;
  transcribeAudio?: MediaTranscriber;
};

export type ParsedMediaToolRequest = MediaToolRequest & {
  operation: MediaToolOperation;
  platform: MediaToolPlatform;
  mediaFilter?: MediaToolFilter;
};

type ResolvedMediaToolRequest = Omit<ParsedMediaToolRequest, "platform"> & {
  platform: ResolvedMediaToolPlatform;
};

type CobaltConfig = {
  apiUrl: string;
  coverUrl: string;
  apiOrigin: string;
  apiKey: string;
};

type CobaltPayload = {
  status?: unknown;
  url?: unknown;
  filename?: unknown;
  picker?: unknown;
  audio?: unknown;
  audioFilename?: unknown;
  error?: unknown;
};

class MediaToolHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MediaToolHttpError";
  }
}

function responseHeaders(status?: number) {
  const headers = new Headers({
    "cache-control": "private, no-store",
    vary: "origin",
  });
  if (status === 429) headers.set("retry-after", "60");
  return headers;
}

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: responseHeaders(status) });
}

function normalizedContentType(request: Request) {
  return request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseMediaToolRequest(body: string): ParsedMediaToolRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (!isPlainJsonObject(value)) return null;

  const keys = Object.keys(value);
  if (
    keys.length < 2 ||
    keys.length > 3 ||
    keys.some((key) => key !== "toolSlug" && key !== "url" && key !== "quality")
  ) {
    return null;
  }
  if (!isMediaToolSlug(value.toolSlug)) return null;
  if (typeof value.url !== "string" || !value.url.trim() || value.url.length > 2_048) return null;
  if (
    Object.prototype.hasOwnProperty.call(value, "quality") &&
    !isMediaDownloadQuality(value.quality)
  ) {
    return null;
  }

  const spec = mediaToolSpecsBySlug[value.toolSlug];
  const mediaFilter = "media" in spec ? spec.media : undefined;
  if (
    (spec.operation !== "download" || mediaFilter === "image") &&
    Object.prototype.hasOwnProperty.call(value, "quality")
  ) {
    return null;
  }
  return {
    toolSlug: value.toolSlug,
    url: value.url.trim(),
    ...(isMediaDownloadQuality(value.quality) ? { quality: value.quality } : {}),
    platform: spec.platform,
    operation: spec.operation,
    ...(mediaFilter ? { mediaFilter } : {}),
  };
}

function normalizedUrlString(url: URL) {
  url.hash = "";
  return url.toString();
}

function normalizeResolvedMediaSourceUrl(platform: ResolvedMediaToolPlatform, input: string) {
  const url = parsePublicHttpUrl(input, {
    requireHttps: true,
    allowNonStandardPort: false,
  });
  if (!url) return null;

  if (platform === "tiktok") {
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    if (hostname === "vm.tiktok.com" || hostname === "vt.tiktok.com") {
      return /^\/[A-Za-z0-9_-]{5,64}\/?$/u.test(url.pathname) ? normalizedUrlString(url) : null;
    }
    const photoSource = tiktokPhotoSourceUrl(normalizedUrlString(url));
    if (photoSource) return normalizedUrlString(new URL(photoSource));
  }

  const source = socialEmbedSourceUrl(platform, normalizedUrlString(url));
  if (!source) return null;
  const normalized = new URL(source);
  return normalizedUrlString(normalized);
}

const detectedMediaPlatforms = ["youtube", "instagram", "tiktok", "twitter"] as const;

export function detectMediaToolPlatform(input: string): ResolvedMediaToolPlatform | null {
  return (
    detectedMediaPlatforms.find((platform) => normalizeResolvedMediaSourceUrl(platform, input)) ??
    null
  );
}

export function normalizeMediaSourceUrl(platform: MediaToolPlatform, input: string) {
  const resolvedPlatform = platform === "auto" ? detectMediaToolPlatform(input) : platform;
  return resolvedPlatform ? normalizeResolvedMediaSourceUrl(resolvedPlatform, input) : null;
}

function environmentValue(envValue: string | undefined, processName: string) {
  const direct = envValue?.trim();
  if (direct) return direct;
  return process.env[processName]?.trim() || "";
}

function cobaltConfiguration(env: MediaToolsEnv): CobaltConfig | null {
  const rawUrl = environmentValue(env.COBALT_API_URL, "COBALT_API_URL");
  const apiKey = environmentValue(env.COBALT_API_KEY, "COBALT_API_KEY");
  if (!rawUrl || !apiKey || apiKey.length > 2_048) return null;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    hostname === "api.cobalt.tools"
  ) {
    return null;
  }
  return {
    apiUrl: `${url.origin}/`,
    coverUrl: `${url.origin}/cover`,
    apiOrigin: url.origin,
    apiKey,
  };
}

function isProductionLike(env: MediaToolsEnv) {
  return env.APP_ENV === "production" || env.APP_ENV === "staging";
}

async function enforceMediaToolRateLimit(
  request: Request,
  env: MediaToolsEnv,
  operation: MediaToolOperation,
) {
  const limiter =
    operation === "transcript"
      ? env.FREE_TOOLS_TRANSCRIPTION_RATE_LIMITER
      : env.FREE_TOOLS_MEDIA_RATE_LIMITER;
  if (!limiter) return !isProductionLike(env);

  const clientAddress = request.headers.get("cf-connecting-ip")?.trim() || "missing-cloudflare-ip";
  const scope = operation === "transcript" ? "free-tool-transcription" : "free-tool-media";
  const result = await limiter.limit({ key: `${scope}:${clientAddress}`.slice(0, 512) });
  return result.success;
}

function timeoutMilliseconds(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PROVIDER_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_PROVIDER_TIMEOUT_MS, Math.floor(value)));
}

function transcriptDownloadTimeoutMilliseconds(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TRANSCRIPT_DOWNLOAD_TIMEOUT_MS;
  }
  return Math.max(1, Math.min(TRANSCRIPT_DOWNLOAD_TIMEOUT_MS, Math.floor(value)));
}

function cobaltVideoQuality(quality: MediaDownloadQuality | undefined) {
  const values: Record<MediaDownloadQuality, string> = {
    best: "max",
    "1080p": "1080",
    "720p": "720",
    "480p": "480",
    "360p": "360",
  };
  return values[quality ?? "best"];
}

function cobaltRequestBody(request: ResolvedMediaToolRequest, sourceUrl: string) {
  if (request.operation === "cover") {
    return { url: sourceUrl, platform: request.platform };
  }
  if (request.operation === "download") {
    return {
      url: sourceUrl,
      ...(request.mediaFilter === "image"
        ? {}
        : { videoQuality: cobaltVideoQuality(request.quality) }),
      downloadMode: "auto",
      alwaysProxy: true,
      localProcessing: "disabled",
    };
  }
  return {
    url: sourceUrl,
    downloadMode: "audio",
    audioFormat: "mp3",
    audioBitrate: "64",
    alwaysProxy: true,
    localProcessing: "disabled",
    ...(request.platform === "tiktok" ? { tiktokFullAudio: false } : {}),
  };
}

async function requestCobaltMedia(
  mediaRequest: ResolvedMediaToolRequest,
  sourceUrl: string,
  config: CobaltConfig,
  requestSignal: AbortSignal,
  dependencies: MediaToolsDependencies,
) {
  const timeoutSignal = AbortSignal.timeout(timeoutMilliseconds(dependencies.providerTimeoutMs));
  const signal = AbortSignal.any([requestSignal, timeoutSignal]);
  try {
    const response = await (dependencies.fetcher ?? fetch)(
      mediaRequest.operation === "cover" ? config.coverUrl : config.apiUrl,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Api-Key ${config.apiKey}`,
        },
        body: JSON.stringify(cobaltRequestBody(mediaRequest, sourceUrl)),
        signal,
      },
    );
    if (response.status === 429) {
      throw new MediaToolHttpError(429, "The media service is busy. Please wait a minute.");
    }
    if (!response.ok) {
      throw new MediaToolHttpError(502, "The media service could not process that link");
    }

    const text = await readResponseText(response, MAX_COBALT_RESPONSE_BYTES);
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new MediaToolHttpError(502, "The media service returned an invalid response");
    }
    if (!isPlainJsonObject(payload)) {
      throw new MediaToolHttpError(502, "The media service returned an invalid response");
    }
    return payload as CobaltPayload;
  } catch (error) {
    if (error instanceof MediaToolHttpError) throw error;
    if (timeoutSignal.aborted) {
      throw new MediaToolHttpError(504, "The media service took too long to respond");
    }
    throw new MediaToolHttpError(502, "The media service could not process that link");
  }
}

function validatedTunnelUrl(value: unknown, cobaltOrigin: string) {
  if (typeof value !== "string" || !value || value.length > 2_048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.origin !== cobaltOrigin ||
    !(
      url.pathname === "/image" ||
      url.pathname === "/youtube-stream" ||
      /^(?:\/(?:youtube-session|webshare))?\/tunnel(?:\/|$)/u.test(url.pathname)
    )
  ) {
    return null;
  }
  url.hash = "";
  return url.toString();
}

function sanitizedFilenameText(value: unknown) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}/\\]+/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 180);
}

function safeFilenameStem(value: unknown, fallback: string) {
  const sanitized = sanitizedFilenameText(value);
  const finalDot = sanitized.lastIndexOf(".");
  const withoutFinalExtension = finalDot > 0 ? sanitized.slice(0, finalDot) : sanitized;
  const stem = withoutFinalExtension
    .replace(/\.+/gu, "-")
    .replace(/^[ .-]+|[ .-]+$/gu, "")
    .trim();
  return stem || fallback;
}

function safeFilenameWithExtension(value: unknown, fallback: string, extension: string) {
  const suffix = `.${extension}`;
  const stem = safeFilenameStem(value, fallback).slice(0, 180 - suffix.length);
  return `${stem}${suffix}`;
}

function downloadMediaType(value: unknown): MediaToolDownloadItem["mediaType"] {
  const filename = sanitizedFilenameText(value).toLowerCase();
  if (filename.endsWith(".gif")) return "gif";
  return /\.(?:jpe?g|png|webp)$/u.test(filename) ? "image" : "video";
}

function matchesMediaFilter(
  mediaType: MediaToolDownloadItem["mediaType"],
  filter: MediaToolFilter | undefined,
) {
  if (filter === "all") return true;
  if (filter === "image") return mediaType === "image";
  return mediaType === "video" || mediaType === "gif";
}

function safeDownloadFilename(
  value: unknown,
  fallback: string,
  mediaType: MediaToolDownloadItem["mediaType"],
) {
  const sanitized = sanitizedFilenameText(value).toLowerCase();
  const extension =
    mediaType === "gif"
      ? "gif"
      : mediaType === "image"
        ? sanitized.endsWith(".png")
          ? "png"
          : sanitized.endsWith(".webp")
            ? "webp"
            : sanitized.endsWith(".jpeg")
              ? "jpeg"
              : "jpg"
        : sanitized.endsWith(".webm")
          ? "webm"
          : "mp4";
  return safeFilenameWithExtension(value, fallback, extension);
}

function safeAudioFilename(value: unknown) {
  return safeFilenameWithExtension(value, "bento-transcript-audio", "mp3");
}

function tunnelKey(value: string) {
  const url = new URL(value);
  url.searchParams.delete("bento_filename");
  return url.toString();
}

function withBentoFilename(value: string, filename: string) {
  const url = new URL(value);
  url.searchParams.set("bento_filename", filename);
  const result = url.toString();
  return result.length <= 2_048 ? result : null;
}

function downloadItemsFromCobalt(
  payload: CobaltPayload,
  request: ResolvedMediaToolRequest,
  cobaltOrigin: string,
): MediaToolDownloadItem[] {
  const coverRequest = request.operation === "cover";
  if (payload.status === "tunnel" || payload.status === "redirect") {
    const validatedUrl = validatedTunnelUrl(payload.url, cobaltOrigin);
    if (!validatedUrl) return [];
    const mediaType = coverRequest ? "image" : downloadMediaType(payload.filename);
    if (!coverRequest && !matchesMediaFilter(mediaType, request.mediaFilter)) return [];
    const filename = safeDownloadFilename(
      payload.filename,
      `${request.platform}-${coverRequest ? "cover" : mediaType}`,
      mediaType,
    );
    const url = withBentoFilename(validatedUrl, filename);
    if (!url) return [];
    return [
      {
        url,
        filename,
        mediaType,
      },
    ];
  }
  if (payload.status !== "picker" || !Array.isArray(payload.picker)) return [];

  const items: MediaToolDownloadItem[] = [];
  const seen = new Set<string>();
  for (const candidate of payload.picker) {
    if (!isPlainJsonObject(candidate)) continue;
    if (coverRequest && candidate.type !== "photo") continue;
    if (
      !coverRequest &&
      candidate.type !== "photo" &&
      candidate.type !== "video" &&
      candidate.type !== "gif"
    )
      continue;
    const mediaType: MediaToolDownloadItem["mediaType"] =
      coverRequest || candidate.type === "photo"
        ? "image"
        : candidate.type === "gif"
          ? "gif"
          : "video";
    if (!coverRequest && !matchesMediaFilter(mediaType, request.mediaFilter)) continue;
    const validatedUrl = validatedTunnelUrl(candidate.url, cobaltOrigin);
    if (!validatedUrl) continue;
    const key = tunnelKey(validatedUrl);
    if (seen.has(key)) continue;
    const filename = safeDownloadFilename(
      candidate.filename,
      `${request.platform}-${coverRequest ? "cover" : mediaType}-${String(items.length + 1).padStart(2, "0")}`,
      mediaType,
    );
    const url = withBentoFilename(validatedUrl, filename);
    if (!url) continue;
    seen.add(key);
    items.push({
      url,
      filename,
      mediaType,
    });
    if (items.length === MAX_MEDIA_DOWNLOAD_ITEMS) break;
  }
  return items;
}

function audioTunnelFromCobalt(payload: CobaltPayload, cobaltOrigin: string) {
  if (payload.status === "tunnel" || payload.status === "redirect") {
    const validatedUrl = validatedTunnelUrl(payload.url, cobaltOrigin);
    if (!validatedUrl) return null;
    const filename = safeAudioFilename(payload.filename);
    const url = withBentoFilename(validatedUrl, filename);
    return url ? { url, filename } : null;
  }
  if (payload.status !== "picker") return null;
  const validatedUrl = validatedTunnelUrl(payload.audio, cobaltOrigin);
  if (!validatedUrl) return null;
  const filename = safeAudioFilename(payload.audioFilename);
  const url = withBentoFilename(validatedUrl, filename);
  return url ? { url, filename } : null;
}

function cobaltPayloadError(payload: CobaltPayload) {
  if (payload.status !== "error") return null;
  const providerError = isPlainJsonObject(payload.error) ? payload.error.code : undefined;
  if (providerError === "error.api.content.too_long") {
    return new MediaToolHttpError(422, "This video is longer than Bento's 25-minute limit");
  }
  const status =
    typeof providerError === "string" && /rate[_-]?limit/iu.test(providerError) ? 429 : 422;
  return new MediaToolHttpError(
    status,
    status === 429
      ? "The media service is busy. Please wait a minute."
      : "That public media link could not be processed",
  );
}

async function fetchTranscriptAudio(
  url: string,
  requestSignal: AbortSignal,
  dependencies: MediaToolsDependencies,
) {
  const timeoutSignal = AbortSignal.timeout(
    transcriptDownloadTimeoutMilliseconds(dependencies.transcriptDownloadTimeoutMs),
  );
  const signal = AbortSignal.any([requestSignal, timeoutSignal]);
  try {
    const response = await (dependencies.fetcher ?? fetch)(url, {
      method: "GET",
      headers: { Accept: "audio/mpeg" },
      redirect: "manual",
      signal,
    });
    if (!response.ok || response.status >= 300) {
      throw new MediaToolHttpError(502, "The transcript audio could not be downloaded");
    }
    const bytes = await readResponseBytes(response, MAX_TRANSCRIPTION_BYTES);
    if (bytes.byteLength < MIN_TRANSCRIPTION_BYTES) {
      throw new MediaToolHttpError(415, "The media link did not return valid audio");
    }
    const format = detectTranscriptionAudioFormat(bytes);
    if (!format) throw new MediaToolHttpError(415, "The media link did not return valid audio");
    return { bytes, contentType: canonicalAudioContentType(format) };
  } catch (error) {
    if (error instanceof MediaToolHttpError) throw error;
    if (error instanceof RequestBodyTooLargeError) {
      throw new MediaToolHttpError(
        413,
        `Transcript audio must be ${MAX_TRANSCRIPTION_SIZE_LABEL} or smaller`,
      );
    }
    if (timeoutSignal.aborted) {
      throw new MediaToolHttpError(504, "The transcript audio took too long to download");
    }
    throw new MediaToolHttpError(502, "The transcript audio could not be downloaded");
  }
}

async function requestBody(request: Request) {
  const declaredValue = request.headers.get("content-length");
  if (declaredValue !== null) {
    if (!/^\d+$/u.test(declaredValue)) {
      throw new MediaToolHttpError(400, "The request size could not be verified");
    }
    const declared = Number(declaredValue);
    if (!Number.isSafeInteger(declared)) {
      throw new MediaToolHttpError(400, "The request size could not be verified");
    }
    if (declared > MAX_MEDIA_REQUEST_BYTES) {
      throw new MediaToolHttpError(413, "Media requests must be 4 KB or smaller");
    }
  }
  try {
    return await readRequestText(request, MAX_MEDIA_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw new MediaToolHttpError(413, "Media requests must be 4 KB or smaller");
    }
    throw error;
  }
}

export async function handleFreeToolMediaRequest(
  request: Request,
  env: MediaToolsEnv,
  dependencies: MediaToolsDependencies = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== MEDIA_TOOLS_API_PATH) return null;
  if (request.method !== "POST") {
    const headers = responseHeaders();
    headers.set("allow", "POST");
    return Response.json({ error: "Method not allowed" }, { status: 405, headers });
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    return jsonError("Cross-origin media requests are not allowed", 403);
  }
  if (normalizedContentType(request) !== "application/json") {
    return jsonError("Send media requests as JSON", 415);
  }

  try {
    const parsed = parseMediaToolRequest(await requestBody(request));
    if (!parsed) throw new MediaToolHttpError(400, "Enter a valid media tool request");
    const resolvedPlatform =
      parsed.platform === "auto" ? detectMediaToolPlatform(parsed.url) : parsed.platform;
    if (!resolvedPlatform) throw new MediaToolHttpError(400, "Paste a valid public media URL");
    const sourceUrl = normalizeMediaSourceUrl(resolvedPlatform, parsed.url);
    if (!sourceUrl) throw new MediaToolHttpError(400, "Paste a valid public media URL");
    const resolvedRequest: ResolvedMediaToolRequest = {
      ...parsed,
      platform: resolvedPlatform,
    };

    const cobalt = cobaltConfiguration(env);
    if (!cobalt) {
      throw new MediaToolHttpError(503, "Media tools are temporarily unavailable");
    }
    if (
      parsed.operation === "transcript" &&
      !dependencies.transcribeAudio &&
      !isTranscriptionProviderConfigured(env)
    ) {
      throw new MediaToolHttpError(503, "Transcription is temporarily unavailable");
    }

    let rateLimitAllowed = false;
    try {
      rateLimitAllowed = await enforceMediaToolRateLimit(request, env, parsed.operation);
    } catch {
      throw new MediaToolHttpError(503, "Media tools are temporarily unavailable");
    }
    if (!rateLimitAllowed) {
      const configuredLimiter =
        parsed.operation === "transcript"
          ? env.FREE_TOOLS_TRANSCRIPTION_RATE_LIMITER
          : env.FREE_TOOLS_MEDIA_RATE_LIMITER;
      if (!configuredLimiter) {
        throw new MediaToolHttpError(503, "Media tools are temporarily unavailable");
      }
      throw new MediaToolHttpError(429, "Too many media requests. Please wait a minute.");
    }

    try {
      await enforceTurnstileRequest(request, env);
    } catch (error) {
      if (error instanceof RequestHttpError) {
        throw new MediaToolHttpError(error.statusCode, error.message);
      }
      throw error;
    }

    const cobaltPayload = await requestCobaltMedia(
      resolvedRequest,
      sourceUrl,
      cobalt,
      request.signal,
      dependencies,
    );
    const providerError = cobaltPayloadError(cobaltPayload);
    if (providerError) throw providerError;

    if (resolvedRequest.operation === "download" || resolvedRequest.operation === "cover") {
      const items = downloadItemsFromCobalt(cobaltPayload, resolvedRequest, cobalt.apiOrigin);
      if (!items.length) {
        throw new MediaToolHttpError(
          502,
          resolvedRequest.operation === "cover"
            ? "The media service returned no downloadable cover image"
            : resolvedRequest.mediaFilter === "image"
              ? "The media service returned no downloadable image"
              : resolvedRequest.mediaFilter === "all"
                ? "The media service returned no downloadable media"
                : "The media service returned no downloadable video",
        );
      }
      const result: MediaToolDownloadResult = {
        kind: "download",
        expiresInSeconds: MEDIA_DOWNLOAD_EXPIRES_IN_SECONDS,
        items,
      };
      return Response.json(result, { headers: responseHeaders() });
    }

    const audio = audioTunnelFromCobalt(cobaltPayload, cobalt.apiOrigin);
    if (!audio) {
      throw new MediaToolHttpError(502, "The media service returned no transcript audio");
    }
    let downloadedAudio;
    try {
      downloadedAudio = await fetchTranscriptAudio(audio.url, request.signal, dependencies);
    } catch (error) {
      if (
        resolvedRequest.platform !== "tiktok" ||
        !(error instanceof MediaToolHttpError) ||
        (error.status !== 415 && error.status !== 502)
      ) {
        throw error;
      }

      // TikTok's proxied MP3 tunnel can fail after resolution even when its video tunnel works.
      // A low-resolution MP4 stays within the same validated tunnel and transcription limits.
      const videoRequest: ResolvedMediaToolRequest = {
        ...resolvedRequest,
        operation: "download",
        mediaFilter: "video",
        quality: "360p",
      };
      const videoPayload = await requestCobaltMedia(
        videoRequest,
        sourceUrl,
        cobalt,
        request.signal,
        dependencies,
      );
      const videoProviderError = cobaltPayloadError(videoPayload);
      if (videoProviderError) throw videoProviderError;
      const [video] = downloadItemsFromCobalt(videoPayload, videoRequest, cobalt.apiOrigin);
      if (!video) throw error;
      downloadedAudio = await fetchTranscriptAudio(video.url, request.signal, dependencies);
    }
    const transcription = dependencies.transcribeAudio
      ? await dependencies.transcribeAudio(
          downloadedAudio.bytes,
          downloadedAudio.contentType,
          env,
          request.signal,
        )
      : await transcribeAudioBytes(
          downloadedAudio.bytes,
          downloadedAudio.contentType,
          env,
          request.signal,
          {
            fetcher: dependencies.fetcher,
          },
        );
    if (!transcription) {
      throw new MediaToolHttpError(502, "The audio could not be transcribed");
    }
    const result: MediaToolTranscriptResult = {
      kind: "transcript",
      filename: audio.filename,
      ...transcription,
    };
    return Response.json(result, { headers: responseHeaders() });
  } catch (error) {
    if (error instanceof MediaToolHttpError) return jsonError(error.message, error.status);
    return jsonError("The media request could not be completed", 502);
  }
}
