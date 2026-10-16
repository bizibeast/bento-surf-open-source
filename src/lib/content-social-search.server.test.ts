import { expect, it, vi } from "vitest";
import {
  fetchSocialSearch,
  fetchSocialSearchPage,
  socialSearchNextOffset,
  socialSearchItems,
  fetchDiscoverCreatorProfiles,
  socialProfileSearchResults,
} from "./content-social-search.server";

it("only accepts supported creator profiles from public search and deduplicates aliases", () => {
  expect(
    socialProfileSearchResults({
      organic: [
        {
          title: "Chef",
          link: "https://instagram.com/chef?utm_source=google",
          description: "Recipes",
        },
        { title: "Chef", link: "https://www.instagram.com/chef/" },
        { title: "A recipe", link: "https://instagram.com/reel/abc" },
        { title: "Spoof", link: "https://instagram.com.evil.test/chef" },
        { title: "Private", link: "https://127.0.0.1/chef" },
      ],
    }),
  ).toEqual([
    {
      name: "Chef",
      profileUrl: "https://www.instagram.com/chef",
      platform: "Instagram",
      description: "Recipes",
    },
  ]);
});

it("looks up a public creator name in the requested locale, without Brain prose", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      organic: [{ title: "Trevor Noah - YouTube", link: "https://www.youtube.com/@trevornoah" }],
    }),
  );
  const result = await fetchDiscoverCreatorProfiles(
    { name: "Trevor Noah", language: "en", region: "za" },
    { fetcher, reserve: async () => true, env: { BRIGHT_DATA_API_KEY: "test" } },
  );
  const target = new URL(JSON.parse(fetcher.mock.calls[0][1].body).url);
  expect(target.searchParams.get("q")).toContain('"Trevor Noah"');
  expect(target.searchParams.get("gl")).toBe("za");
  expect(result[0].profileUrl).toBe("https://www.youtube.com/@trevornoah");
});

it("retries failures wrapped in HTTP 200 instead of caching a missing social platform", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ status_code: 503, body: "" }))
    .mockResolvedValueOnce(
      Response.json({
        status_code: 200,
        organic: [{ title: "Founder story", link: "https://www.instagram.com/reel/abc123/" }],
      }),
    );
  const result = await fetchSocialSearch(
    {
      query: "startup journey",
      group: "site:instagram.com/reel/",
      language: "en",
      region: "global",
    },
    { fetcher, reserve: async () => true, env: { BRIGHT_DATA_API_KEY: "test" } },
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(result[0].platform).toBe("Instagram");
});

it("retries transient provider failures within the budget and accepts wrapped JSON", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response("busy", { status: 503 }))
    .mockResolvedValueOnce(
      Response.json({
        status_code: 200,
        body: {
          organic: [
            { title: "Founder update", link: "https://www.facebook.com/founder/posts/123" },
          ],
        },
      }),
    );
  const reserve = vi.fn().mockResolvedValue(true);
  const posts = await fetchSocialSearch(
    { query: "startup", group: "site:facebook.com", language: "en", region: "global" },
    { fetcher, reserve, env: { BRIGHT_DATA_API_KEY: "test" } },
  );
  expect(reserve).toHaveBeenCalledTimes(2);
  expect(posts[0].platform).toBe("Facebook");
});

it("accepts actual social post URLs without inventing dates or engagement", () => {
  const result = socialSearchItems(
    {
      organic: [
        {
          title: "A launch",
          link: "https://x.com/creator/status/123?utm_source=search",
          description: "How we built it",
        },
        { title: "A story", link: "https://linkedin.com/posts/creator-story" },
        { title: "A profile", link: "https://instagram.com/creator" },
        { title: "Spoof", link: "https://x.com.attacker.test/creator/status/123" },
        { title: "Private network", link: "https://127.0.0.1/status/123" },
      ],
    },
    "2026-10-05T00:00:00Z",
  );
  expect(result.map((item) => item.platform)).toEqual(["X", "LinkedIn"]);
  expect(result[0]).toMatchObject({
    canonicalUrl: "https://x.com/creator/status/123",
    publishedAt: null,
    stats: {},
  });
});
it("does not request search after the shared provider budget is exhausted", async () => {
  const fetcher = vi.fn();
  await expect(
    fetchSocialSearch(
      { query: "AI", group: "site:x.com", region: "global", language: "en" },
      {
        env: { BRIGHT_DATA_API_KEY: "test-only" },
        reserve: async () => false,
        fetcher,
      },
    ),
  ).rejects.toThrow("budget");
  expect(fetcher).not.toHaveBeenCalled();
});

