import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      update: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(async () => ({ error: null })),
        })),
      })),
    })),
  },
}));

import {
  createFacebookRunActionPayload,
  getFacebookAutoDmPolicyWindowFailure,
  handleFacebookWebhook,
  handleFacebookWebhookVerification,
  readFacebookRunActionPayload,
  verifyFacebookWebhookSignature,
  type FacebookDmQueueMessage,
} from "./facebook-auto-dm.server";

const SECRET = "test-facebook-app-secret";
const VERIFY_TOKEN = "test-facebook-webhook-token";

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

describe("Facebook Auto-DM webhook security", () => {
  it("verifies the Meta challenge with the configured token", async () => {
    vi.stubEnv("FACEBOOK_WEBHOOK_VERIFY_TOKEN", VERIFY_TOKEN);
    const accepted = await handleFacebookWebhookVerification(
      new Request(
        `https://bento.surf/api/webhooks/facebook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=hello-meta`,
      ),
    );
    const rejected = await handleFacebookWebhookVerification(
      new Request(
        "https://bento.surf/api/webhooks/facebook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=hello-meta",
      ),
    );

    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe("hello-meta");
    expect(rejected.status).toBe(403);
  });

  it("rejects unsigned bodies and accepts the exact signed body", async () => {
    vi.stubEnv("META_FACEBOOK_APP_SECRET", SECRET);
    const body = JSON.stringify({ object: "page", entry: [] });
    const valid = await signature(body);

    await expect(verifyFacebookWebhookSignature(body, valid)).resolves.toBe(true);
    await expect(verifyFacebookWebhookSignature(`${body} `, valid)).resolves.toBe(false);
    await expect(verifyFacebookWebhookSignature(body, "sha256=00")).resolves.toBe(false);
  });

  it("enqueues parsed Page events in 100-message batches", async () => {
    vi.stubEnv("META_FACEBOOK_APP_SECRET", SECRET);
    const body = JSON.stringify({
      object: "page",
      entry: Array.from({ length: 2 }, (_, entryIndex) => ({
        id: `page-${entryIndex + 1}`,
        time: 1_750_000_000,
        messaging: Array.from({ length: 100 }, (_, index) => ({
          sender: { id: `person-${entryIndex}-${index}` },
          recipient: { id: `page-${entryIndex + 1}` },
          timestamp: 1_750_000_000_000 + entryIndex * 100 + index,
          message: { mid: `message-${entryIndex}-${index}`, text: "info" },
        })),
      })),
    });
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const response = await handleFacebookWebhook(
      new Request("https://bento.surf/api/webhooks/facebook", {
        method: "POST",
        headers: { "x-hub-signature-256": await signature(body) },
        body,
      }),
      { sendBatch } as unknown as Queue<FacebookDmQueueMessage>,
    );

    expect(response.status).toBe(200);
    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(sendBatch.mock.calls[0][0]).toHaveLength(100);
    expect(sendBatch.mock.calls[1][0]).toHaveLength(100);
  });

  it("binds confirmation actions to one workflow, connection and sender", async () => {
    vi.stubEnv("META_FACEBOOK_APP_SECRET", SECRET);
    const runId = "76840dd1-4f90-4de2-a250-91c8239ceda1";
    const connectionId = "11b4b683-51fa-4faf-b742-50df7682ad71";
    const senderIdHash = "a".repeat(32);
    const payload = await createFacebookRunActionPayload(runId, connectionId, senderIdHash);

    await expect(readFacebookRunActionPayload(payload, connectionId, senderIdHash)).resolves.toBe(
      runId,
    );
    await expect(
      readFacebookRunActionPayload(payload, connectionId, "b".repeat(32)),
    ).resolves.toBeNull();
  });
});

describe("Facebook Auto-DM Meta policy windows", () => {
  const baseEvent = {
    externalEventId: "comment:comment-1",
    facebookPageId: "page-1",
    eventType: "comment" as const,
    eventContext: "comment" as const,
    sourceId: "comment-1",
    senderId: "person-1",
    senderUsername: "Maya",
    mediaId: "page-1_post-1",
    text: "guide",
    actionPayload: null,
    occurredAt: "2026-07-30T00:00:00.000Z",
  };

  it("allows fresh private replies and rejects comments older than seven days", () => {
    expect(
      getFacebookAutoDmPolicyWindowFailure(baseEvent, Date.parse("2026-08-06T00:00:00.000Z")),
    ).toBeNull();
    expect(
      getFacebookAutoDmPolicyWindowFailure(baseEvent, Date.parse("2026-08-06T00:00:00.001Z")),
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
      getFacebookAutoDmPolicyWindowFailure(messageEvent, Date.parse("2026-07-31T00:00:00.001Z")),
    ).toMatchObject({ code: "conversation_window_expired" });
  });
});
