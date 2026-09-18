import { describe, expect, it } from "vitest";
import {
  MEDIA_TOOLS_API_PATH,
  isMediaToolDownloadResult,
  isMediaToolTranscriptResult,
  mediaToolSpecsBySlug,
} from "./media-tools";

describe("media tool client contract", () => {
  it("exposes the approved URL media tools", () => {
    expect(MEDIA_TOOLS_API_PATH).toBe("/api/tools/media");
    expect(mediaToolSpecsBySlug).toEqual({
      "social-media-downloader": { platform: "auto", operation: "download", media: "all" },
      "youtube-video-downloader": {
        platform: "youtube",
        operation: "download",
        media: "video",
      },
      "instagram-video-downloader": {
        platform: "instagram",
        operation: "download",
        media: "video",
      },
      "instagram-photo-downloader": {
        platform: "instagram",
        operation: "download",
        media: "image",
      },
      "instagram-carousel-downloader": {
        platform: "instagram",
        operation: "download",
        media: "all",
      },
      "tiktok-video-downloader": {
        platform: "tiktok",
        operation: "download",
        media: "video",
      },
      "tiktok-photo-downloader": {
        platform: "tiktok",
        operation: "download",
        media: "image",
      },
      "twitter-video-downloader": {
        platform: "twitter",
        operation: "download",
        media: "video",
      },
      "twitter-image-downloader": {
        platform: "twitter",
        operation: "download",
        media: "image",
      },
      "youtube-thumbnail-downloader": { platform: "youtube", operation: "cover" },
      "instagram-reel-cover-downloader": { platform: "instagram", operation: "cover" },
      "tiktok-cover-downloader": { platform: "tiktok", operation: "cover" },
      "youtube-to-transcript": { platform: "youtube", operation: "transcript" },
      "instagram-to-transcript": { platform: "instagram", operation: "transcript" },
      "tiktok-to-transcript": { platform: "tiktok", operation: "transcript" },
    });
  });

  it("accepts safe cover images and rejects unsupported image extensions", () => {
    expect(
      isMediaToolDownloadResult({
        kind: "download",
        expiresInSeconds: 90,
        items: [
          {
            url: "https://media.bento.surf/image?bento_filename=youtube-cover.jpg",
            filename: "youtube-cover.jpg",
            mediaType: "image",
          },
        ],
      }),
    ).toBe(true);
    expect(
      isMediaToolDownloadResult({
        kind: "download",
        expiresInSeconds: 90,
        items: [
          {
            url: "https://media.bento.surf/image?bento_filename=youtube-cover.svg",
            filename: "youtube-cover.svg",
            mediaType: "image",
          },
        ],
      }),
    ).toBe(false);
  });

  it("accepts only complete, client-safe download results", () => {
    expect(
      isMediaToolDownloadResult({
        kind: "download",
        expiresInSeconds: 90,
        items: [
          {
            url: "https://cobalt.bento.surf/tunnel/video?bento_filename=youtube-video.mp4",
            filename: "youtube-video.mp4",
            mediaType: "video",
          },
        ],
      }),
    ).toBe(true);
    expect(
      isMediaToolDownloadResult({
        kind: "download",
        expiresInSeconds: 90,
        items: [{ url: "javascript:alert(1)", filename: "video.mp4", mediaType: "video" }],
      }),
    ).toBe(false);
    expect(isMediaToolDownloadResult({ kind: "download", expiresInSeconds: 0, items: [] })).toBe(
      false,
    );
  });

  it.each([
    {
      url: "https://cobalt.bento.surf/tunnel/video",
      filename: "video.mp4",
      mediaType: "video",
    },
    {
      url: "https://cobalt.bento.surf/tunnel/video?bento_filename=setup.exe",
      filename: "setup.exe",
      mediaType: "video",
    },
    {
      url: "https://cobalt.bento.surf/tunnel/video?bento_filename=video.gif",
      filename: "video.gif",
      mediaType: "video",
    },
    {
      url: "https://cobalt.bento.surf/tunnel/video?bento_filename=video.mp4",
      filename: "video.mp4",
      mediaType: "gif",
    },
    {
      url: "https://cobalt.bento.surf/tunnel/video?bento_filename=video-safe.mp4",
      filename: "video\u202esafe.mp4",
      mediaType: "video",
    },
  ])("rejects unsafe, mismatched, or unbound download filenames", (item) => {
    expect(
      isMediaToolDownloadResult({
        kind: "download",
        expiresInSeconds: 90,
        items: [item],
      }),
    ).toBe(false);
  });

  it("accepts only normalized transcript results", () => {
    expect(
      isMediaToolTranscriptResult({
        kind: "transcript",
        filename: "instagram-audio.mp3",
        transcript: "Hello from Bento.",
        wordCount: 3,
        language: "en",
        durationSeconds: 2.5,
        segments: [{ start: 0, end: 2.5, text: "Hello from Bento." }],
      }),
    ).toBe(true);
    expect(
      isMediaToolTranscriptResult({
        kind: "transcript",
        filename: "audio.mp3",
        transcript: "Hello",
        wordCount: 1,
        language: null,
        durationSeconds: null,
        segments: [{ start: 2, end: 1, text: "Hello" }],
      }),
    ).toBe(false);

    expect(
      isMediaToolTranscriptResult({
        kind: "transcript",
        filename: "audio\u2066.exe",
        transcript: "Hello",
        wordCount: 1,
        language: null,
        durationSeconds: 1,
        segments: [{ start: 0, end: 1, text: "Hello" }],
      }),
    ).toBe(false);
  });
});
