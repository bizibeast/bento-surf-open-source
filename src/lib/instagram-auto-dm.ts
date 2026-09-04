import { z } from "zod";

export const INSTAGRAM_DM_TRIGGER_TYPES = [
  "comment_keyword",
  "any_comment",
  "dm_keyword",
  "any_dm",
  "story_reply_keyword",
  "any_story_reply",
  "live_comment_keyword",
  "any_live_comment",
  "post_share",
] as const;
export type InstagramDmTriggerType = (typeof INSTAGRAM_DM_TRIGGER_TYPES)[number];
export type InstagramDmMatchType = "contains" | "exact";
export type InstagramDmMediaScope = "any" | "specific" | "future";
export type InstagramEventContext =
  "comment" | "live_comment" | "dm" | "story_reply" | "post_share" | "quick_reply";

export const INSTAGRAM_AUTO_DM_REQUIRED_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_comments",
  "instagram_business_manage_messages",
] as const;

export const INSTAGRAM_INSIGHTS_SCOPE = "instagram_business_manage_insights" as const;

export const INSTAGRAM_AUTO_DM_WEBHOOK_FIELDS = [
  "comments",
  "live_comments",
  "messages",
  "messaging_postbacks",
] as const;

export const INSTAGRAM_CONNECTION_VERIFICATION_MAX_AGE_MS = 48 * 60 * 60 * 1_000;

export type InstagramConnectionReadinessIssue =
  | "inactive"
  | "unhealthy"
  | "reauth_required"
  | "missing_scope"
  | "missing_webhook_subscription"
  | "token_expired"
  | "token_expiry_unknown"
  | "never_verified"
  | "verification_stale";

export type InstagramConnectionReadinessInput = {
  status?: string | null;
  connection_health?: string | null;
  reauth_required?: boolean | null;
  scopes?: readonly string[] | null;
  webhook_fields?: readonly string[] | null;
  token_expires_at?: string | null;
  last_verified_at?: string | null;
};

function validTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function getInstagramConnectionReadiness(
  connection: InstagramConnectionReadinessInput | null | undefined,
  now = new Date(),
) {
  const issues: InstagramConnectionReadinessIssue[] = [];
  if (!connection || connection.status !== "active") issues.push("inactive");
  if (!connection || connection.connection_health !== "healthy") issues.push("unhealthy");
  if (connection?.reauth_required) issues.push("reauth_required");

  const scopes = new Set(connection?.scopes || []);
  if (INSTAGRAM_AUTO_DM_REQUIRED_SCOPES.some((scope) => !scopes.has(scope))) {
    issues.push("missing_scope");
  }

  const webhookFields = new Set(connection?.webhook_fields || []);
  if (INSTAGRAM_AUTO_DM_WEBHOOK_FIELDS.some((field) => !webhookFields.has(field))) {
    issues.push("missing_webhook_subscription");
  }

  const tokenExpiresAt = validTimestamp(connection?.token_expires_at);
  if (tokenExpiresAt === null) {
    issues.push("token_expiry_unknown");
  } else if (tokenExpiresAt <= now.getTime()) {
    issues.push("token_expired");
  }

  const lastVerifiedAt = validTimestamp(connection?.last_verified_at);
  if (lastVerifiedAt === null) {
    issues.push("never_verified");
  } else if (now.getTime() - lastVerifiedAt > INSTAGRAM_CONNECTION_VERIFICATION_MAX_AGE_MS) {
    issues.push("verification_stale");
  }

  return {
    ready: issues.length === 0,
    issues,
    needsReconnect: issues.some((issue) =>
      ["reauth_required", "missing_scope", "token_expired", "token_expiry_unknown"].includes(issue),
    ),
  };
}

export function instagramConnectionReadinessMessage(
  issues: readonly InstagramConnectionReadinessIssue[],
) {
  if (issues.includes("reauth_required") || issues.includes("token_expired")) {
    return "Reconnect Instagram to renew account access.";
  }
  if (issues.includes("token_expiry_unknown")) {
    return "Reconnect Instagram so Bento can verify token expiry.";
  }
  if (issues.includes("missing_scope")) {
    return "Reconnect Instagram and approve comment and message access.";
  }
  if (issues.includes("missing_webhook_subscription")) {
    return "Repair the connection to restore Meta webhook subscriptions.";
  }
  if (issues.includes("never_verified") || issues.includes("verification_stale")) {
    return "Recheck the connection before enabling automations.";
  }
  if (issues.includes("unhealthy")) return "Instagram connection needs attention.";
  if (issues.includes("inactive")) return "Instagram connection is inactive.";
  return null;
}

