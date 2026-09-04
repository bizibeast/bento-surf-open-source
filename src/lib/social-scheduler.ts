import { z } from "zod";
import { zonedDateTimeInputToIso } from "./local-datetime";
import { isValidTimeZone } from "./timezones";

export const SOCIAL_PROVIDERS = [
  "instagram",
  "facebook",
  "threads",
  "tiktok",
  "linkedin",
  "twitter",
  "youtube",
  "reddit",
] as const;

export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

/** Providers kept in code but not offered in Connect UI until external access is approved. */
export const HIDDEN_SOCIAL_PROVIDERS = ["reddit"] as const satisfies readonly SocialProvider[];

export function isPublicSocialProvider(provider: string): provider is SocialProvider {
  return (
    (SOCIAL_PROVIDERS as readonly string[]).includes(provider) &&
    !(HIDDEN_SOCIAL_PROVIDERS as readonly string[]).includes(provider)
  );
}

export const PUBLIC_SOCIAL_PROVIDERS = SOCIAL_PROVIDERS.filter(isPublicSocialProvider);
export type SocialPostStatus =
  "draft" | "scheduled" | "publishing" | "published" | "partially_failed" | "failed" | "cancelled";

export type SchedulerMedia = {
  key: string;
  url: string;
  name: string;
  mimeType: string;
  size: number;
};

export type SchedulerConnection = {
  id: string;
  provider: SocialProvider;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  status: "active" | "expired" | "revoked" | "error";
  connectedAt: string;
  canPublish: boolean;
  publishBlockReason: string | null;
};

export const INSTAGRAM_CONTENT_PUBLISH_SCOPE = "instagram_business_content_publish";

export function socialConnectionCanPublish(
  provider: SocialProvider,
  scopes: readonly string[] | null | undefined,
) {
  return provider !== "instagram" || Boolean(scopes?.includes(INSTAGRAM_CONTENT_PUBLISH_SCOPE));
}

const MAX_SOCIAL_RETRY_DELAY_SECONDS = 6 * 60 * 60;

export function parseRetryAfterSeconds(value: string | null, nowMs = Date.now()) {
  if (!value) return null;
  const numericValue = Number(value);
  if (Number.isFinite(numericValue) && numericValue >= 0) {
    return Math.min(MAX_SOCIAL_RETRY_DELAY_SECONDS, Math.ceil(numericValue));
  }
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return null;
  return Math.min(
    MAX_SOCIAL_RETRY_DELAY_SECONDS,
    Math.max(0, Math.ceil((retryAt - nowMs) / 1_000)),
  );
}

export function socialRetryDelaySeconds(
  attempt: number,
  retryAfterSeconds: number | null = null,
  random: () => number = Math.random,
) {
  const exponentialDelay = Math.min(
    MAX_SOCIAL_RETRY_DELAY_SECONDS,
    30 * 2 ** Math.max(0, attempt - 1),
  );
  const boundedRandom = Math.max(0, Math.min(1, random()));
  const jitteredDelay = Math.ceil(exponentialDelay / 2 + (exponentialDelay / 2) * boundedRandom);
  return Math.min(MAX_SOCIAL_RETRY_DELAY_SECONDS, Math.max(jitteredDelay, retryAfterSeconds || 0));
}

export type SchedulerTarget = {
  id: string;
  connectionId: string;
  provider: SocialProvider;
  status:
    | "pending"
    | "queued"
    | "publishing"
    | "processing"
    | "published"
    | "retrying"
    | "failed"
    | "cancelled"
    | "outcome_unknown";
  remotePostUrl: string | null;
  errorMessage: string | null;
  publishedAt: string | null;
  likes?: number | null;
  comments?: number | null;
  providerSettings?: Record<string, unknown>;
};

export const MAX_SOCIAL_PROFILES_PER_PROVIDER = 2;

export function socialAccountsWithinLimit<T extends { id: string }>(
  existingProviderUserIds: readonly string[],
  accounts: readonly T[],
) {
  const existing = new Set(existingProviderUserIds);
  const selected: T[] = [];
  let remaining = Math.max(0, MAX_SOCIAL_PROFILES_PER_PROVIDER - existing.size);

  for (const account of accounts) {
    if (selected.some((candidate) => candidate.id === account.id)) continue;
    if (existing.has(account.id)) selected.push(account);
    else if (remaining > 0) {
      selected.push(account);
      remaining -= 1;
    }
  }
  return selected;
}

export function socialCalendarDates(cursor: Date, view: "week" | "month") {
  const start = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
  if (view === "month") start.setDate(1);
  const mondayOffset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - mondayOffset);

  const count = view === "week" ? 7 : 42;
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

export function socialCalendarDateKey(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, "0"))
    .join("-");
}

