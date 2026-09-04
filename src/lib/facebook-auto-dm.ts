import { z } from "zod";

export const FACEBOOK_DM_TRIGGER_TYPES = [
  "comment_keyword",
  "any_comment",
  "dm_keyword",
  "any_dm",
] as const;
export type FacebookDmTriggerType = (typeof FACEBOOK_DM_TRIGGER_TYPES)[number];
export type FacebookDmMatchType = "contains" | "exact";
export type FacebookDmMediaScope = "any" | "specific" | "future";
export type FacebookEventContext = "comment" | "dm" | "quick_reply";

export const FACEBOOK_KEYWORDLESS_TRIGGER_TYPES: readonly FacebookDmTriggerType[] = [
  "any_comment",
  "any_dm",
];

export const FACEBOOK_AUTO_DM_REQUIRED_SCOPES = [
  "pages_show_list",
  "pages_read_user_content",
  "pages_read_engagement",
  "pages_manage_metadata",
  "pages_manage_engagement",
  "pages_messaging",
] as const;

export const FACEBOOK_AUTO_DM_WEBHOOK_FIELDS = ["feed", "messages", "messaging_postbacks"] as const;

export const FACEBOOK_CONNECTION_VERIFICATION_MAX_AGE_MS = 48 * 60 * 60 * 1_000;

export type FacebookConnectionReadinessIssue =
  | "inactive"
  | "unhealthy"
  | "reauth_required"
  | "missing_scope"
  | "missing_webhook_subscription"
  | "token_expired"
  | "never_verified"
  | "verification_stale";

export type FacebookConnectionReadinessInput = {
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

export function getFacebookConnectionReadiness(
  connection: FacebookConnectionReadinessInput | null | undefined,
  now = new Date(),
) {
  const issues: FacebookConnectionReadinessIssue[] = [];
  if (!connection || connection.status !== "active") issues.push("inactive");
  if (!connection || connection.connection_health !== "healthy") issues.push("unhealthy");
  if (connection?.reauth_required) issues.push("reauth_required");

  const scopes = new Set(connection?.scopes || []);
  if (FACEBOOK_AUTO_DM_REQUIRED_SCOPES.some((scope) => !scopes.has(scope))) {
    issues.push("missing_scope");
  }

  const webhookFields = new Set(connection?.webhook_fields || []);
  if (FACEBOOK_AUTO_DM_WEBHOOK_FIELDS.some((field) => !webhookFields.has(field))) {
    issues.push("missing_webhook_subscription");
  }

  const tokenExpiresAt = validTimestamp(connection?.token_expires_at);
  if (tokenExpiresAt !== null && tokenExpiresAt <= now.getTime()) {
    issues.push("token_expired");
  }

  const lastVerifiedAt = validTimestamp(connection?.last_verified_at);
  if (lastVerifiedAt === null) {
    issues.push("never_verified");
  } else if (now.getTime() - lastVerifiedAt > FACEBOOK_CONNECTION_VERIFICATION_MAX_AGE_MS) {
    issues.push("verification_stale");
  }

  return {
    ready: issues.length === 0,
    issues,
    needsReconnect: issues.some((issue) =>
      ["reauth_required", "missing_scope", "token_expired"].includes(issue),
    ),
  };
}

export function facebookConnectionReadinessMessage(
  issues: readonly FacebookConnectionReadinessIssue[],
) {
  if (issues.includes("reauth_required") || issues.includes("token_expired")) {
    return "Reconnect Facebook to renew Page access.";
  }
  if (issues.includes("missing_scope")) {
    return "Reconnect Facebook and approve comment and message access.";
  }
  if (issues.includes("missing_webhook_subscription")) {
    return "Repair the connection to restore Meta webhook subscriptions.";
  }
  if (issues.includes("never_verified") || issues.includes("verification_stale")) {
    return "Recheck the connection before enabling automations.";
  }
  if (issues.includes("unhealthy")) return "Facebook connection needs attention.";
  if (issues.includes("inactive")) return "Facebook connection is inactive.";
  return null;
}

export type FacebookDmAutomation = {
  id: string;
  connectionId: string;
  connectionHandle: string;
  connectionReady: boolean;
  connectionNeedsReconnect: boolean;
  connectionReadinessMessage: string | null;
  connectionLastVerifiedAt: string | null;
  name: string;
  triggerType: FacebookDmTriggerType;
  keywords: string[];
  excludedKeywords: string[];
  matchType: FacebookDmMatchType;
  mediaScope: FacebookDmMediaScope;
  mediaIds: string[];
  replyMessage: string;
  publicReplyEnabled: boolean;
  publicReplyMessages: string[];
  openingMessage: string | null;
  confirmationButtonLabel: string | null;
  emailCaptureEnabled: boolean;
  emailPromptMessage: string | null;
  emailMarketingConsentEnabled: boolean;
  replyButtonLabel: string | null;
  replyButtonUrl: string | null;
  enabled: boolean;
  createdAt: string;
};

export type FacebookDmActivity = {
  id: string;
  automationName: string | null;
  eventType: "comment" | "message";
  eventContext: FacebookEventContext;
  senderLabel: string;
  matchedKeyword: string | null;
  status: "received" | "processing" | "sent" | "failed";
  errorMessage: string | null;
  createdAt: string;
};

export type FacebookDmWorkflow = {
  id: string;
  automationName: string | null;
  senderLabel: string;
  status:
    "awaiting_confirmation" | "awaiting_email" | "delivering" | "completed" | "failed" | "expired";
  emailCaptured: boolean;
  marketingConsent: boolean;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type FacebookMedia = {
  id: string;
  caption: string;
  mediaType: string;
  imageUrl: string | null;
  permalink: string;
  timestamp: string | null;
};

const cleanKeyword = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase();
const emailAddressSchema = z.string().email().max(254);

export function extractFacebookEmailAddress(value: string) {
  const email = value.normalize("NFKC").trim().toLocaleLowerCase();
  return emailAddressSchema.safeParse(email).success ? email : null;
}

export const facebookDmAutomationInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    connectionId: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    triggerType: z.enum(FACEBOOK_DM_TRIGGER_TYPES),
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
    replyButtonLabel: z.string().trim().min(1).max(20).nullable().default(null),
    replyButtonUrl: z.string().url().max(2048).nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, context) => {
    if (
      !FACEBOOK_KEYWORDLESS_TRIGGER_TYPES.includes(value.triggerType) &&
      value.keywords.length === 0
    ) {
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
        message: "Choose at least one Page post.",
      });
    }
    if (Boolean(value.openingMessage) !== Boolean(value.confirmationButtonLabel)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["openingMessage"],
        message: "Add both an opening message and suggested reply, or leave both empty.",
      });
    }
    if (
      ["comment_keyword", "any_comment"].includes(value.triggerType) &&
      (!value.openingMessage || !value.confirmationButtonLabel)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["openingMessage"],
        message: "Comment automations require the opening message and Send it action.",
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
  }));

