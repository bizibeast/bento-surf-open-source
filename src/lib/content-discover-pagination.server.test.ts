import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DISCOVER_PAGE_PLATFORMS,
  initialDiscoverPagination,
  loadDiscoverSourcePage,
  type DiscoverPageDependencies,
} from "./content-discover-pagination.server";
import type { DiscoverPageCacheRow } from "./content-discover-page-cache.server";
import type { ContentSourceItem } from "./content-sources.server";
import { evaluateDiscoverQuality } from "./content-discover-quality";

const now = () => new Date("2026-10-11T12:00:00Z");
const input = {
  userId: "a1000000-0000-4000-8000-000000000001",
  directionKey: "comedy:en:us",
  platform: "YouTube",
  nicheKeywords: ["comedy"],
  creatorNames: ["Trevor Noah"],
  language: "en",
  region: "us",
};
const post = (id: string, platform = "YouTube", eligible = false): ContentSourceItem => ({
  canonicalUrl: `https://example.com/posts/${platform.replaceAll(" ", "-")}/${id}`,
  title: `Comedy inspiration ${id}`,
  summary: "A recent comedy post.",
  sourceName: platform,
  platform,
  kind: "social_search",
  publishedAt: "2026-10-10T12:00:00Z",
  retrievedAt: now().toISOString(),
  ...(eligible ? { stats: { followers: 10_000, views: 20_000, likes: 200, comments: 20 } } : {}),
});
const sourcePage = (items: ContentSourceItem[] = [], nextCursor: string | null = null) => ({
  items,
  nextCursor,
  hasMore: nextCursor !== null,
  warnings: [] as string[],
});
const cachedPage = (overrides: Partial<DiscoverPageCacheRow> = {}): DiscoverPageCacheRow => ({
  id: crypto.randomUUID(),
  items: [post("prior")],
  state: { platforms: { YouTube: "prior-token" }, offset: 1 },
  hasMore: true,
  warnings: [],
  expiresAt: "2026-10-11T18:00:00.000Z",
  ...overrides,
});

function dependencies() {
  type Request = Parameters<DiscoverPageDependencies["read"]>[0];
  const rows: Array<{ request: Request; page: DiscoverPageCacheRow }> = [];
  const sameScope = (a: Request, b: Omit<Request, "requestKey">) =>
    a.userId === b.userId && a.directionKey === b.directionKey && a.platform === b.platform;
  const read = vi.fn<DiscoverPageDependencies["read"]>(async (request) => {
    const row = rows.find(
      (row) => sameScope(row.request, request) && row.request.requestKey === request.requestKey,
    );
    return row ? structuredClone(row.page) : null;
  });
  const readCursor = vi.fn<DiscoverPageDependencies["readCursor"]>(async (request) => {
    const row = rows.find(
      (row) => sameScope(row.request, request) && row.page.id === request.cursor,
    );
    return row ? structuredClone(row.page) : null;
  });
  const save = vi.fn<DiscoverPageDependencies["save"]>(async (request) => {
    const page = cachedPage({
      items: request.items,
      state: request.state,
      hasMore: request.hasMore,
      warnings: request.warnings,
    });
    rows.push(structuredClone({ request, page }));
    return page;
  });
  return {
    rows,
    read,
    readCursor,
    save,
    fetch: vi.fn<DiscoverPageDependencies["fetch"]>(async () => sourcePage()),
    enrich: vi.fn<DiscoverPageDependencies["enrich"]>(async (items) => items),
    assertCurrent: vi.fn<DiscoverPageDependencies["assertCurrent"]>(async () => {}),
    now,
  };
}