function localDateTimeValue(date: Date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

export function minimumScheduleTime(now = new Date()) {
  const date = new Date(now.getTime() + 60_000);
  date.setSeconds(0, 0);
  return localDateTimeValue(date);
}

export function defaultScheduleTime(now = new Date()) {
  const date = new Date(now.getTime() + 30 * 60_000);
  date.setSeconds(0, 0);
  return localDateTimeValue(date);
}

/** Prefill datetime-local for composing from a calendar day. Past days clamp to soonest valid time. */
export function scheduleTimeForDate(date: Date, now = new Date()) {
  if (socialCalendarDateKey(date) === socialCalendarDateKey(now)) return defaultScheduleTime(now);

  const next = new Date(date);
  next.setHours(12, 0, 0, 0);
  if (next.getTime() < now.getTime() + 60_000) return minimumScheduleTime(now);
  return localDateTimeValue(next);
}

export function isSchedulableCalendarDay(date: Date, now = new Date()) {
  return socialCalendarDateKey(date) >= socialCalendarDateKey(now);
}

export type PostingSlot = { day: number; time: string };
export type PostingSchedule = {
  timezone: string;
  slots: PostingSlot[];
  naturalOffset: boolean;
};

export const postingScheduleSchema = z
  .object({
    timezone: z.string().min(1).max(100).refine(isValidTimeZone, "Choose a valid timezone."),
    slots: z
      .array(
        z.object({
          day: z.number().int().min(0).max(6),
          time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Choose a valid posting time."),
        }),
      )
      .max(70),
    naturalOffset: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    const keys = value.slots.map((slot) => `${slot.day}:${slot.time}`);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Posting slots must be unique." });
    }
  });

function dateKeyInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function nextPostingSlot(
  slots: readonly PostingSlot[],
  timeZone: string,
  now = new Date(),
  occupied: readonly string[] = [],
  offsetMinutes = 0,
) {
  if (!slots.length || !isValidTimeZone(timeZone)) return null;
  const occupiedMinutes = new Set(
    occupied.map((value) => new Date(value).toISOString().slice(0, 16)),
  );
  const firstLocalDay = new Date(`${dateKeyInTimeZone(now, timeZone)}T12:00:00Z`);
  const boundedOffset = Math.max(-4, Math.min(4, Math.round(offsetMinutes)));

  for (let dayOffset = 0; dayOffset < 15; dayOffset += 1) {
    const localDay = new Date(firstLocalDay);
    localDay.setUTCDate(firstLocalDay.getUTCDate() + dayOffset);
    const date = localDay.toISOString().slice(0, 10);
    const weekday = localDay.getUTCDay();
    const daySlots = slots
      .filter((slot) => slot.day === weekday)
      .sort((left, right) => left.time.localeCompare(right.time));

    for (const slot of daySlots) {
      const iso = zonedDateTimeInputToIso(`${date}T${slot.time}`, timeZone);
      if (!iso) continue;
      const candidate = new Date(new Date(iso).getTime() + boundedOffset * 60_000);
      if (candidate.getTime() <= now.getTime() + 60_000) continue;
      if (occupiedMinutes.has(candidate.toISOString().slice(0, 16))) continue;
      return candidate.toISOString();
    }
  }
  return null;
}

const ACTIVE_SOCIAL_TARGET_STATUSES = new Set<SchedulerTarget["status"]>([
  "pending",
  "queued",
  "publishing",
  "processing",
  "retrying",
  "outcome_unknown",
]);

export type SchedulerOperationsSummary = {
  totalTargets: number;
  publishedTargets: number;
  failedTargets: number;
  activeTargets: number;
  cancelledTargets: number;
  successRate: number | null;
  providers: Array<{
    provider: SocialProvider;
    total: number;
    published: number;
    failed: number;
    active: number;
    cancelled: number;
    successRate: number | null;
  }>;
};

function deliverySuccessRate(published: number, failed: number) {
  const completed = published + failed;
  return completed ? Math.round((published / completed) * 100) : null;
}

