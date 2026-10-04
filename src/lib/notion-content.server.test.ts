import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentConnection } from "./content-connections.server";
import {
  completeNotionConnectionForUser,
  createNotionAdapter,
  exchangeNotionCode,
  notionAuthorizationUrl,
  notionReady,
} from "./notion-content.server";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.NOTION_CLIENT_ID = "notion-client";
  process.env.NOTION_CLIENT_SECRET = "notion-secret";
  process.env.NOTION_REDIRECT_URI = "https://app.test.example.com/integrations/notion/callback";
  process.env.CONTENT_CONNECTION_ENCRYPTION_KEY = `hex:${"ab".repeat(32)}`;
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

const connection: ContentConnection = {
  id: "11111111-1111-4111-8111-111111111111",
  userId: "owner",
  provider: "notion",
  externalAccountId: "workspace-1",
  displayName: "Creator HQ",
  status: "active",
  scopes: ["read_content"],
  selectedResources: { ids: ["page-1"] },
  metadata: {},
  syncCursor: null,
  accessTokenCiphertext: "encrypted-token",
  refreshTokenCiphertext: null,
  tokenExpiresAt: null,
};

function jsonResponse(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("Notion Content authorization", () => {
  it("requires the dedicated Content encryption key", () => {
    delete process.env.CONTENT_CONNECTION_ENCRYPTION_KEY;
    expect(notionReady()).toBe(false);
  });

  it("uses the official public OAuth flow and a creator-bound state", () => {
    expect(notionReady()).toBe(true);
    const url = new URL(notionAuthorizationUrl("11111111-1111-4111-8111-111111111111"));
    expect(url.origin + url.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("notion-client");
    expect(url.searchParams.get("owner")).toBe("user");
    expect(url.searchParams.get("state")).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("exchanges codes with Basic auth without placing credentials in the body", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        access_token: "provider-access-token",
        workspace_id: "workspace-1",
        workspace_name: "Creator HQ",
        bot_id: "bot-1",
        owner: { type: "user", user: { id: "notion-user" } },
      }),
    );
    await expect(exchangeNotionCode("code-1", fetcher)).resolves.toMatchObject({
      workspace_id: "workspace-1",
    });
    const [, init] = fetcher.mock.calls[0];
    expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic /);
    expect(String(init?.body)).not.toContain("notion-secret");
  });

  it("consumes creator-bound state before saving a token and returns only safe identity", async () => {
    const save = vi.fn(async () => undefined);
    const result = await completeNotionConnectionForUser(
      "owner",
      { code: "code-1", state: "11111111-1111-4111-8111-111111111111" },
      {
        consumeState: vi.fn(async () => ({ metadata: {} })),
        exchange: vi.fn(async () => ({
          access_token: "provider-access-token",
          workspace_id: "workspace-1",
          workspace_name: "Creator HQ",
          bot_id: "bot-1",
        })),
        save,
      },
    );
    expect(save).toHaveBeenCalledWith(
      "owner",
      expect.objectContaining({ workspace_id: "workspace-1" }),
    );
    expect(result).toEqual({ workspaceId: "workspace-1", displayName: "Creator HQ" });
    expect(JSON.stringify(result)).not.toContain("provider-access-token");
  });
});

describe("Notion Content adapter", () => {
  it("lists only API-visible pages", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        results: [
          {
            object: "page",
            id: "page-1",
            url: "https://www.notion.so/page-1",
            properties: { Name: { type: "title", title: [{ plain_text: "Launch plan" }] } },
          },
          { object: "data_source", id: "data-source-1", title: [] },
        ],
        has_more: false,
        next_cursor: null,
      }),
    );
    const adapter = createNotionAdapter({
      fetch: fetcher,
      decrypt: vi.fn(async () => "provider-access-token"),
    });
    await expect(adapter.listResources(connection)).resolves.toEqual([
      { id: "page-1", name: "Launch plan", type: "page" },
    ]);
  });

  it("imports bounded block text only from selected pages", async () => {
    const requested: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/v1/pages/page-1")) {
        return jsonResponse({
          object: "page",
          id: "page-1",
          url: "https://www.notion.so/page-1",
          last_edited_time: "2026-09-19T10:00:00.000Z",
          properties: { Name: { type: "title", title: [{ plain_text: "Launch plan" }] } },
        });
      }
      if (url.includes("/v1/blocks/page-1/children")) {
        if (url.includes("start_cursor=cursor-2")) {
          return jsonResponse({
            results: [
              {
                id: "block-2",
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "The launch is next week." }] },
                has_children: false,
              },
            ],
            has_more: false,
            next_cursor: null,
          });
        }
        return jsonResponse({
          results: [
            {
              id: "block-1",
              type: "paragraph",
              paragraph: { rich_text: [{ plain_text: "We are building for creators." }] },
              has_children: false,
            },
          ],
          has_more: true,
          next_cursor: "cursor-2",
        });
      }
      throw new Error(`Unexpected Notion request: ${url}`);
    });
    const adapter = createNotionAdapter({
      fetch: fetcher,
      decrypt: vi.fn(async () => "provider-access-token"),
      now: () => new Date("2026-09-19T11:00:00.000Z"),
    });
    const result = await adapter.sync(connection);
    expect(result.records).toEqual([
      expect.objectContaining({
        provider: "notion",
        externalItemId: "page-1",
        title: "Launch plan",
        text: "We are building for creators.\nThe launch is next week.",
      }),
    ]);
    expect(result.cursor).toBe("2026-09-19T11:00:00.000Z");
    expect(requested.some((url) => url.includes("unselected"))).toBe(false);
    expect(requested).toHaveLength(3);
  });
});