export type InstagramDmAutomation = {
  id: string;
  connectionId: string;
  connectionHandle: string;
  connectionReady: boolean;
  connectionNeedsReconnect: boolean;
  connectionReadinessMessage: string | null;
  connectionLastVerifiedAt: string | null;
  name: string;
  triggerType: InstagramDmTriggerType;
  keywords: string[];
  excludedKeywords: string[];
  matchType: InstagramDmMatchType;
  mediaScope: InstagramDmMediaScope;
  mediaIds: string[];
  replyMessage: string;
  publicReplyEnabled: boolean;
  publicReplyMessages: string[];
  openingMessage: string | null;
  confirmationButtonLabel: string | null;
  emailCaptureEnabled: boolean;
  emailPromptMessage: string | null;
  emailMarketingConsentEnabled: boolean;
  followGateEnabled: boolean;
  followPromptMessage: string;
  followMaxRechecks: number;
  followFailAction: "send_anyway" | "withhold";
  replyButtonLabel: string | null;
  replyButtonUrl: string | null;
  enabled: boolean;
  createdAt: string;
};

export type InstagramDmActivity = {
  id: string;
  automationName: string | null;
  eventType: "comment" | "message";
  eventContext: InstagramEventContext;
  senderLabel: string;
  matchedKeyword: string | null;
  status: "received" | "processing" | "sent" | "failed";
  errorMessage: string | null;
  createdAt: string;
};

