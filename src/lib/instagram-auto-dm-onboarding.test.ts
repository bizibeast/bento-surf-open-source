import { describe, expect, it } from "vitest";
import {
  getInstagramAutoDmOnboardingStep,
  getInstagramAutoDmStarterTemplate,
  INSTAGRAM_AUTO_DM_STARTER_TEMPLATES,
} from "./instagram-auto-dm-onboarding";

describe("Instagram Auto-DM onboarding", () => {
  it("keeps account connection as the first required step", () => {
    expect(
      getInstagramAutoDmOnboardingStep({
        hasReadyConnection: false,
        selectedTemplateId: "comment-link",
      }),
    ).toBe("connect");
  });

  it("moves from a ready account to template selection and customization", () => {
    expect(
      getInstagramAutoDmOnboardingStep({
        hasReadyConnection: true,
        selectedTemplateId: null,
      }),
    ).toBe("template");
    expect(
      getInstagramAutoDmOnboardingStep({
        hasReadyConnection: true,
        selectedTemplateId: "dm-keyword",
      }),
    ).toBe("customize");
  });

  it("offers three valid active starter templates", () => {
    expect(INSTAGRAM_AUTO_DM_STARTER_TEMPLATES).toHaveLength(3);
    for (const template of INSTAGRAM_AUTO_DM_STARTER_TEMPLATES) {
      expect(template.draft.name).not.toBe("");
      expect(template.draft.replyMessage).not.toBe("");
      expect(template.draft.enabled).toBe(true);
    }

    const template = getInstagramAutoDmStarterTemplate("comment-link");
    expect(template.draft.triggerType).toBe("comment_keyword");
    expect(template.draft.publicReplyMessages.split("\n")).toHaveLength(3);
    expect(template.draft.confirmationButtonLabel).toBe("Send it");
  });
});
