import { describe, expect, it } from "vitest";
import {
  getInstagramConnectionReadiness,
  instagramConnectionReadinessMessage,
  matchInstagramAutomation,
  parseInstagramWebhook,
  testInstagramAutomation,
} from "./instagram-auto-dm";

describe("Instagram connection readiness", () => {
  const now = new Date("2026-08-01T08:00:00.000Z");
  const readyConnection = {
    status: "active",
    connection_health: "healthy",
    reauth_required: false,
    scopes: [
      "instagram_business_basic",
      "instagram_business_manage_comments",
      "instagram_business_manage_messages",
    ],
    webhook_fields: ["comments", "live_comments", "messages", "messaging_postbacks"],
    token_expires_at: "2026-08-31T08:00:00.000Z",
    last_verified_at: "2026-07-31T08:00:00.000Z",
  };

  it("requires a healthy, fully subscribed, verified token", () => {
    expect(getInstagramConnectionReadiness(readyConnection, now)).toEqual({
      ready: true,
      issues: [],
      needsReconnect: false,
    });
  });

  it("does not call an account ready when webhook subscriptions are incomplete", () => {
    const readiness = getInstagramConnectionReadiness(
      { ...readyConnection, webhook_fields: ["comments", "messages"] },
      now,
    );
    expect(readiness).toMatchObject({
      ready: false,
      issues: ["missing_webhook_subscription"],
      needsReconnect: false,
    });
    expect(instagramConnectionReadinessMessage(readiness.issues)).toContain("webhook");
  });

  it("requires reconnection for an expired or untracked token", () => {
    expect(
      getInstagramConnectionReadiness(
        { ...readyConnection, token_expires_at: "2026-07-31T08:00:00.000Z" },
        now,
      ),
    ).toMatchObject({ ready: false, issues: ["token_expired"], needsReconnect: true });
    expect(
      getInstagramConnectionReadiness({ ...readyConnection, token_expires_at: null }, now),
    ).toMatchObject({ ready: false, issues: ["token_expiry_unknown"], needsReconnect: true });
  });

  it("requires a recheck when Meta verification is stale", () => {
    expect(
      getInstagramConnectionReadiness(
        { ...readyConnection, last_verified_at: "2026-07-29T07:59:59.000Z" },
        now,
      ),
    ).toMatchObject({ ready: false, issues: ["verification_stale"], needsReconnect: false });
  });
});