export type FacebookWebhookEvent = {
  externalEventId: string;
  facebookPageId: string;
  eventType: "comment" | "message";
  eventContext: FacebookEventContext;
  sourceId: string;
  senderId: string | null;
  senderUsername: string | null;
  mediaId: string | null;
  text: string;
  actionPayload: string | null;
  occurredAt: string | null;
};

export type MatchableFacebookAutomation = {
  id: string;
  trigger_type: FacebookDmTriggerType;
  keywords: string[];
  excluded_keywords: string[];
  match_type: FacebookDmMatchType;
  media_scope: FacebookDmMediaScope;
  media_ids: string[];
};

function triggerMatchesEvent(trigger: FacebookDmTriggerType, context: FacebookEventContext) {
  if (context === "comment") return trigger === "comment_keyword" || trigger === "any_comment";
  if (context === "dm") return trigger === "dm_keyword" || trigger === "any_dm";
  return false;
}

export function matchFacebookAutomation(
  event: Pick<FacebookWebhookEvent, "eventType" | "eventContext" | "text" | "mediaId">,
  automations: MatchableFacebookAutomation[],
) {
  const normalizedText = cleanKeyword(event.text);
  for (const automation of automations) {
    if (!triggerMatchesEvent(automation.trigger_type, event.eventContext)) continue;
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
    if (FACEBOOK_KEYWORDLESS_TRIGGER_TYPES.includes(automation.trigger_type)) {
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

export type FacebookAutomationTestResult = {
  matches: boolean;
  eventType: "comment" | "message";
  eventContext: FacebookEventContext;
  matchedKeyword: string | null;
};

export function testFacebookAutomation(
  automation: Pick<
    FacebookDmAutomation,
    "id" | "triggerType" | "keywords" | "excludedKeywords" | "matchType" | "mediaScope" | "mediaIds"
  >,
  text: string,
): FacebookAutomationTestResult {
  const eventContext: FacebookEventContext =
    automation.triggerType === "comment_keyword" || automation.triggerType === "any_comment"
      ? "comment"
      : "dm";
  const eventType = eventContext === "comment" ? "comment" : "message";
  const mediaId =
    automation.mediaScope === "specific"
      ? automation.mediaIds[0] || null
      : automation.mediaScope === "future"
        ? "__bento_test_future_media__"
        : null;
  const result = matchFacebookAutomation({ eventType, eventContext, text, mediaId }, [
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

export function parseFacebookWebhook(payload: unknown): FacebookWebhookEvent[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const root = payload as Record<string, unknown>;
  if (root.object !== "page" || !Array.isArray(root.entry)) return [];
  const events: FacebookWebhookEvent[] = [];

  for (const rawEntry of root.entry.slice(0, 100)) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
    const entry = rawEntry as Record<string, unknown>;
    const pageId = stringValue(entry.id, 255);
    if (!pageId) continue;
    const entryTime = timestampValue(entry.time);

    const changeCandidates = Array.isArray(entry.changes) ? entry.changes : [];
    for (const rawChange of changeCandidates.slice(0, 100)) {
      if (!rawChange || typeof rawChange !== "object" || Array.isArray(rawChange)) continue;
      const change = rawChange as Record<string, unknown>;
      if (change.field !== "feed") continue;
      if (!change.value || typeof change.value !== "object" || Array.isArray(change.value)) {
        continue;
      }
      const value = change.value as Record<string, unknown>;
      if (value.item !== "comment" || value.verb !== "add") continue;
      const sourceId = stringValue(value.comment_id, 255);
      if (!sourceId) continue;
      const from = objectValue(value.from);
      const senderId = stringValue(from.id, 255);
      if (senderId && senderId === pageId) continue;
      events.push({
        externalEventId: `comment:${sourceId}`,
        facebookPageId: pageId,
        eventType: "comment",
        eventContext: "comment",
        sourceId,
        senderId,
        senderUsername: stringValue(from.name, 80),
        mediaId: stringValue(value.post_id, 255),
        text: stringValue(value.message, 10_000) || "",
        actionPayload: null,
        occurredAt: timestampValue(value.created_time) || entryTime,
      });
    }

    if (!Array.isArray(entry.messaging)) continue;
    for (const rawMessage of entry.messaging.slice(0, 100)) {
      if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) continue;
      const messageEvent = parseMessagingEvent(
        rawMessage as Record<string, unknown>,
        pageId,
        entryTime,
      );
      if (messageEvent) events.push(messageEvent);
    }
  }
  return events.slice(0, 200);
}

function parseMessagingEvent(
  messaging: Record<string, unknown>,
  fallbackPageId: string,
  entryTime: string | null,
): FacebookWebhookEvent | null {
  const postback = objectValue(messaging.postback);
  const postbackPayload = stringValue(postback.payload, 500);
  const message = objectValue(messaging.message);
  if (message.is_echo === true || message.is_deleted === true) return null;
  const sender = objectValue(messaging.sender);
  const recipient = objectValue(messaging.recipient);
  const senderId = stringValue(sender.id, 255);
  const recipientId = stringValue(recipient.id, 255);
  if (!senderId || !recipientId || senderId === recipientId) return null;
  if (fallbackPageId !== "0" && senderId === fallbackPageId) return null;

  if (postbackPayload) {
    const postbackId =
      stringValue(messaging.timestamp, 500) || stringValue(postback.payload, 255) || "postback";
    return {
      externalEventId: `postback:${recipientId}:${senderId}:${postbackId}`,
      facebookPageId: recipientId || fallbackPageId,
      eventType: "message",
      eventContext: "quick_reply",
      sourceId: postbackId,
      senderId,
      senderUsername: null,
      mediaId: null,
      text: stringValue(postback.title, 10_000) || "",
      actionPayload: postbackPayload,
      occurredAt: timestampValue(messaging.timestamp) || entryTime,
    };
  }

  const messageId = stringValue(message.mid, 500);
  if (!messageId) return null;
  const quickReply = objectValue(message.quick_reply);
  const actionPayload = stringValue(quickReply.payload, 500);
  const text = stringValue(message.text, 10_000) || "";
  const eventContext: FacebookEventContext = actionPayload ? "quick_reply" : "dm";
  if (!text && eventContext === "dm") return null;

  return {
    externalEventId: `message:${messageId}`,
    facebookPageId: recipientId || fallbackPageId,
    eventType: "message",
    eventContext,
    sourceId: messageId,
    senderId,
    senderUsername: null,
    mediaId: null,
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