it("requests a full platform quota inside an explicit recency window", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ organic: [] }));
  await fetchSocialSearch(
    {
      query: '"comedy" OR "Trevor Noah"',
      group: "site:youtube.com/watch",
      language: "en",
      region: "us",
      windowDays: 7,
      limit: 20,
    },
    { fetcher, reserve: async () => true, env: { BRIGHT_DATA_API_KEY: "test" } },
  );
  const target = new URL(JSON.parse(fetcher.mock.calls[0][1].body).url);
  expect(target.searchParams.get("tbs")).toBe("qdr:w");
  expect(target.searchParams.get("num")).toBe("20");
  expect(target.searchParams.get("lr")).toBe("lang_en");
  expect(target.searchParams.get("q")).toBe('(site:youtube.com/watch) ("comedy" OR "Trevor Noah")');
});

it("does not repeatedly bill permanent provider failures", async () => {
  for (const status of [400, 401, 403, 404]) {
    const fetcher = vi.fn().mockResolvedValue(new Response("not available", { status }));
    const reserve = vi.fn().mockResolvedValue(true);
    await expect(
      fetchSocialSearch(
        { query: "comedy", group: "site:instagram.com/reel/", language: "en", region: "global" },
        { fetcher, reserve, env: { BRIGHT_DATA_API_KEY: "test" } },
      ),
    ).rejects.toThrow(String(status));
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});

it("retries a transient timeout and stops immediately when the overall request is cancelled", async () => {
  const input = { query: "comedy", group: "site:x.com", language: "en", region: "global" };
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"))
    .mockResolvedValueOnce(Response.json({ organic: [] }));
  await fetchSocialSearch(input, {
    fetcher,
    reserve: async () => true,
    env: { BRIGHT_DATA_API_KEY: "test" },
    delay: async () => {},
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  const reserve = vi.fn().mockResolvedValue(true);
  await expect(
    fetchSocialSearch(input, {
      fetcher,
      reserve,
      env: { BRIGHT_DATA_API_KEY: "test" },
      signal: AbortSignal.abort(),
    }),
  ).rejects.toThrow();
  expect(reserve).not.toHaveBeenCalled();
});

it("lets a cold 24-second search finish without paying for a premature retry", async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
    return controller.signal;
  });
  try {
    const reserve = vi.fn().mockResolvedValue(true);
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(
            () =>
              resolve(
                Response.json({
                  organic: [{ title: "Creator update", link: "https://instagram.com/p/cold" }],
                }),
              ),
            24_000,
          ),
        ),
    );
    const search = fetchSocialSearch(
      { query: "comedy", group: "site:instagram.com/p/", language: "en", region: "us" },
      { fetcher, reserve, env: { BRIGHT_DATA_API_KEY: "test" } },
    );
    await vi.advanceTimersByTimeAsync(24_000);
    expect(await search).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
  } finally {
    timeout.mockRestore();
    vi.useRealTimers();
  }
});

