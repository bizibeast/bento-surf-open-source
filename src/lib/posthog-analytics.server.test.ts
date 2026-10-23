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
      if (query.includes("arrayJoin(["))
        return response([
          ["channel", "Organic Search", 30, 7, 1900],
          ["referrer", "Google", 30, 7, 1900],
          ["campaign", "launch", 20, 5, 1200],
          ["keyword", "link in bio", 15, 4, 900],
          ["country", "India", 42, 6, 1900],
          ["region", "Maharashtra", 32, 5, 1900],
          ["city", "Mumbai", 22, 4, 1900],
          ["hostname", "public.example.com", 70, 10, 1900],
          ["page", "/signup", 25, 8, 1900],
          ["browser", "Chrome", 55, 8, 1900],
          ["operating_system", "Mac OS X", 45, 7, 1900],
          ["device", "Desktop", 50, 8, 1900],
        ]);
      if (query.includes("AS channel")) return response([["Organic Search", 30, 7, 1900]]);
      if (query.includes("arrayJoin([")) return response([["Google", 30, 7, 1900]]);
      if (query.includes("AS campaign")) return response([["launch", 20, 5, 1200]]);
      if (query.includes("AS keyword")) return response([["link in bio", 15, 4, 900]]);
      if (query.includes("AS country")) return response([["India", 42, 6, 1900]]);
      if (query.includes("AS region")) return response([["Maharashtra", 32, 5, 1900]]);
      if (query.includes("AS city")) return response([["Mumbai", 22, 4, 1900]]);
      if (query.includes("AS hostname")) return response([["public.example.com", 70, 10, 1900]]);
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
    expect(fetcher).toHaveBeenCalledTimes(8);
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
    expect(runtimeFetch).toHaveBeenCalledTimes(8);
  });
  it("reports a failed breakdown as unavailable instead of an empty successful report", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)).query.query as string;
      if (query.includes("arrayJoin([")) return new Response("query failed", { status: 503 });
      return response([[1, 1, 0, 0, 0, 0, 0]]);
    });
    const data = await getFounderWebAnalytics(7, { apiKey: "test", fetcher });
    expect(data.available).toBe(true);
    expect(data.unavailablePanels).toContain("referrers");
    expect(data.error).toContain("report");
  });

  it("counts outbound visitors from outbound events and scopes all queries to this deployment", async () => {
    const queries: string[] = [];
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      queries.push(JSON.parse(String(init?.body)).query.query as string);
      return response([[0, 0, 0, 0, 0, 0, 0]]);
    });
    await getFounderWebAnalytics(7, { apiKey: "test", fetcher, environment: "production" });
    const outbound = queries.find((query) => query.includes("AS exit_link"))!;
    expect(outbound).toContain("uniqIf(distinct_id, event = 'outbound_link_clicked')");
    for (const query of queries) expect(query).toContain("deployment_environment");
    expect(queries[0]).toContain("'production'");
  });
  it("keeps successful reports available when only the overview fails", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)).query.query as string;
      if (query.includes("countIf(event = '$pageview' AND timestamp"))
        return new Response("unavailable", { status: 503 });
      if (query.includes("arrayJoin([")) return response([["channel", "Organic Search", 12, 2, 0]]);
      return response([]);
    });
    const data = await getFounderWebAnalytics(7, { apiKey: "test", fetcher });
    expect(data.available).toBe(true);
    expect(data.unavailablePanels).toContain("overview");
    expect(data.unavailablePanels).not.toContain("channels");
    expect(data.acquisition.channels[0].visitors).toBe(12);
  });

  it("does not treat skipped journey-only reports as successes when both requested queries fail", async () => {
    const fetcher = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const data = await getFounderWebAnalytics(7, { apiKey: "test", fetcher, report: "journeys" });
    expect(data.available).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("counts untagged legacy events only as production", async () => {
    const queries: string[] = [];
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      queries.push(JSON.parse(String(init?.body)).query.query);
      return response([[0, 0, 0, 0, 0, 0, 0]]);
    });
    await getFounderWebAnalytics(7, { apiKey: "test", fetcher, environment: "staging" });
    for (const query of queries) {
      expect(query).toContain("properties.deployment_environment = 'staging'");
      expect(query).not.toContain("properties.$host IN");
    }
    queries.length = 0;
    await getFounderWebAnalytics(7, { apiKey: "test", fetcher, environment: "production" });
    for (const query of queries)
      expect(query).toContain("OR coalesce(toString(properties.deployment_environment), '') = ''");
  });
  it("loads all Audience breakdowns in seven requests with at most four in flight", async () => {
    let active = 0;
    let maximum = 0;
    let resolved = 0;
    const releases: Array<() => void> = [];
    const queries: string[] = [];
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      active += 1;
      maximum = Math.max(maximum, active);
      queries.push(JSON.parse(String(init?.body)).query.query);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      resolved += 1;
      return response([[1, 1, 0, 0, 0, 0, 0]]);
    });
    const pending = getFounderWebAnalytics(7, { apiKey: "test", fetcher, report: "audience" });
    expect(fetcher).toHaveBeenCalledTimes(4);
    for (let round = 0; round < 5 && resolved < 7; round += 1) {
      releases.splice(0).forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(7);
    expect(maximum).toBe(4);
    expect(queries.filter((query) => query.includes("arrayJoin([")).length).toBe(1);
    expect(queries.some((query) => query.trimStart().startsWith("SELECT distinct_id,"))).toBe(
      false,
    );
  });

  it("logs only fixed panel failure categories and HTTP status without SQL, keys, or provider bodies", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetcher = vi.fn(async () => new Response("private provider body", { status: 503 }));
    await getFounderWebAnalytics(7, { apiKey: "phx_private_credential", fetcher });
    expect(warning).toHaveBeenCalledWith(
      "[posthog] analytics panel unavailable",
      expect.objectContaining({
        panel: "breakdowns",
        reason: "http",
        status: 503,
        durationMs: expect.any(Number),
        queuedMs: expect.any(Number),
      }),
    );
    expect(JSON.stringify(warning.mock.calls)).not.toMatch(/private|SELECT|Bearer/);
    warning.mockRestore();
  });
});
