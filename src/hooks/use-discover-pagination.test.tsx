import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ContentDiscoverData,
  DiscoverRecommendation,
} from "@/lib/content-discovery.functions";
import { useDiscoverFeed } from "./use-discover-feed";

const functions = vi.hoisted(() => ({ read: vi.fn(), refresh: vi.fn(), more: vi.fn() }));
vi.mock("@/lib/content-discovery.functions", () => ({
  getContentDiscover: functions.read,
  refreshContentDiscover: functions.refresh,
  loadMoreDiscover: functions.more,
  mergeDiscoverRefresh: (_current: unknown, next: unknown) => next,
}));
vi.mock("@/lib/content-discover-retry", async (original) => ({
  ...(await original<typeof import("@/lib/content-discover-retry")>()),
  discoverRetryDelay: () => 1,
}));

function post(
  id: string,
  sourceUrl = `https://www.youtube.com/watch?v=${id}`,
): DiscoverRecommendation {
  return {
    id,
    fingerprint: id,
    kind: "trend",
    title: id,
    summary: "A creator's original post.",
    sourceUrl,
    sourceName: sourceUrl.includes("instagram.com") ? "Instagram" : "YouTube",
    platform: sourceUrl.includes("instagram.com") ? "Instagram" : "YouTube",
    stats: { followers: 4_000, views: 20_000 },
    sourcePublishedAt: new Date(Date.now()).toISOString(),
    sourceRetrievedAt: new Date(Date.now()).toISOString(),
    reason: "Relevant to comedy.",
    angles: [],
    metricName: "views",
    metricValue: 20_000,
    outlierScore: null,
    feedback: "pending",
  };
}
const initial = post("first");
const base: ContentDiscoverData = {
  winners: [],
  patterns: [],
  trends: [initial],
  ideas: [],
  warnings: [],
  status: "fresh",
  lastRefreshedAt: "2026-10-11T00:00:00Z",
  directionKey: "comedy",
  pagination: {
    all: { cursor: null, hasMore: true },
    YouTube: { cursor: null, hasMore: true },
    Instagram: { cursor: null, hasMore: true },
  },
};
function page(platform = "YouTube", overrides: Record<string, unknown> = {}) {
  return {
    platform,
    directionKey: "comedy",
    trends: [post("second")],
    ideas: [],
    nextCursor: "page-2",
    hasMore: true,
    warnings: [],
    ...overrides,
  };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let clients: QueryClient[];
beforeEach(() => {
  clients = [];
  functions.read.mockReset().mockResolvedValue(base);
  functions.refresh.mockReset().mockResolvedValue(base);
  functions.more.mockReset().mockResolvedValue(page());
});
afterEach(() => {
  clients.forEach((client) => client.clear());
  vi.restoreAllMocks();
});

function setup(data = base) {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });
  clients.push(client);
  client.setQueryData(["content-discover"], data);
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper, ...renderHook(() => useDiscoverFeed(true), { wrapper }) };
}