it("keeps slow search retries inside the caller's original 28-second research budget", async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
    return controller.signal;
  });
  try {
    const reserve = vi.fn().mockResolvedValue(true);
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const result = fetchSocialSearch(
      { query: "comedy", group: "site:instagram.com/p/", language: "en", region: "us" },
      {
        fetcher,
        reserve,
        env: { BRIGHT_DATA_API_KEY: "test" },
        signal: AbortSignal.timeout(28_000),
      },
    ).then(
      () => "unexpected success",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(28_000);
    expect(await result).toMatchObject({ name: "TimeoutError" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenCalledTimes(2);
  } finally {
    timeout.mockRestore();
    vi.useRealTimers();
  }
});

it("uses actual platform creation times without treating indexing or snippet dates as publication", () => {
  const published = Date.parse("2026-10-05T08:00:00Z");
  const xId = ((BigInt(published) - 1288834974657n) << 22n).toString();
  const linkedInId = (BigInt(published) << 22n).toString();
  const tiktokId = (BigInt(published / 1000) << 32n).toString();
  const items = socialSearchItems(
    {
      organic: [
        { title: "X post", link: `https://x.com/creator/status/${xId}` },
        {
          title: "LinkedIn post",
          link: `https://www.linkedin.com/posts/creator_activity-${linkedInId}-x`,
        },
        { title: "TikTok post", link: `https://www.tiktok.com/@creator/video/${tiktokId}` },
        {
          title: "Short",
          link: "https://www.youtube.com/shorts/abc123",
          publishedAt: "2026-10-05T08:00:00Z",
        },
        {
          title: "Index is not age",
          link: "https://www.instagram.com/p/abc123/",
          date: "2 hours ago",
          description: "Updated today",
        },
        {
          title: "Bogus future",
          link: "https://www.instagram.com/p/future/",
          published_at: "2099-10-05T08:00:00Z",
        },
      ],
    },
    "2026-10-06T08:00:00Z",
  );
  expect(items.slice(0, 4).map((item) => item.publishedAt)).toEqual(
    Array(4).fill("2026-10-05T08:00:00.000Z"),
  );
  expect(items[3].platform).toBe("YouTube");
  expect(items.slice(4).every((item) => item.publishedAt === null)).toBe(true);
});

it("does not cache malformed or error-bearing HTTP200 payloads as healthy empty searches", async () => {
  const input = {
    query: "comedy",
    group: "site:instagram.com/reel/",
    language: "en",
    region: "global",
  };
  for (const payload of [
    {},
    { error: "upstream failure" },
    { status_code: 200, body: { error: "upstream failure" } },
  ]) {
    const fetcher = vi.fn(async () => Response.json(payload));
    await expect(
      fetchSocialSearch(input, {
        fetcher,
        reserve: async () => true,
        env: { BRIGHT_DATA_API_KEY: "test" },
        delay: async () => {},
      }),
    ).rejects.toThrow("unavailable result payload");
    expect(fetcher).toHaveBeenCalledTimes(2);
  }
  await expect(
    fetchSocialSearch(input, {
      fetcher: async () => Response.json({ organic: [], errors: [] }),
      reserve: async () => true,
      env: { BRIGHT_DATA_API_KEY: "test" },
    }),
  ).resolves.toEqual([]);
});

it("preserves the original provider error when no paid retry allowance remains", async () => {
  const reserve = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const fetcher = vi.fn().mockResolvedValue(new Response("busy", { status: 503 }));
  await expect(
    fetchSocialSearch(
      { query: "comedy", group: "site:instagram.com/reel/", language: "en", region: "global" },
      { fetcher, reserve, env: { BRIGHT_DATA_API_KEY: "test" }, delay: async () => {} },
    ),
  ).rejects.toThrow("Previous attempt: Social discovery search unavailable (503)");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("uses documented Google next offsets instead of treating ignored num as a larger page", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      organic: [{ title: "New comedy", link: "https://instagram.com/p/one" }],
      pagination: { current_page: 2, next_page: 3, next_page_start: 20 },
    }),
  );
  const page = await fetchSocialSearchPage(
    {
      query: "comedy",
      group: "site:instagram.com/p/",
      language: "en",
      region: "us",
      start: 10,
      publishedAfter: "2026-09-11T12:00:00Z",
      publishedBefore: "2026-10-11T12:00:00Z",
    },
    { fetcher, reserve: async () => true, env: { BRIGHT_DATA_API_KEY: "test" } },
  );
  const target = new URL(JSON.parse(fetcher.mock.calls[0][1].body).url);
  expect(target.searchParams.get("start")).toBe("10");
  expect(target.searchParams.get("tbs")).toBe("cdr:1,cd_min:9/11/2026,cd_max:10/11/2026");
  expect(page.nextOffset).toBe(20);
});

it("honors terminal pagination and only infers continuation from a full unannotated Google page", () => {
  const organic = Array.from({ length: 10 }, () => ({}));
  expect(
    socialSearchNextOffset({ organic, pagination: { current_page: 2, pages: [] } }, 10),
  ).toBeNull();
  expect(socialSearchNextOffset({ organic }, 10)).toBe(20);
  expect(socialSearchNextOffset({ organic: organic.slice(0, 9) }, 10)).toBeNull();
  expect(
    socialSearchNextOffset(
      { organic, pagination: { next_page_link: "https://www.google.com/search?q=x&start=20" } },
      10,
    ),
  ).toBe(20);
  expect(
    socialSearchNextOffset(
      { organic, pagination: { next_page_link: "https://127.0.0.1/search?start=20" } },
      10,
    ),
  ).toBeNull();
  expect(
    socialSearchNextOffset(
      {
        organic,
        pagination: { pages: [{ start: 0 }, { start: 10 }, { start: 30 }, { start: 20 }] },
      },
      10,
    ),
  ).toBe(20);
});