export function summarizeSchedulerOperations(
  posts: readonly Pick<SchedulerPost, "targets">[],
): SchedulerOperationsSummary {
  const providers = SOCIAL_PROVIDERS.map((provider) => {
    const targets = posts.flatMap((post) =>
      post.targets.filter((target) => target.provider === provider),
    );
    const published = targets.filter((target) => target.status === "published").length;
    const failed = targets.filter((target) => target.status === "failed").length;
    const active = targets.filter((target) =>
      ACTIVE_SOCIAL_TARGET_STATUSES.has(target.status),
    ).length;
    const cancelled = targets.filter((target) => target.status === "cancelled").length;
    return {
      provider,
      total: targets.length,
      published,
      failed,
      active,
      cancelled,
      successRate: deliverySuccessRate(published, failed),
    };
  }).filter((provider) => provider.total > 0);

  const publishedTargets = providers.reduce((total, provider) => total + provider.published, 0);
  const failedTargets = providers.reduce((total, provider) => total + provider.failed, 0);
  const activeTargets = providers.reduce((total, provider) => total + provider.active, 0);
  const cancelledTargets = providers.reduce((total, provider) => total + provider.cancelled, 0);

  return {
    totalTargets: providers.reduce((total, provider) => total + provider.total, 0),
    publishedTargets,
    failedTargets,
    activeTargets,
    cancelledTargets,
    successRate: deliverySuccessRate(publishedTargets, failedTargets),
    providers,
  };
}

export type SchedulerMediaKind = "image" | "video" | "file";

/** Picker accepts these; images are converted to JPEG before upload. */
export const SCHEDULER_INPUT_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
] as const;

