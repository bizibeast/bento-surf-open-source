import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleTwitterWebhook,
  handleTwitterWebhookCrc,
  twitterRequestFailed,
  twitterWebhookCrcResponse,
  verifyTwitterWebhookSignature,
} from "./twitter-auto-dm.server";

const SECRET = "test-x-client-secret";

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
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `sha256=${btoa(binary)}`;
}

describe("X Auto-DM webhook security", () => {
  it("answers the CRC challenge with an HMAC of the token", async () => {
    vi.stubEnv("X_CLIENT_SECRET", SECRET);
    const crc = await handleTwitterWebhookCrc(
      new Request("https://bento.surf/api/webhooks/twitter?crc_token=challenge-token"),
    );
    const rejected = await handleTwitterWebhookCrc(
      new Request("https://bento.surf/api/webhooks/twitter"),
    );
    const expected = await twitterWebhookCrcResponse("challenge-token");

    expect(crc.status).toBe(200);
    expect(await crc.json()).toEqual(expected);
    expect(expected.response_token.startsWith("sha256=")).toBe(true);
    expect(rejected.status).toBe(403);
  });

  it("prefers the OAuth 1.0a consumer secret for CRC and webhook signatures", async () => {
    const consumerSecret = "test-x-consumer-secret";
    vi.stubEnv("X_CLIENT_SECRET", SECRET);
    vi.stubEnv("X_CONSUMER_SECRET", consumerSecret);
    const crc = await twitterWebhookCrcResponse("challenge-token");
    const body = JSON.stringify({ for_user_id: "1" });

    expect(crc.response_token).toBe(await signature("challenge-token", consumerSecret));
    await expect(
      verifyTwitterWebhookSignature(body, await signature(body, consumerSecret)),
    ).resolves.toBe(true);
    await expect(verifyTwitterWebhookSignature(body, await signature(body))).resolves.toBe(false);
  });

  it("rejects unsigned bodies and accepts the exact signed body", async () => {
    vi.stubEnv("X_CLIENT_SECRET", SECRET);
    const body = JSON.stringify({ for_user_id: "1", direct_message_events: [] });
    const valid = await signature(body);

    await expect(verifyTwitterWebhookSignature(body, valid)).resolves.toBe(true);
    await expect(verifyTwitterWebhookSignature(`${body} `, valid)).resolves.toBe(false);
    await expect(verifyTwitterWebhookSignature(body, "sha256=00")).resolves.toBe(false);
  });

  it("queues each normalized event only after signature verification", async () => {
    vi.stubEnv("X_CLIENT_SECRET", SECRET);
    const body = JSON.stringify({
      for_user_id: "creator-1",
      users: { "sender-1": { screen_name: "alice" } },
      direct_message_events: [
        {
          type: "message_create",
          id: "dm-1",
          created_timestamp: String(Date.parse("2026-08-13T08:00:00.000Z")),
          message_create: {
            sender_id: "sender-1",
            target: { recipient_id: "creator-1" },
            message_data: { text: "info" },
          },
        },
      ],
    });
    const sent: unknown[] = [];
    const response = await handleTwitterWebhook(
      new Request("https://bento.surf/api/webhooks/twitter", {
        method: "POST",
        headers: { "x-twitter-webhooks-signature": await signature(body) },
        body,
      }),
      {
        sendBatch: async (messages: Array<{ body: unknown }>) => {
          sent.push(...messages.map((message) => message.body));
        },
      } as never,
    );

    expect(response.status).toBe(200);
    expect(sent).toEqual([
      {
        kind: "twitter_dm_event",
        event: expect.objectContaining({
          externalEventId: "dm:dm-1",
          twitterUserId: "creator-1",
          text: "info",
        }),
      },
    ]);
  });
});

describe("twitterRequestFailed", () => {
  it("treats HTTP 200 with an empty errors array as success", () => {
    expect(twitterRequestFailed(200, { data: [], errors: [] })).toBe(false);
    expect(twitterRequestFailed(200, { data: { id: "1" } })).toBe(false);
  });

  it("treats HTTP errors and non-empty X error payloads as failure", () => {
    expect(twitterRequestFailed(403, { errors: [] })).toBe(true);
    expect(twitterRequestFailed(200, { errors: [{ message: "forbidden" }] })).toBe(true);
    expect(twitterRequestFailed(402, { title: "Payment Required" })).toBe(true);
  });
});
