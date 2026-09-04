import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInstagramRunActionPayload,
  getInstagramAccountBackoffSeconds,
  getInstagramAccountWebhookFields,
  getInstagramAutoDmPolicyWindowFailure,
  getInstagramDmRetryDelaySeconds,
  handleInstagramWebhook,
  handleInstagramWebhookVerification,
  isRetryableMetaResponse,
  parseMetaRetryAfterSeconds,
  MetaDeliveryError,
  readInstagramRunActionPayload,
  refreshInstagramLongLivedToken,
  shouldFailInstagramRunAfterError,
  subscribeInstagramAccountWebhooks,
  unsubscribeInstagramAccountWebhooks,
  verifyInstagramWebhookSignature,
  type InstagramDmQueueMessage,
} from "./instagram-auto-dm.server";
import { extractInstagramEmailAddress, parseInstagramWebhook } from "./instagram-auto-dm";

const SECRET = "test-instagram-app-secret";
const VERIFY_TOKEN = "test-instagram-webhook-token";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function signature(body: string, secret = SECRET) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  return `sha256=${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

describe("Instagram Auto-DM webhook security", () => {
  it("verifies the Meta challenge with the configured token", async () => {
    vi.stubEnv("INSTAGRAM_WEBHOOK_VERIFY_TOKEN", VERIFY_TOKEN);
    const accepted = await handleInstagramWebhookVerification(
      new Request(
        `https://bento.surf/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=hello-meta`,
      ),
    );
    const rejected = await handleInstagramWebhookVerification(
      new Request(
        "https://bento.surf/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=hello-meta",
      ),
    );

    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe("hello-meta");
    expect(rejected.status).toBe(403);
  });

  it("rejects unsigned bodies and accepts the exact signed body", async () => {
    vi.stubEnv("META_INSTAGRAM_APP_SECRET", SECRET);
    const body = JSON.stringify({ object: "instagram", entry: [] });
    const valid = await signature(body);

    await expect(verifyInstagramWebhookSignature(body, valid)).resolves.toBe(true);
    await expect(verifyInstagramWebhookSignature(`${body} `, valid)).resolves.toBe(false);
    await expect(verifyInstagramWebhookSignature(body, "sha256=00")).resolves.toBe(false);
  });

  it("accepts signatures from the parent Meta app without weakening validation", async () => {
    const parentSecret = "test-parent-meta-app-secret";
    vi.stubEnv("META_INSTAGRAM_APP_SECRET", SECRET);
    vi.stubEnv("META_FACEBOOK_APP_SECRET", parentSecret);
    const body = JSON.stringify({ object: "instagram", entry: [] });

    await expect(
      verifyInstagramWebhookSignature(body, await signature(body, parentSecret)),
    ).resolves.toBe(true);
    await expect(
      verifyInstagramWebhookSignature(`${body} `, await signature(body, parentSecret)),
    ).resolves.toBe(false);
    await expect(
      verifyInstagramWebhookSignature(body, await signature(body, "unconfigured-secret")),
    ).resolves.toBe(false);
  });

  it("queues each normalized event only after signature verification", async () => {
    vi.stubEnv("META_INSTAGRAM_APP_SECRET", SECRET);
    const body = JSON.stringify({
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
                text: "guide",
                from: { id: "person-1", username: "maya" },
                media: { id: "media-1" },
              },
            },
          ],
        },
      ],
    });
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const request = new Request("https://bento.surf/api/webhooks/instagram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": await signature(body),
      },
      body,
    });

    const response = await handleInstagramWebhook(request, {
      sendBatch,
    } as unknown as Queue<InstagramDmQueueMessage>);

    expect(response.status).toBe(200);
    expect(sendBatch).toHaveBeenCalledOnce();
    expect(sendBatch.mock.calls[0][0][0].body).toMatchObject({
      kind: "instagram_dm_event",
      event: { externalEventId: "comment:comment-1", text: "guide" },
    });
  });

  it("splits a large signed Meta delivery into Cloudflare-safe queue batches", async () => {
    vi.stubEnv("META_INSTAGRAM_APP_SECRET", SECRET);
    const body = JSON.stringify({
      object: "instagram",
      entry: Array.from({ length: 2 }, (_, entryIndex) => ({
        id: `ig-account-${entryIndex + 1}`,
        time: 1_750_000_000,
        changes: Array.from({ length: 100 }, (_, commentIndex) => ({
          field: "comments",
          value: {
            id: `comment-${entryIndex}-${commentIndex}`,
            text: "guide",
            from: { id: `person-${entryIndex}-${commentIndex}`, username: "maya" },
            media: { id: `media-${entryIndex}` },
          },
        })),
      })),
    });
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const request = new Request("https://bento.surf/api/webhooks/instagram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": await signature(body),
      },
      body,
    });

    const response = await handleInstagramWebhook(request, {
      sendBatch,
    } as unknown as Queue<InstagramDmQueueMessage>);

    expect(response.status).toBe(200);
    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(sendBatch.mock.calls[0][0]).toHaveLength(100);
    expect(sendBatch.mock.calls[1][0]).toHaveLength(100);
  });

  it("binds confirmation actions to one workflow, connection and sender", async () => {
    vi.stubEnv("META_INSTAGRAM_APP_SECRET", SECRET);
    const runId = "76840dd1-4f90-4de2-a250-91c8239ceda1";
    const connectionId = "11b4b683-51fa-4faf-b742-50df7682ad71";
    const senderIdHash = "a".repeat(32);
    const payload = await createInstagramRunActionPayload(runId, connectionId, senderIdHash);

    await expect(readInstagramRunActionPayload(payload, connectionId, senderIdHash)).resolves.toBe(
      runId,
    );
    await expect(
      readInstagramRunActionPayload(payload, connectionId, "b".repeat(32)),
    ).resolves.toBeNull();
    await expect(
      readInstagramRunActionPayload(payload, "23a5019f-cbcd-44f0-b663-a25c9f41b3e7", senderIdHash),
    ).resolves.toBeNull();
    const tampered = `${payload.slice(0, -1)}${payload.endsWith("0") ? "1" : "0"}`;
    await expect(
      readInstagramRunActionPayload(tampered, connectionId, senderIdHash),
    ).resolves.toBeNull();

    const followPayload = await createInstagramRunActionPayload(
      runId,
      connectionId,
      senderIdHash,
      "follow_recheck",
    );
    await expect(
      readInstagramRunActionPayload(followPayload, connectionId, senderIdHash, "follow_recheck"),
    ).resolves.toBe(runId);
    await expect(
      readInstagramRunActionPayload(followPayload, connectionId, senderIdHash, "confirm"),
    ).resolves.toBeNull();
  });
});

