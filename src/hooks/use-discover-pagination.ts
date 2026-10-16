import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  loadMoreDiscover,
  type ContentDiscoverData,
  type DiscoverRecommendation,
} from "@/lib/content-discovery.functions";
import { discoverPostKey, uniqueDiscoverPosts } from "@/lib/content-discover-identity";
import { evaluateDiscoverQuality } from "@/lib/content-discover-quality";
import {
  discoverRetryDelay,
  isDiscoverRefreshBusy,
  shouldRetryDiscover,
  withDiscoverDeadline,
} from "@/lib/content-discover-retry";

export const DISCOVER_PLATFORMS = [
  "YouTube",
  "Instagram",
  "TikTok",
  "LinkedIn",
  "X",
  "Threads",
  "Facebook",
  "Reddit",
  "Hacker News",
];

type Cursor = { cursor: string | null; hasMore: boolean };
export type DiscoverPaginationState = Cursor & {
  loading: boolean;
  error: string | null;
  status: string | null;
};
type PageOverlay = {
  trends: DiscoverRecommendation[];
  ideas: DiscoverRecommendation[];
  pagination: Record<string, Cursor>;
  completed: Record<string, string[]>;
  warnings: string[];
};
type PageRequest = {
  direction: string;
  platform: string;
  cursor: string | null;
  epoch: number;
  controller: AbortController;
  queryKey: readonly unknown[];
  promise: Promise<void>;
};
type PageProgress = Pick<DiscoverPaginationState, "loading" | "error" | "status">;

const overlayKey = (direction: string) => ["content-discover-pages", direction];

/** A normal first-page refetch must not truncate pages the reader has already loaded. */
export function withStoredDiscoverPages(client: QueryClient, data: ContentDiscoverData) {
  const pages = data.directionKey
    ? client.getQueryData<PageOverlay>(overlayKey(data.directionKey))
    : undefined;
  const dismissed = new Set(data.dismissedPostKeys || []);
  for (const item of [...data.trends, ...data.ideas]) {
    if (item.feedback === "not_relevant") dismissed.add(discoverPostKey(item));
  }
  const now = Date.now();
  const visible = (current: DiscoverRecommendation[], appended: DiscoverRecommendation[]) =>
    // Authoritative server rows win over old page aliases, including updated save flags.
    uniqueDiscoverPosts([...current, ...appended]).flatMap((item) => {
      if (dismissed.has(discoverPostKey(item)) || item.feedback === "not_relevant") return [];
      if (evaluateDiscoverQuality(item, now).eligible) return [item];
      return item.saved || item.feedback === "saved" ? [{ ...item, savedOnly: true }] : [];
    });
  return {
    ...data,
    trends: visible(data.trends, pages?.trends || []),
    ideas: visible(data.ideas, pages?.ideas || []),
    ...(pages
      ? {
          pagination: { ...data.pagination, ...pages.pagination },
          warnings: [...new Set([...data.warnings, ...pages.warnings])],
        }
      : {}),
  };
}

