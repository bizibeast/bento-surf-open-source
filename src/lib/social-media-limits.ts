import type { SocialProvider, SchedulerMedia } from "./social-scheduler";
import {
  LINKEDIN_DOCUMENT_MAX_BYTES,
  LINKEDIN_IMAGE_MAX_BYTES,
  LINKEDIN_VIDEO_MAX_BYTES,
  SOCIAL_IMAGE_OPTIMIZATION_MAX_BYTES,
  X_GIF_MAX_BYTES,
  X_IMAGE_MAX_BYTES,
  X_VIDEO_MAX_BYTES,
} from "./social-provider-media";

// Conservative upload budgets for the video publishing APIs. Account-specific
// duration and privacy rules still apply; optimization never trims a video.
const VIDEO_BYTE_LIMITS: Partial<Record<SocialProvider, number>> = {
  twitter: X_VIDEO_MAX_BYTES,
  linkedin: LINKEDIN_VIDEO_MAX_BYTES,
  instagram: 1024 ** 3,
  facebook: 4 * 1024 ** 3,
  threads: 1024 ** 3,
  tiktok: 4 * 1024 ** 3,
  youtube: 256 * 1024 ** 3,
};

/** Optimize against both the plan allowance and every selected destination. */
export function schedulerVideoByteLimit(providers: readonly SocialProvider[], planBytes: number) {
  return Math.min(
    planBytes,
    ...providers.map((provider) => VIDEO_BYTE_LIMITS[provider] ?? Infinity),
  );
}

/** Publishing budgets shared by the composer and server preflight. */
export function socialMediaByteLimit(provider: SocialProvider, mimeType: string): number | null {
  if (mimeType.startsWith("video/")) return VIDEO_BYTE_LIMITS[provider] ?? null;
  if (provider === "twitter")
    return mimeType === "image/gif"
      ? X_GIF_MAX_BYTES
      : mimeType.startsWith("image/")
        ? X_IMAGE_MAX_BYTES
        : mimeType.startsWith("video/")
          ? X_VIDEO_MAX_BYTES
          : null;
  if (provider === "linkedin")
    return mimeType.startsWith("image/")
      ? LINKEDIN_IMAGE_MAX_BYTES
      : mimeType.startsWith("video/")
        ? LINKEDIN_VIDEO_MAX_BYTES
        : LINKEDIN_DOCUMENT_MAX_BYTES;
  if (mimeType.startsWith("image/")) {
    if (provider === "instagram" || provider === "threads") return 8 * 1024 * 1024;
    // A conservative photo publishing budget; Facebook fetches the finished URL.
    if (provider === "facebook") return 4 * 1024 * 1024;
  }
  return null;
}

export function schedulerImageByteLimit(providers: readonly SocialProvider[]) {
  return Math.min(
    X_IMAGE_MAX_BYTES,
    ...providers.map((provider) => socialMediaByteLimit(provider, "image/jpeg") ?? Infinity),
  );
}

export function socialMediaSizeError(
  provider: SocialProvider,
  media: Pick<SchedulerMedia, "size" | "mimeType">,
) {
  const limit = socialMediaByteLimit(provider, media.mimeType);
  if (!limit || media.size <= limit) return null;
  const still = ["image/jpeg", "image/png", "image/webp"].includes(media.mimeType);
  if (still && media.size <= SOCIAL_IMAGE_OPTIMIZATION_MAX_BYTES) return null;
  const name =
    provider === "twitter"
      ? "X"
      : provider === "linkedin"
        ? "LinkedIn"
        : provider[0].toUpperCase() + provider.slice(1);
  const size = limit >= 1024 ** 3 ? `${limit / 1024 ** 3} GB` : `${limit / 1024 ** 2} MB`;
  return still
    ? `${name} needs a smaller image. Upload it again so Bento can optimize it before scheduling.`
    : `${name} accepts this file up to ${size}. Choose a smaller file before scheduling.`;
}
