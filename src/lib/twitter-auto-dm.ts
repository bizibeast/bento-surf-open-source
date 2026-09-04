import { z } from "zod";

export const TWITTER_DM_TRIGGER_TYPES = [
  "dm_keyword",
  "any_dm",
  "mention_keyword",
  "any_mention",
  "any_like",
  "any_retweet",
] as const;
export type TwitterDmTriggerType = (typeof TWITTER_DM_TRIGGER_TYPES)[number];
export type TwitterDmMatchType = "contains" | "exact";
export type TwitterEventType = "dm" | "mention" | "like" | "retweet";

export const TWITTER_KEYWORDLESS_TRIGGER_TYPES: readonly TwitterDmTriggerType[] = [
  "any_dm",
  "any_mention",
  "any_like",
  "any_retweet",
];

export const TWITTER_AUTO_DM_REQUIRED_SCOPES = [
  "tweet.read",
  "users.read",
  "dm.read",
  "dm.write",
  "offline.access",
] as const;

export const TWITTER_AUTO_DM_WEBHOOK_FIELDS = ["direct_messages", "mentions"] as const;

export const TWITTER_CONNECTION_VERIFICATION_MAX_AGE_MS = 48 * 60 * 60 * 1_000;

export type TwitterConnectionReadinessIssue =
  | "inactive"
  | "unhealthy"
  | "reauth_required"
  | "missing_scope"
  | "missing_webhook_subscription"
  | "token_expired"
  | "token_expiry_unknown"
  | "never_verified"
  | "verification_stale";

export type TwitterConnectionReadinessInput = {
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

export function getTwitterConnectionReadiness(
  connection: TwitterConnectionReadinessInput | null | undefined,
  now = new Date(),
) {
  const issues: TwitterConnectionReadinessIssue[] = [];
  if (!connection || connection.status !== "active") issues.push("inactive");
  if (!connection || connection.connection_health !== "healthy") issues.push("unhealthy");
  if (connection?.reauth_required) issues.push("reauth_required");

  const scopes = new Set(connection?.scopes || []);
  if (TWITTER_AUTO_DM_REQUIRED_SCOPES.some((scope) => !scopes.has(scope))) {
    issues.push("missing_scope");
  }

  const webhookFields = new Set(connection?.webhook_fields || []);
  if (TWITTER_AUTO_DM_WEBHOOK_FIELDS.some((field) => !webhookFields.has(field))) {
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
  } else if (now.getTime() - lastVerifiedAt > TWITTER_CONNECTION_VERIFICATION_MAX_AGE_MS) {
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

export function twitterConnectionReadinessMessage(
  issues: readonly TwitterConnectionReadinessIssue[],
) {
  if (issues.includes("reauth_required") || issues.includes("token_expired")) {
    return "Reconnect X to renew account access.";
  }
  if (issues.includes("token_expiry_unknown")) {
    return "Reconnect X so Bento can verify token expiry.";
  }
  if (issues.includes("missing_scope")) {
    return "Reconnect X and approve Direct Message access.";
  }
  if (issues.includes("missing_webhook_subscription")) {
    return "Repair the connection to enable X Auto-DM delivery.";
  }
  if (issues.includes("never_verified") || issues.includes("verification_stale")) {
    return "Recheck the connection before enabling automations.";
  }
  if (issues.includes("unhealthy")) return "X connection needs attention.";
  if (issues.includes("inactive")) return "X connection is inactive.";
  return null;
}

export type TwitterDmAutomation = {
  id: string;
  connectionId: string;
  connectionHandle: string;
  connectionReady: boolean;
  connectionNeedsReconnect: boolean;
  connectionReadinessMessage: string | null;
  connectionLastVerifiedAt: string | null;
  name: string;
  triggerType: TwitterDmTriggerType;
  keywords: string[];
  excludedKeywords: string[];
  matchType: TwitterDmMatchType;
  replyMessage: string;
  enabled: boolean;
  createdAt: string;
};

export type TwitterDmActivity = {
  id: string;
  automationName: string | null;
  eventType: TwitterEventType;
  senderLabel: string;
  matchedKeyword: string | null;
  status: "received" | "processing" | "sent" | "failed";
  errorMessage: string | null;
  createdAt: string;
};

const cleanKeyword = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase();

export const twitterDmAutomationInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    connectionId: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    triggerType: z.enum(TWITTER_DM_TRIGGER_TYPES),
    keywords: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    excludedKeywords: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    matchType: z.enum(["contains", "exact"]).default("contains"),
    replyMessage: z.string().trim().min(1).max(10_000),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, context) => {
    if (
      !(TWITTER_KEYWORDLESS_TRIGGER_TYPES as readonly string[]).includes(value.triggerType) &&
      value.keywords.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keywords"],
        message: "Add at least one keyword.",
      });
    }
  })
  .transform((value) => ({
    ...value,
    keywords: [...new Set(value.keywords.map(cleanKeyword).filter(Boolean))],
    excludedKeywords: [...new Set(value.excludedKeywords.map(cleanKeyword).filter(Boolean))],
  }));

