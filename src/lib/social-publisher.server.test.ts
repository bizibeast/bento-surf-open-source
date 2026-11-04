import { describe, expect, it, vi } from "vitest";
import {
  buildInstagramMediaParams,
  buildTikTokPostInfo,
  buildTikTokPhotoPostRequest,
  publishTikTok,
  publishYouTube,
  socialPublishQueueBinding,
  tiktokPrivacyOptionsForAudit,
  targetPostCopy,
  tiktokRetryRemotePostId,
} from "./social-publisher.server";

describe("YouTube Shorts thumbnails", () => {
  it("reports a rejected Shorts thumbnail after video upload instead of claiming success", async () => {
    const thumbnail = {
      key: "thumbnail.jpg",
      url: "https://bento.surf/thumbnail.jpg",
      name: "thumbnail.jpg",
      mimeType: "image/jpeg",
      size: 4,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === thumbnail.url)
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
          headers: { "content-type": "image/jpeg", "content-length": "4" },
        });
      if (url.includes("/youtube/v3/thumbnails/set")) return new Response(null, { status: 403 });
      throw new Error(`Unexpected request to ${url}`);
    });
    try {
      await expect(
        publishYouTube(
          "youtube-token",
          "Short title",
          "Short description",
          [],
          { youtubeFormat: "short", thumbnail },
          { remote_post_id: "already-uploaded-short" },
        ),
      ).rejects.toMatchObject({
        code: "403",
        retryable: false,
        message: expect.stringMatching(/Short.*YouTube Studio/i),
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe("provider queue routing", () => {
  it("publishes each destination's own copy when sync is off", () => {
    const post = { body: "Shared copy", title: "Shared title" };
    expect(targetPostCopy(post, {})).toEqual(post);
    expect(
      targetPostCopy(post, { bodyOverride: "YouTube copy", titleOverride: "Video title" }),
    ).toEqual({
      body: "YouTube copy",
      title: "Video title",
    });
  });
  it("turns selected Facebook and LinkedIn identities into native publishing syntax", () => {
    expect(
      targetPostCopy(
        { body: "With @Acme" },
        {
          mentions: [
            {
              provider: "facebook",
              id: "123",
              name: "Acme",
              handle: null,
              text: "@Acme",
              start: 5,
              end: 10,
              kind: "page",
              verified: true,
            },
          ],
        },
        "facebook",
      ).body,
    ).toBe("With @[123]");
    expect(
      targetPostCopy(
        { body: "With @Acme" },
        {
          mentions: [
            {
              provider: "facebook",
              id: "123",
              name: "Acme",
              handle: null,
              text: "@Acme",
              start: 5,
              end: 10,
              kind: "page",
              verified: true,
            },
          ],
        },
        "facebook",
        [
          {
            key: "photo.jpg",
            url: "https://bento.surf/photo.jpg",
            name: "photo.jpg",
            mimeType: "image/jpeg",
            size: 5,
          },
        ],
      ).body,
    ).toBe("With @Acme");
    expect(
      targetPostCopy(
        { body: "Hello" },
        {
          bodyOverride: "With @Acme",
          mentions: [
            {
              provider: "linkedin",
              id: "urn:li:organization:42",
              name: "Acme",
              handle: null,
              text: "@Acme",
              start: 5,
              end: 10,
              kind: "page",
              verified: true,
            },
          ],
        },
        "linkedin",
      ).body,
    ).toBe("With @[Acme](urn:li:organization:42)");
  });
  it("routes providers onto isolated queue bindings", () => {
    expect(socialPublishQueueBinding("instagram")).toBe("SOCIAL_PUBLISH_QUEUE_META");
    expect(socialPublishQueueBinding("linkedin")).toBe("SOCIAL_PUBLISH_QUEUE_LINKEDIN");
    expect(socialPublishQueueBinding("reddit")).toBe("SOCIAL_PUBLISH_QUEUE_REDDIT");
  });
});

describe("Instagram Reels publishing", () => {
  it("adds Trial Reel parameters without changing standard Reels", () => {
    expect(buildInstagramMediaParams).toBeTypeOf("function");
    const media = { url: "https://example.com/reel.mp4", mimeType: "video/mp4" };

    expect(buildInstagramMediaParams("Caption", media).has("trial_params")).toBe(false);
    expect(
      buildInstagramMediaParams("Caption", media, { trialReel: true }).get("trial_params"),
    ).toBe(JSON.stringify({ graduation_strategy: "MANUAL" }));
    expect(
      buildInstagramMediaParams("Caption", media, {
        trialReel: true,
        graduationStrategy: "SS_PERFORMANCE",
      }).get("trial_params"),
    ).toBe(JSON.stringify({ graduation_strategy: "SS_PERFORMANCE" }));
  });
});

describe("TikTok Direct Post", () => {
  it("posts images to the photo endpoint and videos to the video endpoint", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, body: JSON.parse(String(init?.body || "{}")) });
      return new Response(
        JSON.stringify({
          data: url.includes("creator_info")
            ? { privacy_level_options: ["SELF_ONLY"], comment_disabled: false }
            : { publish_id: "publish-1" },
          error: { code: "ok" },
        }),
        { status: 200 },
      );
    });
    try {
      const image = {
        key: "users/test/image.jpg",
        name: "image.jpg",
        mimeType: "image/jpeg",
        size: 100,
        url: "https://bento.surf/image.jpg",
      };
      const video = { ...image, mimeType: "video/mp4", url: "https://bento.surf/video.mp4" };
      await publishTikTok("token", "Photos", [image, image], { privacyLevel: "SELF_ONLY" });
      await publishTikTok("token", "Video", [video], { privacyLevel: "SELF_ONLY" });
      expect(calls[1].url).toBe("https://open.tiktokapis.com/v2/post/publish/content/init/");
      expect(calls[1].body).toMatchObject({ media_type: "PHOTO", post_mode: "DIRECT_POST" });
      expect(calls[3].url).toBe("https://open.tiktokapis.com/v2/post/publish/video/init/");
      expect(calls[3].body).toMatchObject({
        source_info: { source: "PULL_FROM_URL", video_url: video.url },
      });
    } finally {
      fetchMock.mockRestore();
    }
  });
  it("routes a photo carousel to TikTok's photo Direct Post API in image order", () => {
    const image = {
      key: "users/test/image.jpg",
      name: "image.jpg",
      mimeType: "image/jpeg",
      size: 100,
      url: "",
    };
    expect(
      buildTikTokPhotoPostRequest(
        "Carousel caption",
        [
          { ...image, url: "https://bento.surf/first.jpg" },
          { ...image, url: "https://bento.surf/second.jpg" },
        ],
        { privacyLevel: "SELF_ONLY", disableComment: true, isAigc: true },
        { commentDisabled: false },
      ),
    ).toEqual({
      post_mode: "DIRECT_POST",
      media_type: "PHOTO",
      post_info: {
        description: "Carousel caption",
        privacy_level: "SELF_ONLY",
        disable_comment: true,
        auto_add_music: false,
        brand_content_toggle: false,
        brand_organic_toggle: false,
      },
      source_info: {
        source: "PULL_FROM_URL",
        photo_cover_index: 0,
        photo_images: ["https://bento.surf/first.jpg", "https://bento.surf/second.jpg"],
      },
      is_aigc: true,
    });
  });
  it("offers only private visibility before the Direct Post audit", () => {
    const options = ["PUBLIC_TO_EVERYONE", "SELF_ONLY", "MUTUAL_FOLLOW_FRIENDS"];
    expect(tiktokPrivacyOptionsForAudit(options, false)).toEqual(["SELF_ONLY"]);
    expect(tiktokPrivacyOptionsForAudit(options, true)).toEqual(options);
  });
  it("sends the creator's AI-generated disclosure", () => {
    expect(
      buildTikTokPostInfo(
        "Creator caption",
        {
          privacyLevel: "PUBLIC_TO_EVERYONE",
          disableComment: false,
          disableDuet: false,
          disableStitch: true,
          videoCoverTimestampMs: 2_500,
          isAigc: true,
        },
        { commentDisabled: false, duetDisabled: true, stitchDisabled: false },
      ),
    ).toEqual({
      title: "Creator caption",
      privacy_level: "PUBLIC_TO_EVERYONE",
      disable_comment: false,
      disable_duet: true,
      disable_stitch: true,
      video_cover_timestamp_ms: 2_500,
      brand_content_toggle: false,
      brand_organic_toggle: false,
      is_aigc: true,
    });
  });

  it("restarts only retryable failed TikTok publishes", () => {
    expect(tiktokRetryRemotePostId("tiktok", true, "video_pull_failed", "publish-1")).toBeNull();
    expect(tiktokRetryRemotePostId("tiktok", true, "internal", "publish-1")).toBeNull();
    expect(tiktokRetryRemotePostId("tiktok", true, "rate_limit_exceeded", "publish-1")).toBe(
      "publish-1",
    );
    expect(tiktokRetryRemotePostId("instagram", true, "video_pull_failed", "publish-1")).toBe(
      "publish-1",
    );
  });
});
