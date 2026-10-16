// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobSource, EncodedPacketSink, Input, MP4 } from "mediabunny";
import { prepareSchedulerVideoUpload, VIDEO_OPTIMIZATION_SOURCE_MAX_BYTES } from "./video-upload";
import type { SocialProvider } from "./social-scheduler";
import { hasMp4FastStart } from "./mp4-fast-start";

const originalBytes = readFileSync(new URL("../test/fixtures/social-video.mp4", import.meta.url));
const providers: SocialProvider[] = [
  "twitter",
  "instagram",
  "facebook",
  "threads",
  "linkedin",
  "youtube",
  "tiktok",
];
const file = (pad = 0) =>
  new File([originalBytes, new Uint8Array(pad)], "camera.mp4", { type: "video/mp4" });

async function packets(blob: Blob) {
  const input = new Input({ source: new BlobSource(blob), formats: [MP4] });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    const encoded = async (track: NonNullable<typeof video | typeof audio>) => {
      const result: Uint8Array[] = [];
      for await (const packet of new EncodedPacketSink(track).packets()) result.push(packet.data);
      return result;
    };
    return {
      video: await encoded(video!),
      audio: await encoded(audio!),
      duration: await input.computeDuration(),
      width: await video!.getDisplayWidth(),
      height: await video!.getDisplayHeight(),
    };
  } finally {
    input.dispose();
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("scheduler video preparation", () => {
  it.each(providers)("preserves fitting camera video for %s byte for byte", async (provider) => {
    const original = file();
    await expect(
      prepareSchedulerVideoUpload(original, { providers: [provider], maxBytes: 100_000 }),
    ).resolves.toBe(original);
  });

  it("losslessly repackages an oversized file without changing encoded video or audio", async () => {
    const original = file(300_000);
    const stages: string[] = [];
    const prepared = await prepareSchedulerVideoUpload(original, {
      providers,
      maxBytes: 100_000,
      onProgress: ({ stage }) => stages.push(stage),
    });
    expect(prepared.size).toBeLessThan(100_000);
    expect(prepared.type).toBe("video/mp4");
    expect(await hasMp4FastStart(prepared)).toBe(true);
    expect(stages).toContain("repackaging");
    expect(stages).not.toContain("compressing");
    const before = await packets(original);
    const after = await packets(prepared);
    expect(after.video).toEqual(before.video);
    expect(after.audio).toEqual(before.audio);
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    expect(after.duration).toBeCloseTo(before.duration, 2);
    expect(original.size).toBe(originalBytes.length + 300_000);
  });

  it("does not return an oversized output when video encoding is unavailable", async () => {
    vi.stubGlobal("VideoDecoder", undefined);
    await expect(
      prepareSchedulerVideoUpload(file(300_000), { providers, maxBytes: 10_000 }),
    ).rejects.toThrow(/browser|decode|export/i);
  });

  it("cancels preparation before any upload can use a partial video", async () => {
    const controller = new AbortController();
    await expect(
      prepareSchedulerVideoUpload(file(300_000), {
        providers,
        maxBytes: 100_000,
        signal: controller.signal,
        onProgress: ({ stage }) => {
          if (stage === "repackaging") controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects empty and over-budget source files before loading an encoder", async () => {
    await expect(
      prepareSchedulerVideoUpload(new File([], "empty.mp4"), { providers, maxBytes: 100_000 }),
    ).rejects.toThrow(/empty/);
    const oversized = file();
    Object.defineProperty(oversized, "size", { value: VIDEO_OPTIMIZATION_SOURCE_MAX_BYTES + 1 });
    await expect(
      prepareSchedulerVideoUpload(oversized, { providers, maxBytes: 250 * 1024 ** 2 }),
    ).rejects.toThrow(/up to 1 GB/);
  });
});
