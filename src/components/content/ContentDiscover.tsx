import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  Bookmark,
  Check,
  ChevronRight,
  ExternalLink,
  Flame,
  Image,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
  Zap,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type {
  ContentDiscoverData,
  DiscoverRecommendation,
} from "@/lib/content-discovery.functions";
import { DiscoverPostCard, DiscoverPostDialog, type DiscoverActions } from "./DiscoverPost";
import {
  creatorKey,
  creatorName,
  platformName,
  recommendationMatches,
  type DiscoverBoostAction,
} from "./discover-utils";
import "./discover.css";
import {
  visibleDiscoverRecommendations,
  uniqueDiscoverPosts,
} from "@/lib/content-discover-identity";
import {
  publicSourceUrl,
  sourceCreator,
  sourcePostEmbed,
  sourceThumbnail,
  type DiscoverCreator,
} from "@/lib/content-source-media";
import { creatorMatchesSource } from "@/lib/content-discover-creators";
import { DiscoverCreators, type TrackCreatorInput } from "./DiscoverCreators";
import { DiscoverIdeaCard } from "./DiscoverIdea";
import { DiscoverLoading, DiscoverSkeletonCards } from "./DiscoverLoading";
import { curateDiscoverPosts, publishedWithin } from "./discover-feed";
import { discoverPostKey } from "@/lib/content-discover-identity";

type Feed = "all" | "trends" | "ideas";
type Sort = "relevance" | "newest" | "likes" | "views";
type DiscoverPageState = {
  cursor?: string | null;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  status?: string | null;
};
const DISPLAY_PAGE_SIZE = 18;