export const SCHEDULER_INPUT_VIDEO_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/*",
] as const;

export const SCHEDULER_INPUT_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const;

export type SchedulerMediaCompatibility = {
  allowedKinds: SchedulerMediaKind[];
  allowedMimeTypes: string[];
  accept: string;
  maxMedia: number;
  disabled: boolean;
  summary: string;
};

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm", "mpeg", "mpg"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic", "heif"]);
const DOCUMENT_EXTENSIONS = new Set(["pdf", "doc", "docx", "ppt", "pptx"]);

function extensionFromName(name: string) {
  const extension =
    name
      .split(".")
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9]/g, "") || "";
  return extension.slice(0, 5);
}

export function schedulerMediaKindForFile(file: {
  type?: string;
  name?: string;
}): SchedulerMediaKind | null {
  const mimeType = String(file.type || "").toLowerCase();
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if ((SCHEDULER_INPUT_DOCUMENT_MIME_TYPES as readonly string[]).includes(mimeType)) return "file";

  // Some browsers (especially macOS/iOS) leave File.type empty for camera/exports.
  const extension = extensionFromName(String(file.name || ""));
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "file";
  return null;
}

function schedulerMediaKindForMime(mimeType: string): SchedulerMediaKind | null {
  return schedulerMediaKindForFile({ type: mimeType });
}

export function inferredSchedulerMimeType(file: { type?: string; name?: string }) {
  const mimeType = String(file.type || "")
    .trim()
    .toLowerCase();
  if (mimeType) return mimeType;
  const extension = extensionFromName(String(file.name || ""));
  if (extension === "mp4" || extension === "m4v" || extension === "mpeg" || extension === "mpg") {
    return "video/mp4";
  }
  if (extension === "mov") return "video/quicktime";
  if (extension === "webm") return "video/webm";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  if (extension === "pdf") return "application/pdf";
  return "";
}

export function schedulerMediaCompatibility(
  providers: readonly SocialProvider[],
): SchedulerMediaCompatibility {
  const selectedProviders = [...new Set(providers)];
  if (!selectedProviders.length) {
    return {
      allowedKinds: ["image", "video", "file"],
      allowedMimeTypes: [
        ...SCHEDULER_INPUT_IMAGE_MIME_TYPES,
        ...SCHEDULER_INPUT_VIDEO_MIME_TYPES,
        ...SCHEDULER_INPUT_DOCUMENT_MIME_TYPES,
      ],
      accept: ["image/*", "video/*", ".pdf"].join(","),
      maxMedia: 10,
      disabled: false,
      summary: "Select destinations to see their shared media rules.",
    };
  }

  const definitions = selectedProviders.map((provider) => SOCIAL_PROVIDER_DEFINITIONS[provider]);
  const supportsImages = definitions.every((definition) => definition.supportsImages);
  const supportsVideo = definitions.every((definition) => definition.supportsVideo);
  const supportsDocuments = definitions.every((definition) =>
    Boolean(definition.supportsDocuments),
  );
  const maxMedia = Math.min(...definitions.map((definition) => definition.maxMedia));
  const allowedKinds: SchedulerMediaKind[] = [
    ...(supportsImages ? (["image"] as const) : []),
    ...(supportsVideo ? (["video"] as const) : []),
    ...(supportsDocuments ? (["file"] as const) : []),
  ];
  const disabled = maxMedia === 0 || allowedKinds.length === 0;
  const names = definitions.map((definition) => definition.name).join(", ");

  if (disabled) {
    return {
      allowedKinds: [],
      allowedMimeTypes: [],
      accept: "",
      maxMedia: 0,
      disabled: true,
      summary: `${names} do not share a compatible media format. Schedule these destinations separately.`,
    };
  }

  const allowedMimeTypes = [
    ...(supportsImages ? [...SCHEDULER_INPUT_IMAGE_MIME_TYPES] : []),
    ...(supportsVideo ? [...SCHEDULER_INPUT_VIDEO_MIME_TYPES] : []),
    ...(supportsDocuments ? [...SCHEDULER_INPUT_DOCUMENT_MIME_TYPES] : []),
  ];
  const formatParts = [
    ...(supportsImages ? ["image"] : []),
    ...(supportsVideo ? ["video"] : []),
    ...(supportsDocuments ? ["PDF"] : []),
  ];
  const format = formatParts.join(", ").replace(/, ([^,]*)$/, ", or $1");
  // Prefer broad accept tokens. Mixed explicit MIME lists can make some browsers
  // open an empty/broken file picker with no error.
  const acceptParts = [
    ...(supportsImages ? ["image/*"] : []),
    ...(supportsVideo ? ["video/*"] : []),
    ...(supportsDocuments ? [".pdf", ".doc", ".docx", ".ppt", ".pptx"] : []),
  ];
  return {
    allowedKinds,
    allowedMimeTypes,
    accept: acceptParts.join(","),
    maxMedia,
    disabled: false,
    summary: `${maxMedia} ${format}${maxMedia === 1 ? "" : " files"} per post for the selected destinations. Images are saved as JPEG for network compatibility.`,
  };
}

export function prepareSchedulerMediaFiles<T extends { type: string; name?: string }>(
  files: readonly T[],
  currentCount: number,
  maxMedia = 10,
  allowedKinds: readonly SchedulerMediaKind[] = ["image", "video", "file"],
  allowedMimeTypes: readonly string[] = [],
) {
  const supported = files.filter((file) => {
    const kind = schedulerMediaKindForFile(file);
    const mimeType = inferredSchedulerMimeType(file);
    const allowedKind = Boolean(kind && allowedKinds.includes(kind));
    const allowedMime =
      !allowedMimeTypes.length ||
      allowedMimeTypes.includes(mimeType) ||
      allowedMimeTypes.some(
        (candidate) => candidate.endsWith("/*") && mimeType.startsWith(candidate.slice(0, -1)),
      );
    return allowedKind && allowedMime;
  });
  const available = Math.max(0, maxMedia - Math.max(0, currentCount));
  return {
    accepted: supported.slice(0, available),
    rejectedCount: files.length - supported.length,
    overflowCount: Math.max(0, supported.length - available),
  };
}

export function deriveSocialPostStatus(
  statuses: readonly SchedulerTarget["status"][],
): SocialPostStatus | null {
  if (!statuses.length) return null;
  if (statuses.every((status) => status === "published")) return "published";
  if (statuses.every((status) => status === "cancelled")) return "cancelled";
  if (statuses.every((status) => status === "failed")) return "failed";
  if (statuses.some((status) => ACTIVE_SOCIAL_TARGET_STATUSES.has(status))) return "publishing";
  if (statuses.some((status) => status === "published")) return "partially_failed";
  return "failed";
}

export type SchedulerPost = {
  id: string;
  body: string;
  title: string | null;
  scheduledAt: string | null;
  timezone: string;
  status: SocialPostStatus;
  media: SchedulerMedia[];
  createdAt: string;
  targets: SchedulerTarget[];
};

export function schedulerPostEngagement(
  targets: readonly Pick<SchedulerTarget, "likes" | "comments">[],
) {
  const total = (metric: "likes" | "comments") =>
    targets.some((target) => target[metric] != null)
      ? targets.reduce((sum, target) => sum + (target[metric] || 0), 0)
      : null;
  return { likes: total("likes"), comments: total("comments") };
}

export function isSocialCalendarPost(
  post: Pick<SchedulerPost, "status" | "scheduledAt">,
): post is Pick<SchedulerPost, "status" | "scheduledAt"> & { scheduledAt: string } {
  return post.status !== "draft" && post.status !== "cancelled" && Boolean(post.scheduledAt);
}

export type SocialProviderSettings = Record<string, Record<string, unknown>>;

export type VideoCoverKind = "image" | "timestamp";

type SocialProviderDefinition = {
  name: string;
  color: string;
  maxText: number;
  maxTitle?: number;
  media: "optional" | "required" | "video-required";
  supportsImages: boolean;
  supportsVideo: boolean;
  supportsDocuments?: boolean;
  imageMimeTypes?: string[];
  videoMimeTypes?: string[];
  documentMimeTypes?: string[];
  maxMedia: number;
  requiresTitle?: boolean;
  requiresCommunity?: boolean;
  supportsLink?: boolean;
  /** Custom video cover: uploaded image, or a frame timestamp from the video. */
  videoCover?: VideoCoverKind;
  setupNote: string;
};

