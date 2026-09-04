import { describe, expect, it } from "vitest";
import {
  extractFacebookEmailAddress,
  getFacebookConnectionReadiness,
  facebookConnectionReadinessMessage,
  matchFacebookAutomation,
  parseFacebookWebhook,
  testFacebookAutomation,
} from "./facebook-auto-dm";

describe("Facebook Auto-DM email capture", () => {
  it("accepts only a complete normalized email reply", () => {
    expect(extractFacebookEmailAddress(" Hello.Creator+guide@Example.COM ")).toBe(
      "hello.creator+guide@example.com",
    );
    expect(extractFacebookEmailAddress("Please send it to creator@example.com")).toBeNull();
    expect(extractFacebookEmailAddress("creator@example")).toBeNull();
  });
});

describe("Facebook connection readiness", () => {
  const now = new Date("2026-08-14T08:00:00.000Z");
  const readyConnection = {
    status: "active",
    connection_health: "healthy",
    reauth_required: false,
    scopes: [
      "pages_show_list",
      "pages_read_user_content",
      "pages_read_engagement",
      "pages_manage_metadata",
      "pages_manage_engagement",
      "pages_messaging",
    ],
    webhook_fields: ["feed", "messages", "messaging_postbacks"],
    token_expires_at: null,
    last_verified_at: "2026-08-13T08:00:00.000Z",
  };

  it("treats a never-expiring Page token as ready when health and webhooks are verified", () => {
    expect(getFacebookConnectionReadiness(readyConnection, now)).toEqual({
      ready: true,
      issues: [],
      needsReconnect: false,
    });
  });

  it("does not call a Page ready when webhook subscriptions are incomplete", () => {
    const readiness = getFacebookConnectionReadiness(
      { ...readyConnection, webhook_fields: ["feed", "messages"] },
      now,
    );
    expect(readiness).toMatchObject({
      ready: false,
      issues: ["missing_webhook_subscription"],
      needsReconnect: false,
    });
    expect(facebookConnectionReadinessMessage(readiness.issues)).toContain("webhook");
  });

  it("requires reconnection for missing Messenger scopes", () => {
    expect(
      getFacebookConnectionReadiness({ ...readyConnection, scopes: ["pages_show_list"] }, now),
    ).toMatchObject({ ready: false, issues: ["missing_scope"], needsReconnect: true });
  });

  it("requires reconnection when user-content access was not granted", () => {
    expect(
      getFacebookConnectionReadiness(
        {
          ...readyConnection,
          scopes: readyConnection.scopes.filter((scope) => scope !== "pages_read_user_content"),
        },
        now,
      ),
    ).toMatchObject({ ready: false, issues: ["missing_scope"], needsReconnect: true });
  });
});

describe("Facebook Auto-DM webhook parsing", () => {
  it("normalizes Page comments and inbound Messenger events while ignoring echoes", () => {
    const result = parseFacebookWebhook({
      object: "page",
      entry: [
        {
          id: "page-1",
          time: 1_750_000_000,
          changes: [
            {
              field: "feed",
              value: {
                item: "comment",
                verb: "add",
                comment_id: "comment-1",
                post_id: "page-1_post-1",
                message: "GUIDE please",
                from: { id: "person-1", name: "Maya" },
              },
            },
            {
              field: "feed",
              value: {
                item: "comment",
                verb: "add",
                comment_id: "comment-self",
                post_id: "page-1_post-1",
                message: "Thanks",
                from: { id: "page-1", name: "Page" },
              },
            },
          ],
          messaging: [
            {
              sender: { id: "person-2" },
              recipient: { id: "page-1" },
              timestamp: 1_750_000_001_000,
              message: { mid: "message-1", text: "price" },
            },
            {
              sender: { id: "page-1" },
              recipient: { id: "person-2" },
              message: { mid: "message-2", text: "echo", is_echo: true },
            },
            {
              sender: { id: "person-3" },
              recipient: { id: "page-1" },
              timestamp: 1_750_000_002_000,
              postback: { payload: "bento:fb-run:run-1:abc", title: "Send it" },
            },
          ],
        },
      ],
    });

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      externalEventId: "comment:comment-1",
      eventType: "comment",
      eventContext: "comment",
      mediaId: "page-1_post-1",
      senderUsername: "Maya",
    });
    expect(result[1]).toMatchObject({
      externalEventId: "message:message-1",
      eventType: "message",
      eventContext: "dm",
      senderId: "person-2",
    });
    expect(result[2]).toMatchObject({
      eventContext: "quick_reply",
      actionPayload: "bento:fb-run:run-1:abc",
    });
  });
});

describe("Facebook Auto-DM keyword matching", () => {
  const rules = [
    {
      id: "one",
      trigger_type: "comment_keyword" as const,
      keywords: ["guide"],
      excluded_keywords: ["spam"],
      match_type: "contains" as const,
      media_scope: "specific" as const,
      media_ids: ["page-1_post-1"],
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
      matchFacebookAutomation(
        {
          eventType: "comment",
          eventContext: "comment",
          text: "Send the GUIDE",
          mediaId: "page-1_post-1",
        },
        rules,
      )?.matchedKeyword,
    ).toBe("guide");
    expect(
      matchFacebookAutomation(
        {
          eventType: "comment",
          eventContext: "comment",
          text: "guide",
          mediaId: "another-post",
        },
        rules,
      ),
    ).toBeNull();
    expect(
      matchFacebookAutomation(
        {
          eventType: "message",
          eventContext: "dm",
          text: "price",
          mediaId: null,
        },
        rules,
      )?.matchedKeyword,
    ).toBe("PRICE");
  });

  it("dry-runs a saved automation without calling Meta", () => {
    expect(
      testFacebookAutomation(
        {
          id: "one",
          triggerType: "comment_keyword",
          keywords: ["guide"],
          excludedKeywords: [],
          matchType: "contains",
          mediaScope: "any",
          mediaIds: [],
        },
        "Need the GUIDE",
      ),
    ).toMatchObject({ matches: true, eventContext: "comment", matchedKeyword: "guide" });
  });
});