export function ContentDiscover({
  data,
  now = new Date(),
  onLike,
  onClearFeedback,
  onSave,
  onUnsave,
  onTrackCreator,
  onUntrackCreator,
  onReject,
  onAskAgent,
  onCreateDraft,
  onResolveCreator,
  refreshing = false,
  refreshError = null,
  refreshStatus = null,
  onRefresh,
  pagination = {},
  availablePlatforms = [],
  onLoadMore,
}: {
  data: ContentDiscoverData;
  now?: Date;
  onLike: (id: string) => void | Promise<void>;
  onClearFeedback?: (id: string) => void | Promise<void>;
  onSave: (id: string) => void | Promise<void>;
  onUnsave?: (id: string) => void | Promise<void>;
  onTrackCreator?: (input: TrackCreatorInput) => Promise<void>;
  onUntrackCreator?: (id: string) => Promise<void>;
  onReject: (id: string) => void | Promise<void>;
  onAskAgent: (item: DiscoverRecommendation, action?: DiscoverBoostAction) => void;
  onCreateDraft: (item: DiscoverRecommendation) => void;
  onResolveCreator?: (item: DiscoverRecommendation) => Promise<DiscoverCreator>;
  refreshing?: boolean;
  refreshError?: string | null;
  refreshStatus?: string | null;
  onRefresh?: () => void;
  pagination?: Record<string, DiscoverPageState>;
  availablePlatforms?: string[];
  onLoadMore?: (platform: string, retry?: boolean) => void | Promise<void>;
}) {
  const [view, setView] = useState<"discover" | "creators" | "saved">("discover");
  const [feed, setFeed] = useState<Feed>("all");
  const [platform, setPlatform] = useState("all");
  const [sort, setSort] = useState<Sort>("relevance");
  const [period, setPeriod] = useState(30);
  const [mediaOnly, setMediaOnly] = useState(false);
  const [preset, setPreset] = useState<"viral" | null>(null);
  const [minViews, setMinViews] = useState(0);
  const [minLikes, setMinLikes] = useState(0);
  const [minFollowers, setMinFollowers] = useState(0);
  const reducedMotion = useReducedMotion();
  const [search, setSearch] = useState("");
  const [selectedCreator, setCreator] = useState<DiscoverRecommendation | null>(null);
  const [creatorReturnView, setCreatorReturnView] = useState<"discover" | "creators" | "saved">(
    "discover",
  );
  const [creatorOverrides, setCreatorOverrides] = useState<Record<string, DiscoverCreator>>({});
  const creator = selectedCreator
    ? { ...selectedCreator, ...creatorOverrides[selectedCreator.sourceUrl || selectedCreator.id] }
    : null;
  const resolveCreator = useCallback(
    async (item: DiscoverRecommendation) => {
      const value = await onResolveCreator!(item);
      setCreatorOverrides((current) => ({ ...current, [item.sourceUrl || item.id]: value }));
      return value;
    },
    [onResolveCreator],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showTip, setShowTip] = useState(true);
  const [feedback, setFeedback] = useState<Record<string, DiscoverRecommendation["feedback"]>>({});
  const [savedOverrides, setSavedOverrides] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const pendingIds = useRef(new Set<string>());
  const [actionError, setActionError] = useState<string | null>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [filterDirection, setFilterDirection] = useState(data.directionKey);
  // Reset before committing a new direction, so an old creator or now-hidden
  // platform filter cannot leave the freshly personalized feed looking empty.
  if (filterDirection !== data.directionKey) {
    setFilterDirection(data.directionKey);
    setCreator(null);
    setSelectedId(null);
    setPlatform("all");
    setSearch("");
    setFeed("all");
    setSort("relevance");
    setPeriod(view === "saved" ? 0 : 30);
    setMediaOnly(false);
    setPreset(null);
    setMinViews(0);
    setMinLikes(0);
    setMinFollowers(0);
    setActionError(null);
  }
  const items = useMemo(
    () =>
      visibleDiscoverRecommendations(
        [...data.trends, ...data.ideas].map((item) => ({
          ...item,
          ...creatorOverrides[item.sourceUrl || item.id],
          saved: savedOverrides[item.id] ?? (item.saved || item.feedback === "saved"),
          feedback: feedback[item.id] || item.feedback,
        })),
      ),
    [data.trends, data.ideas, feedback, savedOverrides, creatorOverrides],
  );
  const platforms = [
    ...new Set([
      ...(view === "discover" ? availablePlatforms : []),
      ...items.filter((item) => view === "saved" || !item.savedOnly).map(platformName),
      ...(view === "creators" ? (data.suggestedCreators || []).map((item) => item.platform) : []),
    ]),
  ];
  const scope = items.filter((item) => {
    if (item.savedOnly && view !== "saved") return false;
    if (view === "saved" && !item.saved) return false;
    if (
      creator &&
      creatorKey(item) !== creatorKey(creator) &&
      !(
        creator.authorUrl &&
        creatorMatchesSource(
          { profileUrl: creator.authorUrl, platform: platformName(creator) },
          item,
        )
      )
    )
      return false;
    if (
      !(view === "saved" && feed === "all") &&
      (feed === "ideas" ? item.kind !== "idea" : item.kind !== "trend")
    )
      return false;
    if (feed === "ideas" && !item.angles.length && !item.inspiration) return false;
    return recommendationMatches(item, search);
  });
  const matchesFormat = (item: DiscoverRecommendation) => {
    if (platform !== "all" && platformName(item) !== platform) return false;
    if (
      mediaOnly &&
      !sourceThumbnail(item) &&
      !item.media?.length &&
      !["Video", "Reel"].includes(sourcePostEmbed(item.sourceUrl)?.label || "")
    )
      return false;
    return true;
  };
  const matchesPerformance = (item: DiscoverRecommendation) => {
    if (!publishedWithin(item, period, now)) return false;
    if (minViews && (item.stats?.views == null || item.stats.views < minViews)) return false;
    if (minLikes && (item.stats?.likes == null || item.stats.likes < minLikes)) return false;
    if (minFollowers && (item.stats?.followers == null || item.stats.followers < minFollowers))
      return false;
    if (
      preset === "viral" &&
      (!publishedWithin(item, 7, now) ||
        !((item.stats?.likes ?? 0) >= 500 || (item.stats?.views ?? 0) >= 50_000))
    )
      return false;
    return true;
  };
  const exact = scope.filter((item) => matchesFormat(item) && matchesPerformance(item));
  const sorted = uniqueDiscoverPosts(exact).sort((a, b) => {
    if (sort === "newest")
      return (
        (Date.parse(b.sourcePublishedAt || "") || 0) - (Date.parse(a.sourcePublishedAt || "") || 0)
      );
    if (sort === "likes" || sort === "views")
      return (b.stats?.[sort] ?? -1) - (a.stats?.[sort] ?? -1);
    return (b.relevanceScore || 0) - (a.relevanceScore || 0);
  });
  const filtered =
    feed === "all" && view === "discover" && !creator && sort === "relevance"
      ? curateDiscoverPosts(sorted, now)
      : sorted;
  const windowKey = JSON.stringify([
    data.directionKey,
    data.lastRefreshedAt,
    view,
    feed,
    platform,
    sort,
    period,
    mediaOnly,
    preset,
    minViews,
    minLikes,
    minFollowers,
    search,
    creator?.id,
  ]);
  const [feedWindow, setFeedWindow] = useState({
    key: windowKey,
    count: DISPLAY_PAGE_SIZE,
    keys: [] as string[],
  });
  const sameWindow = feedWindow.key === windowKey;
  const byPost = new Map(filtered.map((item) => [discoverPostKey(item), item]));
  const previousKeys = sameWindow ? feedWindow.keys.filter((key) => byPost.has(key)) : [];
  const knownKeys = new Set(previousKeys);
  // New pages append to the current reading order. Changing filters starts a
  // fresh ordering; posts already on screen never jump above the scroll position.
  const orderedKeys = [
    ...previousKeys,
    ...filtered.map(discoverPostKey).filter((key) => !knownKeys.has(key)),
  ];
  const visibleCount = sameWindow ? feedWindow.count : DISPLAY_PAGE_SIZE;
  if (
    !sameWindow ||
    orderedKeys.length !== feedWindow.keys.length ||
    orderedKeys.some((key, index) => key !== feedWindow.keys[index])
  ) {
    setFeedWindow({ key: windowKey, count: visibleCount, keys: orderedKeys });
  }
  const displayed = orderedKeys.slice(0, visibleCount).map((key) => byPost.get(key)!);
  const pageState = pagination[platform];
  const canResearchMore =
    view === "discover" &&
    feed !== "ideas" &&
    !creator &&
    Boolean(onLoadMore && pageState?.hasMore);
  const loadingMore =
    view === "discover" && feed !== "ideas" && !creator && Boolean(pageState?.loading);
  const loadMoreError =
    view === "discover" && feed !== "ideas" && !creator ? pageState?.error : null;
  const hasLocalMore = displayed.length < filtered.length;
  const canLoadMore = hasLocalMore || canResearchMore;
  // Scrolling only reveals cached rows. Provider continuation requires the visible button.
  const sentinelRef = useRef<HTMLDivElement>(null);
  const automaticRequest = useRef("");
  const requestKey = `${windowKey}:${pageState?.cursor || "first"}:${orderedKeys.length}:${displayed.length}`;
  const loadNext = useCallback(
    (retry = false) => {
      if (loadingMore || refreshing) return;
      automaticRequest.current = requestKey;
      if (hasLocalMore) {
        setFeedWindow((current) => ({ ...current, count: current.count + DISPLAY_PAGE_SIZE }));
      } else if (canResearchMore && onLoadMore) {
        void Promise.resolve(onLoadMore(platform, retry)).catch(() => {
          // The parent keeps the per-platform error and retry status visible.
        });
      }
    },
    [loadingMore, refreshing, requestKey, hasLocalMore, canResearchMore, onLoadMore, platform],
  );
  useEffect(() => {
    const node = sentinelRef.current;
    if (
      !node ||
      !hasLocalMore ||
      loadingMore ||
      refreshing ||
      loadMoreError ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          active &&
          entries.some((entry) => entry.isIntersecting) &&
          automaticRequest.current !== requestKey
        )
          loadNext();
      },
      { rootMargin: "650px 0px" },
    );
    observer.observe(node);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [hasLocalMore, loadingMore, refreshing, loadMoreError, requestKey, loadNext]);
  const selected = items.find((item) => item.id === selectedId) || null;
  const creatorUrl =
    creator && (publicSourceUrl(creator.authorUrl) || sourceCreator(creator.sourceUrl)?.url);
  const activeFilters =
    Number(platform !== "all") +
    Number(period !== 30) +
    Number(sort !== "relevance") +
    Number(minViews > 0) +
    Number(minLikes > 0) +
    Number(minFollowers > 0);
  const resetFilters = () => {
    setPlatform("all");
    setPeriod(30);
    setSort("relevance");
    setPreset(null);
    setMinViews(0);
    setMinLikes(0);
    setMinFollowers(0);
    setMediaOnly(false);
    setSearch("");
    setFeed("all");
  };
  const changeView = (next: typeof view) => {
    setView(next);
    setCreator(null);
    resetFilters();
    if (next === "saved") setPeriod(0);
  };
  const changeFeed = (next: Feed) => {
    setFeed(next);
    setSort(next === "trends" ? "newest" : "relevance");
  };
  const openPost = (post: DiscoverRecommendation) => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelectedId(post.id);
  };
  const openCreator = (item: DiscoverRecommendation) => {
    setCreatorReturnView(view);
    setCreator(item);
    setView("discover");
    setSelectedId(null);
    resetFilters();
  };
  const updateFeedback = async (
    id: string,
    value: DiscoverRecommendation["feedback"],
    action: (id: string) => void | Promise<void>,
    saved?: boolean,
  ) => {
    if (pendingIds.current.has(id)) return;
    pendingIds.current.add(id);
    setPending(new Set(pendingIds.current));
    setActionError(null);
    try {
      await action(id);
      setFeedback((current) => ({ ...current, [id]: value }));
      if (saved !== undefined) setSavedOverrides((current) => ({ ...current, [id]: saved }));
      if (value === "not_relevant" && selectedId === id) setSelectedId(null);
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "This action could not be saved. Please try again.",
      );
    } finally {
      pendingIds.current.delete(id);
      setPending(new Set(pendingIds.current));
    }
  };
  const actions: DiscoverActions = {
    onLike: (id) => {
      const liked = items.find((item) => item.id === id)?.feedback === "liked";
      if (liked && onClearFeedback) void updateFeedback(id, "pending", onClearFeedback);
      else if (!liked) void updateFeedback(id, "liked", onLike);
    },
    onSave: (id) => void updateFeedback(id, "saved", onSave, true),
    onUnsave: onUnsave
      ? (id) =>
          void updateFeedback(
            id,
            items.find((item) => item.id === id)?.feedback === "liked" ? "liked" : "pending",
            onUnsave,
            false,
          )
      : undefined,
    onReject: (id) => void updateFeedback(id, "not_relevant", onReject),
    onAskAgent,
    onCreateDraft,
    onResolveCreator: onResolveCreator ? resolveCreator : undefined,
    pending,
    onShowSaved: () => {
      setSelectedId(null);
      changeView("saved");
    },
  };

  return (
    <section aria-labelledby="discover-heading" className="discover-workspace">
      <div className="discover-search-bar">
        <Search aria-hidden="true" />
        <input
          type="search"
          aria-label="Search Discover"
          placeholder={creator ? "Search posts…" : "Search Discover"}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="discover-icon-button"
              aria-label="Open feed filters"
              title="Filter platforms, performance, and date"
            >
              <SlidersHorizontal />
              {activeFilters > 0 && <span className="discover-filter-count">{activeFilters}</span>}
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="discover-menu discover-filters"
            aria-label="Feed filters"
          >
            <h3>Feed filters</h3>
            {view !== "saved" && (
              <p className="discover-quality-hint">
                Social posts need 1K+ followers and either 10K+ views or 100+ likes. Community posts
                use verified votes and discussion.
              </p>
            )}
            <label>
              Platform
              <select
                aria-label="Discover platform"
                value={platform}
                onChange={(event) => setPlatform(event.target.value)}
              >
                <option value="all">All platforms</option>
                {platforms.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
            {view !== "creators" && (
              <>
                <label>
                  Sort by
                  <select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
                    <option value="relevance">For you</option>
                    <option value="newest">Newest</option>
                    <option value="likes">Most liked</option>
                    <option value="views">Most viewed</option>
                  </select>
                </label>
                <label>
                  Minimum reported views
                  <select
                    value={minViews}
                    onChange={(event) => setMinViews(Number(event.target.value))}
                  >
                    <option value={0}>Any eligible post</option>
                    <option value={10000}>10K views</option>
                    <option value={50000}>50K views</option>
                    <option value={100000}>100K views</option>
                    <option value={1000000}>1M views</option>
                  </select>
                </label>
                <label>
                  Minimum reported likes
                  <select
                    value={minLikes}
                    onChange={(event) => setMinLikes(Number(event.target.value))}
                  >
                    <option value={0}>Any eligible post</option>
                    <option value={100}>100 likes</option>
                    <option value={500}>500 likes</option>
                    <option value={1000}>1K likes</option>
                    <option value={10000}>10K likes</option>
                  </select>
                </label>
                <label>
                  Minimum creator followers
                  <select
                    value={minFollowers}
                    onChange={(event) => setMinFollowers(Number(event.target.value))}
                  >
                    <option value={0}>Any eligible creator</option>
                    <option value={1000}>1K followers</option>
                    <option value={10000}>10K followers</option>
                    <option value={100000}>100K followers</option>
                    <option value={1000000}>1M followers</option>
                  </select>
                </label>
                <label>
                  Posted within
                  <select
                    value={period}
                    onChange={(event) => setPeriod(Number(event.target.value))}
                  >
                    {[
                      [1, "Last 24 hours"],
                      [7, "Last 7 days"],
                      [30, "Last 30 days"],
                      ...(view === "saved"
                        ? [
                            [0, "All dates"],
                            [90, "3 months"],
                            [180, "6 months"],
                            [365, "Year"],
                          ]
                        : []),
                    ].map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <button type="button" className="discover-reset" onClick={resetFilters}>
              Reset filters
            </button>
          </PopoverContent>
        </Popover>
      </div>
      {creator ? (
        <div className="discover-creator-heading">
          <button
            type="button"
            className="discover-icon-button"
            onClick={() => changeView(creatorReturnView)}
            aria-label={creatorReturnView === "creators" ? "Back to Creators" : "Back to Discover"}
          >
            <ArrowLeft />
          </button>
          <h2 id="discover-heading">{creatorName(creator)}</h2>
          <span>{platformName(creator)}</span>
          {creatorUrl && (
            <a
              className="discover-profile-link"
              href={creatorUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Open profile <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      ) : (
        <nav className="discover-navigation" aria-label="Discover views">
          {(
            [
              ["discover", "Discover"],
              ["creators", "Creators"],
              ["saved", "Saved"],
            ] as const
          ).map(([id, label]) => (
            <button
              type="button"
              key={id}
              aria-current={view === id ? "page" : undefined}
              onClick={() => changeView(id)}
            >
              {view === id ? <h2 id="discover-heading">{label}</h2> : label}
            </button>
          ))}
        </nav>
      )}
      <p className="discover-intro">
        {creator
          ? "Explore this creator’s posts in your feed, or open their profile for more."
          : view === "saved"
            ? "Your saved inspiration, ready to explore with Agent."
            : view === "creators"
              ? "Your favorite creators, their latest posts, and ideas worth making your own."
              : "Fresh inspiration for what you’ll create next. Learn from real posts, then make something of your own."}
      </p>
      <div className="discover-toolbar">
        {view !== "creators" && (
          <div className="discover-feed-switch" aria-label="Discover feed mode">
            {(
              [
                ["all", "For you"],
                ["trends", "Posts"],
                ["ideas", "Ideas"],
              ] as const
            ).map(([id, label]) => (
              <button
                type="button"
                key={id}
                aria-pressed={feed === id}
                onClick={() => changeFeed(id)}
              >
                {view === "saved" && id === "all" ? "All saved" : label}
              </button>
            ))}
          </div>
        )}
        <div className="discover-chip-strip" ref={chipsRef} aria-label="Discover filters">
          {view !== "creators" && (
            <>
              <button
                type="button"
                className="discover-chip"
                aria-pressed={preset === "viral"}
                title="Posts from the last 7 days with at least 500 reported likes or 50K reported views"
                onClick={() => setPreset(preset === "viral" ? null : "viral")}
              >
                <Flame />
                Gaining traction
              </button>
            </>
          )}
          {platforms.map((name) => (
            <button
              key={name}
              type="button"
              className="discover-chip"
              aria-pressed={platform === name}
              onClick={() => setPlatform(platform === name ? "all" : name)}
            >
              {platform === name && <Check />}
              {name}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="discover-icon-button discover-scroll-chips"
          aria-label="Scroll filters right"
          onClick={() => chipsRef.current?.scrollBy({ left: 220, behavior: "smooth" })}
        >
          <ChevronRight />
        </button>
        <div className="discover-toolbar-tools">
          {view !== "creators" && (
            <button
              type="button"
              className="discover-icon-button"
              aria-label="Media only"
              title="Media only"
              aria-pressed={mediaOnly}
              onClick={() => setMediaOnly(!mediaOnly)}
            >
              <Image />
            </button>
          )}
          {onRefresh && (
            <button
              type="button"
              className="discover-icon-button"
              aria-label="Refresh feed"
              title="Refresh feed"
              disabled={refreshing}
              onClick={onRefresh}
            >
              <RefreshCw className={refreshing ? "animate-spin" : ""} />
            </button>
          )}
        </div>
      </div>
      {view !== "creators" && (
        <div className="discover-feed-heading">
          <div>
            <h3>
              {view === "saved"
                ? "Your saved inspiration"
                : feed === "ideas"
                  ? "Your next original idea"
                  : feed === "trends"
                    ? "Explore the source posts"
                    : "A fresh perspective, picked for you"}
            </h3>
            <p>
              {view === "saved"
                ? "Posts and ideas you saved, with their original sources."
                : feed === "ideas"
                  ? "Creation prompts, hooks and outlines inspired by real posts. Add your own experience and voice."
                  : feed === "trends"
                    ? "Real posts with publication dates and available performance. Sort the collection or open the original."
                    : "A continuous feed shaped by your Brain, freshness and reported performance. Keep scrolling for more inspiration."}
            </p>
            {filtered.length > 0 && (
              <div className="discover-feed-meta">
                <span>
                  {displayed.length < filtered.length
                    ? `${displayed.length} of ${filtered.length}`
                    : filtered.length}{" "}
                  {view === "saved"
                    ? "saved"
                    : feed === "ideas"
                      ? filtered.length === 1
                        ? "idea"
                        : "ideas"
                      : feed === "all"
                        ? filtered.length === 1
                          ? "eligible post"
                          : "eligible posts"
                        : filtered.length === 1
                          ? "post"
                          : "posts"}
                  {period ? ` · Last ${period} ${period === 1 ? "day" : "days"}` : " · All dates"}
                </span>
              </div>
            )}
          </div>
          <label className="discover-period-control">
            {feed === "ideas" ? "Inspired by posts from" : "Published"}
            <select
              aria-label="Feed date range"
              value={period}
              onChange={(event) => setPeriod(Number(event.target.value))}
            >
              <option value={1}>Last 24 hours</option>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              {view === "saved" && (
                <>
                  <option value={90}>Last 90 days</option>
                  <option value={180}>Last 6 months</option>
                  <option value={365}>Last year</option>
                  <option value={0}>All dates · includes archive</option>
                </>
              )}
            </select>
          </label>
        </div>
      )}
      {showTip && view === "discover" && feed === "all" && !creator && (
        <div className="discover-tip">
          <Plus aria-hidden="true" />
          <div>
            <strong>Save 3 posts you wish you’d made</strong>
            <p>
              Tap + on a post to save it for later, or hit{" "}
              <Zap className="inline size-3" aria-hidden="true" /> Boost to reverse-engineer it or
              get variations. Your feed gets more personalized with everything you save.
            </p>
          </div>
          <button
            type="button"
            className="discover-icon-button"
            aria-label="Dismiss"
            onClick={() => setShowTip(false)}
          >
            <X />
          </button>
        </div>
      )}
      {data.warnings.length > 0 && (
        <details className="discover-warning">
          <summary>Platform coverage · {data.warnings.length} updates</summary>
          {data.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          {onRefresh && (
            <button type="button" disabled={refreshing} onClick={onRefresh}>
              Retry sources
            </button>
          )}
        </details>
      )}
      {refreshing && filtered.length > 0 && (
        <div className="discover-refresh-progress" role="status" aria-live="polite">
          <RefreshCw className="size-3.5 animate-spin" />
          <span>
            {refreshStatus || "Refreshing recommendations…"}
            <small>You can browse now while the remaining platforms finish.</small>
          </span>
          <span className="discover-progress-track" aria-hidden="true" />
        </div>
      )}
      {(refreshError || (actionError && !selected)) && (
        <div className="discover-error" role="alert">
          <span>{refreshError || actionError}</span>
          {refreshError && onRefresh && (
            <button type="button" onClick={onRefresh}>
              Try again
            </button>
          )}
        </div>
      )}
      <p className="sr-only" role="status">
        {filtered.length} {feed === "ideas" ? "ideas" : "posts"}
        {view === "saved" ? " saved" : " found"}
      </p>
      {view === "creators" ? (
        <DiscoverCreators
          items={uniqueDiscoverPosts(
            items.filter((item) => item.kind === "trend" && !item.savedOnly),
          )}
          suggestions={data.suggestedCreators || []}
          creators={data.creators || []}
          platform={platform}
          search={search}
          now={now}
          onOpen={openCreator}
          onTrack={
            onTrackCreator
              ? async (input) => {
                  await onTrackCreator(input);
                  resetFilters();
                }
              : undefined
          }
          onUntrack={onUntrackCreator}
          onResolveCreator={onResolveCreator ? resolveCreator : undefined}
        />
      ) : (
        <div
          className="discover-grid"
          data-mode={feed}
          data-sparse={displayed.length <= 4 && !loadingMore}
        >
          {displayed.map((item, index) => (
            <motion.div
              key={`${feed}:${discoverPostKey(item)}`}
              className="discover-feed-item"
              layout={reducedMotion ? false : "position"}
              initial={false}
              transition={{ type: "spring", stiffness: 360, damping: 35 }}
              style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
            >
              {item.kind === "idea" ? (
                <DiscoverIdeaCard
                  item={item}
                  now={now}
                  actions={actions}
                  onSource={
                    items.some(
                      (candidate) =>
                        candidate.kind === "trend" &&
                        discoverPostKey(candidate) === discoverPostKey(item),
                    )
                      ? (post) =>
                          openPost(
                            items.find(
                              (candidate) =>
                                candidate.kind === "trend" &&
                                discoverPostKey(candidate) === discoverPostKey(post),
                            )!,
                          )
                      : undefined
                  }
                />
              ) : (
                <DiscoverPostCard
                  item={item}
                  now={now}
                  actions={actions}
                  onOpen={openPost}
                  onCreator={openCreator}
                  curated={feed === "all" && view === "discover"}
                />
              )}
            </motion.div>
          ))}
          {loadingMore && <DiscoverSkeletonCards />}
        </div>
      )}
      {view !== "creators" && (canLoadMore || loadingMore || loadMoreError) && (
        <div
          ref={sentinelRef}
          className="discover-pagination"
          aria-label="More Discover inspiration"
        >
          {loadingMore ? (
            <p role="status" aria-live="polite">
              <RefreshCw className="animate-spin" />
              {pageState?.status ||
                `Checking more ${platform === "all" ? "posts" : `${platform} posts`} for your board…`}
            </p>
          ) : loadMoreError ? (
            <div role="alert">
              <p>{loadMoreError}</p>
              <button type="button" onClick={() => loadNext(true)}>
                Try loading again
              </button>
            </div>
          ) : (
            <button type="button" disabled={refreshing} onClick={() => loadNext()}>
              {hasLocalMore
                ? `Show more ${feed === "ideas" ? "ideas" : "posts"}`
                : `Load more ${platform === "all" ? "posts" : `${platform} posts`}`}
            </button>
          )}
        </div>
      )}
      {!filtered.length && refreshing && view !== "creators" && (
        <DiscoverLoading status={refreshStatus || undefined} />
      )}
      {!filtered.length &&
        !refreshing &&
        !loadingMore &&
        !canResearchMore &&
        view !== "creators" && (
          <div className="discover-empty">
            <Bookmark />
            <h3>
              {data.status === "needs_niche"
                ? "Let’s find your inspiration"
                : view === "saved"
                  ? "Your inspiration, all in one place"
                  : feed === "ideas"
                    ? "No recent ideas match yet"
                    : "No posts match these filters yet"}
            </h3>
            <p>
              {data.status === "needs_niche"
                ? "Set topics in Your Discover direction above or connect a social account so Bento knows what to research."
                : refreshing
                  ? "Researching top posts in your niche…"
                  : view === "saved"
                    ? "Save posts with the + button and find them here."
                    : preset === "viral"
                      ? "No posts in this selection have a verified date in the last 7 days and at least 500 reported likes or 50K views. Refresh to look for more."
                      : period
                        ? `We haven’t found matching posts with a verified publish date in the last ${period} days. Refresh to look for more${period < 30 ? ", or choose a wider date range" : ", or adjust your other filters"}.`
                        : "Try a different search or clear your filters."}
            </p>
            {view === "saved" ? (
              <button type="button" onClick={() => changeView("discover")}>
                Explore Discover
              </button>
            ) : (
              <div className="discover-empty-actions">
                {onRefresh && (
                  <button type="button" onClick={onRefresh}>
                    <RefreshCw />
                    Find fresh posts
                  </button>
                )}
                <button type="button" onClick={resetFilters}>
                  Clear filters
                </button>
              </div>
            )}
          </div>
        )}
      <DiscoverPostDialog
        item={selected}
        items={items.filter(
          (item) => item.kind === "trend" && (view === "saved" || !item.savedOnly),
        )}
        now={now}
        actions={actions}
        onClose={() => setSelectedId(null)}
        onOpen={(post) => setSelectedId(post.id)}
        onCreator={openCreator}
        actionError={actionError}
        onRestoreFocus={() => {
          if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
        }}
      />
    </section>
  );
}
