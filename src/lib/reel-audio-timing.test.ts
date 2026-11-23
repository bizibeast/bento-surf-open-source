import { expect, it } from "vitest";
import { reelAudioTrackStart } from "./reel-audio-timing";
import { instagramCatalogAudioSchema, instagramReelAudioSchema } from "./social-scheduler";

it("uses a relative offset even when the input audio has a nonzero timestamp", () => {
  expect(reelAudioTrackStart(1.5, 12, 3.25)).toBe(4.75);
  expect(reelAudioTrackStart(1.5, 12)).toBe(1.5);
});
it.each([-1, NaN, Infinity, 10.5, 20])(
  "rejects an invalid or exhausted audio start: %s",
  (start) => {
    expect(() => reelAudioTrackStart(1.5, 12, start)).toThrow(/before the end/);
  },
);
it("keeps older saved mixes compatible and preserves new uploaded-track offsets", () => {
  const mix = {
    sourceKey: "users/owner/video/source.mp4",
    video: {
      key: "users/owner/video/mix.mp4",
      url: "https://example.com/mix.mp4",
      name: "mix.mp4",
      mimeType: "video/mp4",
      size: 100,
    },
    trackName: "music.wav",
    originalVolume: 100,
    trackVolume: 40,
  };
  expect(instagramReelAudioSchema.parse(mix).trackStartSeconds).toBeUndefined();
  expect(
    instagramReelAudioSchema.parse({ ...mix, trackStartSeconds: 12.5 }).trackStartSeconds,
  ).toBe(12.5);
  expect(instagramReelAudioSchema.safeParse({ ...mix, trackStartSeconds: -1 }).success).toBe(false);
});
it("rejects unsupported publishing offsets for Instagram catalog tracks", () => {
  const catalog = {
    sourceKey: "users/owner/video/source.mp4",
    connectionId: "00000000-0000-4000-8000-000000000001",
    audioId: "1234",
    title: "Song",
    creator: null,
    originalVolume: 100,
    trackVolume: 40,
  };
  expect(instagramCatalogAudioSchema.safeParse(catalog).success).toBe(true);
  expect(instagramCatalogAudioSchema.safeParse({ ...catalog, trackStartSeconds: 12 }).success).toBe(
    false,
  );
});