const CAPTION_FIELD_PROVIDERS = new Set<SocialProvider>([
  "instagram",
  "facebook",
  "threads",
  "tiktok",
  "linkedin",
  "twitter",
]);

export const YOUTUBE_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

export function schedulerUsesCaption(providers: readonly SocialProvider[]) {
  return providers.some((provider) => CAPTION_FIELD_PROVIDERS.has(provider));
}

export function schedulerCaptionLabel(providers: readonly SocialProvider[]) {
  const selected = [
    ...new Set(providers.filter((provider) => CAPTION_FIELD_PROVIDERS.has(provider))),
  ];
  if (selected.length === 1) {
    if (selected[0] === "instagram" || selected[0] === "tiktok") return "Caption";
    if (selected[0] === "twitter") return "Post";
    if (selected[0] === "threads") return "Thread";
    return "Post text";
  }
  return "Caption";
}

export function schedulerCaptionPlaceholder(providers: readonly SocialProvider[]) {
  const selected = [
    ...new Set(providers.filter((provider) => CAPTION_FIELD_PROVIDERS.has(provider))),
  ];
  if (selected.length === 1) {
    if (selected[0] === "instagram") return "Write an Instagram caption";
    if (selected[0] === "tiktok") return "Write a TikTok caption";
    if (selected[0] === "twitter") return "What's happening?";
    if (selected[0] === "threads") return "Start a thread";
    if (selected[0] === "linkedin") return "Share an update";
    if (selected[0] === "facebook") return "Write your post";
  }
  if (selected.length > 1) return "Write a caption for these networks";
  if (providers.includes("youtube") && selected.length === 0) {
    return "Tell viewers what this video is about";
  }
  return "What do you want to share?";
}

export function schedulerCaptionLimit(providers: readonly SocialProvider[]) {
  const selected = providers.filter((provider) => CAPTION_FIELD_PROVIDERS.has(provider));
  if (!selected.length) return 10_000;
  return Math.min(...selected.map((provider) => SOCIAL_PROVIDER_DEFINITIONS[provider].maxText));
}

export function providerVideoCoverKind(provider: SocialProvider): VideoCoverKind | null {
  return SOCIAL_PROVIDER_DEFINITIONS[provider].videoCover || null;
}

export function parseSchedulerMediaSetting(value: unknown): SchedulerMedia | null {
  const parsed = schedulerMediaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function providerSettingsMedia(settings: SocialProviderSettings): SchedulerMedia[] {
  const media: SchedulerMedia[] = [];
  for (const value of Object.values(settings)) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const thumbnail = parseSchedulerMediaSetting(record.thumbnail);
    const cover = parseSchedulerMediaSetting(record.cover);
    if (thumbnail) media.push(thumbnail);
    if (cover) media.push(cover);
  }
  return media;
}

export function youtubeDescriptionFrom(body: string, settings: Record<string, unknown> = {}) {
  const override = typeof settings.description === "string" ? settings.description.trim() : "";
  return override || body;
}

/** YouTube classifies new square or vertical videos up to 3 minutes as Shorts. */
export const YOUTUBE_SHORT_MAX_SECONDS = 180;

export type YouTubePostFormat = "video" | "short";

export type YouTubeVideoMeta = {
  durationSeconds: number;
  width: number;
  height: number;
};

export function youtubeDetectedFormat(meta: YouTubeVideoMeta | null): YouTubePostFormat | null {
  if (!meta) return null;
  const duration = Number(meta.durationSeconds);
  const width = Number(meta.width);
  const height = Number(meta.height);
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  const squareOrVertical = height >= width;
  return squareOrVertical && duration <= YOUTUBE_SHORT_MAX_SECONDS ? "short" : "video";
}

export function resolvedYouTubeFormat(
  requested: unknown,
  detected: YouTubePostFormat | null,
): YouTubePostFormat {
  if (requested === "short" || requested === "video") return requested;
  return detected || "video";
}

export function youtubeDescriptionForUpload(body: string, settings: Record<string, unknown> = {}) {
  return youtubeDescriptionFrom(body, settings);
}

export function youtubePublishedUrl(videoId: string, format: YouTubePostFormat) {
  return format === "short"
    ? `https://www.youtube.com/shorts/${videoId}`
    : `https://www.youtube.com/watch?v=${videoId}`;
}

export function tiktokCoverTimestampMs(settings: Record<string, unknown> = {}) {
  const value = Number(settings.videoCoverTimestampMs);
  if (!Number.isFinite(value) || value < 0) return 1_000;
  return Math.min(Math.floor(value), 60 * 60 * 1_000);
}

