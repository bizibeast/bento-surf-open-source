import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  UrlSource,
  type InputAudioTrack,
} from "mediabunny";
import { ensureAacEncoder } from "./video-optimization";
import { reelAudioTrackStart } from "./reel-audio-timing";

export const REEL_AUDIO_MAX_DURATION = 180;
export const REEL_AUDIO_MAX_TRACK_BYTES = 25 * 1024 ** 2;
const SAMPLE_RATE = 48_000;

type ReelMixOptions = {
  originalVolume: number;
  trackVolume: number;
  track: File | null;
  trackStartSeconds?: number;
  maxBytes: number;
  signal: AbortSignal;
};

async function addAudio(
  context: OfflineAudioContext,
  source: InputAudioTrack,
  volume: number,
  offset: number,
  duration: number,
  signal: AbortSignal,
) {
  if (volume === 0) return;
  const gain = context.createGain();
  gain.gain.value = volume / 100;
  gain.connect(context.destination);
  for await (const { buffer, timestamp } of new AudioBufferSink(source).buffers(
    Math.max(0, offset - 0.25),
    offset + duration,
  )) {
    signal.throwIfAborted();
    const start = timestamp - offset;
    const trim = Math.max(0, -start);
    const length = Math.min(buffer.duration - trim, duration - Math.max(0, start));
    if (length <= 0) continue;
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(gain);
    node.start(Math.max(0, start), trim, length);
  }
}

export async function mixInstagramReelAudio(videoUrl: string, options: ReelMixOptions) {
  const { track, originalVolume, trackVolume, maxBytes, signal, trackStartSeconds = 0 } = options;
  if (
    !Number.isFinite(trackStartSeconds) ||
    trackStartSeconds < 0 ||
    (!track && trackStartSeconds !== 0)
  )
    throw new Error("Choose a valid start time for an uploaded audio track.");
  if (track && (track.size === 0 || track.size > REEL_AUDIO_MAX_TRACK_BYTES))
    throw new Error("Choose a non-empty audio file up to 25 MB.");
  const input = new Input({
    formats: ALL_FORMATS,
    source: new UrlSource(videoUrl, { maxCacheSize: 8 * 1024 ** 2, getRetryDelay: () => null }),
  });
  const musicInput = track
    ? new Input({ formats: ALL_FORMATS, source: new BlobSource(track) })
    : null;
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const abort = () => {
    input.dispose();
    musicInput?.dispose();
    if (output.state === "started") void output.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const [video, original, music] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
      musicInput?.getPrimaryAudioTrack(),
    ]);
    if (!video || (await video.getCodec()) !== "avc")
      throw new Error("Choose an H.264 MP4 to mix audio into this Reel.");
    if (track && !music) throw new Error("Choose a supported MP3, M4A, or WAV track.");
    const [first, end, configuration, transformationMatrix] = await Promise.all([
      video.getFirstTimestamp(),
      video.computeDuration(),
      video.getDecoderConfig(),
      video.getTransformationMatrix(),
    ]);
    const duration = end - first;
    if (duration <= 0 || !Number.isFinite(duration) || duration > REEL_AUDIO_MAX_DURATION)
      throw new Error("Audio mixing supports Reels up to 3 minutes.");
    if (!configuration) throw new Error("Bento could not read this video's format.");
    const musicStart = music
      ? reelAudioTrackStart(
          await music.getFirstTimestamp(),
          await music.computeDuration(),
          trackStartSeconds,
        )
      : 0;
    const mixer = new OfflineAudioContext(2, Math.ceil(duration * SAMPLE_RATE), SAMPLE_RATE);
    await Promise.all([
      original && addAudio(mixer, original, originalVolume, first, duration, signal),
      music && addAudio(mixer, music, trackVolume, musicStart, duration, signal),
      ensureAacEncoder(true),
    ]);
    const mixed = await mixer.startRendering();
    signal.throwIfAborted();
    const videoSource = new EncodedVideoPacketSource("avc");
    const audioSource = new AudioBufferSource({ codec: "aac", bitrate: 160_000 });
    output.addVideoTrack(videoSource, { transformationMatrix });
    output.addAudioTrack(audioSource);
    await output.start();
    let firstPacket = true;
    for await (const packet of new EncodedPacketSink(video).packets()) {
      signal.throwIfAborted();
      await videoSource.add(
        packet.clone({ timestamp: packet.timestamp - first }),
        firstPacket ? { decoderConfig: configuration } : undefined,
      );
      firstPacket = false;
    }
    videoSource.close();
    await audioSource.add(mixed);
    await output.finalize();
    signal.throwIfAborted();
    if (!target.buffer || target.buffer.byteLength > maxBytes)
      throw new Error("The mixed Reel is larger than your upload limit. Choose a smaller video.");
    return new File([target.buffer], "instagram-reel-audio.mp4", { type: "video/mp4" });
  } catch (error) {
    if (output.state === "started") await output.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    input.dispose();
    musicInput?.dispose();
  }
}
