import type { TwitterDmMatchType, TwitterDmTriggerType } from "@/lib/twitter-auto-dm";

export type TwitterAutoDmOnboardingStep = "connect" | "template" | "customize";

export type TwitterAutoDmStarterTemplateId =
  "mention-link" | "dm-keyword" | "welcome-dm" | "like-welcome" | "repost-welcome";

export type TwitterAutoDmStarterTemplate = {
  id: TwitterAutoDmStarterTemplateId;
  eyebrow: string;
  name: string;
  description: string;
  outcome: string;
  emoji: string;
  draft: {
    name: string;
    triggerType: TwitterDmTriggerType;
    keywords: string;
    excludedKeywords: string;
    matchType: TwitterDmMatchType;
    replyMessage: string;
    enabled: boolean;
  };
};

export const TWITTER_AUTO_DM_STARTER_TEMPLATES: TwitterAutoDmStarterTemplate[] = [
  {
    id: "mention-link",
    eyebrow: "Most popular",
    name: "Send a link from a reply",
    description: "When someone replies “link”, DM them the URL instead of posting it publicly.",
    outcome: "Turns public interest into a private conversation.",
    emoji: "🔗",
    draft: {
      name: "Send link from replies",
      triggerType: "mention_keyword",
      keywords: "link",
      excludedKeywords: "",
      matchType: "contains",
      replyMessage: "Thanks for the reply! Here is the link you asked for ✨",
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
      replyMessage: "Thanks for reaching out! Here are the details you asked for ✨",
      enabled: true,
    },
  },
  {
    id: "welcome-dm",
    eyebrow: "Start conversations",
    name: "Welcome every inbound DM",
    description: "Send a warm first reply whenever someone messages you on X.",
    outcome: "Keeps new conversations from sitting unanswered.",
    emoji: "✨",
    draft: {
      name: "Welcome inbound DMs",
      triggerType: "any_dm",
      keywords: "",
      excludedKeywords: "",
      matchType: "contains",
      replyMessage: "Thanks for the message! What would you like to know?",
      enabled: true,
    },
  },
  {
    id: "like-welcome",
    eyebrow: "Turn likes into chats",
    name: "DM people who like your post",
    description: "When someone likes your post, send a private thank-you with your link.",
    outcome: "Catches interest before it scrolls away.",
    emoji: "❤️",
    draft: {
      name: "Thanks for the like",
      triggerType: "any_like",
      keywords: "",
      excludedKeywords: "",
      matchType: "contains",
      replyMessage: "Thanks for the like! Here’s the link if you want the full details ✨",
      enabled: true,
    },
  },
  {
    id: "repost-welcome",
    eyebrow: "Reward shares",
    name: "DM people who repost you",
    description: "When someone reposts your post, send a private thank-you and next step.",
    outcome: "Turns a public share into a private conversation.",
    emoji: "🔁",
    draft: {
      name: "Thanks for the repost",
      triggerType: "any_retweet",
      keywords: "",
      excludedKeywords: "",
      matchType: "contains",
      replyMessage: "Thanks for sharing this! Here’s the link if you want to go further ✨",
      enabled: true,
    },
  },
];

export function getTwitterAutoDmOnboardingStep({
  hasReadyConnection,
  selectedTemplateId,
}: {
  hasReadyConnection: boolean;
  selectedTemplateId: TwitterAutoDmStarterTemplateId | null;
}): TwitterAutoDmOnboardingStep {
  if (!hasReadyConnection) return "connect";
  if (!selectedTemplateId) return "template";
  return "customize";
}

export function getTwitterAutoDmStarterTemplate(
  id: TwitterAutoDmStarterTemplateId,
): TwitterAutoDmStarterTemplate {
  const template = TWITTER_AUTO_DM_STARTER_TEMPLATES.find((item) => item.id === id);
  if (!template) throw new Error(`Unknown X Auto-DM starter template: ${id}`);
  return template;
}
