import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getContentDiscover,
  mergeDiscoverRefresh,
  refreshContentDiscover,
  type ContentDiscoverData,
} from "@/lib/content-discovery.functions";
import {
  discoverRetryDelay,
  isDiscoverRefreshBusy,
  isTransientDiscoverError,
  shouldRetryDiscover,
  withDiscoverDeadline,
} from "@/lib/content-discover-retry";
import { useDiscoverPagination, withStoredDiscoverPages } from "./use-discover-pagination";

type RefreshRequest = {
  force: boolean;
  attempt: number;
  generation: number;
  direction?: string;
  controller: AbortController;
};

function refreshKey(data: ContentDiscoverData): string {
  return `${data.directionKey ?? "initial"}:${data.lastRefreshedAt ?? "missing"}`;
}

export function useDiscoverFeed(enabled: boolean) {
  const queryClient = useQueryClient();
  const attempted = useRef<string | null>(null);
  const generation = useRef(0);
  const active = useRef<RefreshRequest | null>(null);
  const discover = useQuery({
    queryKey: ["content-discover"],
    queryFn: async ({ signal }) =>
      withStoredDiscoverPages(
        queryClient,
        await withDiscoverDeadline(
          (requestSignal) => getContentDiscover({ signal: requestSignal }),
          15_000,
          signal,
        ),
      ),
    enabled,
    retry: shouldRetryDiscover,
    retryDelay: discoverRetryDelay,
    staleTime: 30_000,
    refetchOnReconnect: true,
  });
  const { pagination, loadMore, availablePlatforms, cancelPages, resetPages } =
    useDiscoverPagination(discover.data, enabled, () => Boolean(active.current));
  const research = useMutation<ContentDiscoverData, Error, RefreshRequest>({
    mutationFn: (request) => {
      // A retry can reuse a completed server-side result instead of paying for research again.
      const force = request.force && request.attempt === 0;
      request.attempt++;
      return withDiscoverDeadline(
        (signal) => refreshContentDiscover({ data: { force }, signal }),
        75_000,
        request.controller.signal,
      );
    },
    retry: shouldRetryDiscover,
    retryDelay: discoverRetryDelay,
    onSuccess: async (result, request) => {
      if (request.generation !== generation.current || request.controller.signal.aborted) return;
      await queryClient.cancelQueries({ queryKey: ["content-discover"] });
      if (request.generation !== generation.current || request.controller.signal.aborted) return;
      attempted.current = ["missing", "stale"].includes(result.status) ? refreshKey(result) : null;
      resetPages();
      queryClient.setQueryData<ContentDiscoverData>(["content-discover"], (current) =>
        mergeDiscoverRefresh(current, result),
      );
    },
    onSettled: (_result, _error, request) => {
      if (active.current === request) active.current = null;
    },
  });
  const { mutate } = research;
  const refresh = useCallback(
    (force = false) => {
      if (active.current && !force) return;
      active.current?.controller.abort();
      cancelPages();
      const current = queryClient.getQueryData<ContentDiscoverData>(["content-discover"]);
      attempted.current = current ? refreshKey(current) : "initial:missing";
      const request: RefreshRequest = {
        force,
        attempt: 0,
        generation: ++generation.current,
        direction: current?.directionKey,
        controller: new AbortController(),
      };
      active.current = request;
      mutate(request);
    },
    [mutate, cancelPages, queryClient],
  );

  useEffect(() => {
    if (!enabled || !discover.data) return;
    if (active.current && active.current.direction !== discover.data.directionKey) {
      active.current.controller.abort();
      active.current = null;
      generation.current++;
    }
    if (
      ["missing", "stale"].includes(discover.data.status) &&
      attempted.current !== refreshKey(discover.data)
    ) {
      refresh();
    }
  }, [discover.data, enabled, refresh]);

  useEffect(() => {
    const reconnect = () => {
      if (enabled && !active.current && isTransientDiscoverError(research.error)) refresh();
    };
    window.addEventListener("online", reconnect);
    return () => window.removeEventListener("online", reconnect);
  }, [enabled, refresh, research.error]);

  useEffect(
    () => () => {
      generation.current++;
      active.current?.controller.abort();
      active.current = null;
      attempted.current = null;
    },
    [],
  );

  const refreshStatus = research.isPending
    ? research.isPaused
      ? "Waiting for your connection. Research will resume automatically."
      : isDiscoverRefreshBusy(research.failureReason)
        ? "Finishing the previous refresh. Checking again automatically…"
        : research.failureCount > 0
          ? "Connection interrupted. Retrying automatically…"
          : "Finding recent posts for your Brain…"
    : null;
  const loadingStatus =
    discover.fetchStatus === "paused"
      ? "Waiting for your connection. Discover will resume automatically."
      : discover.failureCount > 0
        ? "Connection interrupted. Retrying automatically…"
        : "Opening your inspiration board…";
  const error = research.error || (discover.data ? discover.error : null);
  const refreshError =
    !research.isPending && error
      ? isTransientDiscoverError(error)
        ? "We couldn't update your board after retrying. Your saved inspiration is still here."
        : error instanceof Error
          ? error.message
          : "Recommendations couldn't be refreshed. Please try again."
      : null;

  return {
    discover,
    refresh,
    refreshing: research.isPending,
    refreshStatus,
    refreshError,
    loadingStatus,
    pagination,
    loadMore,
    availablePlatforms,
  };
}
