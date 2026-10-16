import type { SocialProvider } from "./social-scheduler";

// Read inputs in ranges instead of loading the original into an ArrayBuffer.
export const VIDEO_OPTIMIZATION_SOURCE_MAX_BYTES = 1024 ** 3;

export type VideoPreparationProgress = {
  stage: "checking" | "repackaging" | "compressing" | "verifying";
  fraction: number;
};

export type VideoPreparationOptions = {
  maxBytes: number;
  providers: readonly SocialProvider[];
  signal?: AbortSignal;
  onProgress?: (progress: VideoPreparationProgress) => void;
};

/** Lazy-load video tooling only when a creator adds a video to the scheduler. */
export async function prepareSchedulerVideoUpload(file: File, options: VideoPreparationOptions) {
  options.signal?.throwIfAborted();
  if (file.size <= 0) throw new Error("This video is empty. Choose another file.");
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)
    throw new Error("The video upload limit is unavailable. Please try again.");
  if (file.size > VIDEO_OPTIMIZATION_SOURCE_MAX_BYTES)
    throw new Error("Choose a video up to 1 GB. Bento will optimize it to your upload limit.");
  options.onProgress?.({ stage: "checking", fraction: 0 });
  const { optimizeSchedulerVideo } = await import("./video-optimization");
  options.signal?.throwIfAborted();
  return optimizeSchedulerVideo(file, options);
}
