import { describe, expect, it, vi } from "vitest";
import { searchBennyWeb } from "./benny-web-search.server";

const key = "test-brave-key-for-benny";

describe("explicit Benny web search", () => {
  it("returns bounded evidence from one request and keeps modification dates distinct from publication", async () => {
    const source = {
      title: "<strong>Source A</strong>",
      description: "The observed summary.",
      url: "https://publisher.example/story#intro",
      page_age: "2026-11-10T02:14:00Z",
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        web: {
          results: [
            source,
            { ...source, url: "https://publisher.example/story#results" },
            { ...source, url: "javascript:location.href" },
            { ...source, title: key, url: "https://publisher.example/secret" },
            { ...source, url: "https://publisher.example/undated", page_age: null },
          ],
        },
      }),
    );
    const results = await searchBennyWeb("creator ideas", key, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain(
      "https://api.search.brave.com/res/v1/web/search?q=creator+ideas&count=5",
    );
    expect(init).toMatchObject({ redirect: "error", headers: { "X-Subscription-Token": key } });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: "Source A",
      sourceUrl: "https://publisher.example/story",
      sourcePublishedAt: null,
      pageDate: "2026-11-10T02:14:00Z",
      evidenceType: "search_snippet",
    });
    expect(results[1]).toMatchObject({ sourcePublishedAt: null, pageDate: null });
  });

  it("rejects credentials in a query and never retries or echoes upstream errors", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: key }, { status: 429 }));
    await expect(searchBennyWeb(`text ${key}`, key, fetcher)).rejects.toThrow(
      "without credentials",
    );
    expect(fetcher).not.toHaveBeenCalled();
    await expect(searchBennyWeb("public topic", key, fetcher)).rejects.toThrow(
      "Brave Search could not finish",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