describe("Discover platform pagination", () => {
  it("never resurrects a dismissed paged source after refetch, remount, or an alias on another page", async () => {
    const idea: DiscoverRecommendation = {
      ...post("second-idea", "https://youtu.be/second"),
      kind: "idea",
      angles: ["A personal take inspired by this source"],
    };
    functions.more.mockResolvedValueOnce(page("YouTube", { ideas: [idea] }));
    const hook = setup();
    await act(async () => {
      await hook.result.current.loadMore("YouTube");
    });
    expect(hook.result.current.discover.data?.trends).toHaveLength(2);
    expect(hook.result.current.discover.data?.ideas).toHaveLength(1);
    functions.read.mockResolvedValue({ ...base, dismissedPostKeys: ["youtube:second"] });
    await act(async () => {
      await hook.result.current.discover.refetch();
    });
    await waitFor(() =>
      expect(hook.result.current.discover.data?.trends.map((item) => item.id)).toEqual(["first"]),
    );
    expect(hook.result.current.discover.data?.ideas).toEqual([]);
    hook.unmount();
    const remounted = renderHook(() => useDiscoverFeed(true), { wrapper: hook.wrapper });
    await act(async () => {
      await remounted.result.current.discover.refetch();
    });
    expect(remounted.result.current.discover.data?.trends.map((item) => item.id)).toEqual([
      "first",
    ]);
    functions.more.mockResolvedValueOnce(
      page("all", {
        trends: [post("second-alias", "https://youtu.be/second?si=tracking"), post("third")],
        ideas: [{ ...idea, id: "idea-alias" }],
        nextCursor: "all-2",
      }),
    );
    await act(async () => {
      await remounted.result.current.loadMore("all");
    });
    expect(remounted.result.current.discover.data?.trends.map((item) => item.id)).toEqual([
      "first",
      "third",
    ]);
    expect(remounted.result.current.discover.data?.ideas).toEqual([]);
  });

  it("drops expired overlay posts on refetch while keeping saved posts and ideas only in the library", async () => {
    const nearlyExpired = new Date(Date.now() - 29 * 86_400_000).toISOString();
    const aging = { ...post("aging"), sourcePublishedAt: nearlyExpired };
    const saved = { ...post("saved-aging"), sourcePublishedAt: nearlyExpired, saved: true };
    const savedIdea: DiscoverRecommendation = {
      ...post("saved-idea-aging"),
      sourcePublishedAt: nearlyExpired,
      kind: "idea",
      feedback: "saved",
      angles: ["Keep this for later"],
    };
    functions.more.mockResolvedValueOnce(
      page("YouTube", { trends: [aging, saved], ideas: [savedIdea] }),
    );
    const hook = setup();
    await act(async () => {
      await hook.result.current.loadMore("YouTube");
    });
    expect(hook.result.current.discover.data?.trends.map((item) => item.id)).toContain("aging");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 86_400_000);
    await act(async () => {
      await hook.result.current.discover.refetch();
    });
    await waitFor(() =>
      expect(hook.result.current.discover.data?.trends.map((item) => item.id)).toEqual([
        "first",
        "saved-aging",
      ]),
    );
    expect(
      hook.result.current.discover.data?.trends.find((item) => item.id === "saved-aging"),
    ).toMatchObject({ saved: true, savedOnly: true });
    expect(hook.result.current.discover.data?.ideas).toEqual([{ ...savedIdea, savedOnly: true }]);
    hook.unmount();
    const remounted = renderHook(() => useDiscoverFeed(true), { wrapper: hook.wrapper });
    await act(async () => {
      await remounted.result.current.discover.refetch();
    });
    expect(remounted.result.current.discover.data?.trends.some((item) => item.id === "aging")).toBe(
      false,
    );
    expect(remounted.result.current.discover.data?.ideas[0].savedOnly).toBe(true);
  });

  it("applies a dismissal received while a page request is still in flight", async () => {
    const pending = deferred<ReturnType<typeof page>>();
    functions.more.mockReturnValueOnce(pending.promise);
    const hook = setup({ ...base, trends: [initial, post("second")] });
    let request: Promise<void>;
    act(() => {
      request = hook.result.current.loadMore("all");
    });
    functions.read.mockResolvedValue({ ...base, dismissedPostKeys: ["youtube:second"] });
    await act(async () => {
      await hook.result.current.discover.refetch();
    });
    await waitFor(() =>
      expect(hook.result.current.discover.data?.dismissedPostKeys).toContain("youtube:second"),
    );
    await act(async () => {
      pending.resolve(
        page("all", { trends: [post("late-alias", "https://youtu.be/second"), post("third")] }),
      );
      await request!;
    });
    expect(hook.result.current.discover.data?.trends.map((item) => item.id)).toEqual([
      "first",
      "third",
    ]);
  });

  it("keeps authoritative save and feedback changes ahead of old page variants", async () => {
    functions.more.mockResolvedValueOnce(
      page("YouTube", {
        trends: [{ ...post("second"), saved: true, feedback: "saved" }],
      }),
    );
    const hook = setup();
    await act(async () => {
      await hook.result.current.loadMore("YouTube");
    });
    const current = {
      ...post("server-second", "https://youtu.be/second"),
      saved: false,
      feedback: "liked" as const,
    };
    functions.read.mockResolvedValue({ ...base, trends: [initial, current] });
    await act(async () => {
      await hook.result.current.discover.refetch();
    });
    await waitFor(() =>
      expect(hook.result.current.discover.data?.trends[1]).toMatchObject({
        id: "server-second",
        saved: false,
        feedback: "liked",
      }),
    );
    functions.read.mockResolvedValue({
      ...base,
      trends: [initial, { ...current, stats: { followers: 20, views: 100_000 } }],
    });
    await act(async () => {
      await hook.result.current.discover.refetch();
    });
    await waitFor(() =>
      expect(hook.result.current.discover.data?.trends.map((item) => item.id)).toEqual(["first"]),
    );
  });

  it("single-flights observer calls for the same cursor and appends canonical unique posts", async () => {
    const pending = deferred<ReturnType<typeof page>>();
    functions.more.mockReturnValueOnce(pending.promise);
    const hook = setup();
    let first: Promise<void>;
    let second: Promise<void>;
    act(() => {
      first = hook.result.current.loadMore("YouTube");
      second = hook.result.current.loadMore("YouTube");
    });
    expect(first!).toBe(second!);
    expect(functions.more).toHaveBeenCalledTimes(1);
    expect(functions.more).toHaveBeenCalledWith({
      data: { platform: "YouTube", directionKey: "comedy" },
      signal: expect.any(AbortSignal),
    });
    expect(hook.result.current.pagination.YouTube.loading).toBe(true);
    await act(async () => {
      pending.resolve(
        page("YouTube", {
          trends: [post("same", "https://youtu.be/first?si=tracking"), post("second")],
        }),
      );
      await first!;
    });
    expect(hook.result.current.discover.data?.trends.map((item) => item.id)).toEqual([
      "first",
      "second",
    ]);
    expect(hook.result.current.pagination.YouTube).toMatchObject({
      cursor: "page-2",
      hasMore: true,
      loading: false,
    });
  });

  it("keeps independent platform requests and cursors when responses finish out of order", async () => {
    const youtube = deferred<ReturnType<typeof page>>();
    const instagram = deferred<ReturnType<typeof page>>();
    functions.more.mockImplementation(({ data }) =>
      data.platform === "YouTube" ? youtube.promise : instagram.promise,
    );
    const hook = setup();
    let first: Promise<void>;
    let second: Promise<void>;
    act(() => {
      first = hook.result.current.loadMore("YouTube");
      second = hook.result.current.loadMore("Instagram");
    });
    await act(async () => {
      instagram.resolve(
        page("Instagram", {
          trends: [post("instagram", "https://instagram.com/reel/abc/")],
          nextCursor: "instagram-2",
        }),
      );
      await second!;
    });
    expect(hook.result.current.pagination.YouTube.loading).toBe(true);
    expect(hook.result.current.pagination.Instagram).toMatchObject({
      cursor: "instagram-2",
      loading: false,
    });
    await act(async () => {
      youtube.resolve(page());
      await first!;
    });
    expect(hook.result.current.discover.data?.trends.map((item) => item.id)).toEqual([
      "first",
      "instagram",
      "second",
    ]);
    expect(hook.result.current.pagination.YouTube.cursor).toBe("page-2");
    expect(hook.result.current.pagination.Instagram.cursor).toBe("instagram-2");
  });

  it("deduplicates across All and platform pages and stops repeated cursor cycles", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.loadMore("YouTube");
    });
    functions.more.mockResolvedValueOnce(
      page("all", {
        trends: [post("duplicate", "https://youtu.be/second"), post("third")],
        nextCursor: "all-2",
      }),
    );
    await act(async () => {
      await hook.result.current.loadMore("all");
    });
    expect(hook.result.current.discover.data?.trends.map((item) => item.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
    functions.more.mockResolvedValueOnce(page("YouTube", { nextCursor: "page-2" }));
    await act(async () => {
      await hook.result.current.loadMore("YouTube");
    });
    expect(functions.more.mock.calls[2][0].data.cursor).toBe("page-2");
    expect(hook.result.current.pagination.YouTube.hasMore).toBe(false);
    await act(async () => {
      await hook.result.current.loadMore("YouTube");
    });
    expect(functions.more).toHaveBeenCalledTimes(3);
  });

  it("does not discard appended pages or cursors on an ordinary first-page refetch or remount", async () => {
    const hook = setup();
    await act(async () => {
      await hook.result.current.loadMore("YouTube");
    });
    functions.read.mockResolvedValue({ ...base, trends: [{ ...initial, saved: true }] });
    await act(async () => {
      await hook.result.current.discover.refetch();
    });
    expect(hook.result.current.discover.data?.trends).toHaveLength(2);
    await waitFor(() => expect(hook.result.current.discover.data?.trends[0].saved).toBe(true));
    expect(hook.result.current.pagination.YouTube.cursor).toBe("page-2");
    hook.unmount();
    const remounted = renderHook(() => useDiscoverFeed(true), { wrapper: hook.wrapper });
    await act(async () => {
      await remounted.result.current.discover.refetch();
    });
    expect(remounted.result.current.discover.data?.trends).toHaveLength(2);
    expect(remounted.result.current.pagination.YouTube.cursor).toBe("page-2");
  });

  it("preserves appended data when a read started before the page completed", async () => {
    const pendingRead = deferred<ContentDiscoverData>();
    functions.read.mockReturnValueOnce(pendingRead.promise);
    const hook = setup();
    let read: Promise<unknown>;
    act(() => {
      read = hook.result.current.discover.refetch();
    });
    await act(async () => {
      await hook.result.current.loadMore("YouTube");
    });
    await act(async () => {
      pendingRead.resolve(base);
      await read!;
    });
    expect(hook.result.current.discover.data?.trends).toHaveLength(2);
    expect(hook.result.current.pagination.YouTube.cursor).toBe("page-2");
  });

  it("aborts and ignores an old direction's page when Brain context changes", async () => {
    const old = deferred<ReturnType<typeof page>>();
    functions.more.mockReturnValueOnce(old.promise);
    const hook = setup();
    let oldRequest: Promise<void>;
    act(() => {
      oldRequest = hook.result.current.loadMore("YouTube");
    });
    act(() =>
      hook.client.setQueryData(["content-discover"], {
        ...base,
        directionKey: "lifestyle",
        trends: [post("lifestyle")],
      }),
    );
    await waitFor(() => expect(functions.more.mock.calls[0][0].signal.aborted).toBe(true));
    await act(async () => {
      old.resolve(page());
      await oldRequest!;
    });
    expect(hook.result.current.discover.data?.trends.map((item) => item.id)).toEqual(["lifestyle"]);
    expect(hook.result.current.pagination.YouTube.cursor).toBeNull();
    functions.more.mockResolvedValueOnce(
      page("YouTube", { directionKey: "lifestyle", trends: [post("lifestyle-next")] }),
    );
    await act(async () => {
      await hook.result.current.loadMore("YouTube");
    });
    expect(functions.more.mock.calls[1][0].data.directionKey).toBe("lifestyle");
    expect(hook.result.current.discover.data?.trends.map((item) => item.id)).toEqual([
      "lifestyle",
      "lifestyle-next",
    ]);
  });

  it("fences old pages during refresh and resets pagination only after refreshed data succeeds", async () => {
    const old = deferred<ReturnType<typeof page>>();
    functions.more.mockReturnValueOnce(old.promise);
    functions.refresh.mockResolvedValue({ ...base, trends: [post("refreshed")] });
    const hook = setup();
    let oldRequest: Promise<void>;
    act(() => {
      oldRequest = hook.result.current.loadMore("YouTube");
    });
    act(() => hook.result.current.refresh(true));
    await waitFor(() => expect(hook.result.current.discover.data?.trends[0].id).toBe("refreshed"));
    await act(async () => {
      old.resolve(page());
      await oldRequest!;
    });
    expect(functions.more.mock.calls[0][0].signal.aborted).toBe(true);
    expect(hook.result.current.discover.data?.trends.map((item) => item.id)).toEqual(["refreshed"]);
    expect(hook.result.current.pagination.YouTube.cursor).toBeNull();
  });

  it("automatically retries a temporary page failure without replacing the visible feed", async () => {
    const next = deferred<ReturnType<typeof page>>();
    functions.more
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockReturnValueOnce(next.promise);
    const hook = setup();
    let request: Promise<void>;
    act(() => {
      request = hook.result.current.loadMore("YouTube");
    });
    await waitFor(() => expect(functions.more).toHaveBeenCalledTimes(2));
    expect(hook.result.current.discover.data?.trends.map((item) => item.id)).toEqual(["first"]);
    expect(hook.result.current.pagination.YouTube.error).toBeNull();
    await act(async () => {
      next.resolve(page());
      await request!;
    });
    expect(hook.result.current.discover.data?.trends).toHaveLength(2);
  });

  it("stops exhausted retries until manual retry without an observer loop", async () => {
    functions.more.mockRejectedValue(new Error("Network unavailable"));
    const hook = setup();
    await act(async () => {
      await hook.result.current.loadMore("YouTube");
    });
    expect(functions.more).toHaveBeenCalledTimes(3);
    expect(hook.result.current.discover.data?.trends.map((item) => item.id)).toEqual(["first"]);
    expect(hook.result.current.pagination.YouTube.error).toBe("Network unavailable");
    await act(async () => {
      await hook.result.current.loadMore("YouTube");
    });
    expect(functions.more).toHaveBeenCalledTimes(3);
    functions.more.mockResolvedValue(page());
    await act(async () => {
      await hook.result.current.loadMore("YouTube", true);
    });
    expect(functions.more).toHaveBeenCalledTimes(4);
    expect(hook.result.current.discover.data?.trends).toHaveLength(2);
    expect(hook.result.current.pagination.YouTube.error).toBeNull();
  });
});
