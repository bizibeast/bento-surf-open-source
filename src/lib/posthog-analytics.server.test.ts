import { afterEach, describe, expect, it, vi } from "vitest";
import { getFounderWebAnalytics } from "./posthog-analytics.server";

function response(results: unknown[][]) {
  return new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("founder PostHog analytics", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("fails closed when the PostHog project id is absent", async () => {
    vi.stubEnv("POSTHOG_PROJECT_ID", "");
    const fetcher = vi.fn(async () => response([]));

    const data = await getFounderWebAnalytics(7, {
      apiKey: "phx_test",
      projectId: "",
      fetcher: fetcher as typeof fetch,
    });

    expect(data.available).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed when the read-only reporting key is absent", async () => {
    const data = await getFounderWebAnalytics(30, { apiKey: "" });

    expect(data.available).toBe(false);
    expect(data.overview.visitors).toBe(0);
    expect(data.daily).toHaveLength(30);
  });

  it("maps aggregate acquisition queries into the admin dashboard contract", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00Z"));
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: { query: string } };
      const query = body.query.query;
      if (query.includes("countIf(event = '$pageview' AND timestamp"))
        return response([[120, 80, 12, 3, 90, 60, 8]]);
      if (query.includes("avg(duration_seconds)")) return response([[142, 37.5]]);
      if (query.includes("toDate(timestamp)")) return response([["2026-07-15", 20, 4]]);
      if (query.includes("AS channel")) return response([["Organic Search", 30, 7, 1900]]);
      if (query.includes("AS referrer")) return response([["Google", 30, 7, 1900]]);
      if (query.includes("AS campaign")) return response([["launch", 20, 5, 1200]]);
      if (query.includes("AS keyword")) return response([["link in bio", 15, 4, 900]]);
      if (query.includes("AS country")) return response([["India", 42, 6, 1900]]);
      if (query.includes("AS region")) return response([["Maharashtra", 32, 5, 1900]]);
      if (query.includes("AS city")) return response([["Mumbai", 22, 4, 1900]]);
      if (query.includes("AS hostname")) return response([["bento.surf", 70, 10, 1900]]);
      if (query.includes("AS page")) return response([["/signup", 25, 8, 1900]]);
      if (query.includes("entry_page")) return response([["/", 60, 0, 0]]);
      if (query.includes("AS exit_link")) return response([["instagram.com", 5, 0, 0]]);
      if (query.includes("AS browser")) return response([["Chrome", 55, 8, 1900]]);
      if (query.includes("AS operating_system")) return response([["Mac OS X", 45, 7, 1900]]);
      if (query.includes("AS device")) return response([["Desktop", 50, 8, 1900]]);
      if (query.includes("SELECT distinct_id"))
        return response([
          [
            "user-1",
            "Google",
            "India",
            "Desktop",
            "Mac OS X",
            "Chrome",
            "2026-07-10",
            "2026-07-11",
            3600,
          ],
        ]);
      if (query.includes("crawler_category")) return response([["AI answers", "ChatGPT", 8]]);
      return new Response("unexpected query", { status: 400 });
    });

    const data = await getFounderWebAnalytics(7, {
      apiKey: "phx_test",
      projectId: "513770",
      host: "https://us.i.posthog.com",
      fetcher: fetcher as typeof fetch,
    });

    expect(data.available).toBe(true);
    expect(data.overview).toMatchObject({
      pageviews: 120,
      visitors: 80,
      conversions: 12,
      online: 3,
      previousVisitors: 60,
      bounceRate: 37.5,
      averageSessionSeconds: 142,
    });
    expect(data.acquisition.referrers[0]).toEqual({
      label: "Google",
      visitors: 30,
      conversions: 7,
      revenue: 1900,
    });
    expect(data.geography.countries[0]?.label).toBe("India");
    expect(data.content.pages[0]?.label).toBe("/signup");
    expect(data.technology.devices[0]?.label).toBe("Desktop");
    expect(data.technology.browsers[0]?.label).toBe("Chrome");
    expect(data.journeys[0]?.source).toBe("Google");
    expect(data.crawlers.aiAnswers[0]).toEqual({ label: "ChatGPT", visits: 8, share: 100 });
    expect(data.daily).toHaveLength(7);
    expect(data.daily).toContainEqual({ date: "2026-07-15", visitors: 20, conversions: 4 });
    expect(fetcher).toHaveBeenCalledTimes(19);
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://us.posthog.com/api/projects/513770/query/",
    );
    expect(fetcher.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps the Cloudflare runtime fetch bound to globalThis", async () => {
    const runtimeFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(response([[1, 1, 0, 0, 0, 0, 0]]));
    });
    vi.stubGlobal("fetch", runtimeFetch);

    const data = await getFounderWebAnalytics(90, {
      apiKey: "phx_test",
      projectId: "513770",
      host: "https://us.posthog.com",
    });

    expect(data.available).toBe(true);
    expect(runtimeFetch).toHaveBeenCalledTimes(19);
  });
});