export function clampTikTokCoverTimestampMs(timestampMs: number, durationMs: number) {
  const value = tiktokCoverTimestampMs({ videoCoverTimestampMs: timestampMs });
  if (!Number.isFinite(durationMs) || durationMs <= 0) return value;
  return Math.min(value, Math.max(0, Math.floor(durationMs) - 1));
}

function invalidVideoCover(
  provider: SocialProvider,
  name: string,
  settings: Record<string, unknown>,
  media: SchedulerMedia[],
) {
  const kind = providerVideoCoverKind(provider);
  if (!kind) return null;
  const hasVideo = media.some((item) => item.mimeType.startsWith("video/"));
  if (kind === "image") {
    const image = parseSchedulerMediaSetting(
      provider === "youtube" ? settings.thumbnail : settings.cover,
    );
    if (!image) return null;
    if (!hasVideo) return `${name} thumbnails can only be added to a video.`;
    if (provider === "instagram" && media.length !== 1) {
      return "Instagram thumbnails are for a single Reel, not a carousel.";
    }
    if (!image.mimeType.startsWith("image/") || image.mimeType !== "image/jpeg") {
      return `${name} needs a JPEG thumbnail. Upload it again so Bento can convert it.`;
    }
    if (provider === "youtube" && image.size > YOUTUBE_THUMBNAIL_MAX_BYTES) {
      return "YouTube thumbnails must be 2 MB or smaller.";
    }
  }
  if (
    provider === "tiktok" &&
    settings.videoCoverTimestampMs != null &&
    settings.videoCoverTimestampMs !== ""
  ) {
    const value = Number(settings.videoCoverTimestampMs);
    if (!Number.isFinite(value) || value < 0) return "Choose a valid TikTok thumbnail frame.";
  }
  return null;
}

export const SOCIAL_PROVIDER_DEFINITIONS: Record<SocialProvider, SocialProviderDefinition> = {
  instagram: {
    name: "Instagram",
    color: "#E4405F",
    maxText: 2_200,
    media: "required",
    supportsImages: true,
    supportsVideo: true,
    // Meta Content Publishing accepts JPEG images only; videos are MP4/MOV.
    imageMimeTypes: ["image/jpeg"],
    videoMimeTypes: ["video/mp4", "video/quicktime"],
    maxMedia: 10,
    videoCover: "image",
    setupNote: "Professional Instagram accounts can publish after Meta app review.",
  },
  facebook: {
    name: "Facebook",
    color: "#1877F2",
    maxText: 5_000,
    media: "optional",
    supportsImages: true,
    supportsVideo: true,
    imageMimeTypes: ["image/jpeg", "image/png"],
    videoMimeTypes: ["video/mp4", "video/quicktime"],
    maxMedia: 1,
    setupNote: "Connect a Facebook Page you manage; personal timelines are not supported.",
  },
  threads: {
    name: "Threads",
    color: "#101010",
    maxText: 500,
    media: "optional",
    supportsImages: true,
    supportsVideo: true,
    imageMimeTypes: ["image/jpeg", "image/png"],
    videoMimeTypes: ["video/mp4", "video/quicktime"],
    maxMedia: 1,
    setupNote: "Publishing uses Meta's official Threads API.",
  },
  tiktok: {
    name: "TikTok",
    color: "#111111",
    maxText: 2_200,
    media: "video-required",
    supportsImages: false,
    supportsVideo: true,
    videoMimeTypes: ["video/mp4", "video/quicktime", "video/webm"],
    maxMedia: 1,
    videoCover: "timestamp",
    setupNote:
      "TikTok Login Kit and Content Posting are live; public Direct Posts still require TikTok's separate audit.",
  },
  linkedin: {
    name: "LinkedIn",
    color: "#0A66C2",
    maxText: 3_000,
    media: "optional",
    supportsImages: true,
    supportsVideo: true,
    supportsDocuments: true,
    imageMimeTypes: ["image/jpeg", "image/png", "image/gif"],
    videoMimeTypes: ["video/mp4", "video/quicktime"],
    documentMimeTypes: [...SCHEDULER_INPUT_DOCUMENT_MIME_TYPES],
    maxMedia: 20,
    setupNote: "Supports text, multi-image, video, and PDF/document posts for members.",
  },
  twitter: {
    name: "X",
    color: "#111111",
    maxText: 280,
    media: "optional",
    supportsImages: true,
    supportsVideo: true,
    imageMimeTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
    videoMimeTypes: ["video/mp4", "video/quicktime"],
    maxMedia: 4,
    setupNote:
      "Supports text, up to 4 images, one GIF, or one video. Reconnect X after enabling media.write if uploads fail.",
  },
  youtube: {
    name: "YouTube",
    color: "#FF0000",
    maxText: 5_000,
    maxTitle: 100,
    media: "video-required",
    supportsImages: false,
    supportsVideo: true,
    videoMimeTypes: ["video/mp4", "video/quicktime", "video/webm"],
    maxMedia: 1,
    requiresTitle: true,
    videoCover: "image",
    setupNote: "Public uploads require Google's OAuth consent and API compliance review.",
  },
  reddit: {
    name: "Reddit",
    color: "#FF4500",
    maxText: 10_000,
    maxTitle: 300,
    media: "optional",
    supportsImages: false,
    supportsVideo: false,
    maxMedia: 0,
    requiresTitle: true,
    requiresCommunity: true,
    supportsLink: true,
    setupNote:
      "Reddit Connect is temporarily hidden while Bento awaits Reddit Data API access approval.",
  },
};

