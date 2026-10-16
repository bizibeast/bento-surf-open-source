import { expect, it, vi } from "vitest";
import {
  readDiscoverPage,
  readDiscoverPageCursor,
  saveDiscoverPage,
  type DiscoverPageCacheDependencies,
} from "./content-discover-page-cache.server";
import type { ContentSourceItem } from "./content-sources.server";

const USER = "a1000000-0000-4000-8000-000000000001";
const OTHER = "a1000000-0000-4000-8000-000000000002";
const scope = {
  userId: USER,
  directionKey: "comedy:en:in",
  platform: "Instagram",
  requestKey: "a".repeat(64),
};
const source: ContentSourceItem = {
  canonicalUrl: "https://www.instagram.com/p/public-post/",
  title: "Comedy sketch",
  summary: "A public sketch.",
  sourceName: "Instagram",
  platform: "Instagram",
  kind: "social_search",
  author: "A comedian",
  publishedAt: "2026-10-11T00:00:00Z",
  retrievedAt: "2026-10-11T03:00:00Z",
  stats: { likes: 123 },
};
const pageInput = {
  ...scope,
  items: [source],
  state: {
    platforms: { Instagram: "provider-token", YouTube: null, TikTok: false as const },
    offset: 1,
  },
  hasMore: true,
  warnings: ["One source was slow."],
};

function database() {
  let now = new Date("2026-10-11T03:00:00Z");
  const rows: Record<string, unknown>[] = [];
  const errors = new Set<string>();
  const events: Array<{ op: string; filters: Array<[string, string, string]> }> = [];
  const from = vi.fn(() => {
    const query = (
      op: "select" | "delete" | "upsert",
      inserted?: Record<string, unknown>,
      options?: { ignoreDuplicates: boolean },
    ) => {
      const filters: Array<[string, string, string]> = [];
      const execute = () => {
        events.push({ op, filters: [...filters] });
        if (errors.has(op)) return { data: null, error: { message: "Internal database failure" } };
        const matches = (row: Record<string, unknown>) =>
          filters.every(([mode, column, value]) =>
            mode === "eq"
              ? row[column] === value
              : mode === "gt"
                ? String(row[column]) > value
                : String(row[column]) <= value,
          );
        if (op === "delete") {
          for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i])) rows.splice(i, 1);
          return { data: null, error: null };
        }
        if (op === "upsert" && inserted) {
          expect(options?.ignoreDuplicates).toBe(true);
          const duplicate = rows.find((row) =>
            ["user_id", "direction_key", "platform", "request_key"].every(
              (key) => row[key] === inserted[key],
            ),
          );
          if (!duplicate) rows.push({ id: crypto.randomUUID(), ...structuredClone(inserted) });
          return { data: null, error: null };
        }
        return { data: rows.find(matches) || null, error: null };
      };
      const builder = {
        eq(column: string, value: string) {
          filters.push(["eq", column, value]);
          return builder;
        },
        gt(column: string, value: string) {
          filters.push(["gt", column, value]);
          return builder;
        },
        lte(column: string, value: string) {
          filters.push(["lte", column, value]);
          return builder;
        },
        maybeSingle: async () => execute(),
        then(
          resolve: (result: ReturnType<typeof execute>) => unknown,
          reject: (error: unknown) => unknown,
        ) {
          return Promise.resolve(execute()).then(resolve, reject);
        },
      };
      return builder;
    };
    return {
      select: () => query("select"),
      delete: () => query("delete"),
      upsert: (row: Record<string, unknown>, options: { ignoreDuplicates: boolean }) =>
        query("upsert", row, options),
    };
  });
  return {
    rows,
    events,
    errors,
    from,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    dependencies: { db: { from }, now: () => now } as unknown as DiscoverPageCacheDependencies,
  };
}

it("persists an opaque page UUID with public source data and typed continuation state", async () => {
  const db = database();
  const saved = await saveDiscoverPage(pageInput, db.dependencies);
  expect(saved).toEqual({
    id: expect.any(String),
    items: [source],
    state: pageInput.state,
    hasMore: true,
    warnings: pageInput.warnings,
    expiresAt: "2026-10-11T09:00:00.000Z",
  });
  expect(saved.id).toMatch(/^[a-f0-9-]{36}$/);
  expect(await readDiscoverPage(scope, db.dependencies)).toEqual(saved);
  expect(await readDiscoverPageCursor({ ...scope, cursor: saved.id }, db.dependencies)).toEqual(
    saved,
  );
});

