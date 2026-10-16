import { expect, it, vi } from "vitest";
import {
  fetchTrackedCreatorPosts,
  researchDiscoverFollows,
} from "./content-discover-follows.server";
import type { TrackedDiscoverCreator } from "./content-discover-creators";
import type { ContentSourceItem } from "./content-sources.server";

const now = new Date("2026-10-11T00:00:00Z");
const locale = { language: "en", region: "global" };
const creator = (id: string): TrackedDiscoverCreator => ({
  id,
  name: `Creator ${id}`,
  platform: "Instagram",
  profileUrl: `https://www.instagram.com/creator${id}`,
  topics: "",
  avatarUrl: null,
});
const source = (
  id: string,
  publishedAt: string | null = "2026-10-10T00:00:00Z",
): ContentSourceItem => ({
  canonicalUrl: `https://www.instagram.com/p/Recent${id}/`,
  authorUrl: creator(id).profileUrl,
  title: `Recent post ${id}`,
  summary: "",
  sourceName: "Instagram",
  kind: "social_search",
  publishedAt,
  retrievedAt: now.toISOString(),
});

it("searches the last month and excludes old or unrelated posts after enrichment", async () => {
  const fresh = source("1");
  const undated = { ...source("1", null), canonicalUrl: "https://www.instagram.com/p/Undated1/" };
  const old = {
    ...source("1", "2023-01-01T00:00:00Z"),
    canonicalUrl: "https://www.instagram.com/p/Old1/",
  };
  const wrong = source("2");
  const dependencies = {
    search: vi.fn().mockResolvedValue([fresh, undated, old, wrong]),
    reddit: vi.fn(),
    enrich: vi.fn(async (items: ContentSourceItem[]) => items),
  };
  const result = await fetchTrackedCreatorPosts(creator("1"), locale, dependencies, { now });
  expect(dependencies.search).toHaveBeenCalledWith(
    expect.objectContaining({ windowDays: 30, limit: 20 }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(dependencies.enrich).toHaveBeenCalledWith(
    [fresh, undated, wrong],
    expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 8000 }),
  );
  expect(result).toEqual([fresh, undated]);
});

it("filters dates learned during enrichment instead of trusting the search time window alone", async () => {
  const undated = source("1", null);
  const dependencies = {
    search: vi.fn().mockResolvedValue([undated]),
    reddit: vi.fn(),
    enrich: vi.fn().mockResolvedValue([{ ...undated, publishedAt: "2023-01-01T00:00:00Z" }]),
  };
  expect(await fetchTrackedCreatorPosts(creator("1"), locale, dependencies, { now })).toEqual([]);
});

it("uses fresh directly observed Reddit posts without spending a search request", async () => {
  const followed = {
    ...creator("1"),
    platform: "Reddit",
    profileUrl: "https://www.reddit.com/r/lifestyle",
  };
  const fresh = {
    ...source("1"),
    canonicalUrl: "https://www.reddit.com/r/lifestyle/comments/new/story",
    authorUrl: null,
  };
  const old = {
    ...fresh,
    canonicalUrl: "https://www.reddit.com/r/lifestyle/comments/old/story",
    publishedAt: "2023-01-01T00:00:00Z",
  };
  const dependencies = {
    reddit: vi.fn().mockResolvedValue([fresh, old]),
    search: vi.fn(),
    enrich: vi.fn(),
  };
  expect(await fetchTrackedCreatorPosts(followed, locale, dependencies, { now })).toEqual([fresh]);
  expect(dependencies.reddit).toHaveBeenCalledWith(
    "",
    expect.objectContaining({ windowDays: 30, now, signal: expect.any(AbortSignal) }),
  );
  expect(dependencies.search).not.toHaveBeenCalled();
});

it("rotates a large follow list by least recently checked, leaving unattempted status untouched", async () => {
  const creators = Array.from({ length: 15 }, (_, index) => ({
    ...creator(String(index)),
    lastCheckedAt: new Date(now.getTime() - (15 - index) * 86400000).toISOString(),
  }));
  creators[14].lastCheckedAt = "";
  const fetchPosts = vi
    .fn<typeof fetchTrackedCreatorPosts>()
    .mockImplementation(async (item) => [source(item.id)]);
  const saveStatus = vi.fn(async () => {});
  const result = await researchDiscoverFollows(
    "owner",
    creators,
    locale,
    { now },
    { fetchPosts, saveStatus },
  );
  const checked = fetchPosts.mock.calls.map(([item]) => item.id);
  expect(result).toHaveLength(12);
  expect(checked[0]).toBe("14");
  expect(new Set(checked)).toEqual(
    new Set(["14", ...Array.from({ length: 11 }, (_, index) => String(index))]),
  );
  expect(saveStatus).toHaveBeenCalledTimes(12);
  const second = creators.map((item) =>
    checked.includes(item.id) ? { ...item, lastCheckedAt: now.toISOString() } : item,
  );
  fetchPosts.mockClear();
  await researchDiscoverFollows("owner", second, locale, { now }, { fetchPosts, saveStatus });
  expect(fetchPosts.mock.calls.slice(0, 3).map(([item]) => item.id)).toEqual(["11", "12", "13"]);
});

it("retains successful posts across other creator failures and status persistence failures", async () => {
  const fetchPosts = vi.fn<typeof fetchTrackedCreatorPosts>().mockImplementation(async (item) => {
    if (item.id === "1") throw new Error("Provider unavailable");
    return [source(item.id)];
  });
  const saveStatus = vi.fn().mockRejectedValue(new Error("Database temporarily unavailable"));
  const result = await researchDiscoverFollows(
    "owner",
    [creator("1"), creator("2"), creator("3")],
    locale,
    { now },
    { fetchPosts, saveStatus },
  );
  expect(result).toEqual([source("2"), source("3")]);
  const failed = saveStatus.mock.calls.find(([, id]) => id === "1");
  expect(failed?.[2]).toEqual({
    last_error: "Provider unavailable",
    last_checked_at: now.toISOString(),
  });
});

it("bounds follow research with one shared deadline and does not mark queued creators checked", async () => {
  const fetchPosts = vi.fn<typeof fetchTrackedCreatorPosts>().mockImplementation(
    async (_creator, _locale, _deps, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      }),
  );
  const saveStatus = vi.fn(async () => {});
  const started = Date.now();
  const result = await researchDiscoverFollows(
    "owner",
    Array.from({ length: 15 }, (_, index) => creator(String(index))),
    locale,
    { timeoutMs: 80, now },
    { fetchPosts, saveStatus },
  );
  expect(result).toEqual([]);
  expect(fetchPosts).toHaveBeenCalledTimes(3);
  expect(saveStatus).toHaveBeenCalledTimes(3);
  expect(Date.now() - started).toBeLessThan(1000);
});

it("deduplicates a post discovered through multiple tracked creators", async () => {
  const fetchPosts = vi.fn<typeof fetchTrackedCreatorPosts>().mockResolvedValue([source("1")]);
  const saveStatus = vi.fn(async () => {});
  expect(
    await researchDiscoverFollows(
      "owner",
      [creator("1"), creator("2")],
      locale,
      { now },
      { fetchPosts, saveStatus },
    ),
  ).toEqual([source("1")]);
});
