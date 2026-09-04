import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FacebookWebhookEvent } from "./facebook-auto-dm";
import type { MetaDeliveryError } from "./instagram-auto-dm.server";

const mocks = vi.hoisted(() => ({
  shouldProcess: true,
  connections: [] as Array<Record<string, unknown>>,
  automations: [] as Array<Record<string, unknown>>,
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
            : table === "facebook_dm_automations"
              ? mocks.automations
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
  decryptFacebookConnectionAccessToken,
  processFacebookDmQueueMessage,
} from "./facebook-auto-dm.server";

function event(overrides: Partial<FacebookWebhookEvent> = {}): FacebookWebhookEvent {
  return {
    externalEventId: "comment:comment-b",
    facebookPageId: "facebook-page-b",
    eventType: "comment",
    eventContext: "comment",
    sourceId: "comment-b",
    senderId: "visitor-1",
    senderUsername: "Maya",
    mediaId: "page-b_post-1",
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
    provider_user_id: "facebook-page-b",
    provider_handle: "creator_b",
    access_token: "encrypted-token-b",
    user_id: "user-1",
    status: "active",
    connection_health: "healthy",
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

describe("Facebook Auto-DM queue worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.shouldProcess = true;
    mocks.connections.length = 0;
    mocks.automations.length = 0;
    mocks.updates.length = 0;
    mocks.getPlan.mockResolvedValue("link");
    mocks.decryptServerSecret.mockResolvedValue("meta-token-b");
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_facebook_delivery_slot") {
        return { data: [{ wait_ms: 0 }], error: null };
      }
      if (name === "defer_facebook_delivery_slot") {
        return { data: null, error: null };
      }
      if (name === "claim_facebook_dm_event") {
        return {
          data: {
            event_id: "event-1",
            should_process: mocks.shouldProcess,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC in Facebook worker test: ${name}`);
    });
    vi.stubGlobal("fetch", mocks.fetch);
    vi.stubEnv("META_FACEBOOK_APP_SECRET", "worker-test-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("normalizes unreadable saved tokens into a reconnect-required Meta error", async () => {
    mocks.decryptServerSecret.mockRejectedValueOnce(new Error("Unknown encryption key."));

    await expect(decryptFacebookConnectionAccessToken("encrypted-token-b")).rejects.toMatchObject({
      name: "MetaDeliveryError",
      code: "token_decryption_failed",
      retryable: false,
    } satisfies Partial<MetaDeliveryError>);
  });

  it("routes an event to the matching connected Page and records a sent workflow", async () => {
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("FACEBOOK_AUTO_DM_PROVIDER_MODE", "mock");
    mocks.connections.push(
      connection("connection-a", {
        provider_user_id: "facebook-page-a",
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
      processFacebookDmQueueMessage({
        kind: "facebook_dm_event",
        event: event(),
      }),
    ).resolves.toEqual({ sent: true });

    expect(mocks.rpc).toHaveBeenCalledWith(
      "claim_facebook_dm_event",
      expect.objectContaining({
        p_facebook_page_id: "facebook-page-b",
        p_external_event_id: "comment:comment-b",
      }),
    );
    expect(mocks.updates.some((update) => update.values.status === "sent")).toBe(true);
  });

  it("sends one Send it action in the initial Facebook comment private reply", async () => {
    vi.stubEnv("APP_ENV", "production");
    mocks.connections.push(connection());
    mocks.automations.push(
      automation("automation-b", {
        opening_message: "I have the guide ready.",
        confirmation_button_label: "Send it",
      }),
    );
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_facebook_dm_event") {
        return { data: { event_id: "event-1", should_process: true }, error: null };
      }
      if (name === "create_facebook_dm_run") return { data: "run-1", error: null };
      if (name === "claim_facebook_delivery_slot") {
        return { data: [{ wait_ms: 0 }], error: null };
      }
      throw new Error(`Unexpected RPC in Facebook worker test: ${name}`);
    });
    mocks.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message_id: "private-reply-1" }), { status: 200 }),
    );

    await expect(
      processFacebookDmQueueMessage({ kind: "facebook_dm_event", event: event() }),
    ).resolves.toEqual({ sent: true });

    const request = mocks.fetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      recipient: { comment_id: "comment-b" },
      message: {
        text: "I have the guide ready.\n\nTap Send it below, or reply Send it.",
        quick_replies: [
          {
            content_type: "text",
            title: "Send it",
            payload: expect.stringMatching(/^bento:fb-run:run-1:/),
          },
        ],
      },
    });
  });
});
