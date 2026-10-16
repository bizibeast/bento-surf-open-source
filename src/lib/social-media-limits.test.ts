import { describe, expect, it } from "vitest";
import { validatePostForProviders } from "./social-scheduler";
import {
  socialMediaSizeError,
  schedulerImageByteLimit,
  schedulerVideoByteLimit,
  socialMediaByteLimit,
} from "./social-media-limits";

describe("publishing media preflight", () => {
  const media = (mimeType: string, size: number) => ({
    key: "users/user/video",
    url: "https://bento.surf/cdn/users/user/video",
    name: "media",
    mimeType,
    size,
  });
  it("accepts the reported video instead of the former 100 MB ceiling", () => {
    expect(
      validatePostForProviders(
        "Caption",
        [media("video/mp4", 156_581_249)],
        ["twitter", "linkedin"],
      ),
    ).toEqual({});
  });
  it("permits optimization of oversized stills and blocks oversized animations and documents early", () => {
    expect(socialMediaSizeError("twitter", media("image/jpeg", 9 * 1024 ** 2))).toBeNull();
    expect(socialMediaSizeError("twitter", media("image/gif", 16 * 1024 ** 2))).toMatch(/15 MB/);
    expect(socialMediaSizeError("linkedin", media("application/pdf", 101 * 1024 ** 2))).toMatch(
      /100 MB/,
    );
    expect(socialMediaSizeError("twitter", media("image/png", 21 * 1024 ** 2))).toMatch(/optimize/);
  });
  it("optimizes shared images to the smallest selected destination budget", () => {
    expect(schedulerImageByteLimit(["twitter", "instagram"])).toBe(5 * 1024 ** 2);
    expect(schedulerImageByteLimit(["facebook", "twitter"])).toBe(4 * 1024 ** 2);
  });
  it("allows large JPEG thumbnails for server optimization", () => {
    expect(
      validatePostForProviders("Video", [media("video/mp4", 100)], ["youtube"], "Title", {
        youtube: { thumbnail: media("image/jpeg", 3 * 1024 ** 2) },
      }),
    ).toEqual({});
  });
  it("checks video sizes for every visible publishing destination against the smallest allowance", () => {
    const providers = [
      "twitter",
      "instagram",
      "facebook",
      "threads",
      "linkedin",
      "youtube",
      "tiktok",
    ] as const;
    for (const provider of providers) {
      const limit = socialMediaByteLimit(provider, "video/mp4")!;
      expect(limit).toBeGreaterThanOrEqual(250 * 1024 ** 2);
      expect(socialMediaSizeError(provider, media("video/mp4", limit + 1))).toMatch(/smaller file/);
    }
    expect(schedulerVideoByteLimit(providers, 250 * 1024 ** 2)).toBe(250 * 1024 ** 2);
    expect(schedulerVideoByteLimit(["threads", "youtube"], 2 * 1024 ** 3)).toBe(1024 ** 3);
  });
});