export const schedulerMediaSchema = z.object({
  key: z.string().min(1).max(500),
  url: z.string().url().max(2_000),
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  size: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024 * 1024),
});

export const socialPostInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    body: z.string().trim().max(10_000),
    title: z.string().trim().max(300).optional().default(""),
    scheduledAt: z.string().datetime({ offset: true }).nullable(),
    timezone: z.string().min(1).max(100).default("UTC"),
    connectionIds: z.array(z.string().uuid()).min(1).max(20),
    media: z.array(schedulerMediaSchema).max(10).default([]),
    providerSettings: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    publishNow: z.boolean().default(false),
    asDraft: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    const reddit = value.providerSettings.reddit || {};
    if (
      !value.body &&
      value.media.length === 0 &&
      !value.title &&
      !(reddit.kind === "link" && typeof reddit.url === "string" && reddit.url.trim())
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Add text, media, or a link." });
    }
    if (!value.asDraft && !value.publishNow && !value.scheduledAt) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Choose a publish time." });
    }
    if (value.asDraft && value.publishNow) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A draft cannot be published immediately.",
      });
    }
    if (new Set(value.connectionIds).size !== value.connectionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A publishing destination was selected more than once.",
        path: ["connectionIds"],
      });
    }
    if (
      !value.asDraft &&
      value.scheduledAt &&
      new Date(value.scheduledAt).getTime() < Date.now() - 60_000
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Choose a future publish time." });
    }
  });

