import { z } from "zod";
import { INSTAGRAM_AUTO_DM_DEFAULTS } from "./instagram-auto-dm-defaults";

const keywords = z.array(z.string().trim().min(1).max(80)).max(20);
const common = {
  keywords: keywords.default([]),
  excludedKeywords: keywords.default([]),
  matchType: z.enum(["contains", "exact"]).default("contains"),
};

export const scheduledTwitterAutoDmSchema = z
  .object({
    ...common,
    triggerType: z.enum(["mention_keyword", "any_mention", "any_like", "any_retweet"]),
    replyMessage: z.string().trim().min(1).max(10_000),
  })
  .superRefine((value, context) => {
    if (value.triggerType === "mention_keyword" && !value.keywords.length)
      context.addIssue({
        code: "custom",
        path: ["keywords"],
        message: "Add at least one reply keyword.",
      });
  });

export const scheduledFacebookAutoDmSchema = z
  .object({
    ...common,
    triggerType: z.enum(["comment_keyword", "any_comment"]),
    replyMessage: z.string().trim().min(1).max(1000),
    openingMessage: z.string().trim().min(1).max(1000),
    confirmationButtonLabel: z.string().trim().min(1).max(20).default("Send it"),
    publicReplyEnabled: z.boolean().default(false),
    publicReplyMessages: z.array(z.string().trim().min(1).max(300)).max(3).default([]),
    emailCaptureEnabled: z.boolean().default(false),
    emailPromptMessage: z.string().trim().min(1).max(700).nullable().default(null),
    emailMarketingConsentEnabled: z.boolean().default(false),
    replyButtonLabel: z.string().trim().min(1).max(20).nullable().default(null),
    replyButtonUrl: z.string().url().max(2048).nullable().default(null),
  })
  .superRefine((value, context) => {
    if (value.triggerType === "comment_keyword" && !value.keywords.length)
      context.addIssue({
        code: "custom",
        path: ["keywords"],
        message: "Add at least one comment keyword.",
      });
    if (value.publicReplyEnabled && !value.publicReplyMessages.length)
      context.addIssue({
        code: "custom",
        path: ["publicReplyMessages"],
        message: "Add at least one public reply.",
      });
    if (value.emailCaptureEnabled && !value.emailPromptMessage)
      context.addIssue({
        code: "custom",
        path: ["emailPromptMessage"],
        message: "Add an email prompt.",
      });
    if (value.emailMarketingConsentEnabled && !value.emailCaptureEnabled)
      context.addIssue({
        code: "custom",
        path: ["emailCaptureEnabled"],
        message: "Enable email capture before requesting marketing consent.",
      });
    if (Boolean(value.replyButtonLabel) !== Boolean(value.replyButtonUrl))
      context.addIssue({
        code: "custom",
        path: ["replyButtonUrl"],
        message: "Add both a button label and URL.",
      });
    if (value.replyButtonUrl && !value.replyButtonUrl.startsWith("https://"))
      context.addIssue({
        code: "custom",
        path: ["replyButtonUrl"],
        message: "Use a secure https:// link.",
      });
  });

export type ScheduledPostAutoDmProvider = "twitter" | "facebook";
export const scheduledPostAutoDmSchemas = {
  twitter: scheduledTwitterAutoDmSchema,
  facebook: scheduledFacebookAutoDmSchema,
};
export type ScheduledPostAutoDmDraft = {
  enabled: boolean;
  triggerType:
    | "mention_keyword"
    | "any_mention"
    | "any_like"
    | "any_retweet"
    | "comment_keyword"
    | "any_comment";
  keywords: string;
  excludedKeywords: string;
  matchType: "contains" | "exact";
  replyMessage: string;
  openingMessage: string;
  confirmationButtonLabel: string;
  publicReplyEnabled: boolean;
  publicReplyMessages: string[];
  emailCaptureEnabled: boolean;
  emailPromptMessage: string;
  emailMarketingConsentEnabled: boolean;
  replyButtonLabel: string;
  replyButtonUrl: string;
};

export function scheduledPostAutoDmDraft(
  provider: ScheduledPostAutoDmProvider,
  value?: unknown,
): ScheduledPostAutoDmDraft {
  const defaults: ScheduledPostAutoDmDraft = {
    enabled: false,
    triggerType: provider === "twitter" ? "mention_keyword" : "comment_keyword",
    keywords: "link",
    excludedKeywords: "",
    matchType: "contains",
    openingMessage: INSTAGRAM_AUTO_DM_DEFAULTS.openingMessage,
    confirmationButtonLabel: INSTAGRAM_AUTO_DM_DEFAULTS.confirmationButtonLabel,
    emailPromptMessage: INSTAGRAM_AUTO_DM_DEFAULTS.emailPromptMessage,
    publicReplyMessages: [...INSTAGRAM_AUTO_DM_DEFAULTS.publicReplyMessages],
    replyMessage:
      provider === "twitter"
        ? "Thanks for the reply! Here is the link you asked for ✨"
        : INSTAGRAM_AUTO_DM_DEFAULTS.replyMessage,
    publicReplyEnabled: false,
    emailCaptureEnabled: false,
    emailMarketingConsentEnabled: false,
    replyButtonLabel: "",
    replyButtonUrl: "",
  };
  // Preserve incomplete autosaved forms too; only the publish path requires validity.
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  const saved = value as Record<string, unknown>;
  const draft = { ...defaults, enabled: true };
  for (const key of Object.keys(defaults) as (keyof ScheduledPostAutoDmDraft)[]) {
    if (
      key === "enabled" ||
      key === "keywords" ||
      key === "excludedKeywords" ||
      key === "publicReplyMessages"
    )
      continue;
    if (typeof saved[key] === typeof defaults[key]) Object.assign(draft, { [key]: saved[key] });
  }
  for (const key of ["keywords", "excludedKeywords"] as const)
    if (Array.isArray(saved[key]))
      draft[key] = saved[key].filter((item) => typeof item === "string").join(", ");
  if (Array.isArray(saved.publicReplyMessages))
    draft.publicReplyMessages = saved.publicReplyMessages.filter(
      (item) => typeof item === "string",
    );
  return draft;
}

export function scheduledPostAutoDmSettings(
  provider: ScheduledPostAutoDmProvider,
  draft: ScheduledPostAutoDmDraft,
) {
  if (!draft.enabled) return null;
  const split = (value: string) =>
    value
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  const common = {
    triggerType: draft.triggerType,
    keywords: split(draft.keywords),
    excludedKeywords: split(draft.excludedKeywords),
    matchType: draft.matchType,
    replyMessage: draft.replyMessage.trim(),
  };
  return provider === "twitter"
    ? common
    : {
        ...common,
        openingMessage: draft.openingMessage.trim(),
        confirmationButtonLabel: draft.confirmationButtonLabel.trim(),
        publicReplyEnabled: draft.publicReplyEnabled,
        publicReplyMessages: draft.publicReplyMessages.map((reply) => reply.trim()).filter(Boolean),
        emailCaptureEnabled: draft.emailCaptureEnabled,
        emailPromptMessage: draft.emailCaptureEnabled
          ? draft.emailPromptMessage.trim() || null
          : null,
        emailMarketingConsentEnabled:
          draft.emailCaptureEnabled && draft.emailMarketingConsentEnabled,
        replyButtonLabel: draft.replyButtonLabel.trim() || null,
        replyButtonUrl: draft.replyButtonUrl.trim() || null,
      };
}