export function useDiscoverPagination(
  data: ContentDiscoverData | undefined,
  enabled: boolean,
  isRefreshing: () => boolean,
) {
  const client = useQueryClient();
  const epoch = useRef(0);
  const active = useRef(new Map<string, PageRequest>());
  const progressRef = useRef<Record<string, PageProgress>>({});
  const [progress, setProgress] = useState<Record<string, PageProgress>>({});
  const previousDirection = useRef(data?.directionKey);
  const refreshing = useRef(isRefreshing);
  refreshing.current = isRefreshing;

  const updateProgress = useCallback((platform: string, value: PageProgress) => {
    progressRef.current = { ...progressRef.current, [platform]: value };
    setProgress(progressRef.current);
  }, []);

  const cancelPages = useCallback(() => {
    epoch.current++;
    for (const request of active.current.values()) {
      request.controller.abort();
      void client.cancelQueries({ queryKey: request.queryKey, exact: true });
    }
    active.current.clear();
    progressRef.current = {};
    setProgress({});
  }, [client]);

  const resetPages = useCallback(() => {
    cancelPages();
    client.removeQueries({ queryKey: ["content-discover-pages"] });
    client.removeQueries({ queryKey: ["content-discover-page"] });
  }, [cancelPages, client]);

  useEffect(() => {
    if (previousDirection.current === data?.directionKey) return;
    if (previousDirection.current !== undefined) {
      cancelPages();
      client.removeQueries({ queryKey: overlayKey(previousDirection.current), exact: true });
    }
    previousDirection.current = data?.directionKey;
  }, [cancelPages, client, data?.directionKey]);

  useEffect(
    () => () => {
      epoch.current++;
      for (const request of active.current.values()) {
        request.controller.abort();
        void client.cancelQueries({ queryKey: request.queryKey, exact: true });
      }
      active.current.clear();
    },
    [client],
  );

  const loadMore = useCallback(
    (platform: string, retry = false): Promise<void> => {
      const running = active.current.get(platform);
      if (running) return running.promise;
      const current = client.getQueryData<ContentDiscoverData>(["content-discover"]);
      const direction = current?.directionKey;
      const cursor = current?.pagination?.[platform];
      if (!enabled || refreshing.current() || !direction || !cursor?.hasMore)
        return Promise.resolve();
      if (progressRef.current[platform]?.error && !retry) return Promise.resolve();
      const pages = client.getQueryData<PageOverlay>(overlayKey(direction));
      if (pages?.completed[platform]?.includes(cursor.cursor ?? "")) return Promise.resolve();

      const request: PageRequest = {
        direction,
        platform,
        cursor: cursor.cursor,
        epoch: epoch.current,
        controller: new AbortController(),
        queryKey: ["content-discover-page", direction, epoch.current, platform, cursor.cursor],
        promise: Promise.resolve(),
      };
      const isCurrent = () =>
        !request.controller.signal.aborted &&
        request.epoch === epoch.current &&
        client.getQueryData<ContentDiscoverData>(["content-discover"])?.directionKey ===
          request.direction;
      active.current.set(platform, request);
      updateProgress(platform, { loading: true, error: null, status: "Finding more posts…" });
      request.promise = (async () => {
        try {
          const result = await client.fetchQuery({
            queryKey: request.queryKey,
            queryFn: ({ signal }) =>
              withDiscoverDeadline(
                (requestSignal) =>
                  loadMoreDiscover({
                    data: {
                      platform,
                      ...(request.cursor ? { cursor: request.cursor } : {}),
                      directionKey: direction,
                    },
                    signal: requestSignal,
                  }),
                75_000,
                AbortSignal.any([signal, request.controller.signal]),
              ),
            staleTime: Infinity,
            gcTime: 5 * 60_000,
            retry: shouldRetryDiscover,
            retryDelay: (attempt, error) => {
              if (isCurrent())
                updateProgress(platform, {
                  loading: true,
                  error: null,
                  status: isDiscoverRefreshBusy(error)
                    ? "Finishing the previous refresh. Checking again automatically…"
                    : "Connection interrupted. Retrying more posts automatically…",
                });
              return discoverRetryDelay(attempt, error);
            },
          });
          if (!isCurrent()) return;
          if (result.directionKey !== direction) {
            void client.invalidateQueries({ queryKey: ["content-discover"], exact: true });
            throw new Error("Your Brain changed. Refresh Discover to load the latest direction.");
          }
          if (result.platform !== platform || !Array.isArray(result.trends)) {
            throw new Error("These posts could not be loaded. Please try again.");
          }
          const previous = client.getQueryData<PageOverlay>(overlayKey(direction));
          const completed = [...(previous?.completed[platform] || []), request.cursor ?? ""];
          const next: PageOverlay = {
            trends: uniqueDiscoverPosts([...(previous?.trends || []), ...result.trends]),
            ideas: uniqueDiscoverPosts([...(previous?.ideas || []), ...(result.ideas || [])]),
            pagination: {
              ...previous?.pagination,
              [platform]: {
                cursor: result.nextCursor,
                hasMore:
                  result.hasMore &&
                  result.nextCursor !== null &&
                  !completed.includes(result.nextCursor),
              },
            },
            completed: { ...previous?.completed, [platform]: completed },
            warnings: [...new Set([...(previous?.warnings || []), ...(result.warnings || [])])],
          };
          client.setQueryData(overlayKey(direction), next);
          client.setQueryData<ContentDiscoverData>(["content-discover"], (latest) =>
            latest?.directionKey === direction ? withStoredDiscoverPages(client, latest) : latest,
          );
          updateProgress(platform, { loading: false, error: null, status: null });
        } catch (error) {
          if (!isCurrent()) return;
          // A failed response validation must be fetchable again on explicit retry.
          client.removeQueries({ queryKey: request.queryKey, exact: true });
          updateProgress(platform, {
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : "More posts could not be loaded. Please try again.",
            status: null,
          });
        } finally {
          if (active.current.get(platform) === request) active.current.delete(platform);
        }
      })();
      return request.promise;
    },
    [client, enabled, updateProgress],
  );

  const pagination = useMemo(
    () =>
      Object.fromEntries(
        [...new Set(["all", ...DISCOVER_PLATFORMS, ...Object.keys(data?.pagination || {})])].map(
          (platform) => [
            platform,
            {
              cursor: data?.pagination?.[platform]?.cursor ?? null,
              hasMore: data?.pagination?.[platform]?.hasMore ?? false,
              ...(progress[platform] ?? { loading: false, error: null, status: null }),
            },
          ],
        ),
      ) as Record<string, DiscoverPaginationState>,
    [data?.pagination, progress],
  );

  return { pagination, loadMore, cancelPages, resetPages, availablePlatforms: DISCOVER_PLATFORMS };
}
