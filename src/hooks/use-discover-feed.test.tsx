import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { StrictMode, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentDiscoverData } from "@/lib/content-discovery.functions";
import { useDiscoverFeed } from "./use-discover-feed";

const functions = vi.hoisted(() => ({ read: vi.fn(), refresh: vi.fn(), retryDelay: vi.fn() }));
vi.mock("@/lib/content-discovery.functions", () => ({
  getContentDiscover: functions.read,
  refreshContentDiscover: functions.refresh,
  loadMoreDiscover: vi.fn(),
  mergeDiscoverRefresh: (_current: unknown, next: unknown) => next,
}));
vi.mock("@/lib/content-discover-retry", async (original) => ({
  ...(await original<typeof import("@/lib/content-discover-retry")>()),
  discoverRetryDelay: functions.retryDelay,
}));

const base: ContentDiscoverData = {
  winners: [],
  patterns: [],
  trends: [],
  ideas: [],
  warnings: [],
  status: "stale",
  lastRefreshedAt: "2026-10-10T10:00:00Z",
  directionKey: "comedy",
};
let clients: QueryClient[];
beforeEach(() => {
  clients = [];
  onlineManager.setOnline(true);
  functions.read.mockReset().mockResolvedValue(base);
  functions.refresh.mockReset().mockResolvedValue({ ...base, status: "fresh" });
  functions.retryDelay.mockReset().mockReturnValue(1);
});
afterEach(() => {
  clients.forEach((client) => client.clear());
  onlineManager.setOnline(true);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(cached?: ContentDiscoverData, strict = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });
  clients.push(client);
  if (cached) client.setQueryData(["content-discover"], cached);
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>
      {strict ? <StrictMode>{children}</StrictMode> : children}
    </QueryClientProvider>
  );
  return { client, ...renderHook(() => useDiscoverFeed(true), { wrapper }) };
}

