import { describe, expect, it } from "vitest";
import {
  FACEBOOK_AUTO_DM_STARTER_TEMPLATES,
  getFacebookAutoDmOnboardingStep,
  getFacebookAutoDmStarterTemplate,
} from "./facebook-auto-dm-onboarding";

describe("Facebook Auto-DM onboarding", () => {
  it("keeps Page connection as the first required step", () => {
    expect(
      getFacebookAutoDmOnboardingStep({
        hasReadyConnection: false,
        selectedTemplateId: "comment-link",
      }),
    ).toBe("connect");
  });

  it("moves from a ready Page to template selection and customization", () => {
    expect(
      getFacebookAutoDmOnboardingStep({
        hasReadyConnection: true,
        selectedTemplateId: null,
      }),
    ).toBe("template");
    expect(
      getFacebookAutoDmOnboardingStep({
        hasReadyConnection: true,
        selectedTemplateId: "dm-keyword",
      }),
    ).toBe("customize");
  });

  it("offers two valid active starter templates", () => {
    expect(FACEBOOK_AUTO_DM_STARTER_TEMPLATES).toHaveLength(2);
    for (const template of FACEBOOK_AUTO_DM_STARTER_TEMPLATES) {
      expect(template.draft.name).not.toBe("");
      expect(template.draft.replyMessage).not.toBe("");
      expect(template.draft.enabled).toBe(true);
    }
    expect(getFacebookAutoDmStarterTemplate("comment-link").draft.triggerType).toBe(
      "comment_keyword",
    );
  });
});
