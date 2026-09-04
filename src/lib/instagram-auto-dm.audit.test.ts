import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ConnectionRow = {
  id: string;
  user_id: string;
  provider_user_id: string;
  access_token: string;
  token_expires_at: string | null;
  last_health_check_at: string | null;
  provider_avatar_url: string | null;
};

const mocks = vi.hoisted(() => ({
  connections: [] as ConnectionRow[],
  updates: [] as Array<{ id: string; values: Record<string, unknown> }>,
  decryptServerSecret: vi.fn(),
  encryptServerSecret: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: vi.fn((table: string) => {
      if (table !== "social_connections") {
        throw new Error(`Unexpected table in Instagram connection audit test: ${table}`);
      }

      const query: Record<string, unknown> = {};
      for (const method of ["eq", "or", "order"]) {
        query[method] = vi.fn(() => query);
      }
      query.limit = vi.fn(async () => ({ data: mocks.connections, error: null }));

      return {
        select: vi.fn(() => query),
        update: vi.fn((values: Record<string, unknown>) => ({
          eq: vi.fn(async (_column: string, id: string) => {
            mocks.updates.push({ id, values });
            return { error: null };
          }),
        })),
      };
    }),
  },
}));

vi.mock("./secret-crypto.server", () => ({
  decryptServerSecret: mocks.decryptServerSecret,
  encryptServerSecret: mocks.encryptServerSecret,
}));

vi.mock("./posthog.server", () => ({
  captureServerEvent: vi.fn(),
  captureServerException: vi.fn(),
}));

import {
  auditInstagramConnections,
  INSTAGRAM_AUTO_DM_WEBHOOK_FIELDS,
} from "./instagram-auto-dm.server";

const now = new Date("2026-07-30T08:00:00.000Z");

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function connection(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: "connection-1",
    user_id: "user-1",
    provider_user_id: "instagram-account-1",
    access_token: "encrypted-old-token",
    token_expires_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
    last_health_check_at: null,
    provider_avatar_url: "https://cdn.example.com/avatar.jpg",
    ...overrides,
  };
}

