import { describe, expect, it, vi } from "vitest";
import {
  fetchDiscoverSourcePage,
  type DiscoverSourcePageInput,
} from "./content-discover-source-pages.server";
import type { ContentSourceItem } from "./content-sources.server";

const input: DiscoverSourcePageInput = {
  nicheKeywords: ["comedy"],
  creatorNames: ["Trevor Noah"],
  platform: "YouTube",
  language: "en",
  region: "us",
};
const now = () => new Date("2026-10-11T12:00:00Z");
const post = (id: string, platform = "YouTube"): ContentSourceItem => ({
  canonicalUrl:
    platform === "YouTube"
      ? `https://youtube.com/watch?v=${id}`
      : `https://www.linkedin.com/posts/creator_${id}`,
  title: `A comedy story ${id}`,
  summary: "A recent creator's video",
  platform,
  sourceName: platform,
  publishedAt: "2026-10-10T10:00:00Z",
  retrievedAt: "2026-10-11T12:00:00Z",
  kind: "social_search",
});

describe("real source continuation", () => {
  it("follows the actual YouTube token and retains all candidates beyond a twenty-card UI", async () => {
    const youtube = vi
      .fn()
      .mockResolvedValueOnce({
        items: Array.from({ length: 50 }, (_, index) => post(`first-${index}`)),
        nextPageToken: "next-official-page",
        configured: true,
      })
      .mockResolvedValueOnce({ items: [post("second")], nextPageToken: null, configured: true });
    const first = await fetchDiscoverSourcePage(input, { youtube, now });
    expect(first.items).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    const second = await fetchDiscoverSourcePage(
      { ...input, cursor: first.nextCursor },
      { youtube, now: () => new Date("2026-10-12T12:00:00Z") },
    );
    expect(youtube.mock.calls[1][1]).toMatchObject({
      pageToken: "next-official-page",
      publishedAfter: "2026-09-11T12:00:00.000Z",
      publishedBefore: "2026-10-11T12:00:00.000Z",
    });
    expect(second.items.map((item) => item.canonicalUrl)).toEqual([post("second").canonicalUrl]);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("advances the requested platform's real offset and excludes other platforms", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce({ items: [post("one", "LinkedIn"), post("wrong")], nextOffset: 10 })
      .mockResolvedValueOnce({ items: [post("two", "LinkedIn")], nextOffset: null });
    const first = await fetchDiscoverSourcePage(
      { ...input, platform: "LinkedIn" },
      { search, now },
    );
    const second = await fetchDiscoverSourcePage(
      { ...input, platform: "LinkedIn", cursor: first.nextCursor },
      { search, now },
    );
    expect(search.mock.calls.map(([query]) => query.start)).toEqual([0, 10]);
    expect(first.items).toHaveLength(1);
    expect(second.items[0].canonicalUrl).toBe(post("two", "LinkedIn").canonicalUrl);
    expect(second.hasMore).toBe(false);
  });

  it("rotates multiple-interest queries while preserving each query's own continuation", async () => {
    const youtube = vi
      .fn()
      .mockResolvedValueOnce({
        items: [post("one")],
        nextPageToken: "first-topic-page-2",
        configured: true,
      })
      .mockResolvedValueOnce({ items: [post("two")], nextPageToken: null, configured: true })
      .mockResolvedValueOnce({ items: [post("three")], nextPageToken: null, configured: true });
    const interests = { ...input, nicheKeywords: ["writing", "comedy", "lifestyle", "cooking"] };
    const first = await fetchDiscoverSourcePage(interests, { youtube, now });
    const second = await fetchDiscoverSourcePage(
      { ...interests, cursor: first.nextCursor },
      { youtube, now },
    );
    const third = await fetchDiscoverSourcePage(
      { ...interests, cursor: second.nextCursor },
      { youtube, now },
    );
    expect(youtube.mock.calls[0][0]).toContain('"comedy" | "cooking" | "lifestyle"');
    expect(youtube.mock.calls[1][0]).toBe('"writing"');
    expect(youtube.mock.calls[2][1].pageToken).toBe("first-topic-page-2");
    expect(third.hasMore).toBe(false);
  });

  it("switches to SERP only when the official API is absent and keeps paginating that provider", async () => {
    const youtube = vi
      .fn()
      .mockResolvedValue({ items: [], nextPageToken: null, configured: false });
    const search = vi
      .fn()
      .mockResolvedValueOnce({ items: [post("one")], nextOffset: 10 })
      .mockResolvedValueOnce({ items: [post("two")], nextOffset: null });
    const first = await fetchDiscoverSourcePage(input, { youtube, search, now });
    const second = await fetchDiscoverSourcePage(
      { ...input, cursor: first.nextCursor },
      { youtube, search, now },
    );
    expect(youtube).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[1][0].start).toBe(10);
    expect(second.hasMore).toBe(false);
  });

  it("stops a source that ignores offsets instead of returning its previous posts forever", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce({ items: [post("one", "LinkedIn")], nextOffset: 10 })
      .mockResolvedValueOnce({ items: [post("one", "LinkedIn")], nextOffset: 20 });
    const first = await fetchDiscoverSourcePage(
      { ...input, platform: "LinkedIn" },
      { search, now },
    );
    const second = await fetchDiscoverSourcePage(
      { ...input, platform: "LinkedIn", cursor: first.nextCursor },
      { search, now },
    );
    expect(second).toMatchObject({ items: [], hasMore: false, nextCursor: null });
    expect(second.warnings).toHaveLength(1);
  });

  it("rejects a cursor reused for a different direction or platform before spending another request", async () => {
    const youtube = vi
      .fn()
      .mockResolvedValue({ items: [post("one")], nextPageToken: "next", configured: true });
    const first = await fetchDiscoverSourcePage(input, { youtube, now });
    await expect(
      fetchDiscoverSourcePage(
        { ...input, nicheKeywords: ["fitness"], cursor: first.nextCursor },
        { youtube, now },
      ),
    ).rejects.toThrow("invalid or expired");
    await expect(
      fetchDiscoverSourcePage(
        { ...input, platform: "Instagram", cursor: first.nextCursor },
        { youtube, now },
      ),
    ).rejects.toThrow("invalid or expired");
    expect(youtube).toHaveBeenCalledTimes(1);
  });

  it("leaves continuation available for retry when a provider request fails", async () => {
    const youtube = vi
      .fn()
      .mockResolvedValueOnce({ items: [post("one")], nextPageToken: "next", configured: true })
      .mockRejectedValueOnce(new Error("Temporary upstream failure"))
      .mockResolvedValueOnce({ items: [post("two")], nextPageToken: null, configured: true });
    const first = await fetchDiscoverSourcePage(input, { youtube, now });
    await expect(
      fetchDiscoverSourcePage({ ...input, cursor: first.nextCursor }, { youtube, now }),
    ).rejects.toThrow("Temporary");
    const recovered = await fetchDiscoverSourcePage(
      { ...input, cursor: first.nextCursor },
      { youtube, now },
    );
    expect(youtube.mock.calls.slice(1).map(([, options]) => options.pageToken)).toEqual([
      "next",
      "next",
    ]);
    expect(recovered.items).toHaveLength(1);
  });

  it("propagates the caller's cancellation without accepting late provider results", async () => {
    const controller = new AbortController();
    const search = vi.fn(async (_query, options) => {
      controller.abort();
      expect(options.signal.aborted).toBe(true);
      return {
        items: [{ ...post("unknown", "LinkedIn"), publishedAt: null, title: "A creator's post" }],
        nextOffset: null,
      };
    });
    await expect(
      fetchDiscoverSourcePage(
        { ...input, platform: "LinkedIn", signal: controller.signal },
        { search, now },
      ),
    ).rejects.toThrow();
  });
});

