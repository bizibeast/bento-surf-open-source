import type { TranscriptionResult } from "./transcription-tool";

export const MEDIA_TOOLS_API_PATH = "/api/tools/media";
export const MEDIA_DOWNLOAD_EXPIRES_IN_SECONDS = 90;
export const MEDIA_DOWNLOAD_MAX_ITEMS = 20;

export const mediaToolSpecsBySlug = {
  "social-media-downloader": { platform: "auto", operation: "download", media: "all" },
  "youtube-video-downloader": { platform: "youtube", operation: "download", media: "video" },
  "instagram-video-downloader": {
    platform: "instagram",
    operation: "download",
    media: "video",
  },
  "instagram-photo-downloader": {
    platform: "instagram",
    operation: "download",
    media: "image",
  },
  "instagram-carousel-downloader": {
    platform: "instagram",
    operation: "download",
    media: "all",
  },
  "tiktok-video-downloader": { platform: "tiktok", operation: "download", media: "video" },
  "tiktok-photo-downloader": { platform: "tiktok", operation: "download", media: "image" },
  "twitter-video-downloader": { platform: "twitter", operation: "download", media: "video" },
  "twitter-image-downloader": { platform: "twitter", operation: "download", media: "image" },
  "youtube-thumbnail-downloader": { platform: "youtube", operation: "cover" },
  "instagram-reel-cover-downloader": { platform: "instagram", operation: "cover" },
  "tiktok-cover-downloader": { platform: "tiktok", operation: "cover" },
  "youtube-to-transcript": { platform: "youtube", operation: "transcript" },
  "instagram-to-transcript": { platform: "instagram", operation: "transcript" },
  "tiktok-to-transcript": { platform: "tiktok", operation: "transcript" },
} as const;

export type MediaToolSlug = keyof typeof mediaToolSpecsBySlug;
export type MediaToolSpec = (typeof mediaToolSpecsBySlug)[MediaToolSlug];
export type MediaToolPlatform = MediaToolSpec["platform"];
export type ResolvedMediaToolPlatform = Exclude<MediaToolPlatform, "auto">;
export type MediaToolOperation = MediaToolSpec["operation"];
export type MediaToolFilter = "all" | "image" | "video";

export const mediaDownloadQualities = ["best", "1080p", "720p", "480p", "360p"] as const;
export type MediaDownloadQuality = (typeof mediaDownloadQualities)[number];

export type MediaToolRequest = {
  toolSlug: MediaToolSlug;
  url: string;
  quality?: MediaDownloadQuality;
};

export type MediaToolDownloadItem = {
  url: string;
  filename: string;
  mediaType: "video" | "gif" | "image";
};

export type MediaToolDownloadResult = {
  kind: "download";
  items: MediaToolDownloadItem[];
  expiresInSeconds: number;
};

export type MediaToolTranscriptResult = TranscriptionResult & {
  kind: "transcript";
  filename: string;
};

export type MediaToolResult = MediaToolDownloadResult | MediaToolTranscriptResult;

export function isMediaToolSlug(value: unknown): value is MediaToolSlug {
  return (
    typeof value === "string" && Object.prototype.hasOwnProperty.call(mediaToolSpecsBySlug, value)
  );
}

export function isMediaDownloadQuality(value: unknown): value is MediaDownloadQuality {
  return typeof value === "string" && (mediaDownloadQualities as readonly string[]).includes(value);
}

function parsedHttpsUrl(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function isSafeFilename(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 180 &&
    !/[\p{Cc}\p{Cf}/\\]/u.test(value)
  );
}

function isBoundDownloadFilename(urlValue: unknown, filename: unknown, mediaType: unknown) {
  if (!isSafeFilename(filename)) return false;
  const lowerFilename = filename.toLowerCase();
  const extensionMatches =
    mediaType === "gif"
      ? lowerFilename.endsWith(".gif")
      : mediaType === "image"
        ? /\.(?:jpe?g|png|webp)$/u.test(lowerFilename)
        : mediaType === "video" && /\.(?:mp4|webm)$/u.test(lowerFilename);
  if (!extensionMatches) {
    return false;
  }
  const url = parsedHttpsUrl(urlValue);
  return Boolean(
    url &&
    url.searchParams.getAll("bento_filename").length === 1 &&
    url.searchParams.get("bento_filename") === filename,
  );
}

function isTranscriptSegment(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const segment = value as { start?: unknown; end?: unknown; text?: unknown };
  return (
    typeof segment.start === "number" &&
    Number.isFinite(segment.start) &&
    segment.start >= 0 &&
    typeof segment.end === "number" &&
    Number.isFinite(segment.end) &&
    segment.end >= segment.start &&
    typeof segment.text === "string" &&
    segment.text.trim().length > 0
  );
}

export function isMediaToolDownloadResult(value: unknown): value is MediaToolDownloadResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<MediaToolDownloadResult>;
  return (
    result.kind === "download" &&
    typeof result.expiresInSeconds === "number" &&
    Number.isSafeInteger(result.expiresInSeconds) &&
    result.expiresInSeconds > 0 &&
    Array.isArray(result.items) &&
    result.items.length > 0 &&
    result.items.length <= MEDIA_DOWNLOAD_MAX_ITEMS &&
    result.items.every(
      (item) =>
        !!item &&
        typeof item === "object" &&
        (item.mediaType === "video" || item.mediaType === "gif" || item.mediaType === "image") &&
        isBoundDownloadFilename(item.url, item.filename, item.mediaType),
    )
  );
}

export function isMediaToolTranscriptResult(value: unknown): value is MediaToolTranscriptResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<MediaToolTranscriptResult>;
  return (
    result.kind === "transcript" &&
    isSafeFilename(result.filename) &&
    result.filename.toLowerCase().endsWith(".mp3") &&
    typeof result.transcript === "string" &&
    result.transcript.trim().length > 0 &&
    typeof result.wordCount === "number" &&
    Number.isSafeInteger(result.wordCount) &&
    result.wordCount >= 0 &&
    (result.language === null ||
      (typeof result.language === "string" && result.language.length > 0)) &&
    (result.durationSeconds === null ||
      (typeof result.durationSeconds === "number" &&
        Number.isFinite(result.durationSeconds) &&
        result.durationSeconds >= 0)) &&
    Array.isArray(result.segments) &&
    result.segments.length > 0 &&
    result.segments.every(isTranscriptSegment)
  );
}

export function isMediaToolResult(value: unknown): value is MediaToolResult {
  return isMediaToolDownloadResult(value) || isMediaToolTranscriptResult(value);
}
