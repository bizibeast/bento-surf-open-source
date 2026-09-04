import { describe, expect, it } from "vitest";
import {
  buildTikTokPostInfo,
  socialPublishQueueBinding,
  tiktokRetryRemotePostId,
} from "./social-publisher.server";

describe("provider queue routing", () => {
  it("routes providers onto isolated queue bindings", () => {
    expect(socialPublishQueueBinding("instagram")).toBe("SOCIAL_PUBLISH_QUEUE_META");
    expect(socialPublishQueueBinding("linkedin")).toBe("SOCIAL_PUBLISH_QUEUE_LINKEDIN");
    expect(socialPublishQueueBinding("reddit")).toBe("SOCIAL_PUBLISH_QUEUE_REDDIT");
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
