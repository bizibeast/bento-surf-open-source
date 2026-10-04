import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentConnection } from "./content-connections.server";
import {
  completeSlackConnectionForUser,
  createSlackAdapter,
  exchangeSlackCode,
  slackAuthorizationUrl,
  slackReady,
  slackRetryAfterMs,
} from "./slack-content.server";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.SLACK_CONTENT_CLIENT_ID = "slack-client";
  process.env.SLACK_CONTENT_CLIENT_SECRET = "slack-secret";
  process.env.SLACK_CONTENT_REDIRECT_URI =
    "https://app.test.example.com/integrations/slack/callback";
  process.env.CONTENT_CONNECTION_ENCRYPTION_KEY = `hex:${"ab".repeat(32)}`;
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function json(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const connection: ContentConnection = {
  id: "11111111-1111-4111-8111-111111111111",
  userId: "owner",
  provider: "slack",
  externalAccountId: "T123",
  displayName: "Creator workspace",
  status: "active",
  scopes: ["channels:read", "channels:history"],
  selectedResources: { ids: ["C123"] },
  metadata: {},
  syncCursor: null,
  accessTokenCiphertext: "encrypted-token",
  refreshTokenCiphertext: null,
  tokenExpiresAt: null,
};

describe("Slack Content OAuth", () => {
  it("requires the dedicated Content encryption key", () => {
    delete process.env.CONTENT_CONNECTION_ENCRYPTION_KEY;
    expect(slackReady()).toBe(false);
  });

  it("requests only public-channel read scopes", () => {
    expect(slackReady()).toBe(true);
    const url = new URL(slackAuthorizationUrl("11111111-1111-4111-8111-111111111111"));
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("scope")).toBe("channels:read,channels:history");
    expect(url.searchParams.get("scope")).not.toMatch(/groups|im|mpim|chat:write/);
  });

  it("exchanges OAuth code without exposing the client secret in the URL", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json({
        ok: true,
        access_token: "xoxb-provider-token",
        scope: "channels:read,channels:history",
        team: { id: "T123", name: "Creator workspace" },
      }),
    );
    await expect(exchangeSlackCode("code-1", fetcher)).resolves.toMatchObject({
      teamId: "T123",
    });
    expect(String(fetcher.mock.calls[0][0])).toBe("https://slack.com/api/oauth.v2.access");
    expect(String(fetcher.mock.calls[0][0])).not.toContain("slack-secret");
  });

  it("consumes creator state before saving safe workspace identity", async () => {
    const save = vi.fn(async () => undefined);
    const result = await completeSlackConnectionForUser(
      "owner",
      { code: "code-1", state: "11111111-1111-4111-8111-111111111111" },
      {
        consumeState: vi.fn(async () => ({ metadata: {} })),
        exchange: vi.fn(async () => ({
          accessToken: "xoxb-provider-token",
          refreshToken: null,
          expiresIn: null,
          scopes: ["channels:read", "channels:history"],
          teamId: "T123",
          teamName: "Creator workspace",
        })),
        save,
      },
    );
    expect(result).toEqual({ teamId: "T123", displayName: "Creator workspace" });
    expect(JSON.stringify(result)).not.toContain("xoxb-provider-token");
    expect(save).toHaveBeenCalled();
  });

  it("honors Slack retry-after seconds", () => {
    expect(
      slackRetryAfterMs(new Response(null, { status: 429, headers: { "retry-after": "30" } })),
    ).toBe(30_000);
  });
});

describe("Slack Content adapter", () => {
  it("refreshes rotated Slack OAuth tokens before sync", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("conversations.list")) {
        return json({ ok: true, channels: [], response_metadata: { next_cursor: "" } });
      }
      throw new Error(`Unexpected Slack request: ${url}`);
    });
    const refreshAccessToken = vi.fn(async () => "refreshed-token");
    const decrypt = vi.fn(async () => "old-token");
    const adapter = createSlackAdapter({
      fetch: fetcher,
      decrypt,
      refreshAccessToken,
      now: () => new Date("2026-09-19T11:00:00.000Z"),
    });
    await adapter.sync({
      ...connection,
      selectedResources: { ids: [] },
      refreshTokenCiphertext: "encrypted-refresh",
      tokenExpiresAt: "2026-09-19T10:00:00.000Z",
    });
    expect(refreshAccessToken).toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalledWith("encrypted-token");
  });

  it("lists joined public channels and imports only selected channel history", async () => {
    const requested: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("conversations.list")) {
        return json({
          ok: true,
          channels: [
            { id: "C123", name: "content", is_member: true, is_private: false },
            { id: "C999", name: "private", is_member: true, is_private: true },
            { id: "C456", name: "not-joined", is_member: false, is_private: false },
          ],
          response_metadata: { next_cursor: "" },
        });
      }
      if (url.includes("conversations.history")) {
        return json({
          ok: true,
          messages: [{ ts: "1789812000.000100", user: "U123", text: "We shipped the launch." }],
          response_metadata: { next_cursor: "" },
        });
      }
      throw new Error(`Unexpected Slack request: ${url}`);
    });
    const adapter = createSlackAdapter({
      fetch: fetcher,
      decrypt: vi.fn(async () => "xoxb-provider-token"),
      now: () => new Date("2026-09-19T11:00:00.000Z"),
    });
    await expect(adapter.listResources(connection)).resolves.toEqual([
      { id: "C123", name: "#content", type: "public_channel" },
    ]);
    const result = await adapter.sync(connection);
    expect(result.records).toEqual([
      expect.objectContaining({
        provider: "slack",
        externalItemId: "C123:1789812000.000100",
        text: "We shipped the launch.",
      }),
    ]);
    expect(requested.some((url) => /types=im|types=mpim|C999|C456/.test(url))).toBe(false);
  });
});
