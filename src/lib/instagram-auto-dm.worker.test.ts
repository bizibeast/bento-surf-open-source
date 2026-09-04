import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstagramWebhookEvent } from "./instagram-auto-dm";

const mocks = vi.hoisted(() => ({
  shouldProcess: true,
  connections: [] as Array<Record<string, unknown>>,
  automations: [] as Array<Record<string, unknown>>,
  runs: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ table: string; id: string; values: Record<string, unknown> }>,
  rpc: vi.fn(),
  getPlan: vi.fn(),
  decryptServerSecret: vi.fn(),
  captureServerEvent: vi.fn(),
  captureServerException: vi.fn(),
  fetch: vi.fn(),
}));

function selectChain(data: unknown[]) {
  const chain: Record<string, unknown> & PromiseLike<{ data: unknown[]; error: null }> = {
    then(onfulfilled, onrejected) {
      return Promise.resolve({ data, error: null }).then(onfulfilled, onrejected);
    },
    maybeSingle: vi.fn(async () => ({ data: data[0] || null, error: null })),
  };
  for (const method of ["eq", "in", "gt", "order", "limit"]) {
    chain[method] = vi.fn(() => chain);
  }
  return chain;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: mocks.rpc,
    from: vi.fn((table: string) => ({
      select: vi.fn(() =>
        selectChain(
          table === "social_connections"
            ? mocks.connections
            : table === "instagram_dm_automations"
              ? mocks.automations
              : table === "instagram_dm_runs"
                ? mocks.runs.length
                  ? mocks.runs
                  : [
                      {
                        follow_gate_enabled: false,
                        follow_prompt_message: "Follow this account, then tap I’ve followed.",
                        follow_max_rechecks: 3,
                        follow_fail_action: "send_anyway",
                        follow_recheck_count: 0,
                      },
                    ]
                : [],
        ),
      ),
      update: vi.fn((values: Record<string, unknown>) => ({
        eq: vi.fn(async (_column: string, id: string) => {
          mocks.updates.push({ table, id, values });
          return { error: null };
        }),
      })),
    })),
  },
}));

vi.mock("./plan.server", () => ({
  getPlan: mocks.getPlan,
}));

vi.mock("./secret-crypto.server", () => ({
  decryptServerSecret: mocks.decryptServerSecret,
  encryptServerSecret: vi.fn(),
}));

vi.mock("./posthog.server", () => ({
  captureServerEvent: mocks.captureServerEvent,
  captureServerException: mocks.captureServerException,
}));

import {
  createInstagramRunActionPayload,
  decryptInstagramConnectionAccessToken,
  processInstagramDmQueueMessage,
  type MetaDeliveryError,
} from "./instagram-auto-dm.server";

