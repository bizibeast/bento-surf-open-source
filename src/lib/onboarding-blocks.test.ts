import { describe, expect, it } from "vitest";
import { onboardingSocialBlock } from "./onboarding-blocks";

describe("onboardingSocialBlock", () => {
  it("creates the same full 2x2 social card shown in onboarding preview", () => {
    expect(onboardingSocialBlock("instagram", "  bentosurf  ")).toEqual({
      type: "social_link",
      content: { platform: "instagram", handle: "bentosurf" },
      w: 2,
      h: 2,
    });
  });
});