export type InstagramDmWorkflow = {
  id: string;
  automationName: string | null;
  senderLabel: string;
  status:
    | "awaiting_confirmation"
    | "awaiting_follow"
    | "awaiting_email"
    | "delivering"
    | "completed"
    | "blocked"
    | "failed"
    | "expired";
  emailCaptured: boolean;
  marketingConsent: boolean;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type InstagramMedia = {
  id: string;
  caption: string;
  mediaType: string;
  imageUrl: string | null;
  permalink: string;
  timestamp: string | null;
};

const cleanKeyword = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase();
const emailAddressSchema = z.string().email().max(254);

export function extractInstagramEmailAddress(value: string) {
  const email = value.normalize("NFKC").trim().toLocaleLowerCase();
  return emailAddressSchema.safeParse(email).success ? email : null;
}

export const instagramDmAutomationInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    connectionId: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    triggerType: z.enum(INSTAGRAM_DM_TRIGGER_TYPES),
    keywords: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    excludedKeywords: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    matchType: z.enum(["contains", "exact"]).default("contains"),
    mediaScope: z.enum(["any", "specific", "future"]).default("any"),
    mediaIds: z.array(z.string().trim().min(1).max(255)).max(100).default([]),
    replyMessage: z.string().trim().min(1).max(1000),
    publicReplyEnabled: z.boolean().default(false),
    publicReplyMessages: z.array(z.string().trim().min(1).max(300)).max(3).default([]),
    openingMessage: z.string().trim().min(1).max(1000).nullable().default(null),
    confirmationButtonLabel: z.string().trim().min(1).max(20).nullable().default(null),
    emailCaptureEnabled: z.boolean().default(false),
    emailPromptMessage: z.string().trim().min(1).max(700).nullable().default(null),
    emailMarketingConsentEnabled: z.boolean().default(false),
    followGateEnabled: z.boolean().default(false),
    followPromptMessage: z
      .string()
      .trim()
      .min(1)
      .max(700)
      .default("Follow this account, then tap I’ve followed."),
    followMaxRechecks: z.number().int().min(1).max(3).default(3),
    followFailAction: z.enum(["send_anyway", "withhold"]).default("send_anyway"),
    replyButtonLabel: z.string().trim().min(1).max(20).nullable().default(null),
    replyButtonUrl: z.string().url().max(2048).nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, context) => {
    const keywordOptional = [
      "any_comment",
      "any_dm",
      "any_story_reply",
      "any_live_comment",
      "post_share",
    ].includes(value.triggerType);
    if (!keywordOptional && value.keywords.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keywords"],
        message: "Add at least one keyword.",
      });
    }
    if (value.publicReplyEnabled && value.publicReplyMessages.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["publicReplyMessages"],
        message: "Add at least one public reply.",
      });
    }
    if (value.mediaScope === "specific" && value.mediaIds.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mediaIds"],
        message: "Choose at least one post or reel.",
      });
    }
    if (Boolean(value.openingMessage) !== Boolean(value.confirmationButtonLabel)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["openingMessage"],
        message: "Add both an opening message and suggested reply, or leave both empty.",
      });
    }
    const isCommentAutomation = ["comment_keyword", "any_comment"].includes(value.triggerType);
    if (isCommentAutomation && (!value.openingMessage || !value.confirmationButtonLabel)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["openingMessage"],
        message: "Comment automations require the opening message and Send it action.",
      });
    }
    if (!isCommentAutomation && value.followGateEnabled) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["followGateEnabled"],
        message: "Follower verification is only available for comment automations.",
      });
    }
    if (value.emailCaptureEnabled && (!value.openingMessage || !value.confirmationButtonLabel)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["emailCaptureEnabled"],
        message: "Email capture requires the opening message and suggested reply.",
      });
    }
    if (value.emailCaptureEnabled && !value.emailPromptMessage) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["emailPromptMessage"],
        message: "Add the message that asks for an email address.",
      });
    }
    if (!value.emailCaptureEnabled && value.emailMarketingConsentEnabled) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["emailMarketingConsentEnabled"],
        message: "Marketing consent can only be requested when email capture is on.",
      });
    }
    if (Boolean(value.replyButtonLabel) !== Boolean(value.replyButtonUrl)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replyButtonLabel"],
        message: "Add both a button label and URL, or leave both empty.",
      });
    }
    if (value.replyButtonUrl && !value.replyButtonUrl.startsWith("https://")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replyButtonUrl"],
        message: "Use a secure https:// link.",
      });
    }
  })
  .transform((value) => ({
    ...value,
    keywords: [...new Set(value.keywords.map(cleanKeyword).filter(Boolean))],
    excludedKeywords: [...new Set(value.excludedKeywords.map(cleanKeyword).filter(Boolean))],
    mediaIds: [...new Set(value.mediaIds.map((item) => item.trim()).filter(Boolean))],
    publicReplyMessages: value.publicReplyEnabled
      ? [...new Set(value.publicReplyMessages.map((item) => item.trim()).filter(Boolean))]
      : [],
    emailPromptMessage: value.emailCaptureEnabled ? value.emailPromptMessage : null,
    emailMarketingConsentEnabled: value.emailCaptureEnabled && value.emailMarketingConsentEnabled,
    followGateEnabled:
      ["comment_keyword", "any_comment"].includes(value.triggerType) && value.followGateEnabled,
  }));

export type InstagramWebhookEvent = {
  externalEventId: string;
  instagramAccountId: string;
  eventType: "comment" | "message";
  eventContext: InstagramEventContext;
  sourceId: string;
  senderId: string | null;
  senderUsername: string | null;
  mediaId: string | null;
  text: string;
  actionPayload: string | null;
  occurredAt: string | null;
};

export type MatchableInstagramAutomation = {
  id: string;
  trigger_type: InstagramDmTriggerType;
  keywords: string[];
  excluded_keywords: string[];
  match_type: InstagramDmMatchType;
  media_scope: InstagramDmMediaScope;
  media_ids: string[];
};

