import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import {
  Activity,
  ArrowLeft,
  BarChart3,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Compass,
  DollarSign,
  Eye,
  ExternalLink,
  Gift,
  Goal,
  Gauge,
  Globe2,
  HeartPulse,
  LoaderCircle,
  Mail,
  MousePointerClick,
  RefreshCw,
  Search,
  ShieldCheck,
  Trophy,
  UserRound,
  UserRoundCheck,
  UsersRound,
  Wifi,
  Wrench,
  XCircle,
} from "lucide-react";
import {
  getAdminOverview,
  getComplimentaryPlanGrants,
  getExploreReviews,
  grantComplimentaryPlan,
  reviewExploreProfile,
  revokeComplimentaryPlan,
  type ComplimentaryPlanGrant,
  type ExploreReviewItem,
  type FounderCreatorRevenue,
} from "@/lib/admin.functions";
import { isAdminAccessError } from "@/lib/admin-dashboard";
import type { AnalyticsBreakdown, CrawlerBreakdown } from "@/lib/posthog-analytics.server";
import { MobileTabSelect } from "@/components/MobileTabSelect";
import { MicroAppTabMotion } from "@/components/MicroAppPanel";
import { MicroAppTabs } from "@/components/MicroAppTabs";
import { DecodedImage } from "@/components/DecodedImage";
import { BentoBrand } from "@/components/BentoBrand";
import { FounderAffiliates } from "@/components/admin/FounderAffiliates";
import { configuredPublicOrigin, publicProfileUrl } from "@/lib/application-urls";
import {
  exploreCategoryLabel,
  exploreReviewQueueSchema,
  isLiveOnExplore,
  isReadyForExploreReview,
} from "@/lib/explore";
import { createAdminWebMcpTools } from "@/lib/admin-webmcp";
import { useWebMcpTools } from "@/lib/webmcp";

export const Route = createFileRoute("/_authenticated/admin")({
  validateSearch: z.object({
    tab: z.enum(["overview", "creators", "operations", "affiliates", "explore"]).catch("overview"),
    review: exploreReviewQueueSchema.catch("pending"),
  }),
  head: () => ({ meta: [{ title: "Founder analytics" }] }),
  component: AdminPage,
});

type Period = 7 | 30 | 90;
type Granularity = "Daily" | "Weekly" | "Monthly";
type MetricMode = "visitors" | "revenue";
type AcquisitionTab = "Channel" | "Referrer" | "Campaign" | "Keyword";
type GeographyTab = "Map" | "Country" | "Region" | "City";
type ContentTab = "Hostname" | "Page" | "Entry page" | "Exit link";
type TechnologyTab = "Browser" | "OS" | "Device";
type JourneyTab = "Goal" | "Funnel" | "User" | "Journey";
type CrawlerTab = "AI answers" | "Indexing" | "Training";
type FounderTab = "overview" | "creators" | "operations" | "affiliates" | "explore";

const founderTabs = [
  { id: "overview", label: "Overview", icon: BarChart3 },
  { id: "creators", label: "Creators", icon: UsersRound },
  { id: "operations", label: "Operations", icon: Wrench },
  { id: "affiliates", label: "Affiliates", icon: Gift },
  { id: "explore", label: "Explore", icon: Compass },
] as const;

function AdminPage() {
  const { tab, review } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [days, setDays] = useState<Period>(30);
  const [offset, setOffset] = useState(0);
  const [granularity, setGranularity] = useState<Granularity>("Daily");
  const [acquisitionTab, setAcquisitionTab] = useState<AcquisitionTab>("Referrer");
  const [geographyTab, setGeographyTab] = useState<GeographyTab>("Country");
  const [contentTab, setContentTab] = useState<ContentTab>("Page");
  const [technologyTab, setTechnologyTab] = useState<TechnologyTab>("Browser");
  const [journeyTab, setJourneyTab] = useState<JourneyTab>("Journey");
  const [crawlerTab, setCrawlerTab] = useState<CrawlerTab>("AI answers");
  const [acquisitionMetric, setAcquisitionMetric] = useState<MetricMode>("visitors");
  const [geographyMetric, setGeographyMetric] = useState<MetricMode>("visitors");
  const [contentMetric, setContentMetric] = useState<MetricMode>("visitors");
  const [technologyMetric, setTechnologyMetric] = useState<MetricMode>("visitors");
  const [search, setSearch] = useState("");
  const [reviewPage, setReviewPage] = useState(1);

  const overview = useQuery({
    queryKey: ["admin-overview", days, offset],
    queryFn: () => getAdminOverview({ data: { days, offset } }),
    retry: (failureCount, error) => failureCount < 1 && !isAdminAccessError(error),
    refetchInterval: 60_000,
  });
  const pendingReviews = useQuery({
    queryKey: ["admin-explore-reviews", "pending", 1],
    queryFn: () => getExploreReviews({ data: { queue: "pending", page: 1 } }),
    retry: (failureCount, error) => failureCount < 1 && !isAdminAccessError(error),
    refetchInterval: 60_000,
  });

  useWebMcpTools(
    overview.data &&
      !isAdminAccessError(overview.error) &&
      !isAdminAccessError(pendingReviews.error)
      ? createAdminWebMcpTools({
          refresh: () =>
            Promise.all([
              queryClient.invalidateQueries({ queryKey: ["admin-overview"] }),
              queryClient.invalidateQueries({ queryKey: ["admin-explore-reviews"] }),
              queryClient.invalidateQueries({ queryKey: ["admin-complimentary-plan-grants"] }),
              queryClient.invalidateQueries({ queryKey: ["founder-affiliates"] }),
            ]),
        })
      : [],
  );

  const setTab = (nextTab: FounderTab) => {
    setReviewPage(1);
    void navigate({
      to: "/admin",
      search: { tab: nextTab, review: nextTab === "explore" ? review : "pending" },
      replace: true,
    });
  };

  if (overview.isLoading && tab !== "explore" && tab !== "affiliates") return <LoadingState />;
  if (isAdminAccessError(overview.error) || isAdminAccessError(pendingReviews.error)) {
    return <AccessError />;
  }
  if (tab !== "explore" && tab !== "affiliates" && !overview.data) {
    return <AdminLoadError onRetry={() => overview.refetch()} />;
  }

  const data = overview.data;
  const pendingCount = pendingReviews.data?.pendingCount ?? 0;
  const tabs = founderTabs.map((item) =>
    item.id === "explore" ? { ...item, count: pendingCount } : item,
  );

  return (
    <main
      className="relative min-h-screen overflow-x-clip bg-[#eef4ff] text-[#17213a]"
      data-private
    >
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_12%_8%,rgba(255,201,40,0.22),transparent_22%),radial-gradient(circle_at_88%_16%,rgba(52,120,246,0.17),transparent_25%),radial-gradient(circle_at_52%_100%,rgba(255,122,89,0.12),transparent_28%)]" />
      <div className="relative mx-auto w-full max-w-[1180px] px-3 py-5 sm:px-6 lg:py-8">
        <AnalyticsToolbar
          days={days}
          offset={offset}
          granularity={granularity}
          refreshing={tab === "explore" ? pendingReviews.isFetching : overview.isFetching}
          showPeriod={tab === "overview" || tab === "creators"}
          onDays={(value) => {
            setDays(value);
            setOffset(0);
          }}
          onPrevious={() => setOffset((value) => value + days)}
          onNext={() => setOffset((value) => Math.max(0, value - days))}
          onGranularity={setGranularity}
          onRefresh={() => {
            if (tab === "explore") void pendingReviews.refetch();
            else void overview.refetch();
          }}
        />

        <MicroAppTabs
          tabs={tabs}
          value={tab}
          onChange={setTab}
          ariaLabel="Founder analytics section"
          className="mb-4"
        />

        {tab !== "explore" && overview.isError && data && (
          <div
            className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#ff7a59]/30 bg-[#fff0ea]/90 px-5 py-4 text-sm shadow-sm backdrop-blur-xl"
            role="status"
          >
            <span>
              <strong>The latest refresh failed.</strong>{" "}
              <span className="text-black/55">Showing the last successfully loaded snapshot.</span>
            </span>
            <button
              type="button"
              onClick={() => overview.refetch()}
              disabled={overview.isFetching}
              className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold shadow-sm disabled:opacity-50"
            >
              {overview.isFetching ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}

        <MicroAppTabMotion tabKey={tab} className="mt-0">
          {tab === "affiliates" ? (
            <FounderAffiliates />
          ) : tab === "explore" ? (
            <ExploreReviewQueue
              queue={review}
              page={reviewPage}
              onQueue={(next) => {
                setReviewPage(1);
                void navigate({
                  to: "/admin",
                  search: { tab: "explore", review: next },
                  replace: true,
                });
              }}
              onPage={setReviewPage}
            />
          ) : data ? (
            <FounderTabContent
              tab={tab}
              data={data}
              days={days}
              offset={offset}
              granularity={granularity}
              acquisitionTab={acquisitionTab}
              geographyTab={geographyTab}
              contentTab={contentTab}
              technologyTab={technologyTab}
              journeyTab={journeyTab}
              crawlerTab={crawlerTab}
              acquisitionMetric={acquisitionMetric}
              geographyMetric={geographyMetric}
              contentMetric={contentMetric}
              technologyMetric={technologyMetric}
              search={search}
              onAcquisitionTab={setAcquisitionTab}
              onGeographyTab={setGeographyTab}
              onContentTab={setContentTab}
              onTechnologyTab={setTechnologyTab}
              onJourneyTab={setJourneyTab}
              onCrawlerTab={setCrawlerTab}
              onAcquisitionMetric={setAcquisitionMetric}
              onGeographyMetric={setGeographyMetric}
              onContentMetric={setContentMetric}
              onTechnologyMetric={setTechnologyMetric}
              onSearch={setSearch}
            />
          ) : (
            <LoadingState />
          )}
        </MicroAppTabMotion>
      </div>
    </main>
  );
}

