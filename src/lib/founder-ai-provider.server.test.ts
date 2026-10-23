import { describe, expect, it, vi } from "vitest";
import { createOpenRouterKeyDiagnostic } from "./founder-ai-provider.server";

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), { status });
}

describe("founder OpenRouter key diagnostics", () => {
  it("makes one bounded GET and exposes only safe numeric account fields", async () => {
    const fetcher = vi.fn(async () =>
      response({
        label: "private label",
        hash: "private hash",
        key: "private credential",
        usage: 4.5,
        usage_daily: 0.25,
        usage_monthly: 2,
        limit: 20,
        limit_remaining: 15.5,
        limit_reset: "monthly",
      }),
    );
    const check = createOpenRouterKeyDiagnostic({ fetcher });
    const data = await check("test-key");
    expect(data).toMatchObject({
      status: "ready",
      usageUsd: 4.5,
      dailyUsageUsd: 0.25,
      monthlyUsageUsd: 2,
      limitUsd: 20,
      remainingUsd: 15.5,
      limitReset: "monthly",
    });
    expect(JSON.stringify(data)).not.toMatch(/private|test-key|hash|label/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/key",
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it("distinguishes invalid credentials and missing configuration from zero spend", async () => {
    const fetcher = vi.fn(async () => response({ usage: 0, limit_remaining: 0 }, 401));
    const check = createOpenRouterKeyDiagnostic({ fetcher });
    expect(await check(undefined)).toMatchObject({
      status: "unconfigured",
      usageUsd: null,
      remainingUsd: null,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await check("invalid")).toMatchObject({
      status: "auth_failed",
      usageUsd: null,
      remainingUsd: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not invent zeros for absent, malformed, negative, or unbounded numeric fields", async () => {
    const fetcher = vi.fn(async () =>
      response({ usage: "0", usage_daily: -1, usage_monthly: Infinity, limit: null }),
    );
    const data = await createOpenRouterKeyDiagnostic({ fetcher })("test");
    expect(data).toMatchObject({
      status: "ready",
      usageUsd: null,
      dailyUsageUsd: null,
      monthlyUsageUsd: null,
      limitUsd: null,
      unlimited: true,
      remainingUsd: null,
    });
  });
  it("coalesces concurrent reads, expires the cache, and rechecks changed credentials", async () => {
    let now = 0;
    const fetcher = vi.fn(async () => response({ usage: 1 }));
    const check = createOpenRouterKeyDiagnostic({ fetcher, now: () => now });
    await Promise.all([check("one"), check("one"), check("one")]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 59_999;
    await check("one");
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 60_001;
    await check("one");
    await check("two");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("reports timeouts, malformed responses and oversized responses without retries", async () => {
    for (const result of [
      () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      async () => response(null),
      async () => new Response("x".repeat(20_000)),
      async () => response({ error: "private provider error" }, 503),
    ]) {
      const fetcher = vi.fn(result);
      const data = await createOpenRouterKeyDiagnostic({ fetcher })("test");
      expect(data).toMatchObject({ status: "unavailable", usageUsd: null, limitUsd: null });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("rejects redirects without forwarding the credential or returning the location", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("private provider body", {
          status: 302,
          headers: { location: "https://private.example/key-secret" },
        }),
    );
    const data = await createOpenRouterKeyDiagnostic({ fetcher })("test-key-secret");
    expect(data).toMatchObject({ status: "unavailable", failureReason: "http", httpStatus: 302 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(data)).not.toMatch(/private|secret|location/);
  });

  it("returns safe failure categories and optional HTTP status without raw errors", async () => {
    for (const [fetcher, reason, httpStatus] of [
      [
        vi.fn(async () => {
          throw new DOMException("private timeout details", "TimeoutError");
        }),
        "timeout",
        null,
      ],
      [
        vi.fn(async () => {
          throw new TypeError("private network details");
        }),
        "network",
        null,
      ],
      [vi.fn(async () => response(null)), "invalid_response", 200],
      [vi.fn(async () => new Response("private invalid json")), "invalid_response", 200],
      [vi.fn(async () => response({ message: "private provider details" }, 503)), "http", 503],
      [vi.fn(async () => response({ message: "private auth details" }, 401)), "http", 401],
    ] as const) {
      const data = await createOpenRouterKeyDiagnostic({ fetcher })("test-key");
      expect(data.failureReason).toBe(reason);
      expect(data.httpStatus).toBe(httpStatus);
      expect(JSON.stringify(data)).not.toContain("private");
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});
