import { describe, expect, it } from "vitest";
import {
  getTwitterConnectionReadiness,
  matchTwitterAutomation,
  parseTwitterWebhook,
  testTwitterAutomation,
  twitterConnectionReadinessMessage,
  twitterDmAutomationInputSchema,
  twitterDmEventFromApi,
  twitterMentionEventFromApi,
} from "./twitter-auto-dm";

describe("X Auto-DM connection readiness", () => {
  const now = new Date("2026-08-13T08:00:00.000Z");
  const readyConnection = {
    status: "active",
    connection_health: "healthy",
    reauth_required: false,
    scopes: ["tweet.read", "users.read", "dm.read", "dm.write", "offline.access"],
    webhook_fields: ["direct_messages", "mentions"],
    token_expires_at: "2026-09-13T08:00:00.000Z",
    last_verified_at: "2026-08-12T08:00:00.000Z",
  };

  it("requires a healthy, fully scoped, verified token", () => {
    expect(getTwitterConnectionReadiness(readyConnection, now)).toEqual({
      ready: true,
      issues: [],
      needsReconnect: false,
    });
  });

  it("requires reconnection when Direct Message scopes are missing", () => {
    const readiness = getTwitterConnectionReadiness(
      { ...readyConnection, scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"] },
      now,
    );
    expect(readiness).toMatchObject({
      ready: false,
      issues: ["missing_scope"],
      needsReconnect: true,
    });
    expect(twitterConnectionReadinessMessage(readiness.issues)).toContain("Direct Message");
  });

  it("requires a repair when delivery fields are missing", () => {
    const readiness = getTwitterConnectionReadiness(
      { ...readyConnection, webhook_fields: [] },
      now,
    );
    expect(readiness).toMatchObject({
      ready: false,
      issues: ["missing_webhook_subscription"],
      needsReconnect: false,
    });
  });

  it("allows DM rules with DM delivery but requires the matching feed for mention rules", () => {
    const dmOnly = { ...readyConnection, webhook_fields: ["direct_messages"] };
    expect(getTwitterConnectionReadiness(dmOnly, now).ready).toBe(true);
    expect(getTwitterConnectionReadiness(dmOnly, now, "any_mention").issues).toContain(
      "missing_webhook_subscription",
    );
  });
});

describe("X Auto-DM matching", () => {
  const dmKeyword = {
    id: "auto-1",
    trigger_type: "dm_keyword" as const,
    keywords: ["info"],
    excluded_keywords: ["unsubscribe"],
    match_type: "contains" as const,
  };

  it("matches inbound DM keywords and ignores excluded phrases", () => {
    expect(
      matchTwitterAutomation({ eventType: "dm", text: "Please send INFO" }, [dmKeyword])
        ?.matchedKeyword,
    ).toBe("info");
    expect(
      matchTwitterAutomation({ eventType: "dm", text: "info but unsubscribe me" }, [dmKeyword]),
    ).toBeNull();
  });

  it("does not apply mention rules to inbound DMs", () => {
    expect(
      matchTwitterAutomation({ eventType: "dm", text: "link" }, [
        {
          id: "auto-2",
          trigger_type: "mention_keyword",
          keywords: ["link"],
          excluded_keywords: [],
          match_type: "contains",
        },
      ]),
    ).toBeNull();
  });

  it("dry-runs a saved automation without contacting X", () => {
    expect(
      testTwitterAutomation(
        {
          id: "auto-1",
          triggerType: "mention_keyword",
          keywords: ["link"],
          excludedKeywords: [],
          matchType: "contains",
        },
        "drop the LINK please",
      ),
    ).toEqual({ matches: true, eventType: "mention", matchedKeyword: "link" });
  });

  it("matches likes and reposts without requiring keywords", () => {
    expect(
      matchTwitterAutomation({ eventType: "like", text: "" }, [
        {
          id: "auto-like",
          trigger_type: "any_like",
          keywords: [],
          excluded_keywords: [],
          match_type: "contains",
        },
      ])?.automation.id,
    ).toBe("auto-like");
    expect(
      matchTwitterAutomation({ eventType: "retweet", text: "" }, [
        {
          id: "auto-rt",
          trigger_type: "any_retweet",
          keywords: [],
          excluded_keywords: [],
          match_type: "contains",
        },
      ])?.automation.id,
    ).toBe("auto-rt");
    expect(
      matchTwitterAutomation({ eventType: "like", text: "" }, [
        {
          id: "auto-mention",
          trigger_type: "any_mention",
          keywords: [],
          excluded_keywords: [],
          match_type: "contains",
        },
      ]),
    ).toBeNull();
    expect(
      twitterDmAutomationInputSchema.parse({
        connectionId: "11111111-1111-4111-8111-111111111111",
        name: "Thanks for the like",
        triggerType: "any_like",
        keywords: [],
        replyMessage: "Thanks for the like!",
      }).triggerType,
    ).toBe("any_like");
  });
});

describe("X Auto-DM webhook parsing", () => {
  it("normalizes inbound DMs and ignores self-sent echoes", () => {
    const events = parseTwitterWebhook({
      for_user_id: "creator-1",
      users: {
        "sender-1": { id: "sender-1", screen_name: "alice" },
      },
      direct_message_events: [
        {
          type: "message_create",
          id: "dm-1",
          created_timestamp: String(Date.parse("2026-08-13T08:00:00.000Z")),
          message_create: {
            sender_id: "sender-1",
            target: { recipient_id: "creator-1" },
            message_data: { text: "info please" },
          },
        },
        {
          type: "message_create",
          id: "dm-echo",
          created_timestamp: "1755072001000",
          message_create: {
            sender_id: "creator-1",
            target: { recipient_id: "sender-1" },
            message_data: { text: "Thanks!" },
          },
        },
      ],
    });
    expect(events).toEqual([
      {
        externalEventId: "dm:dm-1",
        twitterUserId: "creator-1",
        eventType: "dm",
        sourceId: "dm-1",
        senderId: "sender-1",
        senderUsername: "alice",
        text: "info please",
        occurredAt: "2026-08-13T08:00:00.000Z",
      },
    ]);
  });

  it("accepts the current X Activity dm.received envelope", () => {
    const events = parseTwitterWebhook({
      data: {
        event_uuid: "delivery-1",
        filter: { user_id: "creator-1" },
        event_type: "dm.received",
        payload: {
          direct_message_events: [
            {
              type: "message_create",
              id: "dm-2",
              created_timestamp: String(Date.parse("2026-10-18T06:00:00.000Z")),
              message_create: {
                sender_id: "sender-1",
                target: { recipient_id: "creator-1" },
                message_data: { text: "info please" },
              },
            },
          ],
        },
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        externalEventId: "dm:dm-2",
        twitterUserId: "creator-1",
        senderId: "sender-1",
        text: "info please",
      }),
    ]);
  });

  it("normalizes mention and reply events", () => {
    const events = parseTwitterWebhook({
      for_user_id: "creator-1",
      tweet_create_events: [
        {
          id_str: "tweet-1",
          text: "link",
          created_at: "2026-08-13T08:00:00.000Z",
          in_reply_to_user_id_str: "creator-1",
          user: { id_str: "sender-1", screen_name: "alice" },
        },
      ],
    });
    expect(events).toEqual([
      {
        externalEventId: "mention:tweet-1",
        twitterUserId: "creator-1",
        eventType: "mention",
        sourceId: "tweet-1",
        senderId: "sender-1",
        senderUsername: "alice",
        text: "link",
        occurredAt: "2026-08-13T08:00:00.000Z",
      },
    ]);
  });

  it("maps official DM and mention API objects for polling", () => {
    const users = new Map([["sender-1", { username: "alice" }]]);
    expect(
      twitterDmEventFromApi(
        {
          id: "dm-2",
          event_type: "MessageCreate",
          sender_id: "sender-1",
          text: "hello",
          created_at: "2026-08-13T08:00:00.000Z",
        },
        "creator-1",
        users,
      ),
    ).toMatchObject({ externalEventId: "dm:dm-2", eventType: "dm", senderUsername: "alice" });
    expect(
      twitterMentionEventFromApi(
        {
          id: "tweet-2",
          author_id: "sender-1",
          text: "link",
          created_at: "2026-08-13T08:00:00.000Z",
        },
        "creator-1",
        users,
      ),
    ).toMatchObject({ externalEventId: "mention:tweet-2", eventType: "mention" });
  });

  it("normalizes likes and reposts from Account Activity payloads", () => {
    expect(
      parseTwitterWebhook({
        for_user_id: "creator-1",
        favorite_events: [
          {
            created_at: "2026-08-13T08:00:00.000Z",
            user: { id_str: "sender-1", screen_name: "alice" },
            favorited_status: {
              id_str: "tweet-9",
              user: { id_str: "creator-1" },
            },
          },
        ],
        tweet_create_events: [
          {
            id_str: "rt-1",
            created_at: "2026-08-13T08:01:00.000Z",
            user: { id_str: "sender-1", screen_name: "alice" },
            retweeted_status: {
              id_str: "tweet-9",
              user: { id_str: "creator-1" },
            },
          },
        ],
      }),
    ).toEqual([
      {
        externalEventId: "retweet:tweet-9:sender-1",
        twitterUserId: "creator-1",
        eventType: "retweet",
        sourceId: "tweet-9",
        senderId: "sender-1",
        senderUsername: "alice",
        text: "",
        occurredAt: "2026-08-13T08:01:00.000Z",
      },
      {
        externalEventId: "like:tweet-9:sender-1",
        twitterUserId: "creator-1",
        eventType: "like",
        sourceId: "tweet-9",
        senderId: "sender-1",
        senderUsername: "alice",
        text: "",
        occurredAt: "2026-08-13T08:00:00.000Z",
      },
    ]);
  });

  it("normalizes X Activity like events", () => {
    expect(
      parseTwitterWebhook({
        data: {
          event_type: "tweet.like",
          filter: { user_id: "creator-1" },
          payload: {
            tweet_id: "tweet-9",
            user_id: "sender-1",
            username: "alice",
            created_at: "2026-08-13T08:00:00.000Z",
          },
        },
      }),
    ).toEqual([
      {
        externalEventId: "like:tweet-9:sender-1",
        twitterUserId: "creator-1",
        eventType: "like",
        sourceId: "tweet-9",
        senderId: "sender-1",
        senderUsername: "alice",
        text: "",
        occurredAt: "2026-08-13T08:00:00.000Z",
      },
    ]);
  });
});