export function matchInstagramAutomation(
  event: Pick<InstagramWebhookEvent, "eventType" | "eventContext" | "text" | "mediaId">,
  automations: MatchableInstagramAutomation[],
) {
  const normalizedText = cleanKeyword(event.text);
  for (const automation of automations) {
    const triggerMatches = triggerMatchesEvent(automation.trigger_type, event.eventContext);
    if (!triggerMatches) continue;
    if (
      (automation.excluded_keywords || []).some((keyword) =>
        normalizedText.includes(cleanKeyword(keyword)),
      )
    ) {
      continue;
    }
    if (
      (automation.media_scope || (automation.media_ids.length ? "specific" : "any")) ===
        "specific" &&
      (!event.mediaId || !automation.media_ids.includes(event.mediaId))
    ) {
      continue;
    }
    if (
      automation.media_scope === "future" &&
      event.mediaId &&
      automation.media_ids.includes(event.mediaId)
    ) {
      continue;
    }
    if (
      ["any_comment", "any_dm", "any_story_reply", "any_live_comment", "post_share"].includes(
        automation.trigger_type,
      )
    ) {
      return { automation, matchedKeyword: null };
    }
    const matchedKeyword = automation.keywords.find((keyword) => {
      const normalizedKeyword = cleanKeyword(keyword);
      return automation.match_type === "exact"
        ? normalizedText === normalizedKeyword
        : normalizedText.includes(normalizedKeyword);
    });
    if (matchedKeyword) return { automation, matchedKeyword };
  }
  return null;
}

export type InstagramAutomationTestResult = {
  matches: boolean;
  eventType: "comment" | "message";
  eventContext: InstagramEventContext;
  matchedKeyword: string | null;
};

/**
 * Dry-runs a saved automation through the same matcher used by the webhook
 * worker. This never calls Meta or writes activity data.
 */
export function testInstagramAutomation(
  automation: Pick<
    InstagramDmAutomation,
    "id" | "triggerType" | "keywords" | "excludedKeywords" | "matchType" | "mediaScope" | "mediaIds"
  >,
  text: string,
): InstagramAutomationTestResult {
  const eventContext: InstagramEventContext =
    automation.triggerType === "comment_keyword" || automation.triggerType === "any_comment"
      ? "comment"
      : automation.triggerType === "live_comment_keyword" ||
          automation.triggerType === "any_live_comment"
        ? "live_comment"
        : automation.triggerType === "story_reply_keyword" ||
            automation.triggerType === "any_story_reply"
          ? "story_reply"
          : automation.triggerType === "post_share"
            ? "post_share"
            : "dm";
  const eventType =
    eventContext === "comment" || eventContext === "live_comment" ? "comment" : "message";
  const mediaId =
    automation.mediaScope === "specific"
      ? automation.mediaIds[0] || null
      : automation.mediaScope === "future"
        ? "__bento_test_future_media__"
        : null;
  const result = matchInstagramAutomation({ eventType, eventContext, text, mediaId }, [
    {
      id: automation.id,
      trigger_type: automation.triggerType,
      keywords: automation.keywords,
      excluded_keywords: automation.excludedKeywords,
      match_type: automation.matchType,
      media_scope: automation.mediaScope,
      media_ids: automation.mediaIds,
    },
  ]);
  return {
    matches: Boolean(result),
    eventType,
    eventContext,
    matchedKeyword: result?.matchedKeyword || null,
  };
}

function triggerMatchesEvent(trigger: InstagramDmTriggerType, context: InstagramEventContext) {
  if (context === "comment") return trigger === "comment_keyword" || trigger === "any_comment";
  if (context === "live_comment") {
    return trigger === "live_comment_keyword" || trigger === "any_live_comment";
  }
  if (context === "story_reply") {
    return trigger === "story_reply_keyword" || trigger === "any_story_reply";
  }
  if (context === "post_share") return trigger === "post_share";
  if (context === "dm") return trigger === "dm_keyword" || trigger === "any_dm";
  return false;
}

