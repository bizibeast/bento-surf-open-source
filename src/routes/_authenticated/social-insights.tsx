import { MicroAppTabs } from "@/components/MicroAppTabs";
import { useEffect, useMemo, useState, type ComponentType } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Award,
  BarChart3,
  Eye,
  ExternalLink,
  Heart,
  Play,
  Repeat2,
  LoaderCircle,
  MessageCircle,
  Plus,
  Send,
  TrendingUp,
  Trophy,
  UserRoundSearch,
  UsersRound,
  RefreshCw,
} from "lucide-react";
import { FaLinkedinIn } from "react-icons/fa";
import {
  SiFacebook,
  SiInstagram,
  SiReddit,
  SiThreads,
  SiTiktok,
  SiX as SiXLogo,
  SiYoutube,
} from "react-icons/si";
import { toast } from "sonner";
import { AppHeader } from "@/components/AppHeader";
import { DecodedImage } from "@/components/DecodedImage";
import { MicroAppPanel, MicroAppStatCard } from "@/components/MicroAppPanel";
import { UpgradeDialog } from "@/components/UpgradeDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip as HoverTooltip,
  TooltipContent as HoverTooltipContent,
  TooltipProvider as HoverTooltipProvider,
  TooltipTrigger as HoverTooltipTrigger,
} from "@/components/ui/tooltip";
import { micro } from "@/lib/micro-app-ui";
import { safeMediaUrl } from "@/lib/safe-url";
import {
  getSocialAnalytics,
  getSocialInsightMedia,
  getTikTokInsightCovers,
  refreshSocialAnalytics,
  setPublicSocialInsightsPeriod,
  SOCIAL_INSIGHTS_DISPLAY_PERIODS,
  socialInsightsDisplayPeriodLabel,
  summarizeSocialAnalytics,
  type SocialAnalyticsAccount,
  type SocialAnalyticsHistoryPoint,
  type SocialInsightsDisplayPeriodDays,
} from "@/lib/social-analytics.functions";
import type { SocialContentInsight } from "@/lib/social-content-insights.server";
import {
  bestSocialContent,
  type BestContentMetric,
  dailySocialPerformance,
  followerGrowthSeries,
  selectedSocialAnalyticsAccount,
  socialContentExposureMetric,
  socialAccountActivity,
  socialContentForRange,
  socialPostMetric,
  socialEngagementSeries,
  socialGrowthMetricsFor,
  socialImpressionSeries,
  socialProviderEmptyStateMessage,
  socialReachSeries,
  socialViewSeries,
  socialContentTypePerformance,
  socialMilestones,
  type SocialGrowthMetric,
} from "@/lib/social-insights-dashboard";
import {
  SOCIAL_DETAIL_METRICS,
  SOCIAL_INSIGHTS_RANGES,
  type SocialDetailMetric,
  type SocialDetailMetrics,
  type SocialInsightsRange,
} from "@/lib/social-insights-metrics";
import { SOCIAL_PROVIDER_DEFINITIONS, type SocialProvider } from "@/lib/social-scheduler";

export const Route = createFileRoute("/_authenticated/social-insights")({
  head: () => ({ meta: [{ title: "Social insights | bento.surf" }] }),
  loader: ({ context }) => {
    context.queryClient.prefetchQuery({
      queryKey: ["social-analytics"],
      queryFn: () => getSocialAnalytics(),
    });
  },
  component: SocialInsightsPage,
});

const PROVIDER_ICONS: Record<SocialProvider, ComponentType<{ className?: string }>> = {
  instagram: SiInstagram,
  facebook: SiFacebook,
  threads: SiThreads,
  tiktok: SiTiktok,
  linkedin: FaLinkedinIn,
  twitter: SiXLogo,
  youtube: SiYoutube,
  reddit: SiReddit,
};

const GROWTH_METRICS: Array<{ id: SocialGrowthMetric; label: string }> = [
  { id: "views", label: "Views" },
  { id: "impressions", label: "Impressions" },
  { id: "reach", label: "Reach" },
  { id: "engagements", label: "Engagements" },
  { id: "followers", label: "Followers" },
];

function SocialInsightsPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>("all");
  const analytics = useQuery({
    queryKey: ["social-analytics"],
    queryFn: () => getSocialAnalytics(),
    staleTime: 5 * 60_000,
    retry: 1,
    refetchInterval: (query) =>
      query.state.data?.accounts?.some((account: SocialAnalyticsAccount) => account.refreshing)
        ? 15_000
        : false,
  });
  const refresh = useMutation({
    mutationFn: () => refreshSocialAnalytics(),
    onSuccess: (result) => {
      queryClient.setQueryData(["social-analytics"], { locked: false, ...result });
      toast.success("Social insights refresh started");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Social insights could not refresh"),
  });
  const displayPeriod = useMutation({
    mutationFn: (days: SocialInsightsDisplayPeriodDays) =>
      setPublicSocialInsightsPeriod({ data: { days } }),
    onSuccess: (result) => {
      queryClient.setQueryData<Awaited<ReturnType<typeof getSocialAnalytics>>>(
        ["social-analytics"],
        (current) =>
          current ? { ...current, displayPeriodDays: result.displayPeriodDays } : current,
      );
      toast.success("Visitor insights period updated");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Insights period could not update"),
  });

  return (
    <main className={`relative overflow-x-clip ${micro.shell}`}>
      <AppHeader
        title="Social insights"
        actions={
          <Link
            to="/settings"
            search={{ section: "integrations", integration: "social" }}
            className={micro.btnPrimaryCompact}
          >
            <Plus className="size-4" />
            <span className="hidden sm:inline">Connect account</span>
          </Link>
        }
      />

      <div className={micro.main}>
        {analytics.isLoading ? (
          <div className="flex min-h-[55vh] items-center justify-center">
            <LoaderCircle className="size-8 animate-spin text-primary" />
          </div>
        ) : !analytics.data ? (
          <MicroAppPanel>
            <p className="text-sm text-rose-700">Social insights could not load.</p>
            <button
              type="button"
              onClick={() => void analytics.refetch()}
              className={`${micro.btnSoft} mt-4`}
            >
              Try again
            </button>
          </MicroAppPanel>
        ) : analytics.data.locked ? (
          <MicroAppPanel className="flex min-h-72 flex-col items-center justify-center text-center">
            <BarChart3 className="size-8 text-primary" />
            <h2 className="mt-4 font-ui-display text-2xl">Understand every social audience</h2>
            <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
              Upgrade to see official audience totals and account-by-account social insights.
            </p>
            <div className="mt-5">
              <UpgradeDialog feature="socialAnalytics" />
            </div>
          </MicroAppPanel>
        ) : (
          <InsightsDashboard
            accounts={analytics.data.accounts}
            history={analytics.data.history || []}
            content={analytics.data.content || []}
            selectedId={selectedId}
            onSelect={setSelectedId}
            displayPeriodDays={analytics.data.displayPeriodDays}
            savingDisplayPeriod={displayPeriod.isPending}
            onDisplayPeriodChange={(days) => displayPeriod.mutate(days)}
            refreshing={refresh.isPending}
            onRefresh={() => refresh.mutate()}
          />
        )}
      </div>
    </main>
  );
}

function HistoricalImporting({ account }: { account: SocialAnalyticsAccount }) {
  const platform = SOCIAL_PROVIDER_DEFINITIONS[account.provider].name;
  return (
    <MicroAppPanel className="flex min-h-72 flex-col items-center justify-center text-center">
      <span className="flex size-14 items-center justify-center rounded-xl bg-[#eef5ff] text-primary">
        <LoaderCircle className="size-7 animate-spin" />
      </span>
      <h2 className="mt-5 font-ui-display text-2xl">We’re importing your data</h2>
      <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
        Historical charts and content for {platform} @{account.handle} will appear as each batch
        finishes.
      </p>
      <p className="mt-5 rounded-lg border border-[#3478f6]/20 bg-[#eef5ff] px-3 py-2 text-xs text-[#285fbf]">
        You can leave this page. The import continues safely in the background.
      </p>
    </MicroAppPanel>
  );
}

export function InsightsDashboard({
  accounts,
  history,
  content,
  selectedId,
  onSelect,
  displayPeriodDays,
  savingDisplayPeriod,
  onDisplayPeriodChange,
  refreshing = false,
  onRefresh,
}: {
  accounts: SocialAnalyticsAccount[];
  history: SocialAnalyticsHistoryPoint[];
  content: SocialContentInsight[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  refreshing?: boolean;
  onRefresh?: () => void;
  displayPeriodDays: SocialInsightsDisplayPeriodDays;
  savingDisplayPeriod: boolean;
  onDisplayPeriodChange: (days: SocialInsightsDisplayPeriodDays) => void;
}) {
  const [range, setRange] = useState<SocialInsightsRange>(30);
  const selected = selectedSocialAnalyticsAccount(accounts, selectedId, content);
  const totals = useMemo(() => summarizeSocialAnalytics(accounts), [accounts]);
  const selectedContent = content.filter((item) => item.connectionId === selected?.connectionId);
  const selectedHistory = history.filter((item) => item.connectionId === selected?.connectionId);

  if (!selected) {
    return (
      <MicroAppPanel className="flex min-h-72 flex-col items-center justify-center text-center">
        <UsersRound className="size-8 text-primary" />
        <h2 className="mt-4 font-ui-display text-2xl">Connect your first social account</h2>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          Official platform analytics will appear here after the first connection refresh.
        </p>
        <Link
          to="/settings"
          search={{ section: "integrations", integration: "social" }}
          className={`${micro.btnPrimary} mt-5`}
        >
          <Plus className="size-4" /> Connect account
        </Link>
      </MicroAppPanel>
    );
  }

  const all = selectedId === "all";
  const now = new Date();
  const scopedContent = all ? content : selectedContent;
  const periodContent = socialContentForRange(scopedContent, range, now);
  const periodActivity = socialAccountActivity(
    all ? accounts : [selected],
    history,
    periodContent,
    range,
    now,
  );
  return (
    <div className="space-y-5">
      <MicroAppPanel>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className={micro.eyebrowMuted}>All social media</p>
            <h2 className="mt-1 font-ui-display text-2xl">
              Totals across every connected platform
            </h2>
          </div>
          <p className="text-xs text-muted-foreground">
            {accounts.length} connected {accounts.length === 1 ? "account" : "accounts"}
          </p>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {[
            { label: "Total followers", value: totals.totalFollowers, icon: UsersRound },
            { label: "Total views", value: totals.totalViews, icon: Eye },
            { label: "Total reach", value: totals.totalReach, icon: UserRoundSearch },
            { label: "Total engagements", value: totals.totalEngagements, icon: MessageCircle },
            { label: "Total posts", value: totals.totalPosts, icon: Send },
          ].map((metric) => (
            <MicroAppStatCard key={metric.label} className="min-w-0 p-4">
              <metric.icon className="size-4 text-primary" />
              <p className="mt-4 text-2xl font-semibold tabular-nums">
                {compactMetric(metric.value)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{metric.label}</p>
            </MicroAppStatCard>
          ))}
        </div>
      </MicroAppPanel>
      <MicroAppPanel className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <p className={micro.eyebrowMuted}>Visitor page</p>
          <h2 className="mt-1 font-ui-display text-xl">Choose what visitors see</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Followers stay current. Activity totals include posts published during the selected
            period.
          </p>
        </div>
        <select
          aria-label="Visitor insights period"
          value={displayPeriodDays}
          disabled={savingDisplayPeriod}
          onChange={(event) =>
            onDisplayPeriodChange(Number(event.target.value) as SocialInsightsDisplayPeriodDays)
          }
          className={`${micro.input} w-full shrink-0 sm:w-44`}
        >
          {SOCIAL_INSIGHTS_DISPLAY_PERIODS.map((days) => (
            <option key={days} value={days}>
              {socialInsightsDisplayPeriodLabel(days)}
            </option>
          ))}
        </select>
      </MicroAppPanel>
      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className={micro.eyebrowMuted}>Connected accounts</p>
            <h2 className="mt-1 font-ui-display text-2xl">Choose an audience</h2>
          </div>
          <div className="flex items-center gap-3">
            <InsightsFreshness accounts={all ? accounts : [selected]} />
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing || accounts.some((account) => account.refreshing)}
              aria-label="Refresh insights"
              className={`${micro.btnSoft} inline-flex items-center gap-2`}
            >
              <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>
        </div>
        <MicroAppTabs
          ariaLabel="Social media view"
          className="mb-3"
          value={all ? "all" : selected.connectionId}
          onChange={onSelect}
          tabs={[
            { id: "all", label: "All social media", icon: BarChart3 },
            ...accounts.map((account) => ({
              id: account.connectionId,
              label: `${SOCIAL_PROVIDER_DEFINITIONS[account.provider].name} · @${account.handle}`,
              icon: PROVIDER_ICONS[account.provider],
            })),
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {accounts.map((account) => (
            <AccountSelector
              key={account.connectionId}
              account={account}
              active={!all && account.connectionId === selected.connectionId}
              onClick={() => onSelect(account.connectionId)}
            />
          ))}
          <Link
            to="/settings"
            search={{ section: "integrations", integration: "social" }}
            className="flex min-h-36 flex-col justify-between rounded-xl border border-dashed border-border bg-white p-4 transition hover:border-primary/35 hover:shadow-sm"
          >
            <div>
              <p className="text-sm font-semibold">Connect more accounts</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Compare every supported social platform here.
              </p>
            </div>
            <span className="mt-4 flex items-center gap-1.5 text-xs font-semibold text-primary">
              <Plus className="size-3.5" /> Go to integrations
            </span>
          </Link>
        </div>
      </section>

      <MicroAppPanel className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-ui-display text-xl">Reporting period</h2>
        <select
          className={micro.input}
          aria-label="Insights reporting period"
          value={range}
          onChange={(event) => {
            const value = event.target.value;
            setRange(value === "all" ? value : (Number(value) as SocialInsightsRange));
          }}
        >
          {SOCIAL_INSIGHTS_RANGES.map((days) => (
            <option key={days} value={days}>
              {days === "all" ? "All time" : days === 366 ? "1 year" : `${days} days`}
            </option>
          ))}
        </select>
      </MicroAppPanel>
      {(all || selected.provider !== "linkedin") && <PeriodActivity {...periodActivity} />}
      {(all ? accounts.some((account) => account.archivePending) : selected.archivePending) && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <RefreshCw className="size-3.5" /> Older posts are imported in batches with each refresh.
        </p>
      )}
      {!all && selected.provider === "linkedin" ? (
        <LinkedInAnalyticsComingSoon account={selected} />
      ) : all ? (
        <>
          <ActivityHeatmap content={content} />
          <div className="grid gap-4 lg:grid-cols-2">
            {accounts.map((account) => (
              <AccountOverview key={account.connectionId} account={account} />
            ))}
          </div>
          <ContentPerformancePanel content={periodContent} provider={selected.provider} />
          <BestContentPanel
            key={`all:${range}`}
            content={periodContent}
            provider={selected.provider}
          />
        </>
      ) : (
        <>
          <AccountOverview account={selected} />

          {selected.initialImportActive && <HistoricalImporting account={selected} />}
          {(!selected.initialImportActive || selectedContent.length > 0) && (
            <ActivityHeatmap account={selected} content={selectedContent} />
          )}
          {(!selected.initialImportActive || selectedHistory.length > 0) && (
            <GrowthPanel
              account={selected}
              history={history}
              content={selectedContent}
              range={range === "all" ? 366 : range}
            />
          )}
          <MilestonesPanel account={selected} content={selectedContent} />
          {(!selected.initialImportActive || selectedContent.length > 0) && (
            <>
              <ContentPerformancePanel content={periodContent} provider={selected.provider} />
              <BestContentPanel
                key={`${selected.connectionId}:${range}`}
                content={periodContent}
                provider={selected.provider}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

function LinkedInAnalyticsComingSoon({ account }: { account: SocialAnalyticsAccount }) {
  return (
    <MicroAppPanel className="flex min-h-72 flex-col items-center justify-center text-center">
      <span className="flex size-14 items-center justify-center rounded-xl bg-[#eef5ff] text-[#0a66c2]">
        <FaLinkedinIn className="size-7" />
      </span>
      <h2 className="mt-5 font-ui-display text-2xl">LinkedIn analytics coming soon</h2>
      <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
        @{account.handle} stays connected for publishing. Analytics will appear here after LinkedIn
        approves Bento’s member analytics access.
      </p>
    </MicroAppPanel>
  );
}

function InsightsFreshness({ accounts }: { accounts: SocialAnalyticsAccount[] }) {
  const allAccounts = accounts.length > 1;
  const lastUpdated = accounts
    .map((account) => account.lastUpdatedAt || account.fetchedAt)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  const overdue = accounts.some((account) => {
    const updated = Date.parse(account.lastUpdatedAt || account.fetchedAt);
    return (
      account.status === "error" ||
      (!account.refreshing && Number.isFinite(updated) && Date.now() - updated > 24 * 60 * 60_000)
    );
  });
  const nextRefresh = accounts
    .flatMap((account) => (account.nextRefreshAt ? [account.nextRefreshAt] : []))
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  return (
    <div className="text-right text-xs text-muted-foreground">
      <p className={`font-semibold ${overdue ? "text-rose-700" : "text-foreground"}`}>
        {overdue ? "Refresh overdue" : "Updated every 24 hours"}
      </p>
      {lastUpdated && (
        <p className="mt-0.5">
          {allAccounts ? "Oldest update" : "Last updated"} {formatDateTime(lastUpdated)}
        </p>
      )}
      {nextRefresh && <p className="mt-0.5">Next refresh {formatDateTime(nextRefresh)}</p>}
    </div>
  );
}

function AccountSelector({
  account,
  active,
  onClick,
}: {
  account: SocialAnalyticsAccount;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = PROVIDER_ICONS[account.provider];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-36 rounded-xl border bg-white p-4 text-left transition ${
        active
          ? "border-[#17213a] shadow-[0_4px_0_rgba(23,33,58,0.12),0_14px_35px_-25px_rgba(23,33,58,0.55)]"
          : "border-border hover:border-[#17213a]/30 hover:shadow-sm"
      }`}
    >
      <div className="flex items-center gap-3">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[#f2f5fb]"
          style={{ color: SOCIAL_PROVIDER_DEFINITIONS[account.provider].color }}
        >
          <Icon className="size-5" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">
            {SOCIAL_PROVIDER_DEFINITIONS[account.provider].name}
          </span>
          <span className="block truncate text-xs text-muted-foreground">@{account.handle}</span>
        </span>
      </div>
      {account.provider === "linkedin" ? (
        <p className="mt-5 text-sm font-semibold text-[#0a66c2]">Analytics coming soon</p>
      ) : (
        <>
          <p className="mt-5 text-2xl font-semibold tabular-nums">
            {compactMetric(account.followers)}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">followers</p>
        </>
      )}
      {account.initialImportActive && (
        <span className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-primary">
          <LoaderCircle className="size-3.5 animate-spin" /> Importing history
        </span>
      )}
    </button>
  );
}

function AccountOverview({ account }: { account: SocialAnalyticsAccount }) {
  const metrics = [
    { label: "Followers", value: account.followers, icon: UsersRound },
    {
      label: ["instagram", "facebook", "threads", "youtube", "tiktok"].includes(account.provider)
        ? "Views"
        : "Impressions",
      value: account.views,
      icon: Eye,
    },
    { label: "Reach", value: account.reach, icon: UserRoundSearch },
    { label: "Engagements", value: account.engagements, icon: MessageCircle },
    { label: "Posts", value: account.posts, icon: Send },
  ].filter((metric) => metric.value !== null);
  return (
    <MicroAppPanel>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className={micro.eyebrowMuted}>
            {SOCIAL_PROVIDER_DEFINITIONS[account.provider].name} account overview
          </p>
          <h2 className="mt-1 font-ui-display text-2xl">{account.displayName}</h2>
        </div>
        <p className="text-xs text-muted-foreground">Updated {formatDateTime(account.fetchedAt)}</p>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {metrics.map((metric) => (
          <div key={metric.label} className={`${micro.soft} p-4`}>
            <metric.icon className="size-4 text-muted-foreground" />
            <p className="mt-4 text-2xl font-semibold tabular-nums">
              {compactMetric(metric.value)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{metric.label}</p>
          </div>
        ))}
      </div>
      {account.status === "error" && account.note && (
        <p className="mt-4 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-700" role="alert">
          {account.note}
        </p>
      )}
      {account.note && account.status !== "error" && (
        <p className="mt-4 text-xs leading-5 text-muted-foreground">{account.note}</p>
      )}
    </MicroAppPanel>
  );
}

function GrowthPanel({
  account,
  history,
  content,
  range,
}: {
  account: SocialAnalyticsAccount;
  history: SocialAnalyticsHistoryPoint[];
  content: SocialContentInsight[];
  range: 7 | 30 | 90 | 366;
}) {
  const availableMetrics = useMemo(
    () => socialGrowthMetricsFor(account.provider),
    [account.provider],
  );
  const [metric, setMetric] = useState<SocialGrowthMetric>(availableMetrics[0]);
  const [cumulative, setCumulative] = useState(false);
  const followerStart = useMemo(
    () => followerGrowthSeries(history, account.connectionId)[0]?.date || null,
    [account.connectionId, history],
  );
  useEffect(() => {
    setMetric(availableMetrics[0]);
    setCumulative(false);
  }, [account.connectionId, availableMetrics]);
  const rawPoints = useMemo(() => {
    if (metric === "followers") {
      const cutoff = Date.now() - range * 24 * 60 * 60_000;
      return followerGrowthSeries(history, account.connectionId).filter(
        (point) => new Date(point.date).getTime() >= cutoff,
      );
    }
    const series =
      metric === "reach"
        ? socialReachSeries(history, account.connectionId, content, range, new Date())
        : metric === "views"
          ? socialViewSeries(history, account.connectionId, content, range, new Date())
          : metric === "engagements"
            ? socialEngagementSeries(history, account.connectionId, content, range, new Date())
            : socialImpressionSeries(history, account.connectionId, content, range, new Date());
    return series.map((point) => ({
      date: point.date,
      value: point[metric],
    }));
  }, [account.connectionId, content, history, metric, range]);
  const points = useMemo(() => {
    if (!cumulative || metric === "followers") return rawPoints;
    let total = 0;
    return rawPoints.map((point) => ({ ...point, value: (total += point.value) }));
  }, [cumulative, metric, rawPoints]);
  const historyMetric = metric === "impressions" ? "views" : metric;
  const hasMetricData =
    history.some(
      (point) => point.connectionId === account.connectionId && point[historyMetric] !== null,
    ) ||
    (metric !== "followers" && content.some((item) => item[metric] !== null));
  const currentValue =
    metric === "followers"
      ? account.followers
      : rawPoints.reduce((total, point) => total + point.value, 0);
  const midpoint = Math.floor(rawPoints.length / 2);
  const prior = rawPoints.slice(0, midpoint).reduce((total, point) => total + point.value, 0);
  const recent = rawPoints.slice(midpoint).reduce((total, point) => total + point.value, 0);
  const change = metric !== "followers" && prior ? ((recent - prior) / prior) * 100 : null;

  return (
    <MicroAppPanel>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <TrendingUp className="size-4 text-primary" />
            <h2 className="font-ui-display text-2xl">Growth</h2>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {compactMetric(currentValue)}{" "}
            {GROWTH_METRICS.find((item) => item.id === metric)?.label.toLowerCase()}
            {change !== null ? ` · ${change >= 0 ? "+" : ""}${change.toFixed(1)}%` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {GROWTH_METRICS.filter((item) => availableMetrics.includes(item.id)).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setMetric(item.id)}
              className={`rounded-lg border px-3 py-2 text-xs font-semibold ${
                item.id === metric
                  ? "border-primary/35 bg-primary/10 text-primary"
                  : "border-border bg-white text-muted-foreground hover:text-foreground"
              }`}
            >
              {item.label}
            </button>
          ))}
          <label
            title={metric === "followers" ? "Follower totals are already cumulative" : undefined}
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold ${
              metric === "followers" || cumulative
                ? "border-primary/35 bg-primary/10 text-primary"
                : "border-border bg-white text-muted-foreground hover:text-foreground"
            } ${metric === "followers" ? "cursor-default" : "cursor-pointer"}`}
          >
            <Switch
              checked={metric === "followers" || cumulative}
              disabled={metric === "followers"}
              onCheckedChange={setCumulative}
              aria-label="Show cumulative growth"
            />
            <span>Cumulative</span>
          </label>
        </div>
      </div>

      {points.length >= 2 && hasMetricData ? (
        <div className="mt-6 h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
              <defs>
                <linearGradient id="social-growth-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3478f6" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#3478f6" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="#e7eaf0" />
              <XAxis
                dataKey="date"
                tickFormatter={shortDate}
                axisLine={false}
                tickLine={false}
                minTickGap={40}
              />
              <YAxis tickFormatter={compactMetric} axisLine={false} tickLine={false} width={62} />
              <Tooltip
                labelFormatter={(value) => formatDateTime(String(value))}
                formatter={(value) => [
                  Number(value).toLocaleString(),
                  metric === "followers" ? "Followers" : cumulative ? "Cumulative" : "Daily",
                ]}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke="#3478f6"
                strokeWidth={2}
                fill="url(#social-growth-fill)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="mt-6 flex min-h-56 items-center justify-center rounded-xl border border-dashed border-border bg-[#fafbfe] px-5 text-center">
          <div>
            <TrendingUp className="mx-auto size-6 text-muted-foreground" />
            <p className="mt-3 text-sm font-semibold">No historical {metric} yet</p>
            <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">
              {socialProviderEmptyStateMessage(account.provider)}
            </p>
          </div>
        </div>
      )}
      {metric === "followers" &&
        ["instagram", "threads", "tiktok", "linkedin", "twitter", "reddit"].includes(
          account.provider,
        ) && (
          <p className="mt-4 rounded-lg border border-[#3478f6]/20 bg-[#eef5ff] px-3 py-2 text-xs leading-5 text-[#285fbf]">
            {socialProviderEmptyStateMessage(account.provider)}
            {followerStart ? ` (${shortDate(followerStart)})` : ""}.
          </p>
        )}
    </MicroAppPanel>
  );
}

export function ActivityHeatmap({
  account,
  content,
  now = new Date(),
}: {
  account?: SocialAnalyticsAccount;
  content: SocialContentInsight[];
  now?: Date;
}) {
  const days = dailySocialPerformance(content, 366, now);
  const total = days.reduce((sum, day) => sum + day.posts, 0);
  const max = Math.max(...days.map((day) => day.posts), 1);
  const leading = new Date(days[0].date).getDay();
  const cells: Array<(typeof days)[number] | null> = [
    ...Array.from({ length: leading }, () => null),
    ...days,
  ];
  return (
    <MicroAppPanel>
      <p className={micro.eyebrowMuted}>
        {account
          ? `${SOCIAL_PROVIDER_DEFINITIONS[account.provider].name} · @${account.handle}`
          : "All social media"}{" "}
        activity
      </p>
      <div className="mt-2 flex items-end gap-2">
        <h2 className="font-ui-display text-4xl">
          {compactMetric(total)} {total === 1 ? "post" : "posts"}
        </h2>
        <span className="pb-1 text-sm text-muted-foreground">past year</span>
      </div>
      {total > 0 ? (
        <div className="mt-6 overflow-x-auto pb-2">
          <HoverTooltipProvider delayDuration={80}>
            <div className="grid min-w-[780px] grid-flow-col grid-rows-7 gap-1.5">
              {cells.map((day, index) => {
                if (!day) return <span key={`empty-${index}`} className="size-3.5" />;
                const level = day.posts ? Math.max(1, Math.ceil((day.posts / max) * 4)) : 0;
                const platforms = [...new Set(day.items.map((item) => item.provider))];
                const label = `${shortDate(day.date)}, ${day.posts} ${day.posts === 1 ? "post" : "posts"}${platforms.length ? ` across ${platforms.map((provider) => SOCIAL_PROVIDER_DEFINITIONS[provider].name).join(" and ")}` : ""}`;
                const cellClass = `size-3.5 rounded-[4px] ${
                  level === 4
                    ? "bg-[#3478f6]"
                    : level === 3
                      ? "bg-[#6da0fa]"
                      : level === 2
                        ? "bg-[#a8c7fc]"
                        : level === 1
                          ? "bg-[#d7e6fe]"
                          : "bg-[#f3f5f9]"
                }`;
                if (!day.items.length)
                  return <span key={day.date} aria-hidden="true" className={cellClass} />;
                const cell = (
                  <button
                    type="button"
                    aria-label={label}
                    className={`${cellClass} outline-none transition hover:scale-125 focus-visible:scale-125 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2`}
                  />
                );
                return (
                  <HoverTooltip key={day.date}>
                    <HoverTooltipTrigger asChild>{cell}</HoverTooltipTrigger>
                    <HoverTooltipContent
                      side="top"
                      sideOffset={10}
                      className="w-80 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-xl"
                    >
                      <p className="font-ui-display text-base">{shortDate(day.date)}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {day.posts} {day.posts === 1 ? "post" : "posts"} across {platforms.length}{" "}
                        {platforms.length === 1 ? "platform" : "platforms"}
                      </p>
                      <div className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
                        {day.items.map((post) => {
                          const PlatformIcon = PROVIDER_ICONS[post.provider];
                          const platform = SOCIAL_PROVIDER_DEFINITIONS[post.provider];
                          return (
                            <div
                              key={`${post.connectionId}:${post.remotePostId}`}
                              aria-label={`${platform.name} post`}
                              className="flex items-start gap-2.5 rounded-lg bg-muted/70 p-2.5"
                            >
                              <span
                                className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-background"
                                style={{ color: platform.color }}
                              >
                                <PlatformIcon className="size-3.5" />
                              </span>
                              <span className="min-w-0">
                                <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                  {platform.name}
                                </span>
                                <span className="mt-0.5 block line-clamp-2 text-xs leading-5">
                                  {post.caption?.trim() || `${post.contentType} post`}
                                </span>
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </HoverTooltipContent>
                  </HoverTooltip>
                );
              })}
            </div>
          </HoverTooltipProvider>
          <div className="mt-3 flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
            Less <span className="size-3 rounded-[3px] bg-[#f3f5f9]" />
            <span className="size-3 rounded-[3px] bg-[#d7e6fe]" />
            <span className="size-3 rounded-[3px] bg-[#a8c7fc]" />
            <span className="size-3 rounded-[3px] bg-[#6da0fa]" />
            <span className="size-3 rounded-[3px] bg-[#3478f6]" /> More
          </div>
        </div>
      ) : account ? (
        <ProviderDataEmpty provider={account.provider} />
      ) : (
        <p className="mt-5 text-sm text-muted-foreground">
          No imported posts in the past year. Refresh to import available content.
        </p>
      )}
    </MicroAppPanel>
  );
}

function MilestonesPanel({
  account,
  content,
}: {
  account: SocialAnalyticsAccount;
  content: SocialContentInsight[];
}) {
  const milestones = socialMilestones(account, content);
  return (
    <MicroAppPanel className="!border-[#3478f6]/30 !bg-[#eef5ff]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-ui-display text-2xl">Milestones</h2>
        <Award className="size-5 text-primary" />
      </div>
      <div className="mt-5 flex gap-3 overflow-x-auto pb-2">
        {milestones.map((milestone) => (
          <div
            key={milestone.label}
            className={`flex min-h-36 min-w-36 flex-col items-center justify-center rounded-xl border p-4 text-center ${
              milestone.reached
                ? "border-[#3478f6]/35 bg-white/80"
                : "border-[#3478f6]/20 bg-white/55 opacity-60"
            }`}
          >
            <Trophy
              className={`size-7 ${milestone.reached ? "text-[#3478f6]" : "text-muted-foreground"}`}
            />
            <p className="mt-4 text-sm font-semibold">{milestone.label}</p>
            <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              {milestone.reached ? "Reached" : "Next up"}
            </p>
          </div>
        ))}
      </div>
    </MicroAppPanel>
  );
}

function ContentPerformancePanel({
  content,
  provider,
}: {
  content: SocialContentInsight[];
  provider: SocialProvider;
}) {
  const performance = socialContentTypePerformance(content);
  const exposureMetric = socialContentExposureMetric(content);
  const exposureLabel =
    exposureMetric === "views"
      ? "views"
      : exposureMetric === "impressions"
        ? "impressions"
        : "engagements";
  const exposure = (item: (typeof performance)[number]) =>
    exposureMetric === "views"
      ? item.averageViews
      : exposureMetric === "impressions"
        ? item.averageImpressions
        : item.averageEngagements;
  const max = Math.max(...performance.map(exposure), 1);
  return (
    <MicroAppPanel>
      <p className={micro.eyebrowMuted}>Content type performance</p>
      <h2 className="mt-2 font-ui-display text-2xl">What performs best</h2>
      {performance.length ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(240px,1fr)]">
          <div className="space-y-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Average {exposureLabel}
            </p>
            {performance.map((item) => (
              <div key={item.type}>
                <div className="flex items-center justify-between text-sm">
                  <span className="font-semibold capitalize">
                    {item.type}{" "}
                    <span className="font-normal text-muted-foreground">· {item.posts} posts</span>
                  </span>
                  <span className="tabular-nums">{compactMetric(exposure(item))}</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-lg bg-[#eef0f5]">
                  <div
                    className="h-full rounded-lg bg-[#3478f6]"
                    style={{ width: `${(exposure(item) / max) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Engagement rate
            </p>
            <div className="mt-4 space-y-3">
              {performance.map((item) => (
                <div key={item.type} className="flex items-center justify-between text-sm">
                  <span className="capitalize text-muted-foreground">{item.type}</span>
                  <span className="font-semibold tabular-nums">
                    {item.engagementRate === null ? "N/A" : `${item.engagementRate.toFixed(1)}%`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <ProviderDataEmpty provider={provider} />
      )}
    </MicroAppPanel>
  );
}

function formatDetailMetric(key: SocialDetailMetric, value: number) {
  if (key === "skipRate" || key === "averageViewedPercent") return `${Number(value.toFixed(2))}%`;
  if (["averageWatchSeconds", "watchSeconds", "durationSeconds"].includes(key))
    return value < 60 ? `${Number(value.toFixed(1))}s` : `${compactMetric(value / 60)} min`;
  return compactMetric(value);
}

function MetricTiles({
  metrics,
  provider,
}: {
  metrics: SocialDetailMetrics;
  provider?: SocialProvider;
}) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {(Object.keys(SOCIAL_DETAIL_METRICS) as SocialDetailMetric[]).map((key) => {
        const value = metrics[key];
        if (value === undefined) return null;
        const label =
          key === "comments" && (provider === "threads" || provider === "twitter")
            ? "Replies"
            : key === "saves" && provider === "twitter"
              ? "Bookmarks"
              : SOCIAL_DETAIL_METRICS[key];
        return (
          <div key={key} className="rounded-lg border border-border bg-muted/30 p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums" title={String(value)}>
              {formatDetailMetric(key, value)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function PeriodActivity({
  accountMetrics,
  postMetrics,
  followerChange,
  partialFollowerHistory,
}: ReturnType<typeof socialAccountActivity>) {
  return (
    <MicroAppPanel className="space-y-4">
      <div>
        <h2 className="font-ui-display text-2xl">Account activity</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Reported activity through the latest available day.
        </p>
      </div>
      <div className="rounded-lg border border-border bg-muted/30 p-3">
        <p className="text-xs text-muted-foreground">Net follower change</p>
        <p className="mt-1 text-lg font-semibold tabular-nums">
          {followerChange === null
            ? "Awaiting follower history"
            : `${followerChange > 0 ? "+" : ""}${compactMetric(followerChange)}`}
        </p>
        {partialFollowerHistory && followerChange !== null && (
          <p className="mt-1 text-xs text-muted-foreground">
            Based on the follower history available for this period.
          </p>
        )}
      </div>
      <MetricTiles metrics={accountMetrics} />
      {Object.keys(postMetrics).length > 0 && (
        <details className="space-y-3">
          <summary className="cursor-pointer text-sm font-semibold">
            Lifetime totals for posts published in this period
          </summary>
          <MetricTiles metrics={postMetrics} />
        </details>
      )}
    </MicroAppPanel>
  );
}

function InsightThumbnail({ item, cover }: { item: SocialContentInsight; cover?: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  const primary = safeMediaUrl(cover || item.thumbnailUrl);
  const alternate =
    item.provider === "youtube" && /^[\w-]{11}$/.test(item.remotePostId)
      ? `https://i.ytimg.com/vi/${item.remotePostId}/hqdefault.jpg`
      : null;
  const src = [primary, alternate].find((url) => url && !failed.includes(url));
  const platform = SOCIAL_PROVIDER_DEFINITIONS[item.provider].name;
  const Icon = PROVIDER_ICONS[item.provider];
  if (!src) {
    return (
      <div className="mt-3 flex aspect-video flex-col items-center justify-center gap-2 rounded-lg bg-muted text-xs font-medium text-muted-foreground">
        {item.contentType === "video" ? <Play className="size-5" /> : <Icon className="size-5" />}
        <span className="sr-only">
          {platform} {item.contentType === "video" ? "video" : "post"}
        </span>
      </div>
    );
  }
  return (
    <DecodedImage
      src={src}
      alt={`${item.contentType} post thumbnail`}
      loading="lazy"
      className="mt-3 aspect-video w-full rounded-lg bg-muted object-cover"
      onError={() => setFailed((current) => [...current, src])}
    />
  );
}

function PostInsightsDialog({
  item,
  cover,
  onClose,
}: {
  item: SocialContentInsight | null;
  cover?: string;
  onClose: () => void;
}) {
  const [play, setPlay] = useState(false);
  const [media, setMedia] = useState<{ image: string | null; video: string | null } | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);
  const platform = item && SOCIAL_PROVIDER_DEFINITIONS[item.provider].name;
  const id = item?.remotePostId || "";
  const embed =
    item?.provider === "youtube" && /^[\w-]{11}$/.test(id)
      ? `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`
      : item?.provider === "tiktok" && /^\d{1,30}$/.test(id)
        ? `https://www.tiktok.com/player/v1/${id}?autoplay=1`
        : null;
  const connectionId = item?.connectionId;
  const contentType = item?.contentType;
  useEffect(() => {
    if (
      !connectionId ||
      !id ||
      embed ||
      contentType === "text" ||
      !/^[a-f\d-]{36}$/i.test(connectionId)
    )
      return;
    let active = true;
    void getSocialInsightMedia({ data: { connectionId, postId: id } })
      .then((sources) => {
        if (!active) return;
        setMedia({
          image: safeMediaUrl(sources.find((source) => source.type !== "video")?.url),
          video: safeMediaUrl(sources.find((source) => source.type === "video")?.url),
        });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [connectionId, contentType, embed, id]);
  const metrics: SocialDetailMetrics = {};
  if (item) {
    for (const key of Object.keys(SOCIAL_DETAIL_METRICS) as SocialDetailMetric[]) {
      const value = socialPostMetric(item, key);
      if (value !== undefined) metrics[key] = value;
    }
  }
  return (
    <Dialog
      open={Boolean(item)}
      onOpenChange={(open) => {
        if (!open) {
          setPlay(false);
          setMedia(null);
          setVideoFailed(false);
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        {item && (
          <>
            <DialogHeader>
              <DialogTitle>
                {item.contentType === "video" ? "Video insights" : "Post insights"}
              </DialogTitle>
              <DialogDescription>
                {platform} · Published {formatDateTime(item.publishedAt)} · Lifetime metrics
              </DialogDescription>
            </DialogHeader>
            {play && embed ? (
              <iframe
                className="aspect-video w-full rounded-lg"
                src={embed}
                title={`${platform} video`}
                allow="autoplay; fullscreen"
                allowFullScreen
              />
            ) : play && media?.video && !videoFailed ? (
              <video
                src={media.video}
                poster={safeMediaUrl(cover || item.thumbnailUrl) || undefined}
                className="max-h-[50dvh] w-full rounded-lg bg-black"
                controls
                autoPlay
                playsInline
                aria-label={`${platform} video`}
                onError={() => {
                  setVideoFailed(true);
                  setPlay(false);
                }}
              />
            ) : (
              item.contentType !== "text" &&
              (embed || (media?.video && !videoFailed) ? (
                <button
                  type="button"
                  className="relative w-full"
                  aria-label="Play video"
                  onClick={() => setPlay(true)}
                >
                  <InsightThumbnail
                    item={item}
                    cover={cover || item.thumbnailUrl || media?.image || undefined}
                  />
                  <span className="absolute inset-0 grid place-items-center">
                    <Play className="size-10 rounded-full bg-foreground/85 p-2.5 text-background" />
                  </span>
                </button>
              ) : (
                <InsightThumbnail
                  item={item}
                  cover={cover || item.thumbnailUrl || media?.image || undefined}
                />
              ))
            )}
            {item.caption && (
              <p className="whitespace-pre-line break-words text-sm">{item.caption}</p>
            )}
            {Object.keys(metrics).length ? (
              <MetricTiles metrics={metrics} provider={item.provider} />
            ) : (
              <p className="text-sm text-muted-foreground">
                This platform has yet to report metrics for this post.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Last refreshed {formatDateTime(item.fetchedAt)}. Available metrics vary by platform
              and post type.
            </p>
            {safeMediaUrl(item.remotePostUrl) && (
              <a
                href={item.remotePostUrl!}
                target="_blank"
                rel="noreferrer"
                className={micro.btnSoft}
              >
                Open on {platform} <ExternalLink className="size-3.5" />
              </a>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

const CONTENT_PAGE_SIZE = 12;

function BestContentPanel({
  content,
  provider,
}: {
  content: SocialContentInsight[];
  provider: SocialProvider;
}) {
  const exposureMetric: BestContentMetric = socialContentExposureMetric(content);
  const [chosenMetric, setChosenMetric] = useState<BestContentMetric>(exposureMetric);
  const [page, setPage] = useState(0);
  const [selectedPost, setSelectedPost] = useState<string | null>(null);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const options = useMemo(
    () =>
      (
        [
          exposureMetric,
          "views",
          "impressions",
          "reach",
          "engagements",
          "likes",
          "comments",
          "shares",
          "saves",
          "reposts",
          "quotes",
          "follows",
          "watchSeconds",
        ] as BestContentMetric[]
      ).filter(
        (option, index, all) =>
          all.indexOf(option) === index &&
          content.some((item) => socialPostMetric(item, option) !== undefined),
      ),
    [content, exposureMetric],
  );
  const metric = options.includes(chosenMetric) ? chosenMetric : options[0] || exposureMetric;
  const ranked = useMemo(() => bestSocialContent(content, Infinity, metric), [content, metric]);
  const pageCount = Math.ceil(ranked.length / CONTENT_PAGE_SIZE);
  const activePage = Math.min(page, Math.max(0, pageCount - 1));
  const visible = useMemo(
    () => ranked.slice(activePage * CONTENT_PAGE_SIZE, (activePage + 1) * CONTENT_PAGE_SIZE),
    [ranked, activePage],
  );
  const postKey = (item: SocialContentInsight) => `${item.connectionId}:${item.remotePostId}`;
  const item = visible.find((post) => postKey(post) === selectedPost);

  useEffect(() => {
    const expired = new Map<string, string[]>();
    for (const post of visible) {
      if (
        post.provider !== "tiktok" ||
        !/^\d{1,30}$/.test(post.remotePostId) ||
        (post.thumbnailUrl && Date.now() - Date.parse(post.fetchedAt) < 5 * 60 * 60_000)
      )
        continue;
      expired.set(post.connectionId, [
        ...(expired.get(post.connectionId) || []),
        post.remotePostId,
      ]);
    }
    let active = true;
    for (const [connectionId, postIds] of expired) {
      void getTikTokInsightCovers({ data: { connectionId, postIds } })
        .then((next) => {
          if (!active) return;
          setCovers((current) => ({
            ...current,
            ...Object.fromEntries(
              Object.entries(next).map(([id, url]) => [`${connectionId}:${id}`, url]),
            ),
          }));
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [visible]);

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-ui-display text-2xl">Best-performing content</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {content.length} posts published in this period · Ranked by lifetime metrics
          </p>
        </div>
        {options.length > 1 && (
          <label className="text-xs font-medium text-muted-foreground">
            Rank by
            <select
              className="ml-2 rounded-lg border border-border bg-background px-2 py-1.5 text-foreground"
              value={metric}
              onChange={(event) => {
                setChosenMetric(event.target.value as BestContentMetric);
                setPage(0);
              }}
            >
              {options.map((option) => (
                <option key={option} value={option}>
                  {SOCIAL_DETAIL_METRICS[option]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {visible.length ? (
        <>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((post) => {
              const platform = SOCIAL_PROVIDER_DEFINITIONS[post.provider].name;
              const matched = socialPostMetric(post, metric);
              const Icon = PROVIDER_ICONS[post.provider];
              return (
                <article
                  key={postKey(post)}
                  className="overflow-hidden rounded-xl border border-border bg-white shadow-sm"
                >
                  <button
                    type="button"
                    aria-label={`View insights for ${post.caption || `${platform} ${post.contentType}`}`}
                    onClick={() => setSelectedPost(postKey(post))}
                    className="block h-full w-full p-4 text-left transition hover:bg-muted/40 focus-visible:outline focus-visible:outline-primary"
                  >
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Icon className="size-3.5" aria-hidden />
                      <span>
                        {platform} · {shortDate(post.publishedAt)}
                      </span>
                    </div>
                    {post.contentType !== "text" && (
                      <InsightThumbnail item={post} cover={covers[postKey(post)]} />
                    )}
                    <p className="mt-3 line-clamp-2 break-words text-sm font-medium">
                      {post.caption || `${platform} ${post.contentType}`}
                    </p>
                    <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                      <span>
                        {matched === undefined ? "N/A" : formatDetailMetric(metric, matched)}{" "}
                        {SOCIAL_DETAIL_METRICS[metric].toLowerCase()}
                      </span>
                      {metric !== "likes" && post.likes !== null && (
                        <span className="flex items-center gap-1">
                          <Heart className="size-3.5" /> {compactMetric(post.likes)}
                        </span>
                      )}
                      {metric !== "reposts" && post.detailMetrics?.reposts !== undefined && (
                        <span className="flex items-center gap-1">
                          <Repeat2 className="size-3.5" />{" "}
                          {compactMetric(post.detailMetrics.reposts)}
                        </span>
                      )}
                    </div>
                  </button>
                </article>
              );
            })}
          </div>
          {pageCount > 1 && (
            <div className="mt-4 flex items-center justify-center gap-4" aria-label="Content pages">
              <button
                type="button"
                className={micro.btnSoft}
                onClick={() => setPage(activePage - 1)}
                disabled={activePage === 0}
              >
                Previous
              </button>
              <span className="text-sm text-muted-foreground">
                Page {activePage + 1} of {pageCount}
              </span>
              <button
                type="button"
                className={micro.btnSoft}
                onClick={() => setPage(activePage + 1)}
                disabled={activePage + 1 === pageCount}
              >
                Next
              </button>
            </div>
          )}
        </>
      ) : (
        <MicroAppPanel className="mt-4">
          <ProviderDataEmpty provider={provider} period />
        </MicroAppPanel>
      )}
      <PostInsightsDialog
        item={item || null}
        cover={item && covers[postKey(item)]}
        onClose={() => setSelectedPost(null)}
      />
    </section>
  );
}

function ProviderDataEmpty({
  provider,
  period = false,
}: {
  provider: SocialProvider;
  period?: boolean;
}) {
  return (
    <div className="mt-5 rounded-xl border border-dashed border-border bg-[#fafbfe] p-6 text-center">
      <BarChart3 className="mx-auto size-6 text-muted-foreground" />
      <p className="mt-3 text-sm font-semibold">
        {period ? "No posts in this period" : "Historical content is not available yet"}
      </p>
      <p className="mx-auto mt-1 max-w-lg text-xs leading-5 text-muted-foreground">
        {socialProviderEmptyStateMessage(provider)}
      </p>
    </div>
  );
}

function compactMetric(value: number | null) {
  return value === null
    ? "N/A"
    : new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
        value,
      );
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(value),
  );
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
