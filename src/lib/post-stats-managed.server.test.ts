import { describe, expect, it, vi } from "vitest";
import {
  parseManagedPublicPostStats,
  readManagedPublicPostStats,
} from "./post-stats-managed.server";
import { withManagedProviderBudget } from "./provider-budget.server";

const reddit = "https://reddit.com/r/test/comments/abc123/title";
const makeCache = () => {
  const entries = new Map<string, Response>();
  return {
    match: vi.fn(async (key: Request) => entries.get(key.url)?.clone()),
    put: vi.fn(async (key: Request, value: Response) => {
      entries.set(key.url, value.clone());
    }),
  };
};

describe("bounded managed public post counters", () => {
  it("rejects unrelated records, profile totals, and multiple records", () => {
    expect(
      parseManagedPublicPostStats(reddit, [
        {
          url: reddit,
          post_id: "abc123",
          num_upvotes: 17,
          num_comments: 3,
          community_members_num: 9999,
        },
      ]),
    ).toEqual({ score: 17, comments: 3 });
    expect(
      parseManagedPublicPostStats(reddit, [
        { url: reddit.replace("abc123", "other"), num_upvotes: 9999 },
      ]),
    ).toEqual({});
    expect(
      parseManagedPublicPostStats(reddit, [{ url: reddit, post_id: "other", num_upvotes: 9999 }]),
    ).toEqual({});
    expect(
      parseManagedPublicPostStats(reddit, [
        { url: reddit, num_upvotes: 9 },
        { url: reddit, num_upvotes: 99 },
      ]),
    ).toEqual({});
  });

  it("never turns hidden Instagram likes into verified zero, or Threads reshares into quotes", () => {
    expect(
      parseManagedPublicPostStats("https://instagram.com/reel/ExactPost", [
        {
          url: "https://instagram.com/p/ExactPost/",
          likes: 0,
          num_comments: 3,
          video_play_count: 100,
        },
      ]),
    ).toEqual({ comments: 3, views: 100 });
    expect(
      parseManagedPublicPostStats("https://threads.com/@creator/post/ExactPost", [
        {
          url: "https://threads.com/@creator/post/ExactPost",
          number_of_shares: 4,
          number_of_reshares: 9,
        },
      ]),
    ).toEqual({ shares: 4, reshares: 9 });
  });

  it("does not submit or poll when configuration, cache persistence, or budget is unavailable", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const reserve = vi.fn().mockRejectedValue(new Error("Denied"));
    await expect(
      readManagedPublicPostStats(reddit, ["score"], {
        enabled: true,
        apiKey: "credential",
        cache: makeCache(),
        fetcher,
        reserve,
      }),
    ).resolves.toMatchObject({ status: "limited" });
    expect(fetcher).not.toHaveBeenCalled();
    await readManagedPublicPostStats(reddit, ["score"], {
      enabled: true,
      apiKey: "credential",
      cache: null,
      fetcher,
      reserve,
    });
    await readManagedPublicPostStats(reddit, ["score"], {
      enabled: false,
      apiKey: "credential",
      cache: makeCache(),
      fetcher,
      reserve,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reserves a single record before submission and reuses a pending snapshot without another charge", async () => {
    const cache = makeCache();
    const reserve = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ snapshot_id: "sd_verified123" }))
      .mockResolvedValue(new Response("{}", { status: 202 }));
    const options = {
      enabled: true,
      apiKey: "credential",
      cache,
      fetcher,
      reserve,
      sleep: async () => {},
      pollLimit: 1 as const,
      workspaceId: "workspace-a",
    };
    expect((await readManagedPublicPostStats(reddit, ["score"], options)).status).toBe("pending");
    expect(reserve).toHaveBeenCalledWith("bright_data_requests", 1, { workspaceId: "workspace-a" });
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(fetcher.mock.invocationCallOrder[0]);
    const submitted = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(submitted.input).toEqual([{ url: reddit }]);
    expect(submitted.limit_per_input).toBe(1);
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.has("type")).toBe(false);
    fetcher.mockResolvedValueOnce(
      Response.json([{ url: reddit, post_id: "abc123", num_comments: 3, num_upvotes: 17 }]),
    );
    expect(await readManagedPublicPostStats(reddit, ["score"], options)).toMatchObject({
      status: "available",
      counts: { score: 17, comments: 3 },
    });
    expect(reserve).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("does not buy an extraction for a metric absent from that provider's schema", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const reserve = vi.fn();
    await readManagedPublicPostStats(
      "https://instagram.com/reel/ExactPost",
      ["shares", "reposts"],
      { enabled: true, apiKey: "credential", cache: makeCache(), fetcher, reserve },
    );
    expect(reserve).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed before a paid submission when the job marker cannot be saved", async () => {
    const cache = makeCache();
    cache.put.mockRejectedValue(new Error("Cache unavailable"));
    const fetcher = vi.fn<typeof fetch>();
    await readManagedPublicPostStats(reddit, ["score"], {
      enabled: true,
      apiKey: "credential",
      cache,
      fetcher,
      reserve: vi.fn().mockResolvedValue(undefined),
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("shares one in-flight public collection across concurrent readers", async () => {
    const reserve = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ snapshot_id: "sd_concurrent123" }))
      .mockResolvedValueOnce(
        Response.json([{ url: reddit, post_id: "abc123", num_upvotes: 17, num_comments: 3 }]),
      );
    const options = {
      enabled: true,
      apiKey: "credential",
      cache: makeCache(),
      reserve,
      fetcher,
      sleep: async () => {},
    };
    const [a, b] = await Promise.all([
      readManagedPublicPostStats(reddit, ["score"], options),
      readManagedPublicPostStats(reddit, ["score"], options),
    ]);
    expect(a.counts).toEqual(b.counts);
    expect(reserve).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("meters the one-record cost inside a managed workspace allowance", async () => {
    const reserve = vi.fn().mockRejectedValue(new Error("Denied"));
    await withManagedProviderBudget({ workspaceId: "workspace-a" }, () =>
      readManagedPublicPostStats(reddit, ["score"], {
        enabled: true,
        apiKey: "credential",
        cache: makeCache(),
        reserve,
        workspaceId: "workspace-a",
      }),
    );
    expect(reserve).toHaveBeenCalledWith("bright_data_requests", 1, {
      workspaceId: "workspace-a",
      managedCostMicrousd: 1500,
    });
  });

  it("recognizes a failed provider job instead of leaving it pending indefinitely", async () => {
    const cache = makeCache();
    cache.match.mockResolvedValue(
      Response.json({
        sourceUrl: reddit,
        datasetId: "gd_lvz8ah06191smkebj4",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        state: "pending",
        snapshotId: "sd_failed123",
      }),
    );
    const reserve = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: "failed" }));
    expect(
      await readManagedPublicPostStats(reddit, ["score"], {
        enabled: true,
        apiKey: "credential",
        cache,
        reserve,
        fetcher,
        sleep: async () => {},
      }),
    ).toMatchObject({ status: "unavailable" });
    expect(String(fetcher.mock.calls[0][0])).toContain("/progress/sd_failed123");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("reads bounded extra provider fields without returning them as post counters", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ snapshot_id: "sd_large123" }))
      .mockResolvedValueOnce(
        Response.json([
          {
            url: reddit,
            post_id: "abc123",
            num_upvotes: 17,
            num_comments: 3,
            ignored: "x".repeat(100_000),
          },
        ]),
      );
    expect(
      await readManagedPublicPostStats(reddit, ["score"], {
        enabled: true,
        apiKey: "credential",
        cache: makeCache(),
        reserve: vi.fn().mockResolvedValue(undefined),
        fetcher,
        sleep: async () => {},
      }),
    ).toMatchObject({ status: "available", counts: { score: 17, comments: 3 } });
  });

  it("timestamps retrieved counters when observed, and preserves that time on cached reads", async () => {
    const cache = makeCache();
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    cache.match.mockResolvedValueOnce(
      Response.json({
        sourceUrl: reddit,
        datasetId: "gd_lvz8ah06191smkebj4",
        startedAt,
        state: "pending",
        snapshotId: "sd_observed123",
      }),
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ status: "ready" }))
      .mockResolvedValueOnce(
        Response.json([{ url: reddit, post_id: "abc123", num_upvotes: 17, num_comments: 3 }]),
      );
    const options = {
      enabled: true,
      apiKey: "credential",
      cache,
      fetcher,
      reserve: vi.fn(),
      sleep: async () => {},
    };
    const result = await readManagedPublicPostStats(reddit, ["score"], options);
    expect(Date.parse(result.observedAt!)).toBeGreaterThan(Date.parse(startedAt));
    const cached = await readManagedPublicPostStats(reddit, ["score"], options);
    expect(cached.observedAt).toBe(result.observedAt);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(options.reserve).not.toHaveBeenCalled();
  });

  it("does not create a collection when only checking for an existing job", async () => {
    const fetcher = vi.fn<typeof fetch>(),
      reserve = vi.fn();
    await readManagedPublicPostStats(reddit, ["score"], {
      enabled: true,
      apiKey: "credential",
      cache: makeCache(),
      fetcher,
      reserve,
      onlyExisting: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("does not reserve or submit a collection for an already-aborted request", async () => {
    const reserve = vi.fn(),
      fetcher = vi.fn<typeof fetch>();
    await readManagedPublicPostStats(reddit, ["score"], {
      enabled: true,
      apiKey: "credential",
      cache: makeCache(),
      reserve,
      fetcher,
      signal: AbortSignal.abort(),
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
