import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentConnection } from "./content-connections.server";
import {
  completeGitHubConnectionForUser,
  createGitHubAdapter,
  createGitHubAppJwt,
  githubAppInstallationUrl,
  githubReady,
} from "./github-content.server";

const originalEnv = { ...process.env };

function base64Pem(bytes: ArrayBuffer) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
}

beforeEach(() => {
  process.env.GITHUB_CONTENT_APP_ID = "12345";
  process.env.GITHUB_CONTENT_APP_SLUG = "bento-content-test";
  process.env.GITHUB_CONTENT_APP_PRIVATE_KEY = "test-key";
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
  provider: "github",
  externalAccountId: "789",
  displayName: "creator",
  status: "active",
  scopes: ["metadata:read", "contents:read", "issues:read", "pull_requests:read"],
  selectedResources: { ids: ["1"] },
  metadata: {},
  syncCursor: null,
  accessTokenCiphertext: null,
  refreshTokenCiphertext: null,
  tokenExpiresAt: null,
};

describe("GitHub Content app", () => {
  it("creates a short-lived RS256 GitHub App JWT", async () => {
    const keys = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const pem = base64Pem(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
    const jwt = await createGitHubAppJwt({
      appId: "12345",
      privateKey: pem,
      nowSeconds: 1_789_750_000,
    });
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    expect(payload).toMatchObject({ iss: "12345", iat: 1_789_749_940, exp: 1_789_750_540 });
  });

  it("starts the official GitHub App installation flow with state", () => {
    expect(githubReady()).toBe(true);
    const url = new URL(githubAppInstallationUrl("11111111-1111-4111-8111-111111111111"));
    expect(url.origin + url.pathname).toBe(
      "https://github.com/apps/bento-content-test/installations/new",
    );
    expect(url.searchParams.get("state")).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("consumes creator state and saves only installation identity", async () => {
    const save = vi.fn(async () => undefined);
    const result = await completeGitHubConnectionForUser(
      "owner",
      { installationId: "789", state: "11111111-1111-4111-8111-111111111111" },
      {
        consumeState: vi.fn(async () => ({ metadata: {} })),
        installationInfo: vi.fn(async () => ({
          accountId: "42",
          displayName: "creator",
          accountType: "User",
        })),
        save,
      },
    );
    expect(result).toEqual({ installationId: "789", displayName: "creator" });
    expect(save).toHaveBeenCalledWith(
      "owner",
      expect.objectContaining({ installationId: "789", displayName: "creator" }),
    );
    expect(JSON.stringify(result)).not.toContain("token");
  });
});

describe("GitHub Content adapter", () => {
  it("imports selected repository activity without reading file bodies", async () => {
    const requested: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/installation/repositories")) {
        return json({
          repositories: [
            { id: 1, full_name: "creator/product", html_url: "https://github.com/creator/product" },
          ],
        });
      }
      if (url.includes("/commits")) {
        return json([
          {
            sha: "abc",
            html_url: "https://github.com/creator/product/commit/abc",
            commit: { message: "Ship content agent", author: { date: "2026-09-19T10:00:00.000Z" } },
          },
        ]);
      }
      if (url.includes("/issues")) {
        return json([
          {
            id: 2,
            number: 2,
            title: "Improve onboarding",
            body: "Make setup easier",
            html_url: "https://github.com/creator/product/issues/2",
            updated_at: "2026-09-19T10:10:00.000Z",
          },
        ]);
      }
      if (url.includes("/pulls")) {
        return json([
          {
            id: 3,
            number: 3,
            title: "Add Brain sources",
            body: "Connect sources",
            html_url: "https://github.com/creator/product/pull/3",
            updated_at: "2026-09-19T10:20:00.000Z",
          },
        ]);
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    });
    const adapter = createGitHubAdapter({
      fetch: fetcher,
      installationToken: vi.fn(async () => "installation-token"),
      now: () => new Date("2026-09-19T11:00:00.000Z"),
    });
    const result = await adapter.sync(connection);
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "commit", externalItemId: "1:commit:abc" }),
        expect.objectContaining({ type: "issue", externalItemId: "1:issue:2" }),
        expect.objectContaining({ type: "pull_request", externalItemId: "1:pull_request:3" }),
      ]),
    );
    expect(result.cursor).toBe("2026-09-19T11:00:00.000Z");
    expect(requested.some((url) => /contents|git\/blobs|actions/.test(url))).toBe(false);
  });
});
