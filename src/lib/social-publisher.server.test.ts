import { describe, expect, it } from "vitest";
import {
  buildInstagramMediaParams,
  buildTikTokPostInfo,
  socialPublishQueueBinding,
  tiktokPrivacyOptionsForAudit,
  targetPostCopy,
  tiktokRetryRemotePostId,
} from "./social-publisher.server";

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
