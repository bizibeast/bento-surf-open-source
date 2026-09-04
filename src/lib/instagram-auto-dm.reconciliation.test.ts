import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  getPlan: vi.fn(),
  decryptServerSecret: vi.fn(),
  captureServerEvent: vi.fn(),
  captureServerException: vi.fn(),
  fetch: vi.fn(),
  connection: null as Record<string, unknown> | null,
  automations: [] as Array<Record<string, unknown>>,
  existingEvents: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
}));

function query<T>(data: T[]) {
  const chain: Record<string, unknown> & PromiseLike<{ data: T[]; error: null }> = {
    then(onfulfilled, onrejected) {
      return Promise.resolve({ data, error: null }).then(onfulfilled, onrejected);
    },
  };
  for (const method of ["eq", "in", "order", "limit"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.maybeSingle = vi.fn(async () => ({ data: data[0] ?? null, error: null }));
  return chain;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: mocks.rpc,
    from: vi.fn((table: string) => ({
      select: vi.fn(() =>
        query(
          table === "social_connections"
            ? mocks.connection
              ? [mocks.connection]
              : []
            : table === "instagram_dm_automations"
              ? mocks.automations
              : table === "instagram_dm_events"
                ? mocks.existingEvents
                : [],
        ),
      ),
      update: vi.fn((values: Record<string, unknown>) => {
        const chain: Record<string, unknown> = {};
        chain.eq = vi.fn(async () => {
          mocks.updates.push({ table, values });
          return { error: null };
        });
        return chain;
      }),
    })),
  },
}));

vi.mock("./plan.server", () => ({ getPlan: mocks.getPlan }));
vi.mock("./secret-crypto.server", () => ({
  decryptServerSecret: mocks.decryptServerSecret,
  encryptServerSecret: vi.fn(),
}));
vi.mock("./posthog.server", () => ({
  captureServerEvent: mocks.captureServerEvent,
  captureServerException: mocks.captureServerException,
}));

import {
  enqueueInstagramCommentReconciliations,
  processInstagramDmQueueMessage,
  type InstagramDmQueueMessage,
} from "./instagram-auto-dm.server";

const now = new Date("2026-08-01T10:00:00.000Z");

function response(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "connection-1",
    user_id: "user-1",
    provider_user_id: "ig-account-1",
    access_token: "encrypted-token",
    status: "active",
    connection_health: "healthy",
    scopes: [
      "instagram_business_basic",
      "instagram_business_manage_comments",
      "instagram_business_manage_messages",
    ],
    webhook_fields: ["comments", "live_comments", "messages", "messaging_postbacks"],
    token_expires_at: "2026-09-01T10:00:00.000Z",
    last_verified_at: now.toISOString(),
    last_comment_reconcile_completed_at: null,
    reauth_required: false,
    ...overrides,
  };
}

function automation(overrides: Record<string, unknown> = {}) {
  return {
    id: "automation-1",
    trigger_type: "comment_keyword",
    keywords: ["guide"],
    excluded_keywords: [],
    match_type: "contains",
    media_scope: "any",
    media_ids: [],
    created_at: "2026-08-01T08:00:00.000Z",
    ...overrides,
  };
}

function queue() {
  return { sendBatch: vi.fn(async () => undefined) } as unknown as Queue<InstagramDmQueueMessage>;
}