it("matches scheduled X replies only to their parent post and prefers them over account-wide rules", () => {
  const generic = {
    id: "general",
    trigger_type: "mention_keyword" as const,
    keywords: ["link"],
    excluded_keywords: [],
    match_type: "contains" as const,
  };
  const scoped = { ...generic, id: "specific", source_post_id: "original-post" };
  expect(
    matchTwitterAutomation(
      { eventType: "mention", text: "link", sourceId: "reply-id", replyToPostId: "original-post" },
      [generic, scoped],
    )?.automation.id,
  ).toBe("specific");
  expect(
    matchTwitterAutomation({ eventType: "mention", text: "link", sourceId: "original-post" }, [
      scoped,
    ]),
  ).toBeNull();
  expect(
    matchTwitterAutomation({ eventType: "mention", text: "link", replyToPostId: "other-post" }, [
      scoped,
    ]),
  ).toBeNull();
  expect(
    matchTwitterAutomation({ eventType: "like", text: "", sourceId: "original-post" }, [
      { ...scoped, trigger_type: "any_like" },
    ])?.automation.id,
  ).toBe("specific");
  expect(
    matchTwitterAutomation({ eventType: "retweet", text: "", sourceId: "other-post" }, [
      { ...scoped, trigger_type: "any_retweet" },
    ]),
  ).toBeNull();
});

it("keeps reply parent IDs from official v1 and v2 webhook payloads without a lookup", () => {
  const legacy = parseTwitterWebhook({
    for_user_id: "owner",
    tweet_create_events: [
      {
        id_str: "reply-id",
        in_reply_to_status_id_str: "parent",
        in_reply_to_user_id_str: "owner",
        text: "link",
        user: { id_str: "sender" },
      },
    ],
  });
  expect(legacy[0]).toMatchObject({ sourceId: "reply-id", replyToPostId: "parent" });
  const modern = parseTwitterWebhook({
    for_user_id: "owner",
    event_type: "tweet.reply",
    payload: {
      id: "reply-id",
      author_id: "sender",
      text: "link",
      referenced_tweets: [
        { type: "quoted", id: "wrong" },
        { type: "replied_to", id: "parent" },
      ],
    },
  });
  expect(modern[0]).toMatchObject({ sourceId: "reply-id", replyToPostId: "parent" });
});
