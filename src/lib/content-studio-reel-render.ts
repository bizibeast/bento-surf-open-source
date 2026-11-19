import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  UrlSource,
  canEncodeAudio,
  canEncodeVideo,
} from "mediabunny";
import { reelTimeline, type ReelScene, type StudioMedia, type StudioReel } from "./content-studio";
import { drawStudioReelScene, REEL_HEIGHT, REEL_WIDTH } from "./content-studio-reel-draw";
import { loadStudioImage } from "./content-studio-carousel";

const FPS = 30;
const AUDIO_RATE = 48000;
type VideoTrack = NonNullable<Awaited<ReturnType<Input["getPrimaryVideoTrack"]>>>;
type AudioTrack = NonNullable<Awaited<ReturnType<Input["getPrimaryAudioTrack"]>>>;

export type ReelAssets = {
  media: Map<string, StudioMedia>;
  avatarUrls: Map<string, string>;
};

export function studioReelAsset(scene: ReelScene, assets: ReelAssets) {
  if (scene.kind === "card") return undefined;
  const media = scene.mediaId ? assets.media.get(scene.mediaId) : undefined;
  if (media) return media;
  const avatarUrl =
    scene.kind === "avatar" && !scene.mediaId && scene.avatarJobId
      ? assets.avatarUrls.get(scene.avatarJobId)
      : undefined;
  if (avatarUrl)
    return {
      id: scene.avatarJobId!,
      url: avatarUrl,
      name: "Generated avatar",
      kind: "video" as const,
    };
  return undefined;
}

let registeredAacEncoder: Promise<void> | undefined;

async function prepareAacEncoder() {
  if (await canEncodeAudio("aac")) return;
  registeredAacEncoder ??= import("@mediabunny/aac-encoder")
    .then(({ registerAacEncoder }) => registerAacEncoder())
    .catch((error) => {
      registeredAacEncoder = undefined;
      throw error;
    });
  await registeredAacEncoder;
}

async function mixSceneAudio(
  track: AudioTrack,
  target: AudioBuffer,
  timelineStart: number,
  sourceStart: number,
  duration: number,
  signal?: AbortSignal,
) {
  const sink = new AudioBufferSink(track);
  const outputStart = Math.round(timelineStart * AUDIO_RATE);
  const outputLength = duration * AUDIO_RATE;
  for await (const { buffer, timestamp } of sink.buffers(
    Math.max(0, sourceStart - 0.1),
    sourceStart + duration,
  )) {
    signal?.throwIfAborted();
    const start = Math.max(0, Math.ceil((timestamp - sourceStart) * AUDIO_RATE));
    const end = Math.min(
      outputLength,
      Math.ceil((timestamp + buffer.duration - sourceStart) * AUDIO_RATE),
    );
    for (let channel = 0; channel < target.numberOfChannels; channel += 1) {
      const out = target.getChannelData(channel);
      const source = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
      for (let frame = start; frame < end; frame += 1) {
        const sample = (sourceStart + frame / AUDIO_RATE - timestamp) * buffer.sampleRate;
        const index = Math.max(0, Math.min(source.length - 1, Math.floor(sample)));
        const next = Math.min(source.length - 1, index + 1);
        out[outputStart + frame] =
          source[index] + (source[next] - source[index]) * (sample - index);
      }
    }
  }
}