it("keeps unknown evidence and generic search titles for the later enrichment stage", async () => {
  const search = vi.fn().mockResolvedValue({
    items: [{ ...post("unknown", "LinkedIn"), title: "A creator's post", publishedAt: null }],
    nextOffset: null,
  });
  const page = await fetchDiscoverSourcePage({ ...input, platform: "LinkedIn" }, { search, now });
  expect(page.items).toHaveLength(1);
  expect(page.items[0].publishedAt).toBeNull();
});

it("allows a slow provider response beyond 24 seconds within the shared page budget", async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
    return controller.signal;
  });
  try {
    const search = vi.fn(
      () =>
        new Promise<{ items: ContentSourceItem[]; nextOffset: number | null }>((resolve) =>
          setTimeout(() => resolve({ items: [post("slow", "LinkedIn")], nextOffset: 10 }), 26_000),
        ),
    );
    const result = fetchDiscoverSourcePage(
      { ...input, platform: "LinkedIn", signal: AbortSignal.timeout(42_000) },
      { search, now },
    );
    await vi.advanceTimersByTimeAsync(26_000);
    expect(await result).toMatchObject({ hasMore: true, items: [post("slow", "LinkedIn")] });
    expect(search).toHaveBeenCalledTimes(1);
  } finally {
    timeout.mockRestore();
    vi.useRealTimers();
  }
});

it("continues Hacker News pages without falling back to social or first-page results", async () => {
  const hackerNews = vi
    .fn()
    .mockResolvedValueOnce({
      items: [{ ...post("one", "Hacker News"), stats: { likes: 200, comments: 40 } }],
      nextPage: 1,
    })
    .mockResolvedValueOnce({ items: [post("two", "Hacker News")], nextPage: null });
  const search = vi.fn();
  const youtube = vi.fn();
  const first = await fetchDiscoverSourcePage(
    { ...input, platform: "Hacker News", nicheKeywords: ["AI"] },
    { hackerNews, search, youtube, now },
  );
  const second = await fetchDiscoverSourcePage(
    { ...input, platform: "Hacker News", nicheKeywords: ["AI"], cursor: first.nextCursor },
    { hackerNews, search, youtube, now },
  );
  expect(hackerNews.mock.calls.map(([, options]) => options.page)).toEqual([0, 1]);
  expect(first.items[0].stats).toEqual({ likes: 200, comments: 40 });
  expect(second.hasMore).toBe(false);
  expect(search).not.toHaveBeenCalled();
  expect(youtube).not.toHaveBeenCalled();
});