export type TwitterWebhookEvent = {
  externalEventId: string;
  twitterUserId: string;
  eventType: TwitterEventType;
  sourceId: string;
  senderId: string | null;
  senderUsername: string | null;
  text: string;
  occurredAt: string | null;
};

export type MatchableTwitterAutomation = {
  id: string;
  trigger_type: TwitterDmTriggerType;
  keywords: string[];
  excluded_keywords: string[];
  match_type: TwitterDmMatchType;
};

export function matchTwitterAutomation<T extends MatchableTwitterAutomation>(
  event: Pick<TwitterWebhookEvent, "eventType" | "text">,
  automations: T[],
) {
  const normalizedText = cleanKeyword(event.text);
  for (const automation of automations) {
    if (!triggerMatchesEvent(automation.trigger_type, event.eventType)) continue;
    if (
      (automation.excluded_keywords || []).some((keyword) =>
        normalizedText.includes(cleanKeyword(keyword)),
      )
    ) {
      continue;
    }
    if (
      (TWITTER_KEYWORDLESS_TRIGGER_TYPES as readonly string[]).includes(automation.trigger_type)
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

export type TwitterAutomationTestResult = {
  matches: boolean;
  eventType: TwitterEventType;
  matchedKeyword: string | null;
};

export function testTwitterAutomation(
  automation: Pick<
    TwitterDmAutomation,
    "id" | "triggerType" | "keywords" | "excludedKeywords" | "matchType"
  >,
  text: string,
): TwitterAutomationTestResult {
  const eventType: TwitterEventType =
    automation.triggerType === "any_like"
      ? "like"
      : automation.triggerType === "any_retweet"
        ? "retweet"
        : automation.triggerType === "mention_keyword" || automation.triggerType === "any_mention"
          ? "mention"
          : "dm";
  const result = matchTwitterAutomation({ eventType, text }, [
    {
      id: automation.id,
      trigger_type: automation.triggerType,
      keywords: automation.keywords,
      excluded_keywords: automation.excludedKeywords,
      match_type: automation.matchType,
    },
  ]);
  return {
    matches: Boolean(result),
    eventType,
    matchedKeyword: result?.matchedKeyword || null,
  };
}

function triggerMatchesEvent(trigger: TwitterDmTriggerType, eventType: TwitterEventType) {
  if (eventType === "dm") return trigger === "dm_keyword" || trigger === "any_dm";
  if (eventType === "like") return trigger === "any_like";
  if (eventType === "retweet") return trigger === "any_retweet";
  return trigger === "mention_keyword" || trigger === "any_mention";
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

function isoTimestamp(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstId(value: Record<string, unknown> | null, keys: readonly string[], max = 255) {
  if (!value) return null;
  for (const key of keys) {
    const direct = stringValue(value[key], max);
    if (direct) return direct;
    const nested = record(value[key]);
    const nestedId = nested ? stringValue(nested.id, max) || stringValue(nested.id_str, max) : null;
    if (nestedId) return nestedId;
  }
  return null;
}

function usernameFrom(value: Record<string, unknown> | null) {
  if (!value) return null;
  return (
    stringValue(value.username, 80) ||
    stringValue(value.screen_name, 80) ||
    stringValue(value.handle, 80)
  );
}

export function twitterEngagementEvent(input: {
  eventType: "like" | "retweet";
  tweetId: string | null;
  accountId: string;
  senderId: string | null;
  senderUsername?: string | null;
  occurredAt?: string | null;
}): TwitterWebhookEvent | null {
  if (!input.tweetId || !input.accountId || !input.senderId) return null;
  if (input.senderId === input.accountId) return null;
  return {
    externalEventId: `${input.eventType}:${input.tweetId}:${input.senderId}`,
    twitterUserId: input.accountId,
    eventType: input.eventType,
    sourceId: input.tweetId,
    senderId: input.senderId,
    senderUsername: input.senderUsername || null,
    text: "",
    occurredAt: input.occurredAt || null,
  };
}

function parseActivityPayload(
  eventTypeHint: string,
  payload: Record<string, unknown>,
  accountId: string,
): TwitterWebhookEvent | null {
  const hint = eventTypeHint.toLowerCase();
  const actor = record(payload.user) || record(payload.actor) || payload;
  const senderId =
    firstId(payload, ["sender_id", "user_id", "actor_id", "liker_id", "from_user_id"]) ||
    firstId(actor, ["id", "id_str"]);
  const senderUsername =
    usernameFrom(record(payload.user)) ||
    usernameFrom(record(payload.actor)) ||
    usernameFrom(payload);
  const occurredAt = isoTimestamp(payload.created_at) || timestampValue(payload.timestamp_ms);
  if (hint.includes("dm")) {
    return twitterDmEventFromApi(
      {
        ...payload,
        sender_id: senderId || payload.sender_id,
      },
      accountId,
      new Map(senderId ? [[senderId, { username: senderUsername }]] : []),
    );
  }
  if (hint.includes("like") || hint.includes("favorite")) {
    return twitterEngagementEvent({
      eventType: "like",
      tweetId: firstId(payload, ["tweet_id", "liked_tweet_id", "favorited_status", "tweet"]),
      accountId,
      senderId,
      senderUsername,
      occurredAt,
    });
  }
  if (
    hint.includes("retweet") ||
    hint.includes("repost") ||
    Boolean(record(payload.retweeted_status))
  ) {
    return twitterEngagementEvent({
      eventType: "retweet",
      tweetId: firstId(payload, [
        "tweet_id",
        "retweeted_tweet_id",
        "source_tweet_id",
        "retweeted_status",
        "tweet",
      ]),
      accountId,
      senderId,
      senderUsername,
      occurredAt,
    });
  }
  if (hint.includes("reply") || hint.includes("mention") || hint.includes("tweet")) {
    return twitterMentionEventFromApi(
      {
        ...payload,
        author_id: senderId || payload.author_id,
      },
      accountId,
      new Map(senderId ? [[senderId, { username: senderUsername }]] : []),
    );
  }
  return null;
}

export function parseTwitterWebhook(payload: unknown): TwitterWebhookEvent[] {
  const root = record(payload);
  if (!root) return [];
  const wrapped = record(root.data);
  const eventNode = record(root.event);
  const eventTypeHint =
    stringValue(root.event_type, 80) ||
    stringValue(wrapped?.event_type, 80) ||
    stringValue(eventNode?.type, 80) ||
    stringValue(eventNode?.event_type, 80) ||
    "";
  const filter = record(root.filter) || record(wrapped?.filter);
  const innerPayload =
    record(root.payload) ||
    record(wrapped?.payload) ||
    record(eventNode?.data) ||
    record(eventNode?.payload);
  const accountId =
    stringValue(root.for_user_id, 255) ||
    stringValue(root.forUserId, 255) ||
    stringValue(filter?.user_id, 255) ||
    stringValue(wrapped?.for_user_id, 255) ||
    "";

  if (eventTypeHint && innerPayload && accountId) {
    const parsed = parseActivityPayload(eventTypeHint, innerPayload, accountId);
    if (parsed) return [parsed];
  }

  const body =
    innerPayload && !root.direct_message_events && !root.tweet_create_events
      ? { ...root, ...innerPayload }
      : root;
  const events: TwitterWebhookEvent[] = [];
  const users = record(body.users) || record(root.users) || {};

  const dmEvents = Array.isArray(body.direct_message_events)
    ? body.direct_message_events
    : Array.isArray(body.dm_events)
      ? body.dm_events
      : [];
  for (const rawEvent of dmEvents.slice(0, 100)) {
    const event = record(rawEvent);
    if (!event) continue;
    const type = stringValue(event.type, 80) || stringValue(event.event_type, 80) || "";
    if (type && type !== "message_create" && type !== "MessageCreate") continue;
    const messageCreate = record(event.message_create);
    const senderId =
      stringValue(event.sender_id, 255) ||
      stringValue(messageCreate?.sender_id, 255) ||
      stringValue(record(messageCreate?.sender)?.id, 255);
    const text =
      stringValue(record(messageCreate?.message_data)?.text, 10_000) ||
      stringValue(event.text, 10_000) ||
      "";
    const sourceId = stringValue(event.id, 255);
    if (!sourceId || !accountId) continue;
    if (senderId && senderId === accountId) continue;
    const senderUser = senderId ? record(users[senderId]) : null;
    events.push({
      externalEventId: `dm:${sourceId}`,
      twitterUserId: accountId,
      eventType: "dm",
      sourceId,
      senderId,
      senderUsername:
        stringValue(senderUser?.screen_name, 80) ||
        stringValue(senderUser?.username, 80) ||
        stringValue(event.sender_username, 80),
      text,
      occurredAt: timestampValue(event.created_timestamp) || isoTimestamp(event.created_at),
    });
  }

  const tweetEvents = Array.isArray(body.tweet_create_events) ? body.tweet_create_events : [];
  for (const rawTweet of tweetEvents.slice(0, 100)) {
    const tweet = record(rawTweet);
    if (!tweet) continue;
    const user = record(tweet.user);
    const senderId = stringValue(user?.id_str, 255) || stringValue(user?.id, 255);
    if (!accountId) continue;
    if (senderId && senderId === accountId) continue;
    const retweeted = record(tweet.retweeted_status);
    if (retweeted) {
      const originalUser = record(retweeted.user);
      const originalAuthor =
        stringValue(originalUser?.id_str, 255) || stringValue(originalUser?.id, 255);
      if (originalAuthor && originalAuthor !== accountId) continue;
      const parsed = twitterEngagementEvent({
        eventType: "retweet",
        tweetId:
          stringValue(retweeted.id_str, 255) ||
          stringValue(retweeted.id, 255) ||
          stringValue(tweet.id_str, 255) ||
          stringValue(tweet.id, 255),
        accountId,
        senderId,
        senderUsername: usernameFrom(user),
        occurredAt: isoTimestamp(tweet.created_at) || timestampValue(tweet.timestamp_ms),
      });
      if (parsed) events.push(parsed);
      continue;
    }
    const sourceId = stringValue(tweet.id_str, 255) || stringValue(tweet.id, 255);
    if (!sourceId) continue;
    const replyToUser =
      stringValue(tweet.in_reply_to_user_id_str, 255) ||
      stringValue(tweet.in_reply_to_user_id, 255);
    const text = stringValue(tweet.full_text, 10_000) || stringValue(tweet.text, 10_000) || "";
    if (replyToUser && replyToUser !== accountId && !text.toLowerCase().includes(`@`)) {
      continue;
    }
    events.push({
      externalEventId: `mention:${sourceId}`,
      twitterUserId: accountId,
      eventType: "mention",
      sourceId,
      senderId,
      senderUsername: usernameFrom(user),
      text,
      occurredAt: isoTimestamp(tweet.created_at) || timestampValue(tweet.timestamp_ms),
    });
  }

  const favoriteEvents = Array.isArray(body.favorite_events)
    ? body.favorite_events
    : Array.isArray(body.like_events)
      ? body.like_events
      : [];
  for (const rawFavorite of favoriteEvents.slice(0, 100)) {
    const event = record(rawFavorite);
    if (!event) continue;
    const status = record(event.favorited_status) || record(event.tweet);
    const statusUser = record(status?.user);
    const tweetAuthorId = stringValue(statusUser?.id_str, 255) || stringValue(statusUser?.id, 255);
    if (tweetAuthorId && tweetAuthorId !== accountId) continue;
    const liker = record(event.user);
    const parsed = twitterEngagementEvent({
      eventType: "like",
      tweetId: stringValue(status?.id_str, 255) || stringValue(status?.id, 255),
      accountId,
      senderId: stringValue(liker?.id_str, 255) || stringValue(liker?.id, 255),
      senderUsername: usernameFrom(liker),
      occurredAt: isoTimestamp(event.created_at) || timestampValue(event.timestamp_ms),
    });
    if (parsed) events.push(parsed);
  }

  return events.slice(0, 100);
}

export function twitterDmEventFromApi(
  event: Record<string, unknown>,
  accountId: string,
  usersById: Map<string, { username?: string | null }>,
): TwitterWebhookEvent | null {
  const type = stringValue(event.event_type, 80) || stringValue(event.type, 80) || "";
  if (type && type !== "MessageCreate" && type !== "message_create") return null;
  const sourceId = stringValue(event.id, 255);
  const senderId = stringValue(event.sender_id, 255);
  if (!sourceId) return null;
  if (senderId && senderId === accountId) return null;
  return {
    externalEventId: `dm:${sourceId}`,
    twitterUserId: accountId,
    eventType: "dm",
    sourceId,
    senderId,
    senderUsername: senderId ? usersById.get(senderId)?.username || null : null,
    text: stringValue(event.text, 10_000) || "",
    occurredAt: isoTimestamp(event.created_at),
  };
}

export function twitterMentionEventFromApi(
  tweet: Record<string, unknown>,
  accountId: string,
  usersById: Map<string, { username?: string | null }>,
): TwitterWebhookEvent | null {
  const sourceId = stringValue(tweet.id, 255);
  const senderId = stringValue(tweet.author_id, 255);
  if (!sourceId) return null;
  if (senderId && senderId === accountId) return null;
  return {
    externalEventId: `mention:${sourceId}`,
    twitterUserId: accountId,
    eventType: "mention",
    sourceId,
    senderId,
    senderUsername: senderId ? usersById.get(senderId)?.username || null : null,
    text: stringValue(tweet.text, 10_000) || "",
    occurredAt: isoTimestamp(tweet.created_at),
  };
}
