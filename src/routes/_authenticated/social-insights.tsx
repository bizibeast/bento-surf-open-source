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
  LoaderCircle,
  MessageCircle,
  Plus,
  RefreshCw,
  Send,
  TrendingUp,
  Trophy,
  UserRoundSearch,
  UsersRound,
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
import { MicroAppPanel } from "@/components/MicroAppPanel";
import { UpgradeDialog } from "@/components/UpgradeDialog";
import { Switch } from "@/components/ui/switch";
import { micro } from "@/lib/micro-app-ui";
import { safeMediaUrl } from "@/lib/safe-url";
import {
  getSocialAnalytics,
  refreshSocialAnalytics,
  setPublicSocialInsightsPeriod,
  SOCIAL_INSIGHTS_DISPLAY_PERIODS,
  socialInsightsDisplayPeriodLabel,
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const analytics = useQuery({
    queryKey: ["social-analytics"],
    queryFn: () => getSocialAnalytics(),
    staleTime: 5 * 60_000,
    retry: 1,
    refetchInterval: (query) =>
      query.state.data?.accounts?.some((account: SocialAnalyticsAccount) => account.refreshing)
        ? 5_000
        : false,
  });
  const refresh = useMutation({
    mutationFn: () => refreshSocialAnalytics(),
    onSuccess: (result) => queryClient.setQueryData(["social-analytics"], result),
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
            refreshing={
              refresh.isPending ||
              analytics.data.accounts.some((account: SocialAnalyticsAccount) => account.refreshing)
            }
            onRefresh={() => refresh.mutate()}
            displayPeriodDays={analytics.data.displayPeriodDays}
            savingDisplayPeriod={displayPeriod.isPending}
            onDisplayPeriodChange={(days) => displayPeriod.mutate(days)}
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
        Historical charts and content for {platform} @{account.handle} will be available in 10–15
        minutes.
      </p>
      <p className="mt-5 rounded-lg border border-[#3478f6]/20 bg-[#eef5ff] px-3 py-2 text-xs text-[#285fbf]">
        You can leave this page. The import continues safely in the background.
      </p>
    </MicroAppPanel>
  );
}

function InsightsDashboard({
  accounts,
  history,
  content,
  selectedId,
  onSelect,
  refreshing,
  onRefresh,
  displayPeriodDays,
  savingDisplayPeriod,
  onDisplayPeriodChange,
}: {
  accounts: SocialAnalyticsAccount[];
  history: SocialAnalyticsHistoryPoint[];
  content: SocialContentInsight[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  refreshing: boolean;
  onRefresh: () => void;
  displayPeriodDays: SocialInsightsDisplayPeriodDays;
  savingDisplayPeriod: boolean;
  onDisplayPeriodChange: (days: SocialInsightsDisplayPeriodDays) => void;
}) {
  const selected = selectedSocialAnalyticsAccount(accounts, selectedId, content);
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

  return (
    <div className="space-y-5">
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
          <button type="button" onClick={onRefresh} disabled={refreshing} className={micro.btnSoft}>
            <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {accounts.map((account) => (
            <AccountSelector
              key={account.connectionId}
              account={account}
              active={account.connectionId === selected.connectionId}
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

      <AccountOverview account={selected} />

      {selected.refreshing && <HistoricalImporting account={selected} />}
      {(!selected.refreshing || selectedContent.length > 0) && (
        <ActivityHeatmap account={selected} content={selectedContent} />
      )}
      {(!selected.refreshing || selectedHistory.length > 0) && (
        <GrowthPanel account={selected} history={history} content={selectedContent} />
      )}
      <MilestonesPanel account={selected} content={selectedContent} />
      {(!selected.refreshing || selectedContent.length > 0) && (
        <>
          <ContentPerformancePanel content={selectedContent} provider={selected.provider} />
          <BestContentPanel content={selectedContent} provider={selected.provider} />
        </>
      )}
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
      <p className="mt-5 text-2xl font-semibold tabular-nums">{compactMetric(account.followers)}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">followers</p>
      {account.refreshing && (
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
      label: ["instagram", "threads", "youtube", "tiktok"].includes(account.provider)
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
          <p className={micro.eyebrowMuted}>Account overview</p>
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
      {account.note && (
        <p className="mt-4 text-xs leading-5 text-muted-foreground">{account.note}</p>
      )}
    </MicroAppPanel>
  );
}

function GrowthPanel({
  account,
  history,
  content,
}: {
  account: SocialAnalyticsAccount;
  history: SocialAnalyticsHistoryPoint[];
  content: SocialContentInsight[];
}) {
  const availableMetrics = useMemo(
    () => socialGrowthMetricsFor(account.provider),
    [account.provider],
  );
  const [metric, setMetric] = useState<SocialGrowthMetric>(availableMetrics[0]);
  const [range, setRange] = useState<7 | 30 | 90 | 366>(30);
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

      <div className="mt-4 flex flex-wrap justify-end gap-1.5">
        {([7, 30, 90, 366] as const).map((days) => (
          <button
            key={days}
            type="button"
            onClick={() => setRange(days)}
            className={`rounded-lg border px-3 py-2 text-xs font-semibold ${
              days === range
                ? "border-primary/35 bg-primary/10 text-primary"
                : "border-border bg-white text-muted-foreground"
            }`}
          >
            {days === 366 ? "1y" : `${days}d`}
          </button>
        ))}
      </div>

      {points.length >= 2 && points.some((point) => point.value > 0) ? (
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

function ActivityHeatmap({
  account,
  content,
}: {
  account: SocialAnalyticsAccount;
  content: SocialContentInsight[];
}) {
  const days = dailySocialPerformance(content, 366, new Date());
  const total = days.reduce((sum, day) => sum + day.posts, 0);
  const max = Math.max(...days.map((day) => day.posts), 1);
  const leading = new Date(days[0].date).getDay();
  const cells: Array<(typeof days)[number] | null> = [
    ...Array.from({ length: leading }, () => null),
    ...days,
  ];
  return (
    <MicroAppPanel>
      <p className={micro.eyebrowMuted}>Activity</p>
      <div className="mt-2 flex items-end gap-2">
        <h2 className="font-ui-display text-4xl">{compactMetric(total)} posts</h2>
        <span className="pb-1 text-sm text-muted-foreground">past year</span>
      </div>
      {total > 0 ? (
        <div className="mt-6 overflow-x-auto pb-2">
          <div className="grid min-w-[780px] grid-flow-col grid-rows-7 gap-1.5">
            {cells.map((day, index) => {
              if (!day) return <span key={`empty-${index}`} className="size-3.5" />;
              const level = day.posts ? Math.max(1, Math.ceil((day.posts / max) * 4)) : 0;
              return (
                <span
                  key={day.date}
                  title={`${shortDate(day.date)} · ${day.posts.toLocaleString()} posts`}
                  aria-label={`${shortDate(day.date)}, ${day.posts} posts`}
                  className={`size-3.5 rounded-[4px] ${
                    level === 4
                      ? "bg-[#3478f6]"
                      : level === 3
                        ? "bg-[#6da0fa]"
                        : level === 2
                          ? "bg-[#a8c7fc]"
                          : level === 1
                            ? "bg-[#d7e6fe]"
                            : "bg-[#f3f5f9]"
                  }`}
                />
              );
            })}
          </div>
          <div className="mt-3 flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
            Less <span className="size-3 rounded-[3px] bg-[#f3f5f9]" />
            <span className="size-3 rounded-[3px] bg-[#d7e6fe]" />
            <span className="size-3 rounded-[3px] bg-[#a8c7fc]" />
            <span className="size-3 rounded-[3px] bg-[#6da0fa]" />
            <span className="size-3 rounded-[3px] bg-[#3478f6]" /> More
          </div>
        </div>
      ) : (
        <ProviderDataEmpty provider={account.provider} />
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

function BestContentPanel({
  content,
  provider,
}: {
  content: SocialContentInsight[];
  provider: SocialProvider;
}) {
  const exposureMetric: BestContentMetric = socialContentExposureMetric(content);
  const [chosenMetric, setChosenMetric] = useState<BestContentMetric>(exposureMetric);
  const options = useMemo(
    () =>
      (
        [
          exposureMetric,
          "engagements",
          "likes",
          "comments",
          "shares",
          "saves",
        ] as BestContentMetric[]
      ).filter(
        (option, index, all) =>
          all.indexOf(option) === index && content.some((item) => item[option] !== null),
      ),
    [content, exposureMetric],
  );
  const metric = options.includes(chosenMetric) ? chosenMetric : options[0] || exposureMetric;
  const best = bestSocialContent(content, 9, metric);
  return (
    <section>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="font-ui-display text-2xl">Repost your best performing content</h2>
        {options.length > 1 && (
          <div className="flex flex-wrap gap-1.5" aria-label="Rank content by">
            {options.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setChosenMetric(option)}
                className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold capitalize ${
                  metric === option
                    ? "border-primary/35 bg-primary/10 text-primary"
                    : "border-border bg-white text-muted-foreground"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        )}
      </div>
      {best.length ? (
        <div className="mt-4 columns-1 gap-4 sm:columns-2 lg:columns-3">
          {best.map((item) => {
            const thumbnail = safeMediaUrl(item.thumbnailUrl);
            return (
              <article
                key={item.remotePostId}
                className="mb-4 break-inside-avoid overflow-hidden rounded-xl border border-border bg-white p-4 shadow-sm"
              >
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground capitalize">
                    {item.contentType}
                  </span>
                  <span>·</span>
                  <span>{shortDate(item.publishedAt)}</span>
                </div>
                {item.caption && (
                  <p className="mt-3 line-clamp-5 whitespace-pre-line text-sm leading-6">
                    {item.caption}
                  </p>
                )}
                {thumbnail && (
                  <DecodedImage
                    src={thumbnail}
                    alt=""
                    loading="lazy"
                    className="mt-4 max-h-80 w-full rounded-lg object-cover"
                  />
                )}
                <div className="mt-4 flex items-center gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Heart className="size-3.5" /> {compactMetric(item.likes)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Eye className="size-3.5" /> {compactMetric(item[exposureMetric])}
                  </span>
                  {item.remotePostUrl && (
                    <a
                      href={item.remotePostUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto inline-flex items-center gap-1 rounded-lg bg-primary/10 px-2.5 py-1.5 font-semibold text-primary"
                    >
                      Repost <ExternalLink className="size-3" />
                    </a>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <MicroAppPanel className="mt-4">
          <ProviderDataEmpty provider={provider} />
        </MicroAppPanel>
      )}
    </section>
  );
}

function ProviderDataEmpty({ provider }: { provider: SocialProvider }) {
  return (
    <div className="mt-5 rounded-xl border border-dashed border-border bg-[#fafbfe] p-6 text-center">
      <BarChart3 className="mx-auto size-6 text-muted-foreground" />
      <p className="mt-3 text-sm font-semibold">Historical content is not available yet</p>
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