export function validatePostForProviders(
  body: string,
  media: SchedulerMedia[],
  providers: SocialProvider[],
  title = "",
  providerSettings: SocialProviderSettings = {},
) {
  const errors: Partial<Record<SocialProvider, string>> = {};
  for (const provider of providers) {
    const definition = SOCIAL_PROVIDER_DEFINITIONS[provider];
    const settings = providerSettings[provider] || {};
    const textForLimit = provider === "youtube" ? youtubeDescriptionFrom(body, settings) : body;
    if (textForLimit.length > definition.maxText) {
      errors[provider] =
        `${definition.name} allows ${definition.maxText.toLocaleString()} characters.`;
      continue;
    }
    if (definition.media === "required" && media.length === 0) {
      errors[provider] = `${definition.name} needs an image or video.`;
      continue;
    }
    if (
      definition.media === "video-required" &&
      !media.some((item) => item.mimeType.startsWith("video/"))
    ) {
      errors[provider] = `${definition.name} needs a video.`;
      continue;
    }
    if (media.length > definition.maxMedia) {
      errors[provider] = definition.maxMedia
        ? `${definition.name} accepts up to ${definition.maxMedia} media file${definition.maxMedia === 1 ? "" : "s"} per scheduled post.`
        : `${definition.name} currently accepts text-only scheduled posts.`;
      continue;
    }
    if (!definition.supportsImages && media.some((item) => item.mimeType.startsWith("image/"))) {
      errors[provider] = `${definition.name} does not accept image-only posts.`;
      continue;
    }
    if (!definition.supportsVideo && media.some((item) => item.mimeType.startsWith("video/"))) {
      errors[provider] = `${definition.name} does not accept video posts yet.`;
      continue;
    }
    if (
      !definition.supportsDocuments &&
      media.some((item) => schedulerMediaKindForMime(item.mimeType) === "file")
    ) {
      errors[provider] = `${definition.name} does not accept PDF or document uploads.`;
      continue;
    }
    if (
      definition.imageMimeTypes?.length &&
      media.some(
        (item) =>
          item.mimeType.startsWith("image/") && !definition.imageMimeTypes!.includes(item.mimeType),
      )
    ) {
      errors[provider] =
        `${definition.name} needs a JPEG image. Remove the current file and upload it again so Bento can convert it.`;
      continue;
    }
    if (
      definition.videoMimeTypes?.length &&
      media.some((item) => {
        if (!item.mimeType.startsWith("video/")) return false;
        return !definition.videoMimeTypes!.some(
          (mimeType) =>
            mimeType === item.mimeType ||
            (mimeType.endsWith("/*") && item.mimeType.startsWith(mimeType.slice(0, -1))),
        );
      })
    ) {
      errors[provider] = `${definition.name} needs an MP4 or MOV video.`;
      continue;
    }
    if (
      definition.documentMimeTypes?.length &&
      media.some(
        (item) =>
          schedulerMediaKindForMime(item.mimeType) === "file" &&
          !definition.documentMimeTypes!.includes(item.mimeType),
      )
    ) {
      errors[provider] = `${definition.name} needs a PDF or Office document.`;
      continue;
    }
    if (
      provider === "linkedin" &&
      media.some((item) => item.mimeType.startsWith("image/")) &&
      media.some((item) => item.mimeType.startsWith("video/"))
    ) {
      errors[provider] = "LinkedIn cannot mix images and video in one post.";
      continue;
    }
    if (provider === "twitter") {
      const images = media.filter((item) => item.mimeType.startsWith("image/"));
      const videos = media.filter((item) => item.mimeType.startsWith("video/"));
      const gifs = images.filter((item) => item.mimeType === "image/gif");
      const stills = images.filter((item) => item.mimeType !== "image/gif");
      if (videos.length && images.length) {
        errors.twitter = "X cannot mix images and video in one post.";
        continue;
      }
      if (videos.length > 1) {
        errors.twitter = "X accepts one video per post.";
        continue;
      }
      if (gifs.length && (stills.length || videos.length)) {
        errors.twitter = "X GIF posts cannot include other images or video.";
        continue;
      }
      if (gifs.length > 1) {
        errors.twitter = "X accepts one GIF per post.";
        continue;
      }
      if (stills.length > 4) {
        errors.twitter = "X accepts up to 4 images per post.";
        continue;
      }
    }
    if (
      provider === "linkedin" &&
      media.some((item) => schedulerMediaKindForMime(item.mimeType) === "file") &&
      media.some((item) => item.mimeType.startsWith("image/") || item.mimeType.startsWith("video/"))
    ) {
      errors[provider] = "LinkedIn document posts cannot include images or video.";
      continue;
    }
    if (definition.requiresTitle && !title.trim()) {
      errors[provider] =
        provider === "youtube"
          ? "YouTube needs a video title."
          : `${definition.name} needs a post title.`;
      continue;
    }
    if (definition.maxTitle && title.trim().length > definition.maxTitle) {
      errors[provider] =
        `${definition.name} allows ${definition.maxTitle.toLocaleString()} title characters.`;
      continue;
    }
    const coverError = invalidVideoCover(provider, definition.name, settings, media);
    if (coverError) {
      errors[provider] = coverError;
      continue;
    }
    if (provider === "tiktok") {
      const privacy = String(settings.privacyLevel || "");
      if (!privacy) {
        errors.tiktok = "Choose a TikTok privacy setting.";
        continue;
      }
      if (
        settings.commercialContent === true &&
        settings.brandOrganicToggle !== true &&
        settings.brandContentToggle !== true
      ) {
        errors.tiktok =
          "Choose whether the TikTok post promotes your brand, another brand, or both.";
        continue;
      }
      if (settings.brandContentToggle === true && privacy === "SELF_ONLY") {
        errors.tiktok = "TikTok branded content cannot use Only me privacy.";
        continue;
      }
      const duration = Number(settings.videoDurationSeconds);
      const maximum = Number(settings.maxVideoPostDurationSec);
      if (
        Number.isFinite(duration) &&
        Number.isFinite(maximum) &&
        maximum > 0 &&
        duration > maximum
      ) {
        errors.tiktok = `This TikTok account accepts videos up to ${maximum} seconds.`;
        continue;
      }
    }
    if (provider === "reddit") {
      const community = String(settings.community || "")
        .trim()
        .replace(/^r\//i, "");
      if (!/^[A-Za-z0-9_]{2,21}$/.test(community)) {
        errors.reddit = "Choose a valid Reddit community, such as creators or r/creators.";
        continue;
      }
      const kind = String(settings.kind || "self");
      if (kind !== "self" && kind !== "link") {
        errors.reddit = "Choose a Reddit text post or link post.";
        continue;
      }
      if (kind === "self" && !body.trim()) {
        errors.reddit = "Reddit text posts need post text.";
        continue;
      }
      if (kind === "link") {
        try {
          const url = new URL(String(settings.url || ""));
          if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
        } catch {
          errors.reddit = "Reddit link posts need a valid https:// URL.";
        }
      }
    }
  }
  return errors;
}
