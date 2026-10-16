import { expect, it } from "vitest";
import {
  scheduledPostAutoDmDraft,
  scheduledPostAutoDmSettings,
  scheduledPostAutoDmSchemas,
} from "./scheduled-post-auto-dm";
import { socialPostInputSchema } from "./social-scheduler";

it.each(["twitter", "facebook"] as const)(
  "round-trips %s drafts with defaults and explicitly disabled optional actions",
  (provider) => {
    const draft = scheduledPostAutoDmDraft(provider);
    expect(scheduledPostAutoDmSettings(provider, draft)).toBeNull();
    const settings = scheduledPostAutoDmSettings(provider, {
      ...draft,
      enabled: true,
      keywords: "guide, details\nlink",
      replyMessage: "Your custom reply, with punctuation",
    });
    expect(scheduledPostAutoDmSchemas[provider].safeParse(settings).success).toBe(true);
    expect(scheduledPostAutoDmDraft(provider, settings)).toMatchObject({
      enabled: true,
      keywords: "guide, details, link",
      replyMessage: "Your custom reply, with punctuation",
      publicReplyEnabled: false,
      emailCaptureEnabled: false,
    });
  },
);

it.each(["twitter", "facebook"] as const)(
  "allows incomplete %s drafts but prevents publishing invalid automations",
  (provider) => {
    const draft = { ...scheduledPostAutoDmDraft(provider), enabled: true, replyMessage: "" };
    const settings = scheduledPostAutoDmSettings(provider, draft);
    const input = {
      body: "This is a post",
      connectionIds: ["11111111-1111-4111-8111-111111111111"],
      providerSettings: { [provider]: { scheduledAutoDm: settings } },
      scheduledAt: "2030-01-01T12:00:00Z",
    };
    expect(socialPostInputSchema.safeParse({ ...input, asDraft: true }).success).toBe(true);
    expect(socialPostInputSchema.safeParse({ ...input, asDraft: false }).success).toBe(false);
    expect(scheduledPostAutoDmDraft(provider, settings).replyMessage).toBe("");
  },
);

it("rejects account-wide DM triggers and invalid Facebook consent/link/reply configurations", () => {
  const x = scheduledPostAutoDmSettings("twitter", {
    ...scheduledPostAutoDmDraft("twitter"),
    enabled: true,
  });
  expect(
    scheduledPostAutoDmSchemas.twitter.safeParse({ ...x, triggerType: "any_dm" }).success,
  ).toBe(false);
  const facebook = scheduledPostAutoDmSettings("facebook", {
    ...scheduledPostAutoDmDraft("facebook"),
    enabled: true,
  });
  for (const invalid of [
    { publicReplyEnabled: true, publicReplyMessages: [] },
    { emailCaptureEnabled: true, emailPromptMessage: null },
    { emailMarketingConsentEnabled: true, emailCaptureEnabled: false },
    { replyButtonUrl: "http://example.test/guide", replyButtonLabel: "Get guide" },
  ])
    expect(scheduledPostAutoDmSchemas.facebook.safeParse({ ...facebook, ...invalid }).success).toBe(
      false,
    );
});