describe("Discover page coordination", () => {
  it("replays an immutable cached page without fetching or enriching again", async () => {
    const deps = dependencies();
    deps.fetch.mockResolvedValue(sourcePage([post("first", "YouTube", true)], "next"));
    const first = await loadDiscoverSourcePage(input, deps);
    deps.fetch.mockClear();
    deps.enrich.mockClear();
    deps.save.mockClear();
    deps.assertCurrent.mockClear();
    const repeated = await loadDiscoverSourcePage(input, deps);
    expect(repeated).toEqual(first);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.enrich).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.assertCurrent).not.toHaveBeenCalled();
    expect(deps.read).toHaveBeenLastCalledWith({
      userId: input.userId,
      directionKey: input.directionKey,
      platform: input.platform,
      requestKey: createHash("sha256").update("first:2026-10-11").digest("hex"),
    });
  });

  it("retries only unknown cache-hit metadata within eight seconds without changing persisted pages", async () => {
    const deps = dependencies();
    const eligible = post("eligible", "YouTube", true);
    const unknownFollowers = post("missing-followers");
    const unknownPublication = { ...post("missing-date", "YouTube", true), publishedAt: null };
    const unknownTraction = { ...post("missing-traction"), stats: { followers: 10_000 } };
    const smallAudience = {
      ...post("small", "YouTube", true),
      stats: { followers: 100, views: 20_000 },
    };
    const lowTraction = {
      ...post("low", "YouTube", true),
      stats: { followers: 10_000, views: 100 },
    };
    const prior = cachedPage({
      items: [
        eligible,
        unknownFollowers,
        unknownPublication,
        unknownTraction,
        smallAudience,
        lowTraction,
      ],
    });
    deps.read.mockResolvedValue(prior);
    deps.enrich.mockImplementation(async (items) =>
      items.map((item) => ({
        ...item,
        publishedAt: eligible.publishedAt,
        stats: eligible.stats,
      })),
    );
    const page = await loadDiscoverSourcePage(input, deps);
    expect(deps.enrich).toHaveBeenCalledExactlyOnceWith(
      [unknownFollowers, unknownPublication, unknownTraction],
      { timeoutMs: 8_000 },
    );
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
    expect(page.id).toBe(prior.id);
    expect(page.state).toBe(prior.state);
    expect(page.expiresAt).toBe(prior.expiresAt);
    expect(page.items[0]).toBe(eligible);
    expect(page.items[4]).toBe(smallAudience);
    expect(page.items[5]).toBe(lowTraction);
    expect(
      page.items
        .slice(0, 4)
        .every((item) => evaluateDiscoverQuality(item, now().getTime()).eligible),
    ).toBe(true);
    expect(prior.items[1].stats).toBeUndefined();
    expect(prior.items[2].publishedAt).toBeNull();
  });

  it("retains a cached page when optional metadata retry fails", async () => {
    const deps = dependencies();
    const prior = cachedPage();
    deps.read.mockResolvedValue(prior);
    deps.enrich.mockRejectedValue(new Error("Metadata timed out"));
    expect(await loadDiscoverSourcePage(input, deps)).toEqual(prior);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
  });

  it.each([
    { userId: "a1000000-0000-4000-8000-000000000002" },
    { directionKey: "lifestyle:en:us" },
    { platform: "Instagram" },
    { cursor: "missing-or-expired-cursor" },
  ])(
    "rejects an unknown or incorrectly scoped continuation before fetching: %j",
    async (changed) => {
      const deps = dependencies();
      const first = await loadDiscoverSourcePage(input, deps);
      deps.fetch.mockClear();
      deps.enrich.mockClear();
      deps.save.mockClear();
      await expect(
        loadDiscoverSourcePage({ ...input, cursor: first.id, ...changed }, deps),
      ).rejects.toThrow("continuation expired");
      expect(deps.fetch).not.toHaveBeenCalled();
      expect(deps.enrich).not.toHaveBeenCalled();
      expect(deps.save).not.toHaveBeenCalled();
    },
  );

  it("follows real continuations across empty and below-quality pages without inventing exhaustion", async () => {
    const deps = dependencies();
    deps.fetch
      .mockResolvedValueOnce(sourcePage([], "page-two"))
      .mockResolvedValueOnce(sourcePage([post("unverified")], "page-three"))
      .mockResolvedValueOnce(sourcePage([post("qualified", "YouTube", true)], "page-four"));
    const first = await loadDiscoverSourcePage(input, deps);
    expect(deps.fetch.mock.calls.map(([request]) => request.cursor)).toEqual([
      null,
      "page-two",
      "page-three",
    ]);
    expect(first.state.platforms).toEqual({ YouTube: "page-four" });
    expect(first.hasMore).toBe(true);
    expect(first.items.map((item) => item.title)).toEqual([
      post("unverified").title,
      post("qualified").title,
    ]);
    deps.fetch.mockClear();
    deps.fetch.mockResolvedValue(sourcePage([post("last", "YouTube", true)]));
    const second = await loadDiscoverSourcePage({ ...input, cursor: first.id }, deps);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.fetch.mock.calls[0][0].cursor).toBe("page-four");
    expect(second.hasMore).toBe(false);
    expect(second.state.platforms).toEqual({ YouTube: false });
    expect(first.state.platforms).toEqual({ YouTube: "page-four" });
    expect(deps.read).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requestKey: createHash("sha256").update(first.id).digest("hex"),
      }),
    );
  });

  it("keeps all-platform browsing round-robin across opaque pages", async () => {
    const deps = dependencies();
    deps.fetch.mockImplementation(async (request) => sourcePage([], `${request.platform}-next`));
    const first = await loadDiscoverSourcePage({ ...input, platform: "all" }, deps);
    const second = await loadDiscoverSourcePage(
      { ...input, platform: "all", cursor: first.id },
      deps,
    );
    const third = await loadDiscoverSourcePage(
      { ...input, platform: "all", cursor: second.id },
      deps,
    );
    expect(deps.fetch.mock.calls.map(([request]) => request.platform)).toEqual([
      ...DISCOVER_PAGE_PLATFORMS,
    ]);
    expect(third.state.offset).toBe(9);
    expect(third.hasMore).toBe(true);
    expect(first.state.platforms.LinkedIn).toBeNull();
    expect(first.state.offset).toBe(3);
  });

  it("prioritizes preferred supported platforms once and isolates a selected platform", async () => {
    const deps = dependencies();
    const preferredPlatforms = ["Reddit", "Reddit", "unsupported", "Instagram"];
    await loadDiscoverSourcePage({ ...input, platform: "all", preferredPlatforms }, deps);
    expect(deps.fetch.mock.calls.map(([request]) => request.platform)).toEqual([
      "Reddit",
      "Instagram",
      "YouTube",
    ]);
    deps.fetch.mockClear();
    deps.fetch.mockResolvedValue(sourcePage([], "more-instagram"));
    const selected = await loadDiscoverSourcePage(
      { ...input, platform: "Instagram", preferredPlatforms },
      deps,
    );
    expect(deps.fetch.mock.calls.map(([request]) => request.platform)).toEqual([
      "Instagram",
      "Instagram",
      "Instagram",
    ]);
    expect(Object.keys(selected.state.platforms)).toEqual(["Instagram"]);
  });

  it("keeps a failed source's original token and successful platforms' progress", async () => {
    const deps = dependencies();
    const prior = cachedPage({
      state: {
        platforms: { YouTube: "valid-youtube-token", Instagram: null, TikTok: null },
        offset: 0,
      },
    });
    deps.readCursor.mockResolvedValue(prior);
    deps.fetch
      .mockRejectedValueOnce(new Error("Upstream timed out"))
      .mockResolvedValueOnce(sourcePage([post("instagram", "Instagram")], "instagram-next"))
      .mockResolvedValueOnce(sourcePage([post("tiktok", "TikTok")], "tiktok-next"));
    const page = await loadDiscoverSourcePage(
      { ...input, platform: "all", cursor: prior.id },
      deps,
    );
    expect(page.state.platforms).toMatchObject({
      YouTube: "valid-youtube-token",
      Instagram: "instagram-next",
      TikTok: "tiktok-next",
    });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.warnings).toContain("YouTube: Upstream timed out");
    expect(prior.state.platforms.Instagram).toBeNull();
  });

  it("never resets a valid token or keeps items from an interrupted continuation", async () => {
    const deps = dependencies();
    const prior = cachedPage({
      state: {
        platforms: Object.fromEntries(
          DISCOVER_PAGE_PLATFORMS.map((platform) => [
            platform,
            platform === "YouTube"
              ? "valid-youtube-token"
              : platform === "Instagram"
                ? null
                : false,
          ]),
        ),
        offset: 0,
      },
    });
    deps.readCursor.mockResolvedValue(prior);
    deps.fetch
      .mockResolvedValueOnce({ ...sourcePage([post("invalid")]), hasMore: true })
      .mockResolvedValueOnce(sourcePage([post("instagram", "Instagram")]));
    const page = await loadDiscoverSourcePage(
      { ...input, platform: "all", cursor: prior.id },
      deps,
    );
    expect(page.state.platforms.YouTube).toBe("valid-youtube-token");
    expect(page.state.platforms.Instagram).toBe(false);
    expect(page.items).toEqual([post("instagram", "Instagram")]);
    expect(page.hasMore).toBe(true);
    expect(page.warnings).toContain("YouTube: Source continuation was interrupted.");
  });

  it("does not cache or exhaust a source when every attempted fetch fails", async () => {
    const deps = dependencies();
    const prior = cachedPage();
    deps.readCursor.mockResolvedValue(prior);
    deps.fetch.mockRejectedValue(new Error("Upstream reset"));
    await expect(loadDiscoverSourcePage({ ...input, cursor: prior.id }, deps)).rejects.toThrow(
      "temporarily unavailable",
    );
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.fetch.mock.calls[0][0].cursor).toBe("prior-token");
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.enrich).not.toHaveBeenCalled();
    expect(prior.state.platforms.YouTube).toBe("prior-token");
  });

  it("does not let duplicate qualifying posts stop continuation before fresh posts arrive", async () => {
    const deps = dependencies();
    const duplicates = Array.from({ length: 10 }, (_, index) =>
      post(`same-${index}`, "YouTube", true),
    );
    deps.fetch
      .mockResolvedValueOnce(sourcePage(duplicates, "second"))
      .mockResolvedValueOnce(sourcePage(duplicates, "third"))
      .mockResolvedValueOnce(sourcePage([post("fresh", "YouTube", true)]));
    const page = await loadDiscoverSourcePage(input, deps);
    expect(deps.fetch).toHaveBeenCalledTimes(3);
    expect(page.items).toHaveLength(11);
    expect(new Set(page.items.map((item) => item.canonicalUrl)).size).toBe(11);
    expect(page.hasMore).toBe(false);
  });

  it("bounds a source request to three provider pages and one 150-item enrichment batch", async () => {
    const deps = dependencies();
    let next = 0;
    deps.fetch.mockImplementation(async () =>
      sourcePage(
        Array.from({ length: 50 }, () => post(`candidate-${next++}`)),
        `continue-${next}`,
      ),
    );
    const page = await loadDiscoverSourcePage(input, deps);
    expect(deps.fetch).toHaveBeenCalledTimes(3);
    expect(deps.enrich).toHaveBeenCalledTimes(1);
    expect(deps.enrich.mock.calls[0][0]).toHaveLength(150);
    expect(page.items).toHaveLength(150);
    expect(page.state.platforms.YouTube).toBe("continue-150");
    expect(page.hasMore).toBe(true);
    expect(deps.assertCurrent.mock.invocationCallOrder[0]).toBeLessThan(
      deps.save.mock.invocationCallOrder[0],
    );
  });

  it("stops after one page of unique qualifying posts and fences cache writes against a lost lease", async () => {
    const deps = dependencies();
    deps.fetch.mockResolvedValue(
      sourcePage(
        Array.from({ length: 18 }, (_, index) => post(`qualified-${index}`, "YouTube", true)),
        "more",
      ),
    );
    deps.assertCurrent.mockRejectedValue(new Error("Refresh lease expired"));
    await expect(loadDiscoverSourcePage(input, deps)).rejects.toThrow("lease expired");
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.enrich).toHaveBeenCalledTimes(1);
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("returns the same terminal page without refetching and initializes every platform consistently", async () => {
    const deps = dependencies();
    const first = await loadDiscoverSourcePage(input, deps);
    deps.fetch.mockClear();
    deps.save.mockClear();
    expect(await loadDiscoverSourcePage({ ...input, cursor: first.id }, deps)).toEqual(first);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
    expect(Object.keys(initialDiscoverPagination())).toEqual(["all", ...DISCOVER_PAGE_PLATFORMS]);
    expect(Object.values(initialDiscoverPagination(false))).toEqual(
      Array.from({ length: 10 }, () => ({ cursor: null, hasMore: false })),
    );
    await expect(
      loadDiscoverSourcePage({ ...input, platform: "unsupported" }, deps),
    ).rejects.toThrow("supported Discover platform");
  });
});
