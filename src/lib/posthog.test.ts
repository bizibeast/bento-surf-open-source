import { describe, expect, it } from "vitest";

import { isHeatmapProductPath, isReplayableProductPath, isTrackedProductPath } from "./posthog";

describe("PostHog product route privacy allowlist", () => {
  it.each(["/", "/signup", "/login", "/onboarding", "/link", "/analytics"])(
    "tracks the first-party product route %s",
    (pathname) => {
      expect(isTrackedProductPath(pathname)).toBe(true);
      expect(isReplayableProductPath(pathname)).toBe(true);
      expect(isHeatmapProductPath(pathname)).toBe(true);
    },
  );

  it.each(["/admin", "/api/webhooks/dodo", "/creator", "/creator/portfolio"])(
    "excludes private, API, and creator route %s",
    (pathname) => {
      expect(isTrackedProductPath(pathname)).toBe(false);
      expect(isReplayableProductPath(pathname)).toBe(false);
      expect(isHeatmapProductPath(pathname)).toBe(false);
    },
  );

  it("tracks free-tool funnels without recording tool input surfaces", () => {
    expect(isTrackedProductPath("/tools/hashtag-generator")).toBe(true);
    expect(isReplayableProductPath("/tools/hashtag-generator")).toBe(false);
    expect(isHeatmapProductPath("/tools/hashtag-generator")).toBe(false);
  });
});
