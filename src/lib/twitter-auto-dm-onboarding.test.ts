import { describe, expect, it } from "vitest";
import {
  getTwitterAutoDmOnboardingStep,
  getTwitterAutoDmStarterTemplate,
  TWITTER_AUTO_DM_STARTER_TEMPLATES,
} from "./twitter-auto-dm-onboarding";

describe("X Auto-DM onboarding", () => {
  it("asks for a connection before a template", () => {
    expect(
      getTwitterAutoDmOnboardingStep({
        hasReadyConnection: false,
        selectedTemplateId: null,
      }),
    ).toBe("connect");
    expect(
      getTwitterAutoDmOnboardingStep({
        hasReadyConnection: true,
        selectedTemplateId: null,
      }),
    ).toBe("template");
    expect(
      getTwitterAutoDmOnboardingStep({
        hasReadyConnection: true,
        selectedTemplateId: "mention-link",
      }),
    ).toBe("customize");
  });

  it("ships starter templates for replies, DMs, likes, and reposts", () => {
    expect(TWITTER_AUTO_DM_STARTER_TEMPLATES).toHaveLength(5);
    for (const template of TWITTER_AUTO_DM_STARTER_TEMPLATES) {
      expect(template.draft.name.length).toBeGreaterThan(0);
      expect(template.draft.replyMessage.length).toBeGreaterThan(0);
    }
    expect(getTwitterAutoDmStarterTemplate("mention-link").draft.triggerType).toBe(
      "mention_keyword",
    );
    expect(getTwitterAutoDmStarterTemplate("like-welcome").draft.triggerType).toBe("any_like");
    expect(getTwitterAutoDmStarterTemplate("repost-welcome").draft.triggerType).toBe("any_retweet");
  });
});