describe("Instagram Auto-DM webhook parsing", () => {
  it("normalizes comment and inbound message events while ignoring echoes", () => {
    const result = parseInstagramWebhook({
      object: "instagram",
      entry: [
        {
          id: "ig-account-1",
          time: 1_750_000_000,
          changes: [
            {
              field: "comments",
              value: {
                id: "comment-1",
                text: "GUIDE please",
                from: { id: "person-1", username: "maya" },
                media: { id: "media-1" },
              },
            },
          ],
          messaging: [
            {
              sender: { id: "person-2" },
              recipient: { id: "ig-account-1" },
              timestamp: 1_750_000_001_000,
              message: { mid: "message-1", text: "price" },
            },
            {
              sender: { id: "ig-account-1" },
              recipient: { id: "person-2" },
              message: { mid: "message-2", text: "echo", is_echo: true },
            },
          ],
        },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      externalEventId: "comment:comment-1",
      eventType: "comment",
      eventContext: "comment",
      mediaId: "media-1",
      senderUsername: "maya",
    });
    expect(result[1]).toMatchObject({
      externalEventId: "message:message-1",
      eventType: "message",
      eventContext: "dm",
      senderId: "person-2",
    });
  });

  it("normalizes Meta's current messages change payload", () => {
    const result = parseInstagramWebhook({
      object: "instagram",
      entry: [
        {
          id: "0",
          time: 1_750_000_000,
          changes: [
            {
              field: "messages",
              value: {
                sender: { id: "person-3" },
                recipient: { id: "ig-account-2" },
                timestamp: "1750000001000",
                message: { mid: "message-3", text: "send the guide" },
              },
            },
          ],
        },
      ],
    });

    expect(result).toEqual([
      expect.objectContaining({
        externalEventId: "message:message-3",
        instagramAccountId: "ig-account-2",
        eventType: "message",
        senderId: "person-3",
        text: "send the guide",
      }),
    ]);
  });

  it("ignores outbound Instagram echoes even when Meta omits is_echo", () => {
    const result = parseInstagramWebhook({
      object: "instagram",
      entry: [
        {
          id: "ig-account-1",
          messaging: [
            {
              sender: { id: "ig-account-1" },
              recipient: { id: "person-1" },
              timestamp: 1_750_000_001_000,
              message: { mid: "outbound-message-1", text: "Here is your suggested reply" },
            },
          ],
        },
      ],
    });

    expect(result).toEqual([]);
  });

  it("classifies story replies, shared posts, quick replies, and Live comments", () => {
    const result = parseInstagramWebhook({
      object: "instagram",
      entry: [
        {
          id: "ig-account-1",
          changes: [
            {
              field: "live_comments",
              value: {
                id: "live-comment-1",
                text: "guide",
                from: { id: "person-live" },
                media: { id: "live-1" },
              },
            },
          ],
          messaging: [
            {
              sender: { id: "person-story" },
              recipient: { id: "ig-account-1" },
              message: {
                mid: "story-message",
                text: "send it",
                reply_to: { story: { id: "story-1", url: "https://instagram.com/stories/1" } },
              },
            },
            {
              sender: { id: "person-share" },
              recipient: { id: "ig-account-1" },
              message: {
                mid: "share-message",
                attachments: [
                  { type: "share", payload: { url: "https://www.instagram.com/p/post-1/" } },
                ],
              },
            },
            {
              sender: { id: "person-tap" },
              recipient: { id: "ig-account-1" },
              message: {
                mid: "quick-message",
                text: "Send it",
                quick_reply: { payload: "bento:auto:automation-id" },
              },
            },
          ],
        },
      ],
    });

    expect(result.map((event) => event.eventContext)).toEqual([
      "live_comment",
      "story_reply",
      "post_share",
      "quick_reply",
    ]);
    expect(result[1].mediaId).toBe("story-1");
    expect(result[2].mediaId).toBe("https://www.instagram.com/p/post-1/");
    expect(result[3].actionPayload).toBe("bento:auto:automation-id");
  });
});

describe("Instagram Auto-DM keyword matching", () => {
  const rules = [
    {
      id: "one",
      trigger_type: "comment_keyword" as const,
      keywords: ["guide"],
      excluded_keywords: ["spam"],
      match_type: "contains" as const,
      media_scope: "specific" as const,
      media_ids: ["media-1"],
    },
    {
      id: "two",
      trigger_type: "dm_keyword" as const,
      keywords: ["PRICE"],
      excluded_keywords: [],
      match_type: "exact" as const,
      media_scope: "any" as const,
      media_ids: [],
    },
  ];

  it("matches case-insensitively and respects media selection", () => {
    expect(
      matchInstagramAutomation(
        {
          eventType: "comment",
          eventContext: "comment",
          text: "Send the GUIDE",
          mediaId: "media-1",
        },
        rules,
      )?.matchedKeyword,
    ).toBe("guide");
    expect(
      matchInstagramAutomation(
        {
          eventType: "comment",
          eventContext: "comment",
          text: "guide",
          mediaId: "another-post",
        },
        rules,
      ),
    ).toBeNull();
  });

  it("supports exact inbound-DM keywords", () => {
    expect(
      matchInstagramAutomation(
        { eventType: "message", eventContext: "dm", text: " price ", mediaId: null },
        rules,
      )?.automation.id,
    ).toBe("two");
  });

  it("honors excluded keywords before a positive match", () => {
    expect(
      matchInstagramAutomation(
        {
          eventType: "comment",
          eventContext: "comment",
          text: "guide spam",
          mediaId: "media-1",
        },
        rules,
      ),
    ).toBeNull();
  });

  it("matches story replies without mixing them with ordinary DMs", () => {
    const storyRule = {
      id: "story",
      trigger_type: "any_story_reply" as const,
      keywords: [],
      excluded_keywords: [],
      match_type: "contains" as const,
      media_scope: "any" as const,
      media_ids: [],
    };
    expect(
      matchInstagramAutomation(
        { eventType: "message", eventContext: "story_reply", text: "🔥", mediaId: "story-1" },
        [storyRule],
      )?.automation.id,
    ).toBe("story");
    expect(
      matchInstagramAutomation(
        { eventType: "message", eventContext: "dm", text: "🔥", mediaId: null },
        [storyRule],
      ),
    ).toBeNull();
  });

  it("dry-runs a saved rule through the production matcher without requiring Meta", () => {
    const result = testInstagramAutomation(
      {
        id: "dry-run",
        triggerType: "comment_keyword",
        keywords: ["guide"],
        excludedKeywords: ["spam"],
        matchType: "contains",
        mediaScope: "specific",
        mediaIds: ["media-1"],
      },
      "Please send the guide",
    );

    expect(result).toEqual({
      matches: true,
      eventType: "comment",
      eventContext: "comment",
      matchedKeyword: "guide",
    });
  });

  it("shows a non-match when dry-run text contains an excluded keyword", () => {
    expect(
      testInstagramAutomation(
        {
          id: "dry-run",
          triggerType: "dm_keyword",
          keywords: ["price"],
          excludedKeywords: ["spam"],
          matchType: "contains",
          mediaScope: "any",
          mediaIds: [],
        },
        "price spam",
      ).matches,
    ).toBe(false);
  });
});
