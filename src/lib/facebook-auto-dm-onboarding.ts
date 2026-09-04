import type {
  FacebookDmMatchType,
  FacebookDmMediaScope,
  FacebookDmTriggerType,
} from "@/lib/facebook-auto-dm";

export type FacebookAutoDmOnboardingStep = "connect" | "template" | "customize";

export type FacebookAutoDmStarterTemplateId = "comment-link" | "dm-keyword";

export type FacebookAutoDmStarterTemplate = {
  id: FacebookAutoDmStarterTemplateId;
  eyebrow: string;
  name: string;
  description: string;
  outcome: string;
  emoji: string;
  draft: {
    name: string;
    triggerType: FacebookDmTriggerType;
    keywords: string;
    excludedKeywords: string;
    matchType: FacebookDmMatchType;
    mediaScope: FacebookDmMediaScope;
    mediaIds: string[];
    replyMessage: string;
    publicReplyEnabled: boolean;
    publicReplyMessages: string;
    openingMessage: string;
    confirmationButtonLabel: string;
    emailCaptureEnabled: boolean;
    emailPromptMessage: string;
    emailMarketingConsentEnabled: boolean;
    replyButtonLabel: string;
    replyButtonUrl: string;
    enabled: boolean;
  };
};

export const FACEBOOK_AUTO_DM_STARTER_TEMPLATES: FacebookAutoDmStarterTemplate[] = [
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
      keywords: "link",
      excludedKeywords: "",
      matchType: "contains",
      mediaScope: "any",
      mediaIds: [],
      replyMessage: "Thanks for commenting! Here is the link you asked for ✨",
      publicReplyEnabled: true,
      publicReplyMessages: "Sent it to your DMs ✨\nCheck your messages 💌\nOn its way 🙌",
      openingMessage: "Thanks for your comment! I have it ready for you.",
      confirmationButtonLabel: "Send it",
      emailCaptureEnabled: false,
      emailPromptMessage: "What’s the best email address to send this to?",
      emailMarketingConsentEnabled: false,
      replyButtonLabel: "",
      replyButtonUrl: "",
      enabled: true,
    },
  },
  {
    id: "dm-keyword",
    eyebrow: "Answer faster",
    name: "Reply to a Messenger keyword",
    description: "When someone sends “info”, instantly reply with the details they need.",
    outcome: "Gives every interested visitor a fast first response.",
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
      emailPromptMessage: "What’s the best email address to send this to?",
      emailMarketingConsentEnabled: false,
      replyButtonLabel: "",
      replyButtonUrl: "",
      enabled: true,
    },
  },
];

export function getFacebookAutoDmOnboardingStep({
  hasReadyConnection,
  selectedTemplateId,
}: {
  hasReadyConnection: boolean;
  selectedTemplateId: FacebookAutoDmStarterTemplateId | null;
}): FacebookAutoDmOnboardingStep {
  if (!hasReadyConnection) return "connect";
  if (!selectedTemplateId) return "template";
  return "customize";
}

export function getFacebookAutoDmStarterTemplate(
  id: FacebookAutoDmStarterTemplateId,
): FacebookAutoDmStarterTemplate {
  const template = FACEBOOK_AUTO_DM_STARTER_TEMPLATES.find((item) => item.id === id);
  if (!template) throw new Error(`Unknown Facebook Auto-DM starter template: ${id}`);
  return template;
}
