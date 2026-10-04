import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentConnection } from "./content-connections.server";
import {
  beginGranolaConnectionForUser,
  completeGranolaConnectionForUser,
  createGranolaAdapter,
  discoverGranolaOAuth,
  granolaAuthorizationUrl,
  granolaReady,
} from "./granola-content.server";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.GRANOLA_REDIRECT_URI = "https://app.test.example.com/integrations/granola/callback";
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const connection: ContentConnection = {
  id: "11111111-1111-4111-8111-111111111111",
  userId: "owner",
  provider: "granola",
  externalAccountId: "creator@example.com",
  displayName: "Creator workspace",
  status: "active",
  scopes: ["mcp"],
  selectedResources: { ids: ["all"] },
  metadata: {},
  syncCursor: null,
  accessTokenCiphertext: "encrypted-token",
  refreshTokenCiphertext: null,
  tokenExpiresAt: null,
};

describe("Granola OAuth", () => {
  it("is ready only when Bento can encrypt provider credentials", () => {
    delete process.env.CONTENT_CONNECTION_ENCRYPTION_KEY;
    expect(granolaReady()).toBe(false);
    process.env.CONTENT_CONNECTION_ENCRYPTION_KEY = `hex:${"ab".repeat(32)}`;
    expect(granolaReady()).toBe(true);
  });

  it("discovers official OAuth endpoints and builds PKCE authorization", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) {
        return json({ authorization_servers: ["https://mcp-auth.granola.ai"] });
      }
      return json({
        authorization_endpoint: "https://mcp-auth.granola.ai/authorize",
        token_endpoint: "https://mcp-auth.granola.ai/token",
        registration_endpoint: "https://mcp-auth.granola.ai/register",
      });
    });
    const metadata = await discoverGranolaOAuth(fetcher);
    expect(metadata.registrationEndpoint).toBe("https://mcp-auth.granola.ai/register");
    const url = new URL(
      granolaAuthorizationUrl({
        state: "11111111-1111-4111-8111-111111111111",
        clientId: "client-1",
        codeChallenge: "challenge",
        authorizationEndpoint: metadata.authorizationEndpoint,
      }),
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe("https://mcp.granola.ai/mcp");
  });

  it("stores encrypted PKCE state and returns the official authorization URL", async () => {
    const createState = vi.fn(async () => "11111111-1111-4111-8111-111111111111");
    const result = await beginGranolaConnectionForUser("owner", {
      discover: vi.fn(async () => ({
        authorizationEndpoint: "https://mcp-auth.granola.ai/authorize",
        tokenEndpoint: "https://mcp-auth.granola.ai/token",
        registrationEndpoint: "https://mcp-auth.granola.ai/register",
      })),
      register: vi.fn(async () => ({ clientId: "client-1" })),
      encrypt: vi.fn(async () => "encrypted-verifier"),
      createState,
      randomVerifier: () => "verifier-value",
      challenge: vi.fn(async () => "challenge-value"),
    });
    expect(result.url).toContain("code_challenge=challenge-value");
    expect(createState).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner",
        provider: "granola",
        metadata: expect.objectContaining({
          clientId: "client-1",
          verifierCiphertext: "encrypted-verifier",
        }),
      }),
    );
    expect(JSON.stringify(createState.mock.calls)).not.toContain("verifier-value");
  });

  it("consumes PKCE state and saves only safe Granola account identity", async () => {
    const save = vi.fn(async () => undefined);
    const result = await completeGranolaConnectionForUser(
      "owner",
      { code: "code-1", state: "11111111-1111-4111-8111-111111111111" },
      {
        consumeState: vi.fn(async () => ({
          metadata: {
            clientId: "client-1",
            tokenEndpoint: "https://mcp-auth.granola.ai/token",
            verifierCiphertext: "encrypted-verifier",
          },
        })),
        decrypt: vi.fn(async () => "verifier-value"),
        exchange: vi.fn(async () => ({
          accessToken: "provider-access-token",
          refreshToken: "provider-refresh-token",
          expiresIn: 3600,
          scope: "mcp",
        })),
        accountInfo: vi.fn(async () => ({
          email: "creator@example.com",
          workspace: "Creator workspace",
        })),
        save,
      },
    );
    expect(result).toEqual({
      accountId: "creator@example.com",
      displayName: "Creator workspace",
    });
    expect(JSON.stringify(result)).not.toContain("provider-access-token");
    expect(save).toHaveBeenCalledWith(
      "owner",
      expect.objectContaining({ accountId: "creator@example.com" }),
    );
  });
});

describe("Granola Content adapter", () => {
  it("refreshes an expired OAuth token before opening an MCP session", async () => {
    const createClient = vi.fn(() => ({
      listTools: vi.fn(async () => [{ name: "list_meetings" }, { name: "get_meetings" }]),
      callTool: vi.fn(async (name: string) =>
        name === "list_meetings"
          ? { structuredContent: { meetings: [] } }
          : { structuredContent: { meetings: [] } },
      ),
    }));
    const adapter = createGranolaAdapter({
      decrypt: vi.fn(async () => "old-token"),
      refreshAccessToken: vi.fn(async () => "refreshed-token"),
      createClient,
      now: () => new Date("2026-09-19T11:00:00.000Z"),
    });
    await adapter.sync({
      ...connection,
      refreshTokenCiphertext: "encrypted-refresh",
      tokenExpiresAt: "2026-09-19T10:00:00.000Z",
    });
    expect(createClient).toHaveBeenCalledWith("refreshed-token");
  });

  it("imports meeting notes and degrades cleanly without paid transcript tools", async () => {
    const callTool = vi.fn(async (name: string) => {
      if (name === "list_meetings") {
        return {
          structuredContent: {
            meetings: [
              {
                id: "meeting-1",
                title: "Weekly review",
                date: "2026-09-19T10:00:00.000Z",
                attendees: ["Sam"],
              },
            ],
          },
        };
      }
      if (name === "get_meetings") {
        return {
          structuredContent: {
            meetings: [
              {
                id: "meeting-1",
                title: "Weekly review",
                date: "2026-09-19T10:00:00.000Z",
                notes: "We decided to launch next week.",
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected tool ${name}`);
    });
    const adapter = createGranolaAdapter({
      decrypt: vi.fn(async () => "provider-access-token"),
      createClient: () => ({
        listTools: vi.fn(async () => [{ name: "list_meetings" }, { name: "get_meetings" }]),
        callTool,
      }),
      now: () => new Date("2026-09-19T11:00:00.000Z"),
    });

    const result = await adapter.sync(connection);
    expect(result.records).toEqual([
      expect.objectContaining({
        provider: "granola",
        externalItemId: "meeting-1",
        text: "We decided to launch next week.",
      }),
    ]);
    expect(result.warnings).toContain("transcript_unavailable");
    expect(callTool).toHaveBeenCalledWith("get_meetings", { meeting_ids: ["meeting-1"] });
  });
});
