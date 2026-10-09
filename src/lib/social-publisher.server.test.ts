import { describe, expect, it } from "vitest";
import {
  buildInstagramMediaParams,
  buildTikTokPostInfo,
  socialPublishQueueBinding,
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