export async function renderStudioReel(
  document: StudioReel,
  assets: ReelAssets,
  updateProgress: (progress: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  await window.document.fonts?.ready;
  if (!(await canEncodeVideo("avc", { width: REEL_WIDTH, height: REEL_HEIGHT }))) {
    throw new Error(
      "This browser cannot encode an H.264 MP4. Open Studio in a browser with WebCodecs H.264 support.",
    );
  }

  const timeline = reelTimeline(document);
  const duration = timeline.at(-1)!.end;
  const canvas = window.document.createElement("canvas");
  canvas.width = REEL_WIDTH;
  canvas.height = REEL_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The browser could not open a video canvas.");

  const sources = new Map<string, { input: Input; video: VideoTrack; audio: AudioTrack | null }>();
  const images = new Map<string, HTMLImageElement>();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target: new BufferTarget(),
  });
  try {
    const tracks = [];
    for (const [index, { scene }] of timeline.entries()) {
      signal?.throwIfAborted();
      const asset = studioReelAsset(scene, assets);
      if (scene.kind !== "card" && !asset)
        throw new Error(`Choose or finish rendering the media for scene ${index + 1}.`);
      if (asset?.kind === "image" && !images.has(asset.url))
        images.set(asset.url, await loadStudioImage(asset.url));
      if (asset?.kind === "video" && !sources.has(asset.url)) {
        const input = new Input({
          formats: ALL_FORMATS,
          source: new UrlSource(asset.url, {
            getRetryDelay: () => null,
            maxCacheSize: 8 * 1024 * 1024,
          }),
        });
        try {
          const [video, audio] = await Promise.all([
            input.getPrimaryVideoTrack(),
            input.getPrimaryAudioTrack(),
          ]);
          if (!video || !(await video.canDecode()))
            throw new Error(`The video in scene ${index + 1} cannot be decoded.`);
          sources.set(asset.url, { input, audio, video });
        } catch (error) {
          input.dispose();
          throw error;
        }
      }
      const clip = asset && sources.get(asset.url);
      const audio = clip && !scene.mute ? clip.audio : null;
      if (audio && !(await audio.canDecode()))
        throw new Error(
          `The audio in scene ${index + 1} cannot be decoded. Mute the scene or choose another clip.`,
        );
      tracks.push({ clip, image: asset && images.get(asset.url), audio });
    }

    const frames = new CanvasSource(canvas, { codec: "avc", quality: new Quality("medium") });
    output.addVideoTrack(frames, { frameRate: FPS });

    let audioOutput: AudioBufferSource | undefined;
    if (tracks.some(({ audio }) => audio)) {
      await prepareAacEncoder();
      audioOutput = new AudioBufferSource({ codec: "aac", quality: new Quality("medium") });
      output.addAudioTrack(audioOutput);
    }
    await output.start();

    const mixedAudio = audioOutput
      ? new AudioBuffer({
          numberOfChannels: 2,
          sampleRate: AUDIO_RATE,
          length: duration * AUDIO_RATE,
        })
      : undefined;
    for (const [index, { scene, start }] of timeline.entries()) {
      const { clip, image, audio } = tracks[index];
      if (clip) {
        const firstTimestamp = await clip.video.getFirstTimestamp();
        const videoEnd = await clip.video.computeDuration();
        const sourceStart = firstTimestamp + scene.sourceStart;
        if (!Number.isFinite(videoEnd) || sourceStart + scene.duration > videoEnd + 0.05) {
          throw new Error(
            `Scene ${index + 1} is longer than the chosen source clip. Shorten the scene or its trim offset.`,
          );
        }
        const sink = new CanvasSink(clip.video, { width: REEL_WIDTH, poolSize: 3 });
        const times = Array.from(
          { length: scene.duration * FPS },
          (_, frame) => sourceStart + frame / FPS,
        );
        let frame = 0;
        for await (const sample of sink.canvasesAtTimestamps(times)) {
          signal?.throwIfAborted();
          if (!sample) throw new Error(`A video frame could not be read for scene ${index + 1}.`);
          drawStudioReelScene(context, document, scene, index, frame / FPS, {
            image: sample.canvas,
            width: sample.canvas.width,
            height: sample.canvas.height,
          });
          await frames.add(start + frame / FPS, 1 / FPS);
          frame += 1;
          if (frame % FPS === 0) updateProgress(((start + frame / FPS) / duration) * 0.95);
        }
        if (mixedAudio && audio)
          await mixSceneAudio(audio, mixedAudio, start, sourceStart, scene.duration, signal);
      } else {
        for (let frame = 0; frame < scene.duration * FPS; frame += 1) {
          signal?.throwIfAborted();
          drawStudioReelScene(
            context,
            document,
            scene,
            index,
            frame / FPS,
            image ? { image, width: image.naturalWidth, height: image.naturalHeight } : undefined,
          );
          await frames.add(start + frame / FPS, 1 / FPS);
          if (frame % FPS === 0) updateProgress(((start + frame / FPS) / duration) * 0.95);
        }
      }
    }
    if (audioOutput && mixedAudio) await audioOutput.add(mixedAudio);
    signal?.throwIfAborted();
    await output.finalize();
    if (!output.target.buffer) throw new Error("The MP4 could not be finalized.");
    updateProgress(1);
    return new Blob([output.target.buffer], { type: "video/mp4" });
  } catch (error) {
    if (output.state === "started") await output.cancel().catch(() => undefined);
    throw error;
  } finally {
    for (const source of sources.values()) source.input.dispose();
  }
}
