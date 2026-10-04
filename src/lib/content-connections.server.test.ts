import { describe, expect, it, vi } from "vitest";
import {
  consumeContentOAuthState,
  createContentOAuthState,
  deleteContentConnectionDataForUser,
  disconnectContentConnectionForUser,
  syncContentConnectionWithAdapter,
  updateContentResourceSelectionWithAdapter,
  type ContentConnection,
  type ContentDataStore,
  type ContentOAuthStateStore,
  type ContentSyncStore,
} from "./content-connections.server";

const connection: ContentConnection = {
  id: "11111111-1111-4111-8111-111111111111",
  userId: "owner",
  provider: "notion",
  externalAccountId: "workspace",
  displayName: "Workspace",
  status: "active",
  scopes: [],
  selectedResources: {},
  metadata: {},
  syncCursor: "cursor-before",
  accessTokenCiphertext: "encrypted",
  refreshTokenCiphertext: null,
  tokenExpiresAt: null,
};

function memoryStateStore(): ContentOAuthStateStore {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    async insert(row) {
      rows.set(row.state, row);
    },
    async consume({ state, userId, provider, now }) {
      const row = rows.get(state);
      if (
        !row ||
        row.user_id !== userId ||
        row.provider !== provider ||
        String(row.expires_at) <= now
      )
        return null;
      rows.delete(state);
      return { metadata: row.metadata as Record<string, unknown> };
    },
  };
}

describe("Content connection OAuth states", () => {
  it("binds state to one creator and provider and consumes it once", async () => {
    const store = memoryStateStore();
    const now = new Date("2026-09-19T10:00:00.000Z");
    const state = await createContentOAuthState(
      { userId: "owner", provider: "notion", metadata: { redirectUri: "https://app.test" } },
      store,
      now,
    );

    await expect(
      consumeContentOAuthState({ userId: "other", provider: "notion", state }, store, now),
    ).resolves.toBeNull();
    await expect(
      consumeContentOAuthState({ userId: "owner", provider: "slack", state }, store, now),
    ).resolves.toBeNull();
    await expect(
      consumeContentOAuthState({ userId: "owner", provider: "notion", state }, store, now),
    ).resolves.toEqual({ metadata: { redirectUri: "https://app.test" } });
    await expect(
      consumeContentOAuthState({ userId: "owner", provider: "notion", state }, store, now),
    ).resolves.toBeNull();
  });
});

describe("Content connection sync", () => {
  it("stores normalized records before advancing the durable cursor", async () => {
    const calls: string[] = [];
    const store: ContentSyncStore = {
      loadConnection: vi.fn(async () => connection),
      markAttempt: vi.fn(async () => calls.push("attempt")),
      upsertSources: vi.fn(async (rows) => {
        calls.push(`upsert:${rows.length}`);
      }),
      complete: vi.fn(async () => calls.push("complete")),
      fail: vi.fn(async () => calls.push("fail")),
    };
    const result = await syncContentConnectionWithAdapter(
      "owner",
      connection.id,
      {
        provider: "notion",
        async listResources() {
          return [];
        },
        async sync() {
          return {
            records: [
              {
                provider: "notion",
                externalItemId: "page-1",
                type: "page",
                title: "Launch plan",
                text: "Ship carefully",
                sourceUrl: "https://notion.so/page-1",
              },
            ],
            cursor: "cursor-after",
            warnings: [],
          };
        },
      },
      store,
    );

    expect(calls).toEqual(["attempt", "upsert:1", "complete"]);
    expect(result).toEqual({ imported: 1, warnings: [] });
    expect(store.complete).toHaveBeenCalledWith(
      "owner",
      connection.id,
      expect.objectContaining({ cursor: "cursor-after", imported: 1 }),
    );
  });

  it("preserves the previous cursor when persistence fails", async () => {
    const store: ContentSyncStore = {
      loadConnection: vi.fn(async () => connection),
      markAttempt: vi.fn(async () => undefined),
      upsertSources: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
      complete: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    };
    await expect(
      syncContentConnectionWithAdapter(
        "owner",
        connection.id,
        {
          provider: "notion",
          async listResources() {
            return [];
          },
          async sync() {
            return {
              records: [
                {
                  provider: "notion",
                  externalItemId: "page-1",
                  type: "page",
                  title: "Launch plan",
                  text: "Ship carefully",
                },
              ],
              cursor: "must-not-advance",
            };
          },
        },
        store,
      ),
    ).rejects.toThrow("database unavailable");
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.fail).toHaveBeenCalledWith("owner", connection.id, "database unavailable", false);
  });

  it("enforces creator resource selection against provider-visible resources", async () => {
    const updateSelection = vi.fn(async () => undefined);
    const store = {
      loadConnection: vi.fn(async () => connection),
      updateSelection,
    };
    const adapter = {
      provider: "notion" as const,
      async listResources() {
        return [
          { id: "page-1", name: "Launch", type: "page" },
          { id: "page-2", name: "Ideas", type: "page" },
        ];
      },
      async sync() {
        return { records: [], cursor: null };
      },
    };

    await expect(
      updateContentResourceSelectionWithAdapter("owner", connection.id, ["page-3"], adapter, store),
    ).rejects.toThrow("not available");
    await updateContentResourceSelectionWithAdapter(
      "owner",
      connection.id,
      ["page-2"],
      adapter,
      store,
    );
    expect(updateSelection).toHaveBeenCalledWith("owner", connection.id, {
      ids: ["page-2"],
    });
  });
});

describe("Content connection deletion", () => {
  it("disconnects credentials without deleting confirmed Brain knowledge", async () => {
    const store: ContentDataStore = {
      disconnect: vi.fn(async () => true),
      deleteSources: vi.fn(async () => undefined),
      deleteBrain: vi.fn(async () => undefined),
      deleteConnection: vi.fn(async () => true),
    };
    await disconnectContentConnectionForUser("owner", connection.id, store);
    expect(store.disconnect).toHaveBeenCalledWith("owner", connection.id);
    expect(store.deleteBrain).not.toHaveBeenCalled();
  });

  it("supports cached-only and explicit full provider-data deletion", async () => {
    const store: ContentDataStore = {
      disconnect: vi.fn(async () => true),
      deleteSources: vi.fn(async () => undefined),
      deleteBrain: vi.fn(async () => undefined),
      deleteConnection: vi.fn(async () => true),
    };
    await deleteContentConnectionDataForUser("owner", connection.id, false, store);
    expect(store.deleteSources).toHaveBeenCalledWith("owner", connection.id);
    expect(store.deleteBrain).toHaveBeenCalledWith("owner", connection.id, false);
    expect(store.deleteConnection).not.toHaveBeenCalled();

    await deleteContentConnectionDataForUser("owner", connection.id, true, store);
    expect(store.deleteBrain).toHaveBeenCalledWith("owner", connection.id, true);
    expect(store.deleteConnection).toHaveBeenCalledWith("owner", connection.id);
  });
});