export function parseInstagramWebhook(payload: unknown): InstagramWebhookEvent[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const root = payload as Record<string, unknown>;
  if (root.object !== "instagram" || !Array.isArray(root.entry)) return [];
  const events: InstagramWebhookEvent[] = [];

  for (const rawEntry of root.entry.slice(0, 100)) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
    const entry = rawEntry as Record<string, unknown>;
    const accountId = stringValue(entry.id, 255);
    if (!accountId) continue;
    const entryTime = timestampValue(entry.time);

    const changeCandidates = Array.isArray(entry.changes)
      ? entry.changes
      : entry.field && entry.value
        ? [{ field: entry.field, value: entry.value }]
        : [];
    for (const rawChange of changeCandidates.slice(0, 100)) {
      if (!rawChange || typeof rawChange !== "object" || Array.isArray(rawChange)) continue;
      const change = rawChange as Record<string, unknown>;
      if (!change.value || typeof change.value !== "object" || Array.isArray(change.value))
        continue;
      const value = change.value as Record<string, unknown>;

      if (change.field === "messages") {
        const messageEvent = parseMessagingEvent(value, accountId, entryTime);
        if (messageEvent) events.push(messageEvent);
        continue;
      }

      if (change.field !== "comments" && change.field !== "live_comments") continue;
      const commentId = stringValue(value.id, 255);
      if (!commentId) continue;
      const from =
        value.from && typeof value.from === "object" && !Array.isArray(value.from)
          ? (value.from as Record<string, unknown>)
          : {};
      const media =
        value.media && typeof value.media === "object" && !Array.isArray(value.media)
          ? (value.media as Record<string, unknown>)
          : {};
      events.push({
        externalEventId: `comment:${commentId}`,
        instagramAccountId: accountId,
        eventType: "comment",
        eventContext: change.field === "live_comments" ? "live_comment" : "comment",
        sourceId: commentId,
        senderId: stringValue(from.id, 255),
        senderUsername: stringValue(from.username, 80),
        mediaId: stringValue(media.id, 255),
        text: stringValue(value.text, 10_000) || "",
        actionPayload: null,
        occurredAt: entryTime,
      });
    }

    if (!Array.isArray(entry.messaging)) continue;
    for (const rawMessage of entry.messaging.slice(0, 100)) {
      if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) continue;
      const messageEvent = parseMessagingEvent(
        rawMessage as Record<string, unknown>,
        accountId,
        entryTime,
      );
      if (messageEvent) events.push(messageEvent);
    }
  }
  return events.slice(0, 200);
}

function parseMessagingEvent(
  messaging: Record<string, unknown>,
  fallbackAccountId: string,
  entryTime: string | null,
): InstagramWebhookEvent | null {
  const message = objectValue(messaging.message);
  if (
    !Object.keys(message).length ||
    message.is_echo === true ||
    message.is_self === true ||
    message.is_deleted === true
  ) {
    return null;
  }
  const sender = objectValue(messaging.sender);
  const recipient = objectValue(messaging.recipient);
  const messageId = stringValue(message.mid, 500);
  const senderId = stringValue(sender.id, 255);
  const recipientId = stringValue(recipient.id, 255);
  const replyTo = objectValue(message.reply_to);
  const story = objectValue(replyTo.story);
  const quickReply = objectValue(message.quick_reply);
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const sharedAttachment = attachments
    .map(objectValue)
    .find((attachment) => ["share", "ig_reel", "reel"].includes(String(attachment.type || "")));
  const attachmentPayload = objectValue(sharedAttachment?.payload);
  const text = stringValue(message.text, 10_000) || "";
  if (
    !messageId ||
    !senderId ||
    !recipientId ||
    senderId === recipientId ||
    // Instagram can echo Bento's own outbound message without setting
    // `message.is_echo`. A real webhook entry is keyed by the connected
    // Instagram account, so an event sent by that same account is outbound and
    // must never be treated as a customer's inbound DM.
    (fallbackAccountId !== "0" && senderId === fallbackAccountId)
  ) {
    return null;
  }
  const actionPayload = stringValue(quickReply.payload, 500);
  const eventContext: InstagramEventContext = actionPayload
    ? "quick_reply"
    : Object.keys(story).length
      ? "story_reply"
      : sharedAttachment
        ? "post_share"
        : "dm";
  if (!text && eventContext === "dm") return null;

  return {
    externalEventId: `message:${messageId}`,
    // Meta currently delivers messaging webhooks in both entry.messaging and
    // entry.changes[field=messages] shapes. The recipient is authoritative in
    // the latter (Meta's test payload uses a placeholder entry id).
    instagramAccountId: recipientId || fallbackAccountId,
    eventType: "message",
    eventContext,
    sourceId: messageId,
    senderId,
    senderUsername: null,
    mediaId:
      stringValue(story.id, 255) ||
      stringValue(attachmentPayload.url, 255) ||
      stringValue(attachmentPayload.id, 255),
    text,
    actionPayload,
    occurredAt: timestampValue(messaging.timestamp) || entryTime,
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown, max: number) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = String(value).trim();
  return result && result.length <= max ? result : null;
}

function timestampValue(value: unknown) {
  const numeric = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return null;
  const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