describe("Instagram missed-comment reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.clearAllMocks();
    mocks.connection = connection();
    mocks.automations = [automation()];
    mocks.existingEvents = [];
    mocks.updates = [];
    mocks.getPlan.mockResolvedValue("link");
    mocks.decryptServerSecret.mockResolvedValue("meta-token");
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("atomically claims due accounts and queues one bounded job per account", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{ connection_id: "connection-1" }, { connection_id: "connection-2" }],
      error: null,
    });
    const targetQueue = queue();

    await expect(enqueueInstagramCommentReconciliations(targetQueue)).resolves.toEqual({
      claimed: 2,
      queued: 2,
    });

    expect(mocks.rpc).toHaveBeenCalledWith("claim_instagram_comment_reconciliations", {
      p_batch_size: 25,
      p_min_interval_seconds: 300,
    });
    expect(targetQueue.sendBatch).toHaveBeenCalledWith([
      { body: { kind: "instagram_comment_reconcile", connectionId: "connection-1" } },
      { body: { kind: "instagram_comment_reconcile", connectionId: "connection-2" } },
    ]);
  });

  it("queues only fresh matching comments that were not already handled or answered", async () => {
    mocks.existingEvents = [{ external_event_id: "comment:duplicate-comment" }];
    mocks.fetch
      .mockResolvedValueOnce(
        response({ data: [{ id: "media-1", timestamp: "2026-08-01T09:30:00.000Z" }] }),
      )
      .mockResolvedValueOnce(
        response({
          data: [
            {
              id: "fresh-comment",
              text: "guide please",
              timestamp: "2026-08-01T09:45:00.000Z",
              from: { id: "visitor-1", username: "maya" },
              replies: { data: [] },
            },
            {
              id: "duplicate-comment",
              text: "guide",
              timestamp: "2026-08-01T09:40:00.000Z",
              from: { id: "visitor-2", username: "sam" },
              replies: { data: [] },
            },
            {
              id: "creator-answered",
              text: "guide",
              timestamp: "2026-08-01T09:35:00.000Z",
              from: { id: "visitor-3", username: "alex" },
              replies: { data: [{ from: { id: "ig-account-1" } }] },
            },
            {
              id: "before-automation",
              text: "guide",
              timestamp: "2026-08-01T07:59:59.000Z",
              from: { id: "visitor-4", username: "lee" },
              replies: { data: [] },
            },
          ],
        }),
      );
    const targetQueue = queue();

    await expect(
      processInstagramDmQueueMessage(
        { kind: "instagram_comment_reconcile", connectionId: "connection-1" },
        targetQueue,
      ),
    ).resolves.toEqual({ scanned: 2, queued: 1, mediaScanned: 1 });

    expect(targetQueue.sendBatch).toHaveBeenCalledTimes(1);
    expect(targetQueue.sendBatch).toHaveBeenCalledWith([
      {
        body: {
          kind: "instagram_dm_event",
          event: expect.objectContaining({
            externalEventId: "comment:fresh-comment",
            instagramAccountId: "ig-account-1",
            senderId: "visitor-1",
            mediaId: "media-1",
          }),
        },
      },
    ]);
    const commentsUrl = new URL(String(mocks.fetch.mock.calls[1]?.[0]));
    expect(commentsUrl.searchParams.get("fields")).toBe(
      "id,text,timestamp,from,replies.limit(100){from}",
    );
    expect(mocks.updates).toContainEqual({
      table: "social_connections",
      values: expect.objectContaining({
        last_comment_reconcile_completed_at: now.toISOString(),
        last_comment_reconcile_error: null,
      }),
    });
  });

  it("uses a short overlap after a successful scan instead of repeatedly fetching 72 hours", async () => {
    mocks.connection = connection({
      last_comment_reconcile_completed_at: "2026-08-01T09:50:00.000Z",
    });
    mocks.fetch
      .mockResolvedValueOnce(response({ data: [{ id: "media-1" }] }))
      .mockResolvedValueOnce(response({ data: [] }));

    await processInstagramDmQueueMessage(
      { kind: "instagram_comment_reconcile", connectionId: "connection-1" },
      queue(),
    );

    const commentsUrl = new URL(String(mocks.fetch.mock.calls[1]?.[0]));
    expect(commentsUrl.searchParams.get("since")).toBe(
      String(Date.parse("2026-08-01T09:35:00.000Z") / 1_000),
    );
  });

  it("marks revoked access for reconnect without retrying a permanent Meta rejection", async () => {
    mocks.fetch.mockResolvedValueOnce(
      response({ error: { code: 190, message: "Invalid OAuth access token." } }, 400),
    );

    await expect(
      processInstagramDmQueueMessage(
        { kind: "instagram_comment_reconcile", connectionId: "connection-1" },
        queue(),
      ),
    ).resolves.toEqual({ failed: true, retryable: false });

    expect(mocks.updates).toEqual(
      expect.arrayContaining([
        {
          table: "social_connections",
          values: expect.objectContaining({
            connection_health: "action_required",
            reauth_required: true,
            provider_error_code: "190",
          }),
        },
      ]),
    );
  });

  it("surfaces rate limits for queue retry and persists only a sanitized provider code", async () => {
    mocks.fetch.mockResolvedValueOnce(
      response({ error: { code: 4, message: "Application request limit reached." } }, 429, {
        "retry-after": "90",
      }),
    );

    await expect(
      processInstagramDmQueueMessage(
        { kind: "instagram_comment_reconcile", connectionId: "connection-1" },
        queue(),
      ),
    ).rejects.toMatchObject({ code: "4", retryable: true, retryAfterSeconds: 90 });

    expect(mocks.updates).toContainEqual({
      table: "social_connections",
      values: { last_comment_reconcile_error: "4" },
    });
  });
});