function FounderTabContent({
  tab,
  data,
  days,
  offset,
  granularity,
  acquisitionTab,
  geographyTab,
  contentTab,
  technologyTab,
  journeyTab,
  crawlerTab,
  acquisitionMetric,
  geographyMetric,
  contentMetric,
  technologyMetric,
  search,
  onAcquisitionTab,
  onGeographyTab,
  onContentTab,
  onTechnologyTab,
  onJourneyTab,
  onCrawlerTab,
  onAcquisitionMetric,
  onGeographyMetric,
  onContentMetric,
  onTechnologyMetric,
  onSearch,
}: {
  tab: Exclude<FounderTab, "explore">;
  data: Awaited<ReturnType<typeof getAdminOverview>>;
  days: Period;
  offset: number;
  granularity: Granularity;
  acquisitionTab: AcquisitionTab;
  geographyTab: GeographyTab;
  contentTab: ContentTab;
  technologyTab: TechnologyTab;
  journeyTab: JourneyTab;
  crawlerTab: CrawlerTab;
  acquisitionMetric: MetricMode;
  geographyMetric: MetricMode;
  contentMetric: MetricMode;
  technologyMetric: MetricMode;
  search: string;
  onAcquisitionTab: (tab: AcquisitionTab) => void;
  onGeographyTab: (tab: GeographyTab) => void;
  onContentTab: (tab: ContentTab) => void;
  onTechnologyTab: (tab: TechnologyTab) => void;
  onJourneyTab: (tab: JourneyTab) => void;
  onCrawlerTab: (tab: CrawlerTab) => void;
  onAcquisitionMetric: (metric: MetricMode) => void;
  onGeographyMetric: (metric: MetricMode) => void;
  onContentMetric: (metric: MetricMode) => void;
  onTechnologyMetric: (metric: MetricMode) => void;
  onSearch: (value: string) => void;
}) {
  const web = data.webAnalytics;
  const primaryRevenue = data.revenue[0] ?? {
    currency: "USD",
    gross: 0,
    refunds: 0,
    net: 0,
    mrr: 0,
  };
  const periodRevenue = data.periodRevenue.find(
    (row) => row.currency === primaryRevenue.currency,
  ) ?? { currency: primaryRevenue.currency, gross: 0, refunds: 0, net: 0 };
  const chartRows = web.daily.map((row) => ({
    ...row,
    revenue: data.dailyRevenue.find((item) => item.date === row.date)?.revenue ?? 0,
  }));
  const displayRows = groupSeries(chartRows, granularity);
  const filteredUsers = filterUsers(data.recentUsers, search);
  const filteredJourneys = data.journeys.filter((journey) =>
    [journey.username, journey.email, journey.source, journey.country]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(search.trim().toLowerCase())),
  );
  const acquisitionRows = {
    Channel: web.acquisition.channels,
    Referrer: web.acquisition.referrers,
    Campaign: web.acquisition.campaigns,
    Keyword: web.acquisition.keywords,
  }[acquisitionTab];
  const geographyRows = {
    Map: web.geography.countries,
    Country: web.geography.countries,
    Region: web.geography.regions,
    City: web.geography.cities,
  }[geographyTab];
  const contentRows = {
    Hostname: web.content.hostnames,
    Page: web.content.pages,
    "Entry page": web.content.entryPages,
    "Exit link": web.content.exitLinks,
  }[contentTab];
  const technologyRows = {
    Browser: web.technology.browsers,
    OS: web.technology.operatingSystems,
    Device: web.technology.devices,
  }[technologyTab];
  const crawlerRows = {
    "AI answers": web.crawlers.aiAnswers,
    Indexing: web.crawlers.indexing,
    Training: web.crawlers.training,
  }[crawlerTab];
  if (tab === "creators") {
    return (
      <>
        <CreatorPulse
          totals={data.totals}
          activity={data.activity}
          periodLabel={periodLabel(days, offset)}
        />
        <CreatorRevenueLeaderboard
          data={data.creatorRevenue}
          periodLabel={periodLabel(days, offset)}
        />
        <JourneyCard
          active={journeyTab}
          onTab={(next) => onJourneyTab(next as JourneyTab)}
          search={search}
          onSearch={onSearch}
          journeys={filteredJourneys}
          users={filteredUsers}
          funnel={data.funnel}
          conversions={web.overview.conversions}
          currency={periodRevenue.currency}
        />
      </>
    );
  }

  if (tab === "operations") {
    return (
      <div className="rounded-[1.75rem] border border-white/80 bg-white/88 p-5 shadow-[0_18px_60px_rgba(44,77,143,0.10)] ring-1 ring-[#17213a]/8 backdrop-blur-2xl sm:p-6">
        <ComplimentaryAccessManager />
        <AddonCapacity data={data.addons} />
        <SocialPreviewHealth data={data.socialPreviews} />
        <InstagramAutoDmHealth data={data.instagramAutoDm} />
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <OperationsRevenue rows={data.revenue} />
          <BillingHealth events={data.recentBillingEvents} />
        </div>
      </div>
    );
  }

  return (
    <>
      {!web.available && (
        <div className="mb-4 rounded-2xl border border-[#ff7a59]/30 bg-[#fff0ea]/90 px-5 py-4 text-sm shadow-sm backdrop-blur-xl">
          <strong>Live product analytics could not load.</strong>{" "}
          <span className="text-black/55">
            {web.error ?? "The reporting service is unavailable."}
          </span>
        </div>
      )}

      <section className="overflow-hidden rounded-[1.75rem] border border-white/80 bg-white/88 shadow-[0_24px_80px_rgba(44,77,143,0.13)] ring-1 ring-[#17213a]/8 backdrop-blur-2xl">
        <KpiStrip
          visitors={web.overview.visitors}
          revenue={periodRevenue.net}
          currency={periodRevenue.currency}
          conversions={web.overview.conversions}
          previousVisitors={web.overview.previousVisitors}
          previousConversions={web.overview.previousConversions}
          bounceRate={web.overview.bounceRate}
          sessionSeconds={web.overview.averageSessionSeconds}
          online={web.overview.online}
        />
        <MainChart rows={displayRows} currency={periodRevenue.currency} />
      </section>

      <div className="mt-4 grid items-stretch gap-4 lg:grid-cols-2">
        <DimensionCard
          tabs={["Channel", "Referrer", "Campaign", "Keyword"]}
          active={acquisitionTab}
          onTab={(next) => onAcquisitionTab(next as AcquisitionTab)}
          rows={acquisitionRows}
          metric={acquisitionMetric}
          onMetric={onAcquisitionMetric}
          currency={periodRevenue.currency}
        />

        <DimensionCard
          tabs={["Map", "Country", "Region", "City"]}
          active={geographyTab}
          onTab={(next) => onGeographyTab(next as GeographyTab)}
          rows={geographyRows}
          metric={geographyMetric}
          onMetric={onGeographyMetric}
          currency={periodRevenue.currency}
          map={geographyTab === "Map"}
        />

        <DimensionCard
          tabs={["Hostname", "Page", "Entry page", "Exit link"]}
          active={contentTab}
          onTab={(next) => onContentTab(next as ContentTab)}
          rows={contentRows}
          metric={contentMetric}
          onMetric={onContentMetric}
          currency={periodRevenue.currency}
          filterLabel={`All (${compactNumber(web.overview.visitors)})`}
        />

        <DimensionCard
          tabs={["Browser", "OS", "Device"]}
          active={technologyTab}
          onTab={(next) => onTechnologyTab(next as TechnologyTab)}
          rows={technologyRows}
          metric={technologyMetric}
          onMetric={onTechnologyMetric}
          currency={periodRevenue.currency}
        />
      </div>

      <CrawlerCard active={crawlerTab} onTab={onCrawlerTab} rows={crawlerRows} />

      <footer className="flex flex-wrap items-center justify-between gap-3 px-2 py-7 text-xs text-black/45">
        <span>
          Updated{" "}
          {new Date(data.generatedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </footer>
    </>
  );
}

function ExploreReviewQueue({
  queue,
  page,
  onQueue,
  onPage,
}: {
  queue: "pending" | "live" | "rejected";
  page: number;
  onQueue: (queue: "pending" | "live" | "rejected") => void;
  onPage: (page: number) => void;
}) {
  const queryClient = useQueryClient();
  const reviews = useQuery({
    queryKey: ["admin-explore-reviews", queue, page],
    queryFn: () => getExploreReviews({ data: { queue, page } }),
    retry: (failureCount, error) => failureCount < 1 && !isAdminAccessError(error),
  });
  const review = useMutation({
    mutationFn: (input: { userId: string; action: "approve" | "reject" }) =>
      reviewExploreProfile({ data: input }),
    onSuccess: async (_, variables) => {
      toast.success(
        variables.action === "approve"
          ? "That Surf is now live on Explore."
          : "That Surf was kept off Explore.",
      );
      await queryClient.invalidateQueries({ queryKey: ["admin-explore-reviews"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "The review could not be saved.");
    },
  });

  const data = reviews.data;
  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.pageSize ?? 40)));

  useEffect(() => {
    if (!reviews.isSuccess || !data || page <= 1 || data.items.length > 0) return;
    onPage(Math.max(1, Math.ceil(data.total / data.pageSize)));
  }, [data, onPage, page, reviews.isSuccess]);

  const queues = [
    { id: "pending" as const, label: "Needs review", count: data?.pendingCount },
    { id: "live" as const, label: "Live on Explore" },
    { id: "rejected" as const, label: "Not approved" },
  ];

  return (
    <section className="rounded-[1.75rem] border border-white/80 bg-white/88 p-5 shadow-[0_18px_60px_rgba(44,77,143,0.10)] ring-1 ring-[#17213a]/8 backdrop-blur-2xl sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-sans text-lg font-semibold">Explore approvals</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-black/50">
            Creators are opted in by default. Home pages with more than 3 cards appear here, newest
            first. Approve a page before it can show on Explore.
          </p>
        </div>
        <a
          href={`${configuredPublicOrigin(import.meta.env.VITE_PUBLIC_URL)}/explore`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-10 items-center gap-1.5 rounded-2xl border border-[#17213a]/10 bg-white px-3 text-xs font-semibold shadow-sm transition hover:bg-[#edf3ff]"
        >
          Open Explore <ExternalLink className="size-3.5" />
        </a>
      </div>

      <div className="mt-5 flex flex-wrap gap-1 rounded-2xl bg-[#eef1f8] p-1">
        {queues.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onQueue(item.id)}
            className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
              queue === item.id
                ? "bg-white text-[#17213a] shadow-sm"
                : "text-black/45 hover:bg-white/60 hover:text-[#17213a]"
            }`}
          >
            {item.label}
            {typeof item.count === "number" ? (
              <span className="ml-2 rounded-full bg-[#f2f5fb] px-2 py-0.5 text-[10px] tabular-nums">
                {item.count}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {reviews.isLoading ? (
        <div className="grid min-h-48 place-items-center text-sm text-black/40">
          <LoaderCircle className="size-5 animate-spin" />
        </div>
      ) : reviews.isError ? (
        <div className="mt-5 rounded-2xl bg-[#fff0ea] p-4 text-sm text-[#9b3b24]" role="alert">
          <p>The Explore review list could not be loaded.</p>
          <button
            type="button"
            onClick={() => reviews.refetch()}
            disabled={reviews.isFetching}
            className="mt-3 rounded-full bg-white px-3 py-1.5 text-xs font-semibold shadow-sm disabled:opacity-50"
          >
            {reviews.isFetching ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : !data || data.items.length === 0 ? (
        <div className="mt-5 grid min-h-40 place-items-center rounded-2xl border border-dashed border-[#17213a]/12 text-center text-sm text-black/40">
          {queue === "pending"
            ? "No Explore requests with more than 3 cards waiting for review."
            : queue === "live"
              ? "No approved pages are currently opted in to Explore."
              : "No rejected Explore requests."}
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {data.items.map((item) => (
            <ExploreReviewCard
              key={item.userId}
              item={item}
              busy={review.isPending && review.variables?.userId === item.userId}
              onApprove={() => review.mutate({ userId: item.userId, action: "approve" })}
              onReject={() => review.mutate({ userId: item.userId, action: "reject" })}
            />
          ))}
          {pageCount > 1 && (
            <div className="flex items-center justify-between pt-2 text-sm">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => onPage(page - 1)}
                className="rounded-xl border border-[#17213a]/10 bg-white px-3 py-2 font-semibold disabled:opacity-35"
              >
                Previous
              </button>
              <span className="text-black/45">
                Page {page} of {pageCount}
              </span>
              <button
                type="button"
                disabled={page >= pageCount}
                onClick={() => onPage(page + 1)}
                className="rounded-xl border border-[#17213a]/10 bg-white px-3 py-2 font-semibold disabled:opacity-35"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ExploreReviewCard({
  item,
  busy,
  onApprove,
  onReject,
}: {
  item: ExploreReviewItem;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const canApprove =
    item.status !== "approved" && item.showInExplore && isReadyForExploreReview(item.cardCount);
  const live = isLiveOnExplore({
    show_in_explore: item.showInExplore,
    explore_review_status: item.status,
    onboarded: item.onboarded,
    noindex: item.noindex,
    cardCount: item.cardCount,
  });
  const warnings = [
    !item.onboarded ? "Not finished onboarding" : null,
    item.noindex ? "Hidden from search" : null,
    item.status === "approved" && !live ? "Not live on Explore yet" : null,
    !isReadyForExploreReview(item.cardCount) ? "Needs more than 3 home cards" : null,
  ].filter(Boolean);
  const profileUrl = publicProfileUrl(item.username, null, import.meta.env.VITE_PUBLIC_URL);

  return (
    <article className="flex flex-col gap-4 rounded-2xl border border-[#17213a]/8 bg-white p-4 sm:flex-row sm:items-start">
      {item.avatarUrl ? (
        <DecodedImage
          src={item.avatarUrl}
          alt=""
          className="size-14 shrink-0 rounded-2xl object-cover"
        />
      ) : (
        <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-[#dfeaff] font-display text-2xl text-[#245fd0]">
          {(item.displayName || item.username).slice(0, 1).toUpperCase()}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="truncate text-sm">{item.displayName}</strong>
          <span className="truncate text-xs text-black/45">@{item.username}</span>
          <span className="rounded-full bg-[#f0f3fa] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-black/45">
            {exploreCategoryLabel(item.category)}
          </span>
          <span className="rounded-full bg-[#f0f3fa] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-black/45">
            {item.cardCount} card{item.cardCount === 1 ? "" : "s"}
          </span>
        </div>
        {item.email && <p className="mt-1 truncate text-xs text-black/45">{item.email}</p>}
        {item.bio ? (
          <p className="mt-2 line-clamp-2 text-sm leading-5 text-black/55">{item.bio}</p>
        ) : null}
        <p className="mt-2 text-[11px] text-black/40">
          {item.optedInAt ? `Queued ${dateTime(item.optedInAt)}` : "Not in the review queue yet"}
          {item.reviewedAt ? ` · Reviewed ${dateTime(item.reviewedAt)}` : ""}
        </p>
        {warnings.length > 0 && (
          <p className="mt-2 text-xs text-[#9a4818]">{warnings.join(" · ")}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-stretch">
        <a
          href={profileUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-[#17213a]/10 bg-white px-3 text-xs font-semibold"
        >
          Open page <ExternalLink className="size-3.5" />
        </a>
        {item.status !== "approved" && (
          <button
            type="button"
            disabled={busy || !canApprove}
            onClick={onApprove}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl bg-[#17213a] px-3 text-xs font-semibold text-white disabled:opacity-50"
          >
            <CheckCircle2 className="size-3.5" />
            Approve
          </button>
        )}
        {item.status !== "rejected" && (
          <button
            type="button"
            disabled={busy}
            onClick={onReject}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-[#ef4444]/15 bg-[#fff6f6] px-3 text-xs font-semibold text-[#b42318] disabled:opacity-50"
          >
            <XCircle className="size-3.5" />
            {item.status === "approved" ? "Remove" : "Reject"}
          </button>
        )}
      </div>
    </article>
  );
}

function InstagramAutoDmHealth({
  data,
}: {
  data: {
    connections: {
      total: number;
      healthy: number;
      actionRequired: number;
      reauthRequired: number;
    };
    automations: { total: number; enabled: number };
    runs24h: { total: number; completed: number; awaiting: number; failed: number };
    recentFailures: Array<{
      id: string;
      errorCode: string | null;
      errorMessage: string | null;
      attempts: number;
      createdAt: string;
      updatedAt: string;
    }>;
  };
}) {
  const metrics = [
    ["Healthy connections", data.connections.healthy, data.connections.total],
    ["Enabled automations", data.automations.enabled, data.automations.total],
    ["Completed runs · 24h", data.runs24h.completed, data.runs24h.total],
    ["Failed runs · 24h", data.runs24h.failed, data.runs24h.total],
  ] as const;

  return (
    <section className="mt-6 rounded-[1.5rem] border border-[#17213a]/10 bg-white/75 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-sans font-semibold">Instagram Auto DMs</h3>
          <p className="mt-1 text-sm text-black/50">
            Official Meta connection readiness and durable workflow health.
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
            data.connections.actionRequired || data.runs24h.failed
              ? "bg-[#fff1e7] text-[#9a4818]"
              : "bg-[#e9f8ef] text-[#17683b]"
          }`}
        >
          {data.connections.actionRequired || data.runs24h.failed ? "Needs attention" : "Healthy"}
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(([label, value, total]) => (
          <div key={label} className="rounded-2xl bg-[#f5f7fb] p-3">
            <p className="text-xs text-black/45">{label}</p>
            <p className="mt-1 text-xl font-semibold">
              {value}
              <span className="ml-1 text-sm font-normal text-black/35">/ {total}</span>
            </p>
          </div>
        ))}
      </div>

      {(data.connections.reauthRequired > 0 || data.runs24h.awaiting > 0) && (
        <p className="mt-3 text-xs text-black/50">
          {data.connections.reauthRequired > 0
            ? `${data.connections.reauthRequired} connection${
                data.connections.reauthRequired === 1 ? "" : "s"
              } require Meta reauthorization. `
            : ""}
          {data.runs24h.awaiting > 0
            ? `${data.runs24h.awaiting} workflow${
                data.runs24h.awaiting === 1 ? " is" : "s are"
              } awaiting a creator action or delivery.`
            : ""}
        </p>
      )}

      {data.recentFailures.length > 0 && (
        <details className="mt-4 rounded-2xl border border-[#17213a]/8 bg-white p-3">
          <summary className="cursor-pointer text-sm font-semibold">
            Recent safe failure details ({data.recentFailures.length})
          </summary>
          <div className="mt-3 space-y-2">
            {data.recentFailures.map((failure) => (
              <div
                key={failure.id}
                className="flex flex-col gap-1 rounded-xl bg-[#fff7f2] p-3 text-xs sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="min-w-0 break-words text-black/65">
                  {failure.errorCode ? `${failure.errorCode}: ` : ""}
                  {failure.errorMessage || "Provider delivery failed"}
                </span>
                <span className="shrink-0 text-black/40">
                  {failure.attempts} attempt{failure.attempts === 1 ? "" : "s"} ·{" "}
                  {new Date(failure.updatedAt).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function AnalyticsToolbar({
  days,
  offset,
  granularity,
  refreshing,
  showPeriod,
  onDays,
  onPrevious,
  onNext,
  onGranularity,
  onRefresh,
}: {
  days: Period;
  offset: number;
  granularity: Granularity;
  refreshing: boolean;
  showPeriod: boolean;
  onDays: (days: Period) => void;
  onPrevious: () => void;
  onNext: () => void;
  onGranularity: (value: Granularity) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="mb-4 grid grid-cols-[auto_1fr_auto] items-center gap-2 sm:flex sm:flex-wrap">
      <Link
        to="/link"
        className="inline-flex h-11 items-center gap-2 rounded-2xl bg-[#17213a] px-2.5 font-semibold text-white shadow-[0_10px_30px_rgba(23,33,58,0.22)] transition hover:-translate-y-0.5 sm:gap-2.5 sm:px-4"
      >
        <BentoBrand iconClassName="size-7" textClassName="hidden text-white sm:inline" />
        <span className="hidden rounded-lg bg-white/10 px-2 py-1 text-[10px] font-medium text-white/70 sm:inline">
          founder
        </span>
      </Link>
      {showPeriod ? (
        <div className="flex h-11 min-w-0 items-center overflow-hidden rounded-2xl border border-white/80 bg-white/88 shadow-sm ring-1 ring-[#17213a]/8 backdrop-blur-xl">
          <button
            type="button"
            onClick={onPrevious}
            className="grid h-full w-10 place-items-center border-r border-[#17213a]/8 transition hover:bg-[#edf3ff]"
            aria-label="Previous period"
          >
            <ChevronLeft className="size-4" />
          </button>
          <label className="relative flex h-full min-w-0 flex-1 items-center justify-center px-2 text-xs font-semibold sm:min-w-44 sm:px-4 sm:text-sm">
            <span className="truncate">{periodLabel(days, offset)}</span>
            <select
              value={days}
              onChange={(event) => onDays(Number(event.target.value) as Period)}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="Date range"
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </label>
          <button
            type="button"
            onClick={onNext}
            disabled={offset === 0}
            className="grid h-full w-10 place-items-center border-l border-[#17213a]/8 transition hover:bg-[#edf3ff] disabled:cursor-not-allowed disabled:opacity-25"
            aria-label="Next period"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      ) : null}
      {showPeriod ? (
        <label className="relative hidden h-11 min-w-28 items-center justify-center rounded-2xl border border-white/80 bg-white/88 px-4 text-sm font-semibold shadow-sm ring-1 ring-[#17213a]/8 backdrop-blur-xl sm:flex">
          {granularity}
          <select
            value={granularity}
            onChange={(event) => onGranularity(event.target.value as Granularity)}
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-label="Chart granularity"
          >
            <option>Daily</option>
            <option>Weekly</option>
            <option>Monthly</option>
          </select>
        </label>
      ) : null}
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className="col-start-3 grid size-11 place-items-center rounded-2xl border border-white/80 bg-white/88 shadow-sm ring-1 ring-[#17213a]/8 backdrop-blur-xl transition hover:-translate-y-0.5 hover:bg-white disabled:cursor-wait disabled:opacity-60 disabled:hover:translate-y-0"
        aria-label="Refresh analytics data"
      >
        <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
      </button>
      <span className="ml-auto hidden items-center gap-2 rounded-full border border-white/80 bg-white/70 px-3 py-2 text-xs font-medium text-black/45 shadow-sm backdrop-blur-xl md:flex">
        <ShieldCheck className="size-4 text-[#3478f6]" /> Founder cockpit · live data
      </span>
    </div>
  );
}

function KpiStrip({
  visitors,
  revenue,
  currency,
  conversions,
  previousVisitors,
  previousConversions,
  bounceRate,
  sessionSeconds,
  online,
}: {
  visitors: number;
  revenue: number;
  currency: string;
  conversions: number;
  previousVisitors: number;
  previousConversions: number;
  bounceRate: number;
  sessionSeconds: number;
  online: number;
}) {
  const items = [
    {
      icon: Eye,
      label: "Visitors",
      value: visitors.toLocaleString(),
      note: trend(visitors, previousVisitors),
    },
    { icon: DollarSign, label: "Revenue", value: money(revenue, currency), note: "verified" },
    {
      icon: Goal,
      label: "Conversion rate",
      value: percent(conversions, visitors),
      note: trend(conversions, previousConversions),
    },
    {
      icon: Gauge,
      label: "Revenue/visitor",
      value: visitors ? money(Math.round(revenue / visitors), currency) : "-",
      note: "per visitor",
    },
    {
      icon: MousePointerClick,
      label: "Bounce rate",
      value: `${bounceRate}%`,
      note: "of sessions",
    },
    { icon: Clock3, label: "Session time", value: duration(sessionSeconds), note: "average" },
    { icon: Wifi, label: "Online", value: online.toLocaleString(), note: "last 5 min" },
  ];
  return (
    <div className="grid grid-cols-2 border-b border-[#17213a]/8 md:grid-cols-4 xl:grid-cols-7">
      {items.map((item, index) => (
        <div
          key={item.label}
          className={`group min-h-28 border-[#17213a]/8 px-4 py-4 transition hover:bg-[#f7faff] sm:px-5 ${index % 2 === 1 ? "border-l" : ""} ${index >= 2 ? "border-t" : ""} ${index % 4 === 0 ? "md:border-l-0" : "md:border-l"} ${index >= 4 ? "md:border-t" : "md:border-t-0"} ${index === 0 ? "xl:border-l-0" : "xl:border-l"} xl:border-t-0`}
        >
          <div className="flex items-center gap-1.5 text-xs font-medium text-black/45">
            <item.icon className="size-3.5" aria-hidden="true" />
            <span>{item.label}</span>
          </div>
          <div className="mt-2 text-[1.65rem] font-semibold leading-none tracking-[-0.045em] tabular-nums">
            {item.value}
          </div>
          <div className={`mt-2 text-[11px] ${trendTone(item.note)}`}>{item.note}</div>
        </div>
      ))}
    </div>
  );
}

function MainChart({
  rows,
  currency,
}: {
  rows: Array<{ date: string; visitors: number; conversions: number; revenue: number }>;
  currency: string;
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const width = 1040;
  const height = 360;
  const left = 54;
  const right = 1015;
  const floor = 304;
  const top = 42;
  const maxVisitors = Math.max(1, ...rows.map((row) => row.visitors));
  const maxRevenue = Math.max(1, ...rows.map((row) => Math.max(0, row.revenue)));
  const x = (index: number) => left + (index / Math.max(rows.length - 1, 1)) * (right - left);
  const y = (value: number) => floor - (value / maxVisitors) * (floor - top);
  const points = rows.map((row, index) => `${x(index)},${y(row.visitors)}`).join(" ");
  const labelEvery = Math.max(1, Math.ceil(rows.length / 5));
  const hovered = hoveredIndex === null ? null : rows[hoveredIndex];
  return (
    <div className="relative p-3 sm:p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2 px-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-black/45">
          <BarChart3 className="size-3.5" /> Traffic & revenue over time
        </span>
        <div className="flex gap-4 text-[11px] font-medium text-black/45">
          <span className="flex items-center gap-1.5">
            <i className="size-2.5 rounded-full bg-[#3478f6]" /> Visitors
          </span>
          <span className="flex items-center gap-1.5">
            <i className="size-2.5 rounded-sm bg-[#ff8b6b]" /> Revenue
          </span>
        </div>
      </div>
      {hovered && hoveredIndex !== null && (
        <div
          className="pointer-events-none absolute top-12 z-10 min-w-40 -translate-x-1/2 rounded-2xl border border-white bg-[#17213a] px-4 py-3 text-xs text-white shadow-2xl"
          style={{ left: `${Math.min(88, Math.max(12, (x(hoveredIndex) / width) * 100))}%` }}
        >
          <div className="font-semibold">{dateOnly(hovered.date)}</div>
          <div className="mt-2 flex justify-between gap-6 text-white/70">
            <span>Visitors</span>
            <strong className="text-white">{hovered.visitors.toLocaleString()}</strong>
          </div>
          <div className="mt-1 flex justify-between gap-6 text-white/70">
            <span>Revenue</span>
            <strong className="text-white">{money(hovered.revenue, currency)}</strong>
          </div>
          <div className="mt-1 flex justify-between gap-6 text-white/70">
            <span>Conversions</span>
            <strong className="text-white">{hovered.conversions.toLocaleString()}</strong>
          </div>
        </div>
      )}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-[290px] w-full sm:h-[350px]"
        role="img"
        aria-label="Visitors and revenue over time"
        onMouseLeave={() => setHoveredIndex(null)}
      >
        <defs>
          <linearGradient id="visitor-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#3478f6" stopOpacity="0.26" />
            <stop offset="100%" stopColor="#3478f6" stopOpacity="0.025" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3].map((line) => {
          const lineY = floor - line * ((floor - top) / 3);
          return (
            <line
              key={line}
              x1={left}
              x2={right}
              y1={lineY}
              y2={lineY}
              stroke="#17213a"
              strokeOpacity="0.09"
              strokeDasharray="4 7"
            />
          );
        })}
        <text x="8" y={top + 5} fontSize="12" fill="#17213a" opacity="0.4">
          {compactNumber(maxVisitors)}
        </text>
        <text x="28" y={floor + 4} fontSize="12" fill="#17213a" opacity="0.4">
          0
        </text>
        {rows.map((row, index) => {
          const barHeight = (Math.max(0, row.revenue) / maxRevenue) * 165;
          const barWidth = Math.max(8, Math.min(42, 500 / Math.max(rows.length, 1)));
          return (
            <rect
              key={`${row.date}-revenue`}
              x={x(index) - barWidth / 2}
              y={floor - barHeight}
              width={barWidth}
              height={barHeight}
              rx="6"
              fill="#ff8b6b"
              opacity={hoveredIndex === null || hoveredIndex === index ? "0.86" : "0.34"}
            >
              <title>{`${row.date}: ${money(row.revenue, currency)} revenue`}</title>
            </rect>
          );
        })}
        <polygon
          points={`${left},${floor} ${points} ${right},${floor}`}
          fill="url(#visitor-area)"
        />
        <polyline
          points={points}
          fill="none"
          stroke="#3478f6"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {rows.map((row, index) => (
          <g key={`${row.date}-visitor`}>
            {row.conversions > 0 && (
              <circle
                cx={x(index)}
                cy={Math.max(top + 12, y(row.visitors) - 10)}
                r="4"
                fill="#ff7a59"
              />
            )}
            <circle
              cx={x(index)}
              cy={y(row.visitors)}
              r={hoveredIndex === index ? "6" : "4"}
              fill="white"
              stroke="#3478f6"
              strokeWidth="3"
            >
              <title>{`${row.date}: ${row.visitors} visitors`}</title>
            </circle>
          </g>
        ))}
        {rows.map((row, index) =>
          index % labelEvery === 0 || index === rows.length - 1 ? (
            <text
              key={`${row.date}-label`}
              x={x(index)}
              y="342"
              textAnchor={index === rows.length - 1 ? "end" : index === 0 ? "start" : "middle"}
              fontSize="13"
              fill="#17213a"
              opacity="0.48"
            >
              {axisDate(row.date)}
            </text>
          ) : null,
        )}
        {rows.map((row, index) => {
          const hitWidth = Math.max(18, (right - left) / Math.max(rows.length, 1));
          return (
            <rect
              key={`${row.date}-hit`}
              x={x(index) - hitWidth / 2}
              y={top}
              width={hitWidth}
              height={floor - top}
              fill="transparent"
              onMouseEnter={() => setHoveredIndex(index)}
            />
          );
        })}
      </svg>
    </div>
  );
}

function DimensionCard({
  tabs,
  active,
  onTab,
  rows,
  metric,
  onMetric,
  currency,
  map = false,
  filterLabel,
}: {
  tabs: string[];
  active: string;
  onTab: (tab: string) => void;
  rows: AnalyticsBreakdown[];
  metric: MetricMode;
  onMetric: (metric: MetricMode) => void;
  currency: string;
  map?: boolean;
  filterLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const visibleRows = expanded ? rows : rows.slice(0, 10);
  return (
    <section className="flex h-full min-h-[490px] flex-col overflow-hidden rounded-[1.6rem] border border-white/80 bg-white/88 shadow-[0_18px_60px_rgba(44,77,143,0.10)] ring-1 ring-[#17213a]/8 backdrop-blur-2xl">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#17213a]/8 p-3.5 sm:px-4">
        <Tabs tabs={tabs} active={active} onTab={onTab} />
        <div className="flex items-center gap-2">
          {filterLabel && (
            <button
              type="button"
              className="rounded-xl border border-[#17213a]/10 bg-white px-2.5 py-1.5 text-[11px] font-semibold shadow-sm"
            >
              {filterLabel}
            </button>
          )}
          <MetricSwitch value={metric} onChange={onMetric} />
        </div>
      </div>
      {map ? (
        <GeoMap rows={rows} />
      ) : (
        <BreakdownBars rows={visibleRows} metric={metric} currency={currency} />
      )}
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="mt-auto border-t border-[#17213a]/8 py-3.5 text-center text-[10px] font-semibold uppercase tracking-[0.16em] text-black/35 transition hover:bg-[#f7faff] hover:text-[#3478f6]"
      >
        {expanded
          ? "Close details ↑"
          : `Details ${rows.length > 10 ? `· ${rows.length} rows` : "↗"}`}
      </button>
    </section>
  );
}

function Tabs({
  tabs,
  active,
  onTab,
}: {
  tabs: string[];
  active: string;
  onTab: (tab: string) => void;
}) {
  return (
    <>
      <MobileTabSelect
        value={active}
        options={tabs.map((tab) => ({ value: tab, label: tab }))}
        onChange={onTab}
        ariaLabel="Admin section"
      />
      <div className="hidden max-w-full gap-0.5 overflow-x-auto rounded-xl bg-[#eef1f8] p-1 sm:flex">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => onTab(tab)}
            className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition sm:px-3 ${active === tab ? "bg-white text-[#17213a] shadow-sm" : "text-black/40 hover:bg-white/60 hover:text-[#17213a]"}`}
          >
            {tab}
          </button>
        ))}
      </div>
    </>
  );
}

function MetricSwitch({
  value,
  onChange,
}: {
  value: MetricMode;
  onChange: (value: MetricMode) => void;
}) {
  return (
    <div className="flex rounded-xl border border-[#17213a]/10 bg-white p-1 text-[10px] font-semibold shadow-sm">
      {(["visitors", "revenue"] as const).map((metric) => (
        <button
          key={metric}
          type="button"
          onClick={() => onChange(metric)}
          className={`rounded-lg px-2.5 py-1.5 capitalize transition ${value === metric ? "bg-[#17213a] text-white shadow-sm" : "text-black/40 hover:text-[#17213a]"}`}
        >
          {metric === "visitors" ? "Visitors" : "Revenue"}
        </button>
      ))}
    </div>
  );
}

function BreakdownBars({
  rows,
  metric,
  currency,
}: {
  rows: AnalyticsBreakdown[];
  metric: MetricMode;
  currency: string;
}) {
  const max = Math.max(
    1,
    ...rows.map((row) => (metric === "visitors" ? row.visitors : Math.abs(row.revenue))),
  );
  if (!rows.length)
    return <EmptyState label="Nothing recorded for this view in the selected period." />;
  return (
    <div className="space-y-1 p-3.5 sm:p-4">
      {rows.map((row, index) => {
        const value = metric === "visitors" ? row.visitors : Math.abs(row.revenue);
        return (
          <div
            key={`${row.label}-${index}`}
            className="group relative flex min-h-10 items-center overflow-hidden rounded-lg bg-[#f4f6fb] px-3"
          >
            <div
              className="absolute inset-y-0 left-0 bg-[#3478f6]/20 transition-all duration-500"
              style={{ width: `${(value / max) * 100}%` }}
            />
            {row.conversions > 0 && (
              <div
                className="absolute inset-y-0 left-0 bg-[#ff7a59]/32"
                style={{
                  width: `${(row.conversions / Math.max(1, row.visitors)) * (value / max) * 100}%`,
                }}
              />
            )}
            <div className="relative flex w-full items-center justify-between gap-3 text-xs">
              <span className="flex min-w-0 items-center gap-2 truncate font-semibold">
                <span className="truncate">{row.label}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2 font-semibold tabular-nums">
                {row.conversions > 0 && (
                  <span className="hidden text-[10px] font-medium text-[#c3573c] sm:inline">
                    {row.conversions} converted
                  </span>
                )}
                {metric === "visitors" ? compactNumber(row.visitors) : money(row.revenue, currency)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GeoMap({ rows }: { rows: AnalyticsBreakdown[] }) {
  const top = rows.slice(0, 6);
  return (
    <div className="relative min-h-[432px] flex-1 overflow-hidden bg-[linear-gradient(155deg,#dceaff_0%,#edf5ff_55%,#fff4d7_100%)] p-5">
      <Globe2 className="absolute -right-10 -top-12 size-64 text-[#3478f6]/8" />
      <div className="absolute left-1/2 top-[45%] h-56 w-[88%] max-w-[440px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[50%] border border-[#3478f6]/20 bg-[radial-gradient(circle_at_28%_35%,rgba(52,120,246,0.26),transparent_13%),radial-gradient(circle_at_58%_28%,rgba(52,120,246,0.22),transparent_16%),radial-gradient(circle_at_76%_61%,rgba(52,120,246,0.24),transparent_12%),radial-gradient(circle_at_42%_72%,rgba(52,120,246,0.20),transparent_14%),linear-gradient(rgba(255,255,255,0.68),rgba(255,255,255,0.38))] shadow-inner">
        <div className="absolute inset-0 bg-[repeating-linear-gradient(0deg,transparent,transparent_43px,rgba(52,120,246,0.10)_44px),repeating-linear-gradient(90deg,transparent,transparent_54px,rgba(52,120,246,0.10)_55px)]" />
        {top.map((row, index) => {
          const position = geoPosition(index);
          return (
            <div
              key={row.label}
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[#3478f6] px-2 py-1 text-[11px] font-semibold text-white shadow-[0_6px_16px_rgba(52,120,246,0.35)]"
              style={position}
              title={`${row.label}: ${row.visitors} visitors`}
            >
              {compactNumber(row.visitors)}
            </div>
          );
        })}
      </div>
      <div className="absolute inset-x-4 bottom-4 grid grid-cols-2 gap-2">
        {top.slice(0, 4).map((row) => (
          <div
            key={row.label}
            className="flex items-center gap-2 rounded-xl border border-white bg-white/75 px-3 py-2 text-[11px] shadow-sm backdrop-blur-xl"
          >
            <strong className="min-w-0 flex-1 truncate">{row.label}</strong>
            <span className="font-semibold tabular-nums">{compactNumber(row.visitors)}</span>
          </div>
        ))}
      </div>
      {!top.length && <EmptyState label="No countries recorded in this period." />}
    </div>
  );
}

function CreatorPulse({
  totals,
  activity,
  periodLabel: selectedPeriod,
}: {
  totals: {
    users: number;
    onboarded: number;
    pro: number;
    free: number;
    store: number;
    creator: number;
    newUsers7d: number;
    newUsersPeriod: number;
  };
  activity: {
    creatorActive7d: number;
    creatorActive30d: number;
    pagesWithVisitors7d: number;
    pagesWithVisitors30d: number;
  };
  periodLabel: string;
}) {
  const items = [
    { icon: UsersRound, label: "Creators", value: totals.users, note: "all time" },
    {
      icon: UserRound,
      label: "New creators",
      value: totals.newUsersPeriod,
      note: selectedPeriod.toLowerCase(),
    },
    {
      icon: CheckCircle2,
      label: "Activated",
      value: totals.onboarded,
      note: `${rate(totals.onboarded, totals.users)} of creators`,
    },
    {
      icon: DollarSign,
      label: "Store plan",
      value: totals.store,
      note: `${rate(totals.store, totals.users)} of creators`,
    },
    {
      icon: Trophy,
      label: "Creator plan",
      value: totals.creator,
      note: `${rate(totals.creator, totals.users)} of creators`,
    },
    {
      icon: UsersRound,
      label: "Free plan",
      value: totals.free,
      note: `${rate(totals.free, totals.users)} of creators`,
    },
    {
      icon: Activity,
      label: "Active creators",
      value: activity.creatorActive7d,
      note: `7d · ${activity.creatorActive30d} in 30d`,
    },
    {
      icon: Globe2,
      label: "Pages with visitors",
      value: activity.pagesWithVisitors30d,
      note: `30d · ${activity.pagesWithVisitors7d} in 7d`,
    },
  ];
  return (
    <section className="mt-4 overflow-hidden rounded-[1.6rem] border border-white/80 bg-white/88 shadow-[0_18px_60px_rgba(44,77,143,0.10)] ring-1 ring-[#17213a]/8 backdrop-blur-2xl">
      <div className="flex items-center justify-between border-b border-[#17213a]/8 px-4 py-3.5">
        <div>
          <h2 className="flex items-center gap-2 font-sans text-sm font-semibold">
            <Activity className="size-4" /> Creator pulse
          </h2>
          <p className="mt-0.5 text-[11px] text-black/40">
            Activation, retention and reach at a glance.
          </p>
        </div>
        <span className="hidden rounded-full bg-[#e9f1ff] px-3 py-1.5 text-[10px] font-semibold text-[#3478f6] sm:block">
          Supabase truth
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        {items.map((item, index) => (
          <div
            key={item.label}
            className={`min-h-28 px-4 py-4 ${index ? "border-l border-[#17213a]/8" : ""}`}
          >
            <div className="text-xs font-medium text-black/45">
              <span className="flex items-center gap-1.5">
                <item.icon className="size-3.5" /> {item.label}
              </span>
            </div>
            <div className="mt-2 text-3xl font-semibold tracking-[-0.04em] tabular-nums">
              {item.value.toLocaleString()}
            </div>
            <div className="mt-1 text-[10px] text-black/35">{item.note}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CreatorRevenueLeaderboard({
  data,
  periodLabel: selectedPeriod,
}: {
  data: FounderCreatorRevenue;
  periodLabel: string;
}) {
  return (
    <section className="mt-4 overflow-hidden rounded-[1.6rem] border border-white/80 bg-white/88 shadow-[0_18px_60px_rgba(44,77,143,0.10)] ring-1 ring-[#17213a]/8 backdrop-blur-2xl">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#17213a]/8 px-4 py-4 sm:px-5">
        <div>
          <h2 className="flex items-center gap-2 font-sans text-sm font-semibold">
            <Trophy className="size-4" /> Creator revenue leaderboard
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-black/45">
            Completed storefront sales less refunds · {selectedPeriod}. Each currency is ranked
            separately.
          </p>
        </div>
        <span className="rounded-full bg-[#e8f8ef] px-3 py-1.5 text-xs font-semibold text-[#247a49]">
          {compactNumber(data.creatorCount)} earning creators
        </span>
      </div>

      {data.totals.length ? (
        <div className="space-y-5 p-3 sm:p-5">
          {data.totals.map((total) => {
            const creators = data.leaderboard.filter(
              (creator) => creator.currency === total.currency,
            );
            return (
              <article
                key={total.currency}
                className="overflow-hidden rounded-[1.35rem] border border-[#17213a]/8 bg-[#f7f9fd]"
              >
                <div className="grid grid-cols-2 gap-3 border-b border-[#17213a]/8 p-4 sm:grid-cols-5">
                  <div className="col-span-2 sm:col-span-1">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-black/35">
                      {total.currency}
                    </span>
                    <strong className="mt-1 block text-xl">
                      {money(total.revenue, total.currency)}
                    </strong>
                    <span className="text-xs text-black/40">Creator revenue</span>
                  </div>
                  <SmallValue label="Net earnings" value={money(total.net, total.currency)} />
                  <SmallValue label="Refunds" value={money(total.refunds, total.currency)} />
                  <SmallValue label="Orders" value={compactNumber(total.orders)} />
                  <SmallValue label="Creators" value={compactNumber(total.creators)} />
                </div>

                <div className="divide-y divide-[#17213a]/7">
                  {creators.map((creator) => (
                    <div
                      key={`${creator.currency}:${creator.creatorId}`}
                      className="grid grid-cols-[2.25rem_minmax(0,1fr)] items-center gap-3 p-3 sm:grid-cols-[2.25rem_minmax(0,1.6fr)_repeat(4,minmax(5.5rem,1fr))] sm:px-4"
                    >
                      <span className="grid size-9 place-items-center rounded-full bg-[#17213a] text-xs font-bold text-white">
                        #{creator.rank}
                      </span>
                      <div className="flex min-w-0 items-center gap-3">
                        {creator.avatarUrl ? (
                          <img
                            src={creator.avatarUrl}
                            alt=""
                            loading="lazy"
                            className="size-10 shrink-0 rounded-xl object-cover"
                          />
                        ) : (
                          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#dfe9ff] font-semibold text-[#2659b8]">
                            {(creator.displayName ?? creator.username).slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <div className="min-w-0">
                          <strong className="block truncate text-sm">
                            {creator.displayName || creator.username}
                          </strong>
                          <span className="block truncate text-xs text-black/40">
                            @{creator.username}
                          </span>
                        </div>
                      </div>
                      <div className="col-span-2 grid grid-cols-2 gap-3 rounded-xl bg-white/70 p-3 sm:contents">
                        <SmallValue
                          label="Revenue"
                          value={money(creator.revenue, creator.currency)}
                        />
                        <SmallValue label="Net" value={money(creator.net, creator.currency)} />
                        <SmallValue label="Orders" value={compactNumber(creator.orders)} />
                        <SmallValue label="Customers" value={compactNumber(creator.customers)} />
                      </div>
                    </div>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState label={`No creator sales in ${selectedPeriod.toLowerCase()}.`} />
      )}
    </section>
  );
}

function JourneyCard({
  active,
  onTab,
  search,
  onSearch,
  journeys,
  users,
  funnel,
  conversions,
  currency,
}: {
  active: JourneyTab;
  onTab: (tab: string) => void;
  search: string;
  onSearch: (value: string) => void;
  journeys: Array<{
    id: string;
    username: string;
    email: string | null;
    source: string;
    country: string;
    device: string;
    operatingSystem: string;
    browser: string;
    spent: number;
    currency: string;
    timeToCompleteSeconds: number;
    completedAt: string | null;
  }>;
  users: Array<{
    id: string;
    email: string | null;
    username: string;
    isPro: boolean;
    onboarded: boolean;
    createdAt: string;
    lastSignInAt: string | null;
    subscriptionStatus: string | null;
    planId: "free" | "store" | "creator";
  }>;
  funnel: Array<{ label: string; value: number }>;
  conversions: number;
  currency: string;
}) {
  return (
    <section className="mt-4 overflow-hidden rounded-[1.6rem] border border-white/80 bg-white/88 shadow-[0_18px_60px_rgba(44,77,143,0.10)] ring-1 ring-[#17213a]/8 backdrop-blur-2xl">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#17213a]/8 p-3.5 sm:px-4">
        <Tabs tabs={["Goal", "Funnel", "User", "Journey"]} active={active} onTab={onTab} />
        <div className="flex flex-wrap gap-2">
          <div className="rounded-xl bg-[#fff3c5] px-3 py-2 text-xs font-semibold shadow-sm">
            Goal: Activated creator <span className="ml-2">{conversions}</span>
          </div>
          <label className="flex items-center gap-2 rounded-xl border border-[#17213a]/10 bg-white px-3 py-2 shadow-sm focus-within:ring-2 focus-within:ring-[#3478f6]/20">
            <Search className="size-4 text-black/35" />
            <input
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Search"
              className="w-32 bg-transparent text-xs outline-none"
            />
          </label>
        </div>
      </div>
      {active === "Journey" && <JourneyTable rows={journeys} currency={currency} />}
      {active === "User" && <UserTable users={users} />}
      {active === "Funnel" && <Funnel rows={funnel} />}
      {active === "Goal" && <GoalRows rows={funnel} />}
    </section>
  );
}

function JourneyTable({
  rows,
  currency,
}: {
  rows: Array<{
    id: string;
    username: string;
    email: string | null;
    source: string;
    country: string;
    device: string;
    operatingSystem: string;
    browser: string;
    spent: number;
    timeToCompleteSeconds: number;
    completedAt: string | null;
  }>;
  currency: string;
}) {
  if (!rows.length) return <EmptyState label="No completed creator journeys in this period yet." />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-left text-sm">
        <thead className="bg-[#f4f6fb] text-[11px] text-black/45">
          <tr>
            <th className="px-6 py-4">Visitor</th>
            <th className="px-4 py-4">Source</th>
            <th className="px-4 py-4">Spent</th>
            <th className="px-4 py-4">Time to complete</th>
            <th className="px-6 py-4">Completed at</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#17213a]/8">
          {rows.map((row) => (
            <tr key={row.id} className="transition hover:bg-[#f8faff]">
              <td className="px-6 py-4">
                <div className="flex items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[#e9f1ff] text-lg shadow-inner">
                    {avatarInitial(row.username)}
                  </span>
                  <div>
                    <strong className="block">@{row.username}</strong>
                    <span className="text-xs text-black/40">
                      {countryFlag(row.country)} {row.country} · {row.device} ·{" "}
                      {row.operatingSystem}
                      {" · "}
                      {row.browser}
                    </span>
                  </div>
                </div>
              </td>
              <td className="px-4 py-4 font-medium">{row.source}</td>
              <td className="px-4 py-4 font-semibold">{money(row.spent, currency)}</td>
              <td className="px-4 py-4">{durationLong(row.timeToCompleteSeconds)}</td>
              <td className="px-6 py-4">
                <span className="block">{row.completedAt ? dateTime(row.completedAt) : "-"}</span>
                <span className="mt-1 block text-[9px] tracking-[0.28em] text-[#ff8b6b]">
                  ●○●○○
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserTable({
  users,
}: {
  users: Array<{
    id: string;
    email: string | null;
    username: string;
    isPro: boolean;
    onboarded: boolean;
    createdAt: string;
    lastSignInAt: string | null;
    subscriptionStatus: string | null;
    planId: "free" | "store" | "creator";
  }>;
}) {
  if (!users.length) return <EmptyState label="No creators match this search." />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="bg-[#f4f6fb] text-[11px] text-black/45">
          <tr>
            <th className="px-6 py-4">Creator</th>
            <th className="px-4 py-4">Plan</th>
            <th className="px-4 py-4">Activated</th>
            <th className="px-4 py-4">Joined</th>
            <th className="px-6 py-4">Last sign-in</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#17213a]/8">
          {users.map((user) => (
            <tr key={user.id} className="transition hover:bg-[#f8faff]">
              <td className="px-6 py-4">
                <div className="flex items-center gap-3">
                  <span className="grid size-8 place-items-center rounded-full bg-[#e9f1ff]">
                    {avatarInitial(user.username)}
                  </span>
                  <div>
                    <strong className="block">@{user.username}</strong>
                    <span className="text-xs text-black/40">{user.email ?? "No email"}</span>
                  </div>
                </div>
              </td>
              <td className="px-4 py-4">
                <span className="capitalize">{user.planId}</span>
                {user.subscriptionStatus ? ` · ${user.subscriptionStatus}` : ""}
              </td>
              <td className="px-4 py-4">{user.onboarded ? "Yes" : "Not yet"}</td>
              <td className="px-4 py-4">{dateOnly(user.createdAt)}</td>
              <td className="px-6 py-4">{user.lastSignInAt ? dateOnly(user.lastSignInAt) : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Funnel({ rows }: { rows: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, rows[0]?.value ?? 0);
  return (
    <div className="space-y-4 p-5 sm:p-6">
      {rows.map((row, index) => (
        <div key={row.label}>
          <div className="mb-2 flex justify-between">
            <strong>{row.label}</strong>
            <span className="text-sm text-black/45">
              {row.value.toLocaleString()} · {Math.round((row.value / max) * 100)}%
            </span>
          </div>
          <div className="h-10 overflow-hidden rounded-xl bg-[#eef1f8]">
            <div
              className={`h-full rounded-xl ${["bg-[#3478f6]", "bg-[#6f9df8]", "bg-[#ffc928]", "bg-[#ff7a59]"][index] ?? "bg-[#3478f6]"}`}
              style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function GoalRows({ rows }: { rows: Array<{ label: string; value: number }> }) {
  return (
    <div className="grid gap-3 p-5 sm:grid-cols-3">
      {rows.slice(1).map((row, index) => (
        <div
          key={row.label}
          className={`rounded-2xl p-5 ${index % 2 ? "bg-[#fff0ea]" : "bg-[#e9f1ff]"}`}
        >
          <div className="text-sm text-black/45">Goal</div>
          <strong className="mt-2 block text-xl">{row.label}</strong>
          <span className="mt-4 block text-4xl font-semibold">{row.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

function CrawlerCard({
  active,
  onTab,
  rows,
}: {
  active: CrawlerTab;
  onTab: (tab: CrawlerTab) => void;
  rows: CrawlerBreakdown[];
}) {
  return (
    <section className="mt-4 overflow-hidden rounded-[1.6rem] border border-white/80 bg-white/88 shadow-[0_18px_60px_rgba(44,77,143,0.10)] ring-1 ring-[#17213a]/8 backdrop-blur-2xl">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#17213a]/8 p-3.5 sm:px-4">
        <Tabs
          tabs={["AI answers", "Indexing", "Training"]}
          active={active}
          onTab={(tab) => onTab(tab as CrawlerTab)}
        />
        <div className="flex items-center gap-2 rounded-full bg-[#e9f1ff] px-3 py-1.5 text-xs font-semibold text-[#3478f6]">
          <Bot className="size-4" /> Crawlers
        </div>
      </div>
      {rows.length ? (
        <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center gap-3 rounded-2xl bg-[#f4f6fb] p-4">
              <div className="grid size-10 place-items-center rounded-xl bg-[#17213a] text-lg text-white">
                <Bot className="size-4" />
              </div>
              <strong className="truncate text-sm">{row.label}</strong>
              <div className="ml-auto text-right">
                <div className="text-lg font-semibold">{row.visits}</div>
                <div className="text-xs text-black/40">{row.share}%</div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          label={`No ${active.toLowerCase()} crawler visits recorded yet. Tracking is active from this release forward.`}
        />
      )}
    </section>
  );
}

function ComplimentaryAccessManager() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [planId, setPlanId] = useState<"store" | "creator">("store");
  const [duration, setDuration] = useState("365");
  const [customDurationDays, setCustomDurationDays] = useState("30");
  const grants = useQuery({
    queryKey: ["admin-complimentary-plan-grants"],
    queryFn: () => getComplimentaryPlanGrants(),
    retry: (failureCount, error) => failureCount < 1 && !isAdminAccessError(error),
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin-complimentary-plan-grants"] }),
      queryClient.invalidateQueries({ queryKey: ["admin-overview"] }),
    ]);
  const grant = useMutation({
    mutationFn: (input: { email: string; planId: "store" | "creator"; durationDays: number }) =>
      grantComplimentaryPlan({ data: input }),
    onSuccess: async () => {
      setEmail("");
      await refresh();
      toast.success("Complimentary plan access updated");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not grant access"),
  });
  const revoke = useMutation({
    mutationFn: (grantId: string) => revokeComplimentaryPlan({ data: { grantId } }),
    onSuccess: async () => {
      await refresh();
      toast.success("Complimentary access revoked. The creator's billing plan was restored.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not revoke access"),
  });

  const rows = grants.data ?? [];
  const activeCount = rows.filter((row) => row.status === "active").length;
  const staging = import.meta.env.VITE_APP_ENV === "staging";

  return (
    <section className="mt-6 overflow-hidden rounded-[1.5rem] border border-[#17213a]/10 bg-[#f8faff]">
      <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.35fr)]">
        <div>
          <div className="flex items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-[#fff2bd] text-[#17213a]">
              <Gift className="size-5" />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-sans font-semibold">Give or upgrade a creator plan</h3>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                    staging ? "bg-[#fff2bd] text-[#725500]" : "bg-[#e8f8ef] text-[#247a49]"
                  }`}
                >
                  {staging ? "Staging" : "Production"}
                </span>
              </div>
              <p className="mt-1 text-sm leading-5 text-black/50">
                Works for Free and paid accounts without charging them. The highest active plan
                wins, and existing billing stays intact.
              </p>
              <p className="mt-2 flex items-start gap-1.5 text-xs font-medium leading-5 text-[#2659b8]">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
                This unlocks creator app features only. It never grants access to the founder
                dashboard.
              </p>
              {staging && (
                <p className="mt-2 text-xs font-medium text-[#725500]">
                  This grant applies only to accounts in this staging deployment.
                </p>
              )}
            </div>
          </div>

          <form
            className="mt-5 grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!email.trim()) return;
              const durationDays = Number(duration === "custom" ? customDurationDays : duration);
              if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650) {
                toast.error("Choose a duration between 1 day and 10 years");
                return;
              }
              grant.mutate({ email: email.trim(), planId, durationDays });
            }}
          >
            <label className="grid gap-1.5 text-xs font-semibold text-black/55">
              Creator email
              <span className="flex h-12 items-center gap-2 rounded-2xl border border-[#17213a]/10 bg-white px-3 shadow-sm focus-within:border-[#3478f6]/50 focus-within:ring-4 focus-within:ring-[#3478f6]/10">
                <Mail className="size-4 text-black/35" />
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="creator@example.com"
                  autoComplete="email"
                  required
                  className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-black/25"
                />
              </span>
            </label>
            <label className="grid gap-1.5 text-xs font-semibold text-black/55">
              Complimentary plan
              <select
                value={planId}
                onChange={(event) => setPlanId(event.target.value as "store" | "creator")}
                className="h-12 rounded-2xl border border-[#17213a]/10 bg-white px-3 text-sm font-semibold shadow-sm outline-none focus:border-[#3478f6]/50 focus:ring-4 focus:ring-[#3478f6]/10"
              >
                <option value="store">Store - $15 plan</option>
                <option value="creator">Creator - $30 plan</option>
              </select>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-xs font-semibold text-black/55">
                Access duration
                <select
                  value={duration}
                  onChange={(event) => setDuration(event.target.value)}
                  className="h-12 rounded-2xl border border-[#17213a]/10 bg-white px-3 text-sm font-semibold shadow-sm outline-none focus:border-[#3478f6]/50 focus:ring-4 focus:ring-[#3478f6]/10"
                >
                  <option value="7">7 days</option>
                  <option value="30">1 month</option>
                  <option value="90">3 months</option>
                  <option value="180">6 months</option>
                  <option value="365">1 year</option>
                  <option value="730">2 years</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              {duration === "custom" && (
                <label className="grid gap-1.5 text-xs font-semibold text-black/55">
                  Custom days
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={3650}
                    step={1}
                    value={customDurationDays}
                    onChange={(event) => setCustomDurationDays(event.target.value)}
                    className="h-12 rounded-2xl border border-[#17213a]/10 bg-white px-3 text-sm font-semibold shadow-sm outline-none focus:border-[#3478f6]/50 focus:ring-4 focus:ring-[#3478f6]/10"
                  />
                </label>
              )}
            </div>
            <p className="-mt-1 text-xs leading-5 text-black/40">
              Access expires automatically. Paid access, if any, is restored afterward.
            </p>
            <button
              type="submit"
              disabled={grant.isPending || !email.trim()}
              className="mt-1 inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-[#17213a] px-4 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(23,33,58,0.18)] transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0"
            >
              <UserRoundCheck className="size-4" />
              {grant.isPending
                ? "Granting…"
                : `Give complimentary ${planId === "store" ? "Store" : "Creator"} access`}
            </button>
          </form>
        </div>

        <div className="min-w-0 rounded-[1.25rem] border border-white bg-white/80 p-3 shadow-sm sm:p-4">
          <div className="flex items-center justify-between gap-3 px-1 pb-3">
            <div>
              <h3 className="font-sans font-semibold">Complimentary plan access</h3>
              <p className="text-xs text-black/45">
                {activeCount} active · {rows.length} total grants
              </p>
            </div>
            <button
              type="button"
              onClick={() => grants.refetch()}
              disabled={grants.isFetching}
              className="grid size-9 place-items-center rounded-xl border border-[#17213a]/8 bg-white transition hover:bg-[#edf3ff] disabled:opacity-50"
              aria-label="Refresh early testers"
            >
              <RefreshCw className={`size-4 ${grants.isFetching ? "animate-spin" : ""}`} />
            </button>
          </div>

          {grants.isLoading ? (
            <div className="grid min-h-36 place-items-center text-sm text-black/40">
              Loading early testers…
            </div>
          ) : grants.isError ? (
            <div className="rounded-2xl bg-[#fff0ea] p-4 text-sm text-[#9b3b24]" role="alert">
              <p>The early tester list could not be loaded.</p>
              <button
                type="button"
                onClick={() => grants.refetch()}
                disabled={grants.isFetching}
                className="mt-3 rounded-full bg-white px-3 py-1.5 text-xs font-semibold shadow-sm disabled:opacity-50"
              >
                {grants.isFetching ? "Retrying…" : "Retry"}
              </button>
            </div>
          ) : rows.length === 0 ? (
            <div className="grid min-h-36 place-items-center rounded-2xl border border-dashed border-[#17213a]/12 text-center text-sm text-black/40">
              No complimentary plans have been granted in this environment yet.
            </div>
          ) : (
            <div className="max-h-[29rem] space-y-2 overflow-y-auto pr-1">
              {rows.map((row) => (
                <ComplimentaryGrantCard
                  key={row.id}
                  grant={row}
                  revoking={revoke.isPending && revoke.variables === row.id}
                  onRevoke={() => revoke.mutate(row.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ComplimentaryGrantCard({
  grant,
  revoking,
  onRevoke,
}: {
  grant: ComplimentaryPlanGrant;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const active = grant.status === "active" && Date.parse(grant.expiresAt) > Date.now();
  const status = active ? "active" : grant.status === "revoked" ? "revoked" : "expired";
  const [confirming, setConfirming] = useState(false);
  return (
    <article className="rounded-2xl border border-[#17213a]/8 bg-white p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="max-w-52 truncate text-sm">
              {grant.displayName || `@${grant.username}`}
            </strong>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                grant.planId === "store"
                  ? "bg-[#fff2bd] text-[#725500]"
                  : "bg-[#e8f0ff] text-[#2659b8]"
              }`}
            >
              {grant.planId}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                active
                  ? "bg-[#e8f8ef] text-[#247a49]"
                  : status === "expired"
                    ? "bg-[#fff2bd] text-[#725500]"
                    : "bg-black/5 text-black/40"
              }`}
            >
              {status}
            </span>
          </div>
          <p className="mt-1 truncate text-xs text-black/50">{grant.email}</p>
          <p className="mt-2 text-[11px] leading-5 text-black/38">
            @{grant.username} · joined {dateOnly(grant.userCreatedAt)}
            <br />
            {grant.billingPlanId
              ? `Paid ${grant.billingPlanId} (${grant.billingStatus}) · `
              : "No active paid plan · "}
            effective {grant.effectivePlanId}
            <br />
            Granted {dateTime(grant.grantedAt)}
            {grant.grantedByEmail ? ` by ${grant.grantedByEmail}` : ""}
            <br />
            {status === "expired" ? "Expired" : "Expires"} {dateTime(grant.expiresAt)}
            <br />
            Last sign-in {grant.lastSignInAt ? dateTime(grant.lastSignInAt) : "not recorded"}
          </p>
        </div>
        {active && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {confirming && !revoking && (
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="h-9 rounded-xl border border-[#17213a]/10 bg-white px-3 text-xs font-semibold"
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (!confirming) {
                  setConfirming(true);
                  return;
                }
                onRevoke();
              }}
              disabled={revoking}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-[#ef4444]/15 bg-[#fff6f6] px-3 text-xs font-semibold text-[#b42318] transition hover:bg-[#ffe8e8] disabled:opacity-50"
            >
              <XCircle className="size-3.5" />
              {revoking ? "Revoking…" : confirming ? "Confirm revoke" : "Revoke"}
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

function AddonCapacity({ data }: { data: Awaited<ReturnType<typeof getAdminOverview>>["addons"] }) {
  return (
    <div className="mt-6">
      <h3 className="flex items-center gap-2 font-ui-display text-3xl">
        <Gauge className="size-5" /> Add-on capacity
      </h3>
      <p className="mt-1 text-sm text-black/40">
        Active contact tiers and storage from verified subscription state.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SmallValue label="Storage add-on units" value={compactNumber(data.storageUnits)} />
        <SmallValue
          label="Creators above contact capacity"
          value={compactNumber(data.creatorsAboveContactCapacity)}
        />
        {data.contactTiers.map((tier) => (
          <SmallValue
            key={tier.contacts}
            label={`${tier.contacts.toLocaleString()} contacts`}
            value={`${compactNumber(tier.creators)} creators`}
          />
        ))}
      </div>
    </div>
  );
}

function OperationsRevenue({
  rows,
}: {
  rows: Array<{ currency: string; gross: number; refunds: number; net: number; mrr: number }>;
}) {
  return (
    <div>
      <h3 className="flex items-center gap-2 font-ui-display text-3xl">
        <DollarSign className="size-5" /> Revenue ledger
      </h3>
      <p className="mt-1 text-sm text-black/40">Authoritative Dodo payments and refunds.</p>
      <div className="mt-4 space-y-3">
        {rows.length ? (
          rows.map((row) => (
            <div
              key={row.currency}
              className="grid grid-cols-2 gap-3 rounded-2xl bg-[#f4f6fb] p-4 sm:grid-cols-4"
            >
              <SmallValue label="Gross" value={money(row.gross, row.currency)} />
              <SmallValue label="Refunds" value={money(row.refunds, row.currency)} />
              <SmallValue label="Net" value={money(row.net, row.currency)} />
              <SmallValue label="MRR" value={money(row.mrr, row.currency)} />
            </div>
          ))
        ) : (
          <EmptyState label="No processed payments yet." />
        )}
      </div>
    </div>
  );
}

function SocialPreviewHealth({
  data,
}: {
  data: Awaited<ReturnType<typeof getAdminOverview>>["socialPreviews"];
}) {
  return (
    <div className="mt-6">
      <h3 className="flex items-center gap-2 font-ui-display text-3xl">
        <BarChart3 className="size-5" /> Social follower reliability
      </h3>
      <p className="mt-1 text-sm text-black/40">
        Source success rates for the selected period and current zero-spend budgets.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SmallValue label="Attempts" value={compactNumber(data.attempts)} />
        <SmallValue label="Stale profiles" value={compactNumber(data.cache.stale)} />
        <SmallValue label="Unavailable profiles" value={compactNumber(data.cache.unavailable)} />
        <SmallValue
          label="Bright remaining"
          value={`${compactNumber(data.bright.remaining)} / ${compactNumber(data.bright.limit)}`}
        />
      </div>
      <div className="mt-4 space-y-2">
        {data.sources.length ? (
          data.sources.slice(0, 20).map((source) => {
            const percent = Math.round(source.successRate * 100);
            return (
              <div
                key={`${source.platform}:${source.source}`}
                className="rounded-2xl bg-[#f4f6fb] p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <strong className="capitalize">
                    {source.platform} · {source.source.replaceAll("_", " ")}
                  </strong>
                  <span className="text-black/45">
                    {percent}% · {source.successes}/{source.attempts} · {source.averageDurationMs}ms
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/5">
                  <div
                    className="h-full rounded-full bg-[#16a269]"
                    style={{ width: `${percent}%` }}
                    aria-label={`${percent}% success`}
                  />
                </div>
              </div>
            );
          })
        ) : (
          <EmptyState label="No social-preview attempts recorded for this period." />
        )}
      </div>
      <p className="mt-3 text-xs text-black/40">
        Browser budget remaining: {Math.ceil(data.browser.remainingMs / 1_000)}s today.
      </p>
    </div>
  );
}

function BillingHealth({
  events,
}: {
  events: Array<{
    webhook_id: string;
    event_type: string;
    status: string;
    attempts: number;
    error_message: string | null;
    occurred_at: string | null;
    created_at: string;
  }>;
}) {
  return (
    <div>
      <h3 className="flex items-center gap-2 font-ui-display text-3xl">
        <HeartPulse className="size-5" /> Billing health
      </h3>
      <p className="mt-1 text-sm text-black/40">Latest verified webhook deliveries.</p>
      <div className="mt-4 max-h-72 space-y-2 overflow-auto">
        {events.length ? (
          events.map((event) => (
            <div key={event.webhook_id} className="rounded-2xl bg-[#f4f6fb] p-4 text-sm">
              <div className="flex justify-between gap-3">
                <strong>{event.event_type}</strong>
                <span
                  className={event.status === "processed" ? "text-[#16a269]" : "text-[#e45c49]"}
                >
                  {event.status}
                </span>
              </div>
              <div className="mt-1 text-xs text-black/40">
                Attempt {event.attempts} · {dateTime(event.occurred_at ?? event.created_at)}
              </div>
              {event.status !== "processed" && event.error_message && (
                <p className="mt-2 rounded-xl bg-[#fff0ea] px-3 py-2 text-xs text-[#9b3b24]">
                  {event.error_message}
                </p>
              )}
            </div>
          ))
        ) : (
          <EmptyState label="No billing webhooks recorded yet." />
        )}
      </div>
    </div>
  );
}

function SmallValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-xs text-black/40">{label}</span>
      <strong className="mt-1 block text-sm">{value}</strong>
    </div>
  );
}
function EmptyState({ label }: { label: string }) {
  return (
    <div className="grid min-h-44 place-items-center p-8 text-center text-sm text-black/40">
      <span>{label}</span>
    </div>
  );
}
function LoadingState() {
  return (
    <div className="grid min-h-screen place-items-center bg-[#eef4ff] text-[#17213a]">
      <div className="rounded-2xl border border-white bg-white/90 px-6 py-4 shadow-lg backdrop-blur-xl">
        <LoaderCircle className="size-5 animate-spin" /> Loading live founder analytics…
      </div>
    </div>
  );
}
function AccessError() {
  return (
    <div className="grid min-h-screen place-items-center bg-[#eef4ff] px-6 text-[#17213a]">
      <div className="max-w-md rounded-[2rem] border border-white bg-white/90 p-8 text-center shadow-xl backdrop-blur-xl">
        <ShieldCheck className="mx-auto size-10 text-black/30" />
        <h1 className="mt-4 font-ui-display text-4xl">Admin access required</h1>
        <p className="mt-2 text-sm text-black/45">
          Sign in with the instance administrator account to open this private dashboard.
        </p>
        <Link
          to="/link"
          className="mt-6 inline-flex items-center gap-2 rounded-full bg-[#17213a] px-5 py-2.5 text-sm font-semibold text-white"
        >
          <ArrowLeft className="size-4" /> Back to dashboard
        </Link>
      </div>
    </div>
  );
}

function AdminLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="grid min-h-screen place-items-center bg-[#eef4ff] px-6 text-[#17213a]">
      <div
        className="max-w-md rounded-[2rem] border border-white bg-white/90 p-8 text-center shadow-xl backdrop-blur-xl"
        role="alert"
      >
        <XCircle className="mx-auto size-10 text-[#e45c49]" />
        <h1 className="mt-4 font-ui-display text-4xl">Dashboard unavailable</h1>
        <p className="mt-2 text-sm text-black/45">
          The founder data could not be loaded. Your access has not changed; this is an operational
          error.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-2 rounded-full bg-[#17213a] px-5 py-2.5 text-sm font-semibold text-white"
          >
            <RefreshCw className="size-4" /> Retry
          </button>
          <Link
            to="/link"
            className="inline-flex items-center gap-2 rounded-full border border-[#17213a]/10 bg-white px-5 py-2.5 text-sm font-semibold"
          >
            <ArrowLeft className="size-4" /> Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}

function trendTone(note: string) {
  if (note.includes("↑") || note.startsWith("+")) return "text-[#16a269]";
  if (note.includes("↓") || note.startsWith("-")) return "text-[#e45c49]";
  return "text-black/35";
}

function rate(value: number, total: number) {
  return `${total ? Math.round((value / total) * 100) : 0}%`;
}

function countryFlag(value: string) {
  const label = value.toLowerCase();
  const flags: Record<string, string> = {
    india: "🇮🇳",
    "united states": "🇺🇸",
    "united arab emirates": "🇦🇪",
    sweden: "🇸🇪",
    ireland: "🇮🇪",
    france: "🇫🇷",
    "united kingdom": "🇬🇧",
    germany: "🇩🇪",
    canada: "🇨🇦",
    singapore: "🇸🇬",
    spain: "🇪🇸",
    brazil: "🇧🇷",
    turkey: "🇹🇷",
    "south korea": "🇰🇷",
  };
  return flags[label] ?? "";
}

function avatarInitial(seed: string) {
  return seed.trim().charAt(0).toUpperCase() || "B";
}

function geoPosition(index: number) {
  const positions = [
    { left: "66%", top: "49%" },
    { left: "25%", top: "38%" },
    { left: "57%", top: "43%" },
    { left: "49%", top: "27%" },
    { left: "43%", top: "37%" },
    { left: "79%", top: "64%" },
  ];
  return positions[index % positions.length];
}

function filterUsers<
  T extends {
    email: string | null;
    username: string;
    subscriptionStatus: string | null;
    planId: string;
  },
>(users: T[], search: string) {
  const query = search.trim().toLowerCase();
  if (!query) return users;
  return users.filter((user) =>
    [user.email, user.username, user.subscriptionStatus, user.planId]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query)),
  );
}
function groupSeries<
  T extends { date: string; visitors: number; conversions: number; revenue: number },
>(rows: T[], granularity: Granularity) {
  const size = granularity === "Daily" ? 1 : granularity === "Weekly" ? 7 : 30;
  if (size === 1) return rows;
  const result: T[] = [];
  for (let index = 0; index < rows.length; index += size) {
    const chunk = rows.slice(index, index + size);
    result.push({
      ...chunk[0],
      date: chunk[0].date,
      visitors: chunk.reduce((sum, row) => sum + row.visitors, 0),
      conversions: chunk.reduce((sum, row) => sum + row.conversions, 0),
      revenue: chunk.reduce((sum, row) => sum + row.revenue, 0),
    });
  }
  return result;
}
function periodLabel(days: number, offset: number) {
  if (!offset) return `Last ${days} days`;
  const end = new Date(Date.now() - offset * 86_400_000);
  const start = new Date(Date.now() - (offset + days - 1) * 86_400_000);
  return `${axisDate(start.toISOString().slice(0, 10))} – ${axisDate(end.toISOString().slice(0, 10))}`;
}
function trend(current: number, previous: number) {
  if (!previous) return current ? "new ↑" : "0%";
  const value = Math.round(((current - previous) / previous) * 100);
  return `${value >= 0 ? "+" : ""}${value}% ${value >= 0 ? "↑" : "↓"}`;
}
function percent(value: number, total: number) {
  return `${total ? ((value / total) * 100).toFixed(2) : "0.00"}%`;
}
function compactNumber(value: number) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}
function money(value: number, currency: string) {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value / 100);
}
function duration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}
function durationLong(seconds: number) {
  if (!seconds) return "under a minute";
  const days = Math.floor(seconds / 86_400);
  if (days) return `${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.floor(seconds / 3_600);
  if (hours) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
function axisDate(value: string) {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${value}T00:00:00Z`),
  );
}
function dateOnly(value: string) {
  return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", year: "numeric" }).format(
    new Date(value),
  );
}
function dateTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