function event(overrides: Partial<InstagramWebhookEvent> = {}): InstagramWebhookEvent {
  return {
    externalEventId: "comment:comment-b",
    instagramAccountId: "instagram-account-b",
    eventType: "comment",
    eventContext: "comment",
    sourceId: "comment-b",
    senderId: "visitor-1",
    senderUsername: "maya",
    mediaId: "media-b",
    text: "guide please",
    actionPayload: null,
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

function connection(id = "connection-b", overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id,
    provider_user_id: "instagram-account-b",
    provider_handle: "creator_b",
    access_token: "encrypted-token-b",
    user_id: "user-1",
    status: "active",
    connection_health: "healthy",
    scopes: [
      "instagram_business_basic",
      "instagram_business_manage_comments",
      "instagram_business_manage_messages",
    ],
    webhook_fields: ["comments", "live_comments", "messages", "messaging_postbacks"],
    token_expires_at: new Date(now + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    last_verified_at: new Date(now).toISOString(),
    reauth_required: false,
    ...overrides,
  };
}

function automation(id = "automation-b", overrides: Record<string, unknown> = {}) {
  return {
    id,
    connection_id: "connection-b",
    trigger_type: "comment_keyword",
    keywords: ["guide"],
    excluded_keywords: [],
    match_type: "contains",
    media_scope: "any",
    media_ids: [],
    opening_message: null,
    confirmation_button_label: null,
    email_capture_enabled: false,
    reply_message: "Here is the guide.",
    reply_button_label: null,
    reply_button_url: null,
    public_reply_enabled: false,
    public_reply_message: null,
    ...overrides,
  };
}

async function testSenderHash(senderId: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("worker-test-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(senderId)),
  );
  return Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("Instagram Auto-DM queue worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.shouldProcess = true;
    mocks.connections.length = 0;
    mocks.automations.length = 0;
    mocks.runs.length = 0;
    mocks.updates.length = 0;
    mocks.getPlan.mockResolvedValue("link");
    mocks.decryptServerSecret.mockResolvedValue("meta-token-b");
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_instagram_delivery_slot") {
        return { data: [{ wait_ms: 0 }], error: null };
      }
      if (name === "defer_instagram_delivery_slot") {
        return { data: null, error: null };
      }
      if (name === "claim_instagram_dm_event") {
        return {
          data: {
            event_id: "event-1",
            should_process: mocks.shouldProcess,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC in Instagram worker test: ${name}`);
    });
    vi.stubGlobal("fetch", mocks.fetch);
    vi.stubEnv("META_INSTAGRAM_APP_SECRET", "worker-test-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("normalizes unreadable saved tokens into a reconnect-required Meta error", async () => {
    mocks.decryptServerSecret.mockRejectedValueOnce(new Error("Unknown encryption key."));

    await expect(decryptInstagramConnectionAccessToken("encrypted-token-b")).rejects.toMatchObject({
      name: "MetaDeliveryError",
      code: "token_decryption_failed",
      retryable: false,
    } satisfies Partial<MetaDeliveryError>);
  });

  it("routes an event to the matching connected account and records a sent workflow", async () => {
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("INSTAGRAM_AUTO_DM_PROVIDER_MODE", "mock");
    mocks.connections.push(
      connection("connection-a", {
        provider_user_id: "instagram-account-a",
        provider_handle: "creator_a",
        access_token: "encrypted-token-a",
      }),
      connection(),
    );
    mocks.automations.push(
      automation("automation-a", {
        connection_id: "connection-a",
        keywords: ["different"],
        reply_message: "This must not be sent.",
      }),
      automation(),
    );

    await expect(
      processInstagramDmQueueMessage({
        kind: "instagram_dm_event",
        event: event(),
      }),
    ).resolves.toEqual({ sent: true });

    expect(mocks.rpc).toHaveBeenCalledWith(
      "claim_instagram_dm_event",
      expect.objectContaining({
        p_instagram_account_id: "instagram-account-b",
        p_external_event_id: "comment:comment-b",
      }),
    );
    expect(mocks.updates).toEqual(
      expect.arrayContaining([
        {
          table: "instagram_dm_events",
          id: "event-1",
          values: expect.objectContaining({
            connection_id: "connection-b",
            automation_id: "automation-b",
            matched_keyword: "guide",
          }),
        },
        {
          table: "instagram_dm_events",
          id: "event-1",
          values: expect.objectContaining({
            status: "sent",
            response_id: "staging-dm-comment-b",
          }),
        },
      ]),
    );
    expect(mocks.captureServerEvent).toHaveBeenCalledWith(
      "user-1",
      "instagram_auto_dm_sent",
      expect.objectContaining({
        automation_id: "automation-b",
        connection_id: "connection-b",
      }),
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not deliver when Meta webhook subscriptions are incomplete", async () => {
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("INSTAGRAM_AUTO_DM_PROVIDER_MODE", "mock");
    mocks.connections.push(connection("connection-b", { webhook_fields: ["comments"] }));
    mocks.automations.push(automation());

    await expect(
      processInstagramDmQueueMessage({ kind: "instagram_dm_event", event: event() }),
    ).resolves.toEqual({ ignored: true });

    expect(mocks.updates).toEqual(
      expect.arrayContaining([
        {
          table: "instagram_dm_events",
          id: "event-1",
          values: expect.objectContaining({
            connection_id: "connection-b",
            status: "ignored",
            error_code: "connection_not_ready",
          }),
        },
      ]),
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("sends configured public reply variants even when the legacy reply column is empty", async () => {
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("INSTAGRAM_AUTO_DM_PROVIDER_MODE", "mock");
    mocks.connections.push(connection());
    mocks.automations.push(
      automation("automation-b", {
        public_reply_enabled: true,
        public_reply_message: null,
        public_reply_messages: ["Check your DMs ✨", "Sent it over 🙌"],
      }),
    );

    await expect(
      processInstagramDmQueueMessage({ kind: "instagram_dm_event", event: event() }),
    ).resolves.toEqual({ sent: true });

    expect(mocks.updates).toEqual(
      expect.arrayContaining([
        {
          table: "instagram_dm_events",
          id: "event-1",
          values: expect.objectContaining({
            status: "sent",
            public_reply_id: "staging-comment-comment-b",
          }),
        },
      ]),
    );
  });

  it("sends the single Send it action in the initial comment private reply", async () => {
    vi.stubEnv("APP_ENV", "production");
    mocks.connections.push(connection());
    mocks.automations.push(
      automation("automation-b", {
        opening_message: "I have the guide ready.",
        confirmation_button_label: "Send it",
      }),
    );
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_instagram_dm_event") {
        return { data: { event_id: "event-1", should_process: true }, error: null };
      }
      if (name === "create_instagram_dm_run") {
        return { data: "run-1", error: null };
      }
      if (name === "claim_instagram_delivery_slot") {
        return { data: [{ wait_ms: 0 }], error: null };
      }
      throw new Error(`Unexpected RPC in Instagram worker test: ${name}`);
    });
    mocks.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message_id: "private-reply-1" }), { status: 200 }),
    );

    await expect(
      processInstagramDmQueueMessage({ kind: "instagram_dm_event", event: event() }),
    ).resolves.toEqual({ sent: true });

    const request = mocks.fetch.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload).toEqual({
      recipient: { comment_id: "comment-b" },
      message: {
        text: "I have the guide ready.\n\nTap Send it below, or reply Send it.",
        quick_replies: [
          {
            content_type: "text",
            title: "Send it",
            payload: expect.stringMatching(/^bento:run:confirm:run-1:/),
          },
        ],
      },
    });
    expect(mocks.updates).toEqual(
      expect.arrayContaining([
        {
          table: "instagram_dm_runs",
          id: "run-1",
          values: expect.objectContaining({ opening_response_id: "private-reply-1" }),
        },
      ]),
    );
  });

  it("treats a typed Send it reply as the one confirmation action", async () => {
    vi.stubEnv("APP_ENV", "production");
    mocks.connections.push(connection());
    mocks.automations.push(
      automation("automation-b", {
        opening_message: "I have the guide ready.",
        confirmation_button_label: "Send it",
      }),
    );
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_instagram_dm_event") {
        return { data: { event_id: "event-2", should_process: true }, error: null };
      }
      if (name === "claim_instagram_dm_run_for_quick_reply_prompt") {
        return {
          data: {
            run_id: "run-1",
            automation_id: "automation-b",
            user_id: "user-1",
            should_process: true,
          },
          error: null,
        };
      }
      if (name === "claim_instagram_delivery_slot") {
        return { data: [{ wait_ms: 0 }], error: null };
      }
      throw new Error(`Unexpected RPC in Instagram worker test: ${name}`);
    });
    mocks.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message_id: "final-message-typed" }), { status: 200 }),
    );

    await expect(
      processInstagramDmQueueMessage({
        kind: "instagram_dm_event",
        event: event({
          externalEventId: "message:reply-1",
          eventType: "message",
          eventContext: "dm",
          sourceId: "reply-1",
          text: "Send it",
          mediaId: null,
        }),
      }),
    ).resolves.toEqual({ sent: true });

    expect(mocks.rpc).toHaveBeenCalledWith(
      "claim_instagram_dm_run_for_quick_reply_prompt",
      expect.objectContaining({
        p_connection_id: "connection-b",
        p_confirmation_event_id: "event-2",
        p_reply_text: "Send it",
      }),
    );
    const request = mocks.fetch.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload).toMatchObject({
      recipient: { id: "visitor-1" },
      messaging_type: "RESPONSE",
      message: { text: "Here is the guide." },
    });
    expect(mocks.updates).toEqual(
      expect.arrayContaining([
        {
          table: "instagram_dm_runs",
          id: "run-1",
          values: expect.objectContaining({
            status: "completed",
            final_response_id: "final-message-typed",
          }),
        },
      ]),
    );
  });

  it("advances the workflow when the recipient taps the native suggested reply", async () => {
    vi.stubEnv("APP_ENV", "production");
    mocks.connections.push(connection());
    mocks.automations.push(
      automation("automation-b", {
        opening_message: "I have the guide ready.",
        confirmation_button_label: "Send it",
      }),
    );
    const runId = crypto.randomUUID();
    const senderIdHash = await testSenderHash("visitor-1");
    const payload = await createInstagramRunActionPayload(runId, "connection-b", senderIdHash);
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_instagram_dm_event") {
        return { data: { event_id: "event-3", should_process: true }, error: null };
      }
      if (name === "claim_instagram_dm_run") {
        return {
          data: {
            automation_id: "automation-b",
            user_id: "user-1",
            should_process: true,
          },
          error: null,
        };
      }
      if (name === "claim_instagram_delivery_slot") {
        return { data: [{ wait_ms: 0 }], error: null };
      }
      throw new Error(`Unexpected RPC in Instagram worker test: ${name}`);
    });
    mocks.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message_id: "final-message-1" }), { status: 200 }),
    );

    await expect(
      processInstagramDmQueueMessage({
        kind: "instagram_dm_event",
        event: event({
          externalEventId: "message:quick-reply-1",
          eventType: "message",
          eventContext: "quick_reply",
          sourceId: "quick-reply-1",
          senderId: "visitor-1",
          text: "Send it",
          actionPayload: payload,
          mediaId: null,
        }),
      }),
    ).resolves.toEqual({ sent: true });

    expect(mocks.rpc).toHaveBeenCalledWith("claim_instagram_dm_run", {
      p_run_id: runId,
      p_connection_id: "connection-b",
      p_sender_id_hash: senderIdHash,
      p_confirmation_event_id: "event-3",
    });
    const request = mocks.fetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      recipient: { id: "visitor-1" },
      messaging_type: "RESPONSE",
      message: { text: "Here is the guide." },
    });
    expect(mocks.updates).toEqual(
      expect.arrayContaining([
        {
          table: "instagram_dm_runs",
          id: runId,
          values: expect.objectContaining({
            status: "completed",
            final_response_id: "final-message-1",
          }),
        },
      ]),
    );
  });

  it("checks follow status immediately after Send it and waits without sending the link", async () => {
    vi.stubEnv("APP_ENV", "production");
    mocks.connections.push(connection());
    mocks.automations.push(
      automation("automation-b", {
        opening_message: "I have the guide ready.",
        confirmation_button_label: "Send it",
        follow_gate_enabled: true,
      }),
    );
    const runId = crypto.randomUUID();
    const senderIdHash = await testSenderHash("visitor-1");
    const payload = await createInstagramRunActionPayload(runId, "connection-b", senderIdHash);
    mocks.runs.push({
      follow_gate_enabled: true,
      follow_prompt_message: "Follow me, then retry.",
      follow_max_rechecks: 3,
      follow_fail_action: "send_anyway",
      follow_recheck_count: 0,
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_instagram_dm_event") {
        return { data: { event_id: "event-follow", should_process: true }, error: null };
      }
      if (name === "claim_instagram_dm_run") {
        return {
          data: { automation_id: "automation-b", user_id: "user-1", should_process: true },
          error: null,
        };
      }
      if (name === "claim_instagram_delivery_slot") {
        return { data: [{ wait_ms: 0 }], error: null };
      }
      throw new Error(`Unexpected RPC in Instagram worker test: ${name}`);
    });
    mocks.fetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ is_user_follow_business: false }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message_id: "follow-prompt-1" }), { status: 200 }),
      );

    await expect(
      processInstagramDmQueueMessage({
        kind: "instagram_dm_event",
        event: event({
          externalEventId: "message:confirm-follow",
          eventType: "message",
          eventContext: "quick_reply",
          sourceId: "confirm-follow",
          senderId: "visitor-1",
          text: "Send it",
          actionPayload: payload,
          mediaId: null,
        }),
      }),
    ).resolves.toEqual({ sent: true });

    const sent = JSON.parse(String((mocks.fetch.mock.calls[1][1] as RequestInit).body));
    expect(sent.message).toMatchObject({
      text: "Follow me, then retry.",
      quick_replies: [{ title: "I’ve followed" }],
    });
    expect(sent.message.quick_replies[0].payload).toMatch(/^bento:run:follow_recheck:/);
    expect(mocks.updates).toEqual(
      expect.arrayContaining([
        {
          table: "instagram_dm_runs",
          id: runId,
          values: expect.objectContaining({
            status: "awaiting_follow",
            follow_prompt_response_id: "follow-prompt-1",
          }),
        },
      ]),
    );
    expect(JSON.stringify(mocks.fetch.mock.calls)).not.toContain("Here is the guide.");
  });

  it("deduplicates a redelivered Meta webhook before loading any user connection", async () => {
    mocks.shouldProcess = false;

    await expect(
      processInstagramDmQueueMessage({
        kind: "instagram_dm_event",
        event: event(),
      }),
    ).resolves.toEqual({ duplicate: true });

    expect(mocks.updates).toHaveLength(0);
    expect(mocks.captureServerEvent).not.toHaveBeenCalled();
  });

  it("paces concurrent deliveries for the same Instagram account before calling Meta", async () => {
    vi.stubEnv("APP_ENV", "production");
    mocks.connections.push(connection());
    mocks.automations.push(automation());
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_instagram_dm_event") {
        return { data: { event_id: "event-1", should_process: true }, error: null };
      }
      if (name === "claim_instagram_delivery_slot") {
        return { data: [{ wait_ms: 1_250 }], error: null };
      }
      throw new Error(`Unexpected RPC in Instagram worker test: ${name}`);
    });

    await expect(
      processInstagramDmQueueMessage({ kind: "instagram_dm_event", event: event() }),
    ).rejects.toMatchObject({
      code: "account_paced",
      retryable: true,
      retryAfterSeconds: 2,
    });

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith("claim_instagram_delivery_slot", {
      p_connection_id: "connection-b",
      p_min_interval_ms: 500,
    });
  });

  it("keeps retryable Meta failures below the permanent-attempt cap and emits diagnostics", async () => {
    vi.stubEnv("APP_ENV", "production");
    mocks.connections.push(connection());
    mocks.automations.push(automation());
    mocks.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 4, message: "Temporarily unavailable" } }), {
        status: 429,
      }),
    );

    await expect(
      processInstagramDmQueueMessage({
        kind: "instagram_dm_event",
        event: event(),
      }),
    ).rejects.toThrow("Instagram is temporarily unavailable");

    const failedUpdate = mocks.updates.find(
      (update) => update.table === "instagram_dm_events" && update.values.status === "failed",
    );
    expect(failedUpdate?.values).toMatchObject({
      status: "failed",
      error_code: "4",
    });
    expect(failedUpdate?.values).not.toHaveProperty("attempt_count");
    expect(mocks.rpc).toHaveBeenCalledWith("defer_instagram_delivery_slot", {
      p_connection_id: "connection-b",
      p_retry_after_seconds: 60,
    });
    expect(mocks.captureServerEvent).toHaveBeenCalledWith(
      "user-1",
      "instagram_auto_dm_failed",
      expect.objectContaining({
        provider_error_code: "4",
        retryable: true,
      }),
    );
    expect(mocks.captureServerException).toHaveBeenCalledWith(
      expect.any(Error),
      "instagram-auto-dm-worker",
      expect.objectContaining({
        event_id: "event-1",
        retryable: true,
      }),
    );
  });

  it("marks a connection for reconnection when its rotated token can no longer be decrypted", async () => {
    vi.stubEnv("APP_ENV", "production");
    mocks.connections.push(connection());
    mocks.automations.push(automation());
    mocks.decryptServerSecret.mockRejectedValueOnce(new Error("Unknown encryption key."));

    await expect(
      processInstagramDmQueueMessage({
        kind: "instagram_dm_event",
        event: event(),
      }),
    ).resolves.toEqual({ failed: true });

    expect(mocks.updates).toEqual(
      expect.arrayContaining([
        {
          table: "social_connections",
          id: "connection-b",
          values: expect.objectContaining({
            connection_health: "action_required",
            reauth_required: true,
            provider_error_code: "token_decryption_failed",
          }),
        },
        {
          table: "instagram_dm_events",
          id: "event-1",
          values: expect.objectContaining({
            status: "failed",
            attempt_count: 9,
            error_code: "token_decryption_failed",
          }),
        },
      ]),
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