describe("Instagram Auto-DM Meta policy windows", () => {
  const baseEvent = {
    externalEventId: "comment:comment-1",
    instagramAccountId: "ig-account",
    eventType: "comment" as const,
    eventContext: "comment" as const,
    sourceId: "comment-1",
    senderId: "person-1",
    senderUsername: "maya",
    mediaId: "media-1",
    text: "guide",
    actionPayload: null,
    occurredAt: "2026-07-30T00:00:00.000Z",
  };

  it("allows fresh private replies and rejects comments older than seven days", () => {
    expect(
      getInstagramAutoDmPolicyWindowFailure(baseEvent, Date.parse("2026-08-06T00:00:00.000Z")),
    ).toBeNull();
    expect(
      getInstagramAutoDmPolicyWindowFailure(baseEvent, Date.parse("2026-08-06T00:00:00.001Z")),
    ).toMatchObject({ code: "private_reply_window_expired" });
  });

  it("rejects conversation replies older than 24 hours", () => {
    const messageEvent = {
      ...baseEvent,
      externalEventId: "message:dm-1",
      eventType: "message" as const,
      eventContext: "dm" as const,
      sourceId: "dm-1",
    };
    expect(
      getInstagramAutoDmPolicyWindowFailure(messageEvent, Date.parse("2026-07-31T00:00:00.001Z")),
    ).toMatchObject({ code: "conversation_window_expired" });
  });

  it("does not guess whether an Instagram Live broadcast is still active", () => {
    expect(
      getInstagramAutoDmPolicyWindowFailure(
        { ...baseEvent, eventContext: "live_comment" },
        Date.parse("2026-08-20T00:00:00.000Z"),
      ),
    ).toBeNull();
  });
});