describe("Instagram connection health audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connections.length = 0;
    mocks.updates.length = 0;
    mocks.decryptServerSecret.mockResolvedValue("old-token");
    mocks.encryptServerSecret.mockResolvedValue("encrypted-refreshed-token");
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("refreshes expiring tokens, repairs webhook subscriptions, and records healthy state", async () => {
    mocks.connections.push(connection());
    mocks.fetch
      .mockResolvedValueOnce(
        response({
          access_token: "refreshed-token",
          expires_in: 60 * 24 * 60 * 60,
        }),
      )
      .mockResolvedValueOnce(
        response({
          user_id: "instagram-account-1",
          username: "bizibeast",
          profile_picture_url: "https://cdn.example.com/avatar-new.jpg",
        }),
      )
      .mockResolvedValueOnce(
        response({
          data: [{ subscribed_fields: ["comments"] }],
        }),
      )
      .mockResolvedValueOnce(response({ success: true }))
      .mockResolvedValueOnce(
        response({
          data: [{ subscribed_fields: [...INSTAGRAM_AUTO_DM_WEBHOOK_FIELDS] }],
        }),
      );

    await expect(auditInstagramConnections(now)).resolves.toEqual({
      checked: 1,
      healthy: 1,
      refreshed: 1,
      repaired: 1,
      actionRequired: 0,
      transientFailures: 0,
    });

    expect(mocks.decryptServerSecret).toHaveBeenCalledWith("encrypted-old-token", "social");
    expect(mocks.encryptServerSecret).toHaveBeenCalledWith("refreshed-token", "social");
    expect(mocks.fetch).toHaveBeenCalledTimes(5);
    expect(mocks.fetch.mock.calls[0]?.[0].toString()).toContain(
      "graph.instagram.com/refresh_access_token",
    );
    expect(mocks.fetch.mock.calls[3]?.[1]).toMatchObject({ method: "POST" });
    expect(mocks.updates).toEqual(
      expect.arrayContaining([
        {
          id: "connection-1",
          values: { last_health_check_at: now.toISOString() },
        },
        {
          id: "connection-1",
          values: expect.objectContaining({
            access_token: "encrypted-refreshed-token",
            provider_avatar_url: "https://cdn.example.com/avatar-new.jpg",
            connection_health: "healthy",
            webhook_fields: [...INSTAGRAM_AUTO_DM_WEBHOOK_FIELDS].sort(),
            reauth_required: false,
            provider_error_code: null,
            last_error: null,
          }),
        },
      ]),
    );
  });

  it("backfills a missing Instagram profile picture without reconnecting", async () => {
    mocks.connections.push(
      connection({
        provider_avatar_url: null,
        token_expires_at: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
      }),
    );
    mocks.fetch
      .mockResolvedValueOnce(
        response({
          user_id: "instagram-account-1",
          username: "bizibeast",
          profile_picture_url: "https://cdn.example.com/avatar.jpg",
        }),
      )
      .mockResolvedValueOnce(
        response({
          data: [{ subscribed_fields: [...INSTAGRAM_AUTO_DM_WEBHOOK_FIELDS] }],
        }),
      );

    await expect(auditInstagramConnections(now)).resolves.toMatchObject({
      checked: 1,
      healthy: 1,
    });

    expect(mocks.fetch.mock.calls[0]?.[0].toString()).toContain(
      "fields=user_id%2Cusername%2Cprofile_picture_url",
    );
    expect(mocks.updates.at(-1)).toEqual({
      id: "connection-1",
      values: expect.objectContaining({
        provider_avatar_url: "https://cdn.example.com/avatar.jpg",
      }),
    });
  });

  it("marks an expired token as requiring reconnection without calling Meta", async () => {
    mocks.connections.push(
      connection({
        token_expires_at: new Date(now.getTime() - 1_000).toISOString(),
      }),
    );

    await expect(auditInstagramConnections(now)).resolves.toEqual({
      checked: 1,
      healthy: 0,
      refreshed: 0,
      repaired: 0,
      actionRequired: 1,
      transientFailures: 0,
    });

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.updates.at(-1)).toEqual({
      id: "connection-1",
      values: expect.objectContaining({
        connection_health: "action_required",
        webhook_fields: [],
        reauth_required: true,
        provider_error_code: "token_expired",
      }),
    });
  });

  it("preserves connection state when Meta has a temporary token-refresh outage", async () => {
    mocks.connections.push(connection());
    mocks.fetch.mockResolvedValueOnce(response({ error: { code: 4 } }, 429));

    await expect(auditInstagramConnections(now)).resolves.toEqual({
      checked: 1,
      healthy: 0,
      refreshed: 0,
      repaired: 0,
      actionRequired: 0,
      transientFailures: 1,
    });

    expect(mocks.updates).toEqual([
      {
        id: "connection-1",
        values: { last_health_check_at: now.toISOString() },
      },
    ]);
  });

  it("does not allow production to use the mock Meta delivery provider", async () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("INSTAGRAM_AUTO_DM_PROVIDER_MODE", "mock");
    const { shouldMockInstagramAutoDmProvider } = await import("./instagram-auto-dm.server");

    expect(shouldMockInstagramAutoDmProvider()).toBe(false);
  });

  it("fails closed to testing access until Meta Advanced Access is explicitly configured", async () => {
    const { instagramMetaAccessLevel } = await import("./instagram-auto-dm.server");

    expect(instagramMetaAccessLevel()).toBe("testing");

    vi.stubEnv("META_INSTAGRAM_ACCESS_LEVEL", "advanced_access");
    expect(instagramMetaAccessLevel()).toBe("advanced_access");

    vi.stubEnv("META_INSTAGRAM_ACCESS_LEVEL", "unexpected");
    expect(instagramMetaAccessLevel()).toBe("testing");
  });
});