describe("Discover automatic recovery", () => {
  it("waits for an older server lease through repeated busy responses after changing direction", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const actual = await vi.importActual<typeof import("@/lib/content-discover-retry")>(
      "@/lib/content-discover-retry",
    );
    functions.retryDelay.mockImplementation(actual.discoverRetryDelay);
    const busy = new Error("Discover refresh is already running. Retrying shortly.");
    const lifestyle = { ...base, directionKey: "lifestyle" };
    functions.refresh
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockRejectedValueOnce(busy)
      .mockRejectedValueOnce(busy)
      .mockRejectedValueOnce(busy)
      .mockResolvedValueOnce({ ...lifestyle, status: "fresh" });
    const hook = setup(base);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(functions.refresh).toHaveBeenCalledTimes(1);
    act(() => hook.client.setQueryData(["content-discover"], lifestyle));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(functions.refresh.mock.calls[0][0].signal.aborted).toBe(true);
    expect(hook.result.current.refreshStatus).toBe(
      "Finishing the previous refresh. Checking again automatically…",
    );
    for (let retry = 0; retry < 3; retry++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(functions.refresh).toHaveBeenCalledTimes(5);
    expect(functions.refresh.mock.calls.every(([request]) => !request.data.force)).toBe(true);
    expect(hook.result.current.discover.data).toMatchObject({
      directionKey: "lifestyle",
      status: "fresh",
    });
    expect(hook.result.current.refreshError).toBeNull();
  });

  it.each([
    "Discover refresh is already running. Retrying shortly.",
    "Discover refresh could not start. Retrying shortly.",
    "Discover refresh was interrupted. Retrying shortly.",
  ])("retries the recoverable refresh lease failure: %s", async (message) => {
    functions.refresh.mockRejectedValueOnce(new Error(message));
    const hook = setup(base);
    await waitFor(() => expect(hook.result.current.discover.data?.status).toBe("fresh"));
    expect(functions.refresh).toHaveBeenCalledTimes(2);
    expect(hook.result.current.refreshError).toBeNull();
  });

  it("aborts a timed-out initial read and automatically loads on the next attempt", async () => {
    vi.useFakeTimers();
    functions.read
      .mockImplementationOnce(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          ),
      )
      .mockResolvedValue({ ...base, status: "fresh" });
    const hook = setup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(functions.read.mock.calls[0][0].signal.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(functions.read).toHaveBeenCalledTimes(2);
    expect(hook.result.current.discover.data?.status).toBe("fresh");
    expect(hook.result.current.discover.error).toBeNull();
  });

  it("restarts temporary refresh failures and keeps the cached board throughout", async () => {
    functions.refresh.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const hook = setup(base);
    expect(hook.result.current.discover.data).toEqual(base);
    await waitFor(() => expect(functions.refresh).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.result.current.discover.data?.status).toBe("fresh"));
    expect(hook.result.current.refreshError).toBeNull();
    expect(
      functions.refresh.mock.calls.every(([request]) => request.signal instanceof AbortSignal),
    ).toBe(true);
  });

  it("stops after three attempts without the stale-data effect restarting the loop", async () => {
    functions.refresh.mockRejectedValue(new Error("Network unavailable"));
    const hook = setup(base);
    await waitFor(() => expect(hook.result.current.refreshError).toContain("after retrying"));
    expect(functions.refresh).toHaveBeenCalledTimes(3);
    hook.rerender();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    expect(functions.refresh).toHaveBeenCalledTimes(3);
    expect(hook.result.current.discover.data).toEqual(base);
  });

  it("forces only the first manual attempt, then reuses server caches on retry", async () => {
    const hook = setup({ ...base, status: "fresh" });
    functions.refresh.mockRejectedValueOnce(new Error("Network unavailable"));
    act(() => hook.result.current.refresh(true));
    await waitFor(() => expect(functions.refresh).toHaveBeenCalledTimes(2));
    expect(functions.refresh.mock.calls.map(([request]) => request.data.force)).toEqual([
      true,
      false,
    ]);
  });

  it("lets a manual refresh restart an exhausted attempt budget", async () => {
    functions.refresh.mockRejectedValue(new Error("Network unavailable"));
    const hook = setup(base);
    await waitFor(() => expect(hook.result.current.refreshError).not.toBeNull());
    functions.refresh.mockResolvedValue({ ...base, status: "fresh" });
    act(() => hook.result.current.refresh(true));
    await waitFor(() => expect(hook.result.current.discover.data?.status).toBe("fresh"));
    expect(functions.refresh).toHaveBeenCalledTimes(4);
    expect(functions.refresh.mock.calls[3][0].data.force).toBe(true);
  });

  it("refreshes again when a successfully refreshed board later becomes stale", async () => {
    const hook = setup(base);
    await waitFor(() => expect(hook.result.current.discover.data?.status).toBe("fresh"));
    act(() => hook.client.setQueryData(["content-discover"], base));
    await waitFor(() => expect(functions.refresh).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.result.current.discover.data?.status).toBe("fresh"));
  });

  it("resumes initial loading when the browser comes back online", async () => {
    onlineManager.setOnline(false);
    const hook = setup();
    expect(hook.result.current.loadingStatus).toContain("Waiting for your connection");
    expect(functions.read).not.toHaveBeenCalled();
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(hook.result.current.discover.data?.status).toBe("fresh"));
  });

  it("can restart after StrictMode cleans up the first request", async () => {
    const hook = setup(base, true);
    await waitFor(() => expect(hook.result.current.discover.data?.status).toBe("fresh"));
    expect(hook.result.current.refreshError).toBeNull();
  });

  it("resumes after an exhausted failure when the browser reconnects", async () => {
    functions.refresh.mockRejectedValue(new Error("Network unavailable"));
    const hook = setup(base);
    await waitFor(() => expect(hook.result.current.refreshError).not.toBeNull());
    functions.refresh.mockResolvedValue({ ...base, status: "fresh" });
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(hook.result.current.discover.data?.status).toBe("fresh"));
    expect(functions.refresh).toHaveBeenCalledTimes(4);
  });

  it("does not repeatedly call authorization failures, even on reconnect", async () => {
    functions.refresh.mockRejectedValue(
      Object.assign(new Error("Sign in required"), { status: 401 }),
    );
    const hook = setup(base);
    await waitFor(() => expect(hook.result.current.refreshError).toBe("Sign in required"));
    act(() => window.dispatchEvent(new Event("online")));
    expect(functions.refresh).toHaveBeenCalledTimes(1);
  });

  it("automatically recovers initial loading and retains data after a later read failure", async () => {
    functions.read
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({ ...base, status: "fresh" });
    const hook = setup();
    await waitFor(() => expect(hook.result.current.discover.data?.status).toBe("fresh"));
    expect(functions.read).toHaveBeenCalledTimes(2);
    functions.read.mockRejectedValue(new Error("Network unavailable"));
    await act(async () => {
      await hook.result.current.discover.refetch();
    });
    expect(hook.result.current.discover.data?.status).toBe("fresh");
    await waitFor(() => expect(hook.result.current.refreshError).toContain("saved inspiration"));
  });

  it("aborts superseded research and ignores its late result when direction changes", async () => {
    let resolveFirst: (value: ContentDiscoverData) => void = () => undefined;
    functions.refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const hook = setup(base);
    await waitFor(() => expect(functions.refresh).toHaveBeenCalledTimes(1));
    const lifestyle = { ...base, directionKey: "lifestyle" };
    functions.refresh.mockResolvedValue({ ...lifestyle, status: "fresh" });
    act(() => hook.client.setQueryData(["content-discover"], lifestyle));
    await waitFor(() => expect(functions.refresh).toHaveBeenCalledTimes(2));
    expect(functions.refresh.mock.calls[0][0].signal.aborted).toBe(true);
    await act(async () => resolveFirst({ ...base, status: "fresh" }));
    await waitFor(() => expect(hook.result.current.discover.data?.directionKey).toBe("lifestyle"));
  });
});