describe("Instagram Auto-DM provider subscription health", () => {
  it("honors provider retry guidance without shortening exponential backoff", () => {
    expect(parseMetaRetryAfterSeconds("90")).toBe(90);
    expect(
      parseMetaRetryAfterSeconds(
        "Thu, 31 Jul 2026 12:02:00 GMT",
        Date.parse("2026-07-31T12:00:00Z"),
      ),
    ).toBe(120);
    expect(parseMetaRetryAfterSeconds("invalid")).toBeUndefined();
    expect(
      getInstagramDmRetryDelaySeconds(new MetaDeliveryError("Rate limited", "4", true, 300), 1),
    ).toBe(300);
    expect(
      getInstagramDmRetryDelaySeconds(new MetaDeliveryError("Temporary failure", "2", true, 5), 3),
    ).toBe(120);
    expect(
      getInstagramDmRetryDelaySeconds(
        new MetaDeliveryError("Account is paced", "account_paced", true, 1),
        3,
      ),
    ).toBe(1);
    expect(getInstagramDmRetryDelaySeconds(new Error("Network failure"), 9)).toBe(3_600);
  });

  it("shares only provider-directed or rate-limit backoff across an account", () => {
    expect(
      getInstagramAccountBackoffSeconds(new MetaDeliveryError("Rate limited", "4", true)),
    ).toBe(60);
    expect(
      getInstagramAccountBackoffSeconds(new MetaDeliveryError("Retry later", "2", true, 90)),
    ).toBe(90);
    expect(
      getInstagramAccountBackoffSeconds(
        new MetaDeliveryError("Account is paced", "account_paced", true, 1),
      ),
    ).toBeUndefined();
    expect(
      getInstagramAccountBackoffSeconds(new MetaDeliveryError("Rejected", "10", false)),
    ).toBeUndefined();
  });

  it("retries transport failures and provider-declared transient Graph errors", () => {
    expect(isRetryableMetaResponse(429, {})).toBe(true);
    expect(isRetryableMetaResponse(503, {})).toBe(true);
    expect(
      isRetryableMetaResponse(400, {
        error: { code: 2, is_transient: true },
      }),
    ).toBe(true);
    expect(
      isRetryableMetaResponse(400, {
        error: { code: 190, is_transient: false },
      }),
    ).toBe(false);
  });

  it("closes workflow runs only when the current step cannot be retried safely", () => {
    expect(
      shouldFailInstagramRunAfterError(
        "opening",
        new MetaDeliveryError("Temporary provider failure", "2", true),
      ),
    ).toBe(false);
    expect(
      shouldFailInstagramRunAfterError(
        "opening",
        new MetaDeliveryError("Recipient is unavailable", "10", false),
      ),
    ).toBe(true);
    expect(
      shouldFailInstagramRunAfterError(
        "confirmation_prompt",
        new MetaDeliveryError("Temporary provider failure", "2", true),
      ),
    ).toBe(true);
    expect(shouldFailInstagramRunAfterError("confirmation", new Error("Delivery failed"))).toBe(
      true,
    );
    expect(shouldFailInstagramRunAfterError("email", new Error("Delivery failed"))).toBe(true);
    expect(shouldFailInstagramRunAfterError(null, new Error("Delivery failed"))).toBe(false);
  });

  it("reads back and normalizes subscribed fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "app-id",
              subscribed_fields: [
                "messages",
                "comments",
                "messages",
                "messaging_postbacks",
                "live_comments",
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await expect(getInstagramAccountWebhookFields("ig-account", "token")).resolves.toEqual([
      "comments",
      "live_comments",
      "messages",
      "messaging_postbacks",
    ]);
  });

  it("does not report a connection ready until POST is confirmed by GET", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "app-id", subscribed_fields: ["comments", "messages"] }],
          }),
          { status: 200 },
        ),
      );

    await expect(subscribeInstagramAccountWebhooks("ig-account", "token")).rejects.toThrow(
      "did not confirm the required webhook fields",
    );
  });

  it("unsubscribes the provider account during disconnect", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));

    await expect(unsubscribeInstagramAccountWebhooks("ig-account", "token")).resolves.toEqual({
      ok: true,
    });
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("refreshes a long-lived token without leaking it into headers", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "fresh-token",
          token_type: "bearer",
          expires_in: 5_184_000,
        }),
        { status: 200 },
      ),
    );

    await expect(refreshInstagramLongLivedToken("old-token")).resolves.toEqual({
      accessToken: "fresh-token",
      expiresIn: 5_184_000,
    });
    const [url, init] = request.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/refresh_access_token");
    expect(url.searchParams.get("grant_type")).toBe("ig_refresh_token");
    expect(url.searchParams.get("access_token")).toBe("old-token");
    expect(init.headers).not.toMatchObject({ Authorization: expect.any(String) });
  });
});

