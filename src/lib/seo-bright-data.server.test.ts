import { describe, expect, it, vi } from "vitest";
import {
  SeoProviderBudgetError,
  SeoSerpTransportError,
  fetchSeoSerp,
} from "./seo-bright-data.server";

const env = {
  BRIGHT_DATA_API_KEY: "key",
  BRIGHT_DATA_SERP_ZONE: "serp_api1",
  SEO_BRIGHT_DATA_MONTHLY_REQUEST_LIMIT: "3000",
};

describe("Bright Data SEO research", () => {
  it("parses the real Bright Data response envelope", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        status_code: 200,
        body: JSON.stringify({
          organic: [
            {
              global_rank: 1,
              title: "Creator website guide",
              link: "https://example.com/guide",
              description: "A useful creator guide.",
            },
          ],
        }),
      }),
    );

    const result = await fetchSeoSerp(
      { keyword: "creator website", country: "us", language: "en" },
      env,
      { fetcher, reserve: async () => true },
    );

    expect(result.organic).toHaveLength(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      zone: "serp_api1",
      data_format: "parsed",
    });
  });

  it("parses a parsed_light body directly and ignores a json envelope", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        status_code: 200,
        body: JSON.stringify({
          organic: [
            {
              global_rank: 9,
              title: "Envelope only",
              link: "https://envelope.example/nope",
              description: "This is the json envelope, not the raw body.",
            },
          ],
        }),
        organic: [
          {
            link: "https://example.com/creator-website",
            title: "How to build a creator website",
            description: "A practical guide to a creator website.",
            global_rank: 1,
            extensions: [
              { type: "site_link", text: "Templates", link: "https://example.com/templates" },
            ],
          },
          {
            link: "https://docs.example.org/creator-website",
            title: "Creator website examples",
            description: "Examples of creator websites that sell and collect subscribers.",
            global_rank: 2,
          },
        ],
      }),
    );

    const result = await fetchSeoSerp(
      { keyword: "creator website", country: "us", language: "en" },
      env,
      { fetcher, reserve: async () => true, dataFormat: "parsed_light" },
    );

    expect(result.organic.map((row) => row.title)).toEqual([
      "How to build a creator website",
      "Creator website examples",
    ]);
    expect(result.questions).toEqual([]);
    expect(result.relatedSearches).toEqual([]);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      format: "raw",
      data_format: "parsed_light",
    });
  });

  it("rejects an upstream error inside a successful HTTP response", async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ status_code: 502, body: "Upstream request failed" }),
      );
    await expect(
      fetchSeoSerp({ keyword: "creator website", country: "us", language: "en" }, env, {
        fetcher,
        reserve: async () => true,
        delay: async () => undefined,
      }),
    ).rejects.toThrow("Bright Data SEO request failed (502)");
  });

  it("retries transient upstream failures and reserves every attempt", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ status_code: 502, body: "temporarily unavailable" }))
      .mockResolvedValueOnce(Response.json({ status_code: 503, body: "temporarily unavailable" }))
      .mockResolvedValueOnce(Response.json({ status_code: 200, body: JSON.stringify({}) }));
    const reserve = vi.fn().mockResolvedValue(true);

    const result = await fetchSeoSerp(
      { keyword: "creator website", country: "us", language: "en" },
      env,
      { fetcher, reserve, delay: async () => undefined },
    );

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(reserve).toHaveBeenCalledTimes(3);
    expect(result.requestsUsed).toBe(3);
  });

  it("does not retry a 429 or spend a second reservation", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("slow down", { status: 429 }));
    const reserve = vi.fn().mockResolvedValue(true);
    const delay = vi.fn(async () => undefined);

    await expect(
      fetchSeoSerp({ keyword: "creator website", country: "us", language: "en" }, env, {
        fetcher,
        reserve,
        delay,
      }),
    ).rejects.toThrow("Bright Data SEO request failed (429)");
    expect(reserve).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });

  it("does not retry a 429 hidden in a Bright Data envelope", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ status_code: 429, body: "slow down" }));
    const reserve = vi.fn().mockResolvedValue(true);

    await expect(
      fetchSeoSerp({ keyword: "creator website", country: "us", language: "en" }, env, {
        fetcher,
        reserve,
        delay: async () => undefined,
      }),
    ).rejects.toThrow("Bright Data SEO request failed (429)");
    expect(reserve).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("stops a transient retry when the monthly reservation is exhausted", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ status_code: 502, body: "temporarily unavailable" }));
    const reserve = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(
      fetchSeoSerp({ keyword: "creator website", country: "us", language: "en" }, env, {
        fetcher,
        reserve,
        delay: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(SeoProviderBudgetError);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("reserves one request before calling Bright Data", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({}));
    const reserve = vi.fn().mockResolvedValue(false);

    await expect(
      fetchSeoSerp({ keyword: "creator website", country: "us", language: "en" }, env, {
        fetcher,
        reserve,
      }),
    ).rejects.toBeInstanceOf(SeoProviderBudgetError);
    expect(fetcher).not.toHaveBeenCalled();

    reserve.mockResolvedValue(true);
    await fetchSeoSerp({ keyword: "creator website", country: "us", language: "en" }, env, {
      fetcher,
      reserve,
    });

    expect(reserve).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects request 3,001 before fetching", async () => {
    const fetcher = vi.fn();

    await expect(
      fetchSeoSerp({ keyword: "creator website", country: "us", language: "en" }, env, {
        fetcher,
        usage: async () => 3_000,
      }),
    ).rejects.toBeInstanceOf(SeoProviderBudgetError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("normalizes organic, PAA, and nested related-search rows", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        organic: [
          {
            global_rank: 1,
            title: "Creator website guide",
            link: "https://example.com/guide",
            description: "A useful creator guide.",
          },
        ],
        people_also_ask: [
          { question: "What should a creator website include?" },
          { question: "What should a creator website include?" },
        ],
        related: [
          {
            text: "creator website examples",
            items: [{ text: "creator website builder" }],
          },
        ],
      }),
    );

    const result = await fetchSeoSerp(
      { keyword: "creator website", country: "us", language: "en" },
      env,
      { fetcher, usage: async () => 12 },
    );

    expect(result.organic[0]).toEqual({
      rank: 1,
      title: "Creator website guide",
      url: "https://example.com/guide",
      domain: "example.com",
      description: "A useful creator guide.",
    });
    expect(result.questions).toEqual(["What should a creator website include?"]);
    expect(result.relatedSearches).toEqual(["creator website examples", "creator website builder"]);
    expect(result.requestsUsed).toBe(1);

    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(request).toMatchObject({ zone: "serp_api1", format: "json" });
    expect(request.url).toBe("https://www.google.com/search?q=creator+website&gl=us&hl=en&num=10");
  });

  it("preserves the operator research query without hosted SEO rewrites", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ organic: [] }));
    await fetchSeoSerp(
      { keyword: "free bio link options for creators", country: "us", language: "en" },
      env,
      { fetcher, reserve: async () => true },
    );
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(new URL(request.url).searchParams.get("q")).toBe("free bio link options for creators");
    expect(request.data_format).toBe("parsed");
  });

  it("caps parsed requests at 20s and parsed_light at 45s", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        organic: [
          {
            global_rank: 1,
            title: "Creator website guide",
            link: "https://example.com/guide",
            description: "A useful creator guide.",
          },
        ],
      }),
    );
    const keyword = { keyword: "creator website", country: "us", language: "en" };
    await expect(
      fetchSeoSerp(keyword, env, { fetcher, reserve: async () => true, timeoutMs: 20_001 }),
    ).rejects.toThrow("Invalid SEO request timeout.");
    await expect(
      fetchSeoSerp(keyword, env, {
        fetcher,
        reserve: async () => true,
        timeoutMs: 45_000,
        dataFormat: "parsed",
      }),
    ).rejects.toThrow("Invalid SEO request timeout.");
    expect(fetcher).not.toHaveBeenCalled();

    const light = await fetchSeoSerp(keyword, env, {
      fetcher,
      reserve: async () => true,
      timeoutMs: 45_000,
      dataFormat: "parsed_light",
    });
    expect(light.organic).toHaveLength(1);
    await expect(
      fetchSeoSerp(keyword, env, {
        fetcher,
        reserve: async () => true,
        timeoutMs: 45_001,
        dataFormat: "parsed_light",
      }),
    ).rejects.toThrow("Invalid SEO request timeout.");
  });

  it("logs the transport error name and duration", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher = vi.fn(async () => {
      const timeout = new Error("The operation was aborted due to timeout");
      timeout.name = "TimeoutError";
      throw timeout;
    });
    const error = await fetchSeoSerp(
      { keyword: "creator website", country: "us", language: "en" },
      env,
      { fetcher, reserve: async () => true, maxAttempts: 1 },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SeoSerpTransportError);
    expect((error as Error).message).toMatch(
      /Bright Data SEO transport failed after retries \(TimeoutError, \d+ms\)/,
    );
    expect(logged).toHaveBeenCalledWith(
      "Bright Data SEO transport failed",
      expect.objectContaining({ name: "TimeoutError", attempt: 0 }),
    );
    logged.mockRestore();
  });
});