it("never exposes a cursor from another user, direction or platform", async () => {
  const db = database();
  const saved = await saveDiscoverPage(pageInput, db.dependencies);
  for (const wrong of [
    { userId: OTHER },
    { directionKey: "lifestyle:en:in" },
    { platform: "YouTube" },
  ]) {
    expect(await readDiscoverPage({ ...scope, ...wrong }, db.dependencies)).toBeNull();
    expect(
      await readDiscoverPageCursor({ ...scope, ...wrong, cursor: saved.id }, db.dependencies),
    ).toBeNull();
  }
  for (const event of db.events.filter((event) => event.op === "select")) {
    expect(event.filters.map(([, column]) => column)).toEqual(
      expect.arrayContaining(["user_id", "direction_key", "platform", "expires_at"]),
    );
  }
});

it("rejects malformed and expired cursors while renewing an expired request with a new page ID", async () => {
  const db = database();
  const saved = await saveDiscoverPage(pageInput, db.dependencies);
  db.from.mockClear();
  expect(
    await readDiscoverPageCursor({ ...scope, cursor: "encoded-provider-token" }, db.dependencies),
  ).toBeNull();
  expect(db.from).not.toHaveBeenCalled();
  db.advance(6 * 60 * 60_000);
  expect(await readDiscoverPage(scope, db.dependencies)).toBeNull();
  expect(await readDiscoverPageCursor({ ...scope, cursor: saved.id }, db.dependencies)).toBeNull();
  const renewed = await saveDiscoverPage(
    { ...pageInput, state: { platforms: { Instagram: false }, offset: 2 }, hasMore: false },
    db.dependencies,
  );
  expect(renewed.id).not.toBe(saved.id);
  expect(renewed.hasMore).toBe(false);
  expect(db.rows).toHaveLength(1);
  expect(await readDiscoverPageCursor({ ...scope, cursor: saved.id }, db.dependencies)).toBeNull();
});

it("returns the same immutable page on replay without extending expiry or overwriting state", async () => {
  const db = database();
  const first = await saveDiscoverPage(pageInput, db.dependencies);
  db.advance(60_000);
  const repeated = await saveDiscoverPage(
    {
      ...pageInput,
      items: [],
      state: { platforms: { Instagram: false }, offset: 200 },
      hasMore: false,
      warnings: [],
    },
    db.dependencies,
  );
  expect(repeated).toEqual(first);
  expect(db.rows).toHaveLength(1);
});

it("cleans the owner's expired cursor pages across directions while preserving live pages and other users", async () => {
  const db = database();
  const first = await saveDiscoverPage(pageInput, db.dependencies);
  const other = await saveDiscoverPage({ ...pageInput, userId: OTHER }, db.dependencies);
  const oldCursor = await saveDiscoverPage(
    {
      ...pageInput,
      platform: "YouTube",
      directionKey: "lifestyle:en:in",
      requestKey: "b".repeat(64),
    },
    db.dependencies,
  );
  db.advance(60_000);
  const live = await saveDiscoverPage(
    { ...pageInput, requestKey: "c".repeat(64) },
    db.dependencies,
  );
  db.advance(6 * 60 * 60_000 - 60_000);
  await saveDiscoverPage(pageInput, db.dependencies);
  expect(db.rows.map((row) => row.id)).toEqual(expect.arrayContaining([other.id, live.id]));
  expect(db.rows.some((row) => row.id === first.id || row.id === oldCursor.id)).toBe(false);
  expect(await readDiscoverPageCursor({ ...scope, cursor: live.id }, db.dependencies)).toEqual(
    live,
  );
});

it("strips Brain and feedback from the stored sources", async () => {
  const db = database();
  const item = {
    ...source,
    feedback: "saved",
    saved: true,
    brain: "private writing context",
    stats: { ...source.stats, privateNote: "private" },
  };
  const saved = await saveDiscoverPage({ ...pageInput, items: [item] }, db.dependencies);
  expect(saved.items).toEqual([source]);
  expect(JSON.stringify(db.rows)).not.toContain("private");
  expect(JSON.stringify(db.rows)).not.toContain("feedback");
});

it.each(["select", "delete", "upsert"])("fails closed when %s fails", async (operation) => {
  const db = database();
  db.errors.add(operation);
  await expect(saveDiscoverPage(pageInput, db.dependencies)).rejects.toThrow(
    "Discover page cache is temporarily unavailable",
  );
});

it("rejects unbounded or malformed state before writing", async () => {
  const db = database();
  await expect(
    saveDiscoverPage(
      { ...pageInput, items: Array.from({ length: 161 }, () => source) },
      db.dependencies,
    ),
  ).rejects.toThrow();
  await expect(
    saveDiscoverPage({ ...pageInput, state: { platforms: {}, offset: -1 } }, db.dependencies),
  ).rejects.toThrow();
  expect(db.from).not.toHaveBeenCalled();
});