describe("Instagram Auto-DM email capture", () => {
  it("accepts only a complete normalized email reply", () => {
    expect(extractInstagramEmailAddress(" Hello.Creator+guide@Example.COM ")).toBe(
      "hello.creator+guide@example.com",
    );
    expect(extractInstagramEmailAddress("Please send it to creator@example.com")).toBeNull();
    expect(extractInstagramEmailAddress("my address is creator@example")).toBeNull();
    expect(extractInstagramEmailAddress("there is no address here")).toBeNull();
  });
});

describe("Instagram Auto-DM official webhook payloads", () => {
  it("normalizes comments, live comments, DMs, story replies, post shares and quick replies", () => {
    const events = parseInstagramWebhook({
      object: "instagram",
      entry: [
        {
          id: "ig-account",
          time: 1_750_000_000_000,
          changes: [
            {
              field: "comments",
              value: {
                id: "comment-1",
                text: "guide",
                from: { id: "person-1", username: "maya" },
                media: { id: "media-1" },
              },
            },
            {
              field: "live_comments",
              value: {
                id: "live-comment-1",
                text: "send it",
                from: { id: "person-2", username: "sam" },
                media: { id: "live-1" },
              },
            },
            {
              field: "messages",
              value: {
                sender: { id: "person-3" },
                recipient: { id: "ig-account" },
                timestamp: 1_750_000_000_001,
                message: { mid: "dm-1", text: "hello" },
              },
            },
          ],
          messaging: [
            {
              sender: { id: "person-4" },
              recipient: { id: "ig-account" },
              timestamp: 1_750_000_000_002,
              message: {
                mid: "story-1",
                text: "love this",
                reply_to: { story: { id: "story-media-1", url: "https://example.com/story" } },
              },
            },
            {
              sender: { id: "person-5" },
              recipient: { id: "ig-account" },
              timestamp: 1_750_000_000_003,
              message: {
                mid: "share-1",
                attachments: [{ type: "share", payload: { id: "shared-media-1" } }],
              },
            },
            {
              sender: { id: "person-6" },
              recipient: { id: "ig-account" },
              timestamp: 1_750_000_000_004,
              message: {
                mid: "quick-reply-1",
                text: "Send it",
                quick_reply: { payload: `bento:run:${crypto.randomUUID()}:${"a".repeat(32)}` },
              },
            },
            {
              sender: { id: "ig-account" },
              recipient: { id: "person-7" },
              message: { mid: "echo-1", text: "ignore me", is_echo: true },
            },
          ],
        },
      ],
    });

    expect(events.map(({ eventContext }) => eventContext)).toEqual([
      "comment",
      "live_comment",
      "dm",
      "story_reply",
      "post_share",
      "quick_reply",
    ]);
    expect(events[0]).toMatchObject({
      instagramAccountId: "ig-account",
      senderId: "person-1",
      mediaId: "media-1",
    });
    expect(events[3]).toMatchObject({ mediaId: "story-media-1", senderId: "person-4" });
    expect(events[4]).toMatchObject({ mediaId: "shared-media-1", senderId: "person-5" });
    expect(events.some(({ sourceId }) => sourceId === "echo-1")).toBe(false);
  });
});
