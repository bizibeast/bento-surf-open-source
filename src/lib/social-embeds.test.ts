import { describe, expect, it } from "vitest";
import {
  normalizeSocialEmbedContent,
  socialEmbedProviderFromContent,
  socialEmbedSourceUrl,
  socialEmbedUrl,
  tiktokPhotoSourceUrl,
} from "./social-embeds";

describe("socialEmbedUrl", () => {
  it.each([
    [
      "https://www.youtube.com/watch?v=M7lc1UVf-VE",
      "https://www.youtube.com/embed/M7lc1UVf-VE?playsinline=1&rel=0",
    ],
    [
      "https://youtu.be/M7lc1UVf-VE?t=10",
      "https://www.youtube.com/embed/M7lc1UVf-VE?playsinline=1&rel=0",
    ],
    [
      "youtube.com/shorts/M7lc1UVf-VE",
      "https://www.youtube.com/embed/M7lc1UVf-VE?playsinline=1&rel=0",
    ],
  ])("normalizes a YouTube share URL", (input, expected) => {
    expect(socialEmbedUrl("youtube", input)).toBe(expected);
  });

  it("recognizes legacy YouTube video blocks that did not save an embed provider", () => {
    expect(
      socialEmbedProviderFromContent({
        url: "https://www.youtube.com/embed/M7lc1UVf-VE",
      }),
    ).toBe("youtube");
  });

  it("persists the provider while normalizing a YouTube video block", () => {
    expect(
      normalizeSocialEmbedContent("youtube", {
        originalUrl: "https://youtu.be/M7lc1UVf-VE",
      }),
    ).toEqual(
      expect.objectContaining({
        embedProvider: "youtube",
        originalUrl: "https://youtu.be/M7lc1UVf-VE",
        url: "https://www.youtube.com/embed/M7lc1UVf-VE?playsinline=1&rel=0",
      }),
    );
  });

  it.each([
    ["https://www.instagram.com/reel/ABC_def123/", "reel"],
    ["instagram.com/p/ABC_def123/?img_index=1", "p"],
    ["https://instagram.com/tv/ABC_def123/", "tv"],
  ])("normalizes a public Instagram post URL", (input, kind) => {
    expect(socialEmbedUrl("instagram", input)).toBe(
      `https://www.instagram.com/${kind}/ABC_def123/embed/`,
    );
  });

  it("builds the official TikTok player URL from a full video link", () => {
    expect(
      socialEmbedUrl("tiktok", "https://www.tiktok.com/@scout2015/video/6718335390845095173"),
    ).toBe("https://www.tiktok.com/player/v1/6718335390845095173?autoplay=0");
  });

  it("recognizes TikTok photo posts without treating them as video embeds", () => {
    const input = "https://www.tiktok.com/@creator/photo/7400000000000000000?lang=en#comments";

    expect(tiktokPhotoSourceUrl(input)).toBe(
      "https://www.tiktok.com/@creator/photo/7400000000000000000?lang=en",
    );
    expect(socialEmbedUrl("tiktok", input)).toBeNull();
  });

  it.each([
    "https://www.tiktok.com/@creator/video/7400000000000000000",
    "https://www.tiktok.com/@creator/photo/not-an-id",
    "https://www.tiktok.com/@creator/photo/7400000000000000000/extra",
    "https://user@www.tiktok.com/@creator/photo/7400000000000000000",
    "https://www.tiktok.com:444/@creator/photo/7400000000000000000",
    "https://tiktok.com.evil.example/@creator/photo/7400000000000000000",
  ])("rejects a non-photo TikTok source URL: %s", (input) => {
    expect(tiktokPhotoSourceUrl(input)).toBeNull();
  });

  it.each([
    "x.com/bento/status/1234567890123456789",
    "https://twitter.com/bento/status/1234567890123456789",
  ])("builds an X post iframe from either supported domain", (input) => {
    expect(socialEmbedUrl("twitter", input)).toBe(
      "https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789&dnt=true&theme=light",
    );
  });

  it("accepts historical X posts with short numeric IDs", () => {
    expect(socialEmbedUrl("twitter", "https://twitter.com/jack/status/20")).toBe(
      "https://platform.twitter.com/embed/Tweet.html?id=20&dnt=true&theme=light",
    );
  });

  it("builds a dark X post iframe when requested", () => {
    expect(
      socialEmbedUrl("twitter", "https://x.com/bento/status/1234567890123456789", {
        twitterTheme: "dark",
      }),
    ).toBe(
      "https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789&dnt=true&theme=dark",
    );
  });

  it("repairs a legacy Twitter iframe URL into an editable X post URL", () => {
    const legacy =
      "https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789&dnt=true&theme=light";

    expect(socialEmbedSourceUrl("twitter", legacy)).toBe(
      "https://x.com/i/status/1234567890123456789",
    );
    expect(
      normalizeSocialEmbedContent("twitter", {
        embedProvider: "twitter",
        originalUrl: legacy,
        url: "",
        twitterTheme: "dark",
      }),
    ).toEqual(
      expect.objectContaining({
        originalUrl: "https://x.com/i/status/1234567890123456789",
        url: "https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789&dnt=true&theme=dark",
        twitterTheme: "dark",
      }),
    );
  });

  it.each([
    ["youtube", "https://youtube.com/@bento"],
    ["instagram", "https://instagram.com/bento"],
    ["tiktok", "https://vm.tiktok.com/ZMshort/"],
    ["twitter", "https://example.com/bento/status/1234567890123456789"],
    ["instagram", "javascript:alert(1)"],
  ] as const)("rejects non-post and unsafe URLs", (provider, input) => {
    expect(socialEmbedUrl(provider, input)).toBeNull();
  });
});
