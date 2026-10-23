import { INSTAGRAM_AUTO_DM_DEFAULTS as autoDmDefaults } from "./instagram-auto-dm-defaults";
import { normalizeCustomerCopy } from "./text/dashes";
import type {
  InstagramDmMatchType,
  InstagramDmMediaScope,
  InstagramDmTriggerType,
} from "@/lib/instagram-auto-dm";

export type InstagramAutoDmOnboardingStep = "connect" | "template" | "customize";

export type InstagramAutoDmStarterTemplateId = "comment-link" | "dm-keyword" | "story-reply";

export type InstagramAutoDmStarterTemplate = {
  id: InstagramAutoDmStarterTemplateId;
  eyebrow: string;
  name: string;
  description: string;
  outcome: string;
  emoji: string;
  draft: {
    name: string;
    triggerType: InstagramDmTriggerType;
    keywords: string;
    excludedKeywords: string;
    matchType: InstagramDmMatchType;
    mediaScope: InstagramDmMediaScope;
    mediaIds: string[];
    replyMessage: string;
    publicReplyEnabled: boolean;
    publicReplyMessages: string;
    openingMessage: string;
    confirmationButtonLabel: string;
    emailCaptureEnabled: boolean;
    emailPromptMessage: string;
    emailMarketingConsentEnabled: boolean;
    followGateEnabled: boolean;
    followPromptMessage: string;
    followMaxRechecks: number;
    followFailAction: "send_anyway" | "withhold";
    replyButtonLabel: string;
    replyButtonUrl: string;
    enabled: boolean;
  };
};

const instagramAutoDmStarterTemplateList: InstagramAutoDmStarterTemplate[] = [
  {
    id: "comment-link",
    eyebrow: "Most popular",
    name: "Send a link from comments",
    description: "When someone comments “link”, let them tap Send it once, then DM them.",
    outcome: "Turns public interest into a private conversation.",
    emoji: "🔗",
    draft: {
      name: "Send link from comments",
      triggerType: "comment_keyword",
      keywords: autoDmDefaults.keyword,
      excludedKeywords: "",
      matchType: "contains",
      mediaScope: "any",
      mediaIds: [],
      replyMessage: autoDmDefaults.replyMessage,
      publicReplyEnabled: true,
      publicReplyMessages: autoDmDefaults.publicReplyMessages.join("\n"),
      openingMessage: autoDmDefaults.openingMessage,
      confirmationButtonLabel: autoDmDefaults.confirmationButtonLabel,
      emailCaptureEnabled: false,
      emailPromptMessage: autoDmDefaults.emailPromptMessage,
      emailMarketingConsentEnabled: false,
      followGateEnabled: true,
      followPromptMessage: autoDmDefaults.followPromptMessage,
      followMaxRechecks: 3,
      followFailAction: "send_anyway",
      replyButtonLabel: "",
      replyButtonUrl: "",
      enabled: true,
    },
  },
  {
    id: "dm-keyword",
    eyebrow: "Answer faster",
    name: "Reply to a DM keyword",
    description: "When someone sends “info”, instantly reply with the details they need.",
    outcome: "Gives every interested follower a fast first response.",
    emoji: "💬",
    draft: {
      name: "Reply to info DMs",
      triggerType: "dm_keyword",
      keywords: "info",
      excludedKeywords: "",
      matchType: "contains",
      mediaScope: "any",
      mediaIds: [],
      replyMessage: "Thanks for reaching out! Here are the details you asked for ✨",
      publicReplyEnabled: false,
      publicReplyMessages: "",
      openingMessage: "",
      confirmationButtonLabel: "",
      emailCaptureEnabled: false,
      emailPromptMessage: autoDmDefaults.emailPromptMessage,
      emailMarketingConsentEnabled: false,
      followGateEnabled: false,
      followPromptMessage: autoDmDefaults.followPromptMessage,
      followMaxRechecks: 3,
      followFailAction: "send_anyway",
      replyButtonLabel: "",
      replyButtonUrl: "",
      enabled: true,
    },
  },
  {
    id: "story-reply",
    eyebrow: "Start conversations",
    name: "Welcome every Story reply",
    description: "Send a warm response whenever someone replies to your Instagram Story.",
    outcome: "Keeps Story engagement from getting lost in your inbox.",
    emoji: "✨",
    draft: {
      name: "Welcome Story replies",
      triggerType: "any_story_reply",
      keywords: "",
      excludedKeywords: "",
      matchType: "contains",
      mediaScope: "any",
      mediaIds: [],
      replyMessage: "Thanks for replying to my Story! What would you like to know?",
      publicReplyEnabled: false,
      publicReplyMessages: "",
      openingMessage: "",
      confirmationButtonLabel: "",
      emailCaptureEnabled: false,
      emailPromptMessage: autoDmDefaults.emailPromptMessage,
      emailMarketingConsentEnabled: false,
      followGateEnabled: false,
      followPromptMessage: autoDmDefaults.followPromptMessage,
      followMaxRechecks: 3,
      followFailAction: "send_anyway",
      replyButtonLabel: "",
      replyButtonUrl: "",
      enabled: true,
    },
  },
];

export const INSTAGRAM_AUTO_DM_STARTER_TEMPLATES = normalizeCustomerCopy(
  instagramAutoDmStarterTemplateList,
);

export function getInstagramAutoDmOnboardingStep({
  hasReadyConnection,
  selectedTemplateId,
}: {
  hasReadyConnection: boolean;
  selectedTemplateId: InstagramAutoDmStarterTemplateId | null;
}): InstagramAutoDmOnboardingStep {
  if (!hasReadyConnection) return "connect";
  if (!selectedTemplateId) return "template";
  return "customize";
}

export function getInstagramAutoDmStarterTemplate(
  id: InstagramAutoDmStarterTemplateId,
): InstagramAutoDmStarterTemplate {
  const template = INSTAGRAM_AUTO_DM_STARTER_TEMPLATES.find((item) => item.id === id);
  if (!template) throw new Error(`Unknown Instagram Auto-DM starter template: ${id}`);
  return template;
}
