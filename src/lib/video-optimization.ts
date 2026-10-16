import {
  ALL_FORMATS,
  BlobSource,
  canEncodeAudio,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  type ConversionVideoOptions,
} from "mediabunny";
import { inferredSchedulerMimeType, SOCIAL_PROVIDER_DEFINITIONS } from "./social-scheduler";
import type { VideoPreparationOptions } from "./video-upload";
import { hasMp4FastStart, prepareMp4FastStart } from "./mp4-fast-start";

export type VideoOptimizationMetadata = {
  width: number;
  height: number;
  duration: number;
  frameRate: number;
  audioBitrate: number;
};

class VideoBudgetError extends Error {}

/** Keep all frames and stop at a conservative bitrate floor, rather than silently
 * producing a blurry video. Prefer the source resolution before resizing. */
export function videoEncodingCandidates(info: VideoOptimizationMetadata, maxBytes: number) {
  const available = (maxBytes * 8 * 0.9) / info.duration - info.audioBitrate - 64_000;
  const longEdge = Math.max(info.width, info.height);
  const seen = new Set<string>();
  return [longEdge, 2560, 1920, 1280].flatMap((edge) => {
    const scale = Math.min(1, edge / longEdge);
    const width = Math.max(2, Math.floor((info.width * scale) / 2) * 2);
    const height = Math.max(2, Math.floor((info.height * scale) / 2) * 2);
    const key = `${width}x${height}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const pixelsPerSecond = width * height * Math.max(24, info.frameRate);
    const floor = Math.max(1_000_000, pixelsPerSecond * 0.12);
    if (available < floor) return [];
    return [
      {
        width,
        height,
        bitrate: Math.floor(Math.min(available, Math.max(floor, pixelsPerSecond * 0.22))),
      },
    ];
  });
}

let aacRegistration: Promise<void> | undefined;
async function ensureAacEncoder() {
  if (await canEncodeAudio("aac")) return;
  aacRegistration ??= import("@mediabunny/aac-encoder")
    .then(({ registerAacEncoder }) => registerAacEncoder())
    .catch((error) => {
      aacRegistration = undefined;
      throw error;
    });
  await aacRegistration;
}

function mediaInput(blob: Blob) {
  return new Input({
    source: new BlobSource(blob, { maxCacheSize: 4 * 1024 ** 2 }),
    formats: ALL_FORMATS,
  });
}

async function verifyVideo(blob: Blob, source: Input, width: number, height: number) {
  const result = mediaInput(blob);
  try {
    const sourceVideos = await source.getVideoTracks();
    const sourceAudio = await source.getAudioTracks();
    const videos = await result.getVideoTracks();
    const audio = await result.getAudioTracks();
    if (videos.length !== sourceVideos.length || audio.length !== sourceAudio.length)
      throw new Error("Video preparation could not preserve every video and audio track.");
    if (!videos.length || (await videos[0].getCodec()) !== "avc")
      throw new Error("The prepared video is not a compatible MP4.");
    const [actualWidth, actualHeight] = await Promise.all([
      videos[0].getDisplayWidth(),
      videos[0].getDisplayHeight(),
    ]);
    if (Math.abs(actualWidth - width) > 2 || Math.abs(actualHeight - height) > 2)
      throw new Error("Video preparation changed the frame unexpectedly.");
    const sourceStart = Math.max(0, await source.getFirstTimestamp());
    const sourceDuration = (await source.computeDuration()) - sourceStart;
    const resultDuration =
      (await result.computeDuration()) - Math.max(0, await result.getFirstTimestamp());
    if (Math.abs(sourceDuration - resultDuration) > Math.max(0.15, sourceDuration * 0.001))
      throw new Error(
        "Video preparation could not preserve the full duration. Try another export.",
      );
    for (let index = 0; index < videos.length; index += 1) {
      const [before, after] = await Promise.all([
        sourceVideos[index].computePacketStats(),
        videos[index].computePacketStats(),
      ]);
      if (before.packetCount !== after.packetCount)
        throw new Error("Video preparation could not preserve every frame. Choose another export.");
    }
    for (const [index, track] of audio.entries()) {
      if ((await track.getCodec()) !== "aac")
        throw new Error("Video preparation could not preserve compatible audio.");
      const before = await sourceAudio[index].computeDuration();
      const after = await track.computeDuration();
      const offset = Math.max(0, await source.getFirstTimestamp());
      if (
        Math.abs(before - offset - after) > Math.max(0.15, sourceDuration * 0.001) ||
        (await sourceAudio[index].getNumberOfChannels()) !== (await track.getNumberOfChannels())
      )
        throw new Error(
          "Video preparation could not preserve the full audio. Choose another export.",
        );
    }
  } finally {
    result.dispose();
  }
}

/** Browser encoding avoids Worker memory limits and processes the full video.
 * Lossless packet copying comes first; compression is used only when necessary. */
export async function optimizeSchedulerVideo(file: File, options: VideoPreparationOptions) {
  const input = mediaInput(file);
  let active: Conversion | undefined;
  const controller = new AbortController();
  const abort = () => {
    controller.abort(options.signal?.reason ?? new DOMException("Canceled", "AbortError"));
    input.dispose();
    void active?.cancel().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  let stallTimer: ReturnType<typeof setTimeout>;
  const touch = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      controller.abort(new Error("Video preparation timed out. Please try again with this file."));
      input.dispose();
      void active?.cancel().catch(() => undefined);
    }, 90_000);
  };
  const deadline = setTimeout(() => {
    controller.abort(new Error("This video is taking too long to prepare. Try a smaller export."));
    input.dispose();
    void active?.cancel().catch(() => undefined);
  }, 15 * 60_000);
  touch();

  const run = async (video: ConversionVideoOptions, lossless: boolean) => {
    controller.signal.throwIfAborted();
    let blob = new Blob([], { type: "video/mp4" });
    let budgetExceeded = false;
    const target = new StreamTarget(
      new WritableStream({
        write({ data, position }) {
          if (controller.signal.aborted || budgetExceeded) return;
          const end = position + data.byteLength;
          if (end > options.maxBytes) {
            budgetExceeded = true;
            // Cancel the converter without erroring its writable stream. Its
            // cleanup must still be able to close the stream normally.
            void active?.cancel().catch(() => undefined);
            return;
          }
          // MP4 writes its final header back at the start. Blob slices support
          // these writes without making a second full-size ArrayBuffer.
          const gap = Math.max(0, position - blob.size);
          blob = new Blob([blob.slice(0, position), new Uint8Array(gap), data, blob.slice(end)], {
            type: "video/mp4",
          });
          touch();
        },
      }),
      { chunked: true, chunkSize: 1024 ** 2 },
    );
    const output = new Output({ target, format: new Mp4OutputFormat({ fastStart: false }) });
    active = await Conversion.init({
      input,
      output,
      video,
      audio: (track) =>
        track
          .getCodec()
          .then((codec) =>
            codec === "aac"
              ? {}
              : { codec: "aac" as const, quality: new Quality({ bitrate: 192_000 }) },
          ),
      ...(lossless ? { copy: { mode: "forced" as const } } : {}),
      tags: {},
      showWarnings: false,
    });
    if (!active.isValid || active.discardedTracks.length) {
      await active.cancel();
      active = undefined;
      throw new Error(
        "This browser cannot prepare this video while keeping its audio. Try the latest Chrome or Safari, or export an H.264 MP4 with AAC audio.",
      );
    }
    active.onProgress = (fraction) => {
      touch();
      options.onProgress?.({
        stage: lossless ? "repackaging" : "compressing",
        fraction: Math.min(0.99, fraction),
      });
    };
    try {
      await active.execute();
      controller.signal.throwIfAborted();
      if (!blob.size || blob.size > options.maxBytes)
        throw new VideoBudgetError("The prepared video is too large.");
      if (budgetExceeded) throw new VideoBudgetError("The video still exceeds the upload limit.");
      return blob;
    } catch (error) {
      if (budgetExceeded) throw new VideoBudgetError("The video still exceeds the upload limit.");
      throw error;
    } finally {
      await active.cancel().catch(() => undefined);
      active = undefined;
    }
  };

  try {
    options.signal?.throwIfAborted();
    const videos = await input.getVideoTracks();
    const audio = await input.getAudioTracks();
    if (!videos.length)
      throw new Error("This file does not contain a readable video. Choose another export.");
    const video = videos[0];
    const width = await video.getDisplayWidth();
    const height = await video.getDisplayHeight();
    const codecs = await Promise.all(audio.map((track) => track.getCodec()));
    const commonCodecs =
      (await video.getCodec()) === "avc" && codecs.every((codec) => codec === "aac");
    const mimeType = inferredSchedulerMimeType(file);
    const acceptedContainer = options.providers.every((provider) =>
      SOCIAL_PROVIDER_DEFINITIONS[provider].videoMimeTypes?.includes(mimeType),
    );
    const flexibleCodecs =
      options.providers.length > 0 &&
      options.providers.every((provider) => provider === "youtube" || provider === "tiktok");
    const metaDestination = options.providers.some((provider) =>
      ["instagram", "facebook", "threads"].includes(provider),
    );
    const compatibleIndex =
      !metaDestination || (commonCodecs && acceptedContainer && (await hasMp4FastStart(file)));
    if (
      file.size <= options.maxBytes &&
      acceptedContainer &&
      (commonCodecs || flexibleCodecs) &&
      compatibleIndex
    ) {
      controller.signal.throwIfAborted();
      return file;
    }
    if (commonCodecs) {
      options.onProgress?.({ stage: "repackaging", fraction: 0 });
      try {
        const blob = await prepareMp4FastStart(await run({ codec: "avc" }, true));
        options.onProgress?.({ stage: "verifying", fraction: 0.99 });
        await verifyVideo(blob, input, width, height);
        return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".mp4", {
          type: "video/mp4",
          lastModified: file.lastModified,
        });
      } catch (error) {
        if (!(error instanceof VideoBudgetError)) throw error;
      }
    }
    if (await video.hasHighDynamicRange())
      throw new Error(
        "This HDR video needs an SDR H.264 export to fit the limit while preserving its colors.",
      );
    if (await video.canBeTransparent())
      throw new Error(
        "This video has transparency that a social MP4 cannot preserve. Choose an opaque export.",
      );
    if (videos.length !== 1)
      throw new Error("Choose a video with one video track so Bento can optimize it safely.");
    if (!(await video.canDecode()))
      throw new Error(
        "This browser cannot decode this video. Try the latest Chrome or Safari, or export an H.264 MP4 with AAC audio.",
      );
    if (codecs.some((codec) => codec !== "aac")) await ensureAacEncoder();
    const duration = (await input.computeDuration()) - Math.max(0, await input.getFirstTimestamp());
    const stats = await video.computePacketStats(120);
    const audioStats = await Promise.all(audio.map((track) => track.computePacketStats(120)));
    const audioBitrate = audioStats.reduce(
      (sum, stat, index) =>
        sum + (codecs[index] === "aac" ? Math.max(192_000, stat.averageBitrate) : 192_000),
      0,
    );
    if (
      ![width, height, duration, stats.averagePacketRate].every(
        (value) => Number.isFinite(value) && value > 0,
      )
    )
      throw new Error(
        "This video's dimensions or duration could not be verified. Choose another export.",
      );
    const candidates = videoEncodingCandidates(
      { width, height, duration, frameRate: stats.averagePacketRate, audioBitrate },
      options.maxBytes,
    );
    for (const candidate of candidates) {
      options.onProgress?.({ stage: "compressing", fraction: 0 });
      try {
        const blob = await prepareMp4FastStart(
          await run(
            {
              codec: "avc",
              width: candidate.width,
              height: candidate.height,
              fit: "contain",
              allowTransformationMetadata: false,
              quality: new Quality({ bitrate: candidate.bitrate, bitrateMode: "variable" }),
              forceTranscode: true,
            },
            false,
          ),
        );
        options.onProgress?.({ stage: "verifying", fraction: 0.99 });
        await verifyVideo(blob, input, candidate.width, candidate.height);
        return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".mp4", {
          type: "video/mp4",
          lastModified: file.lastModified,
        });
      } catch (error) {
        if (!(error instanceof VideoBudgetError)) throw error;
      }
    }
    throw new Error(
      `This video cannot fit the ${Math.floor(options.maxBytes / 1024 ** 2)} MB upload limit at high quality. Choose a shorter or smaller export. Bento will not trim it or remove its audio.`,
    );
  } catch (error) {
    controller.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(stallTimer!);
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", abort);
    input.dispose();
  }
}
