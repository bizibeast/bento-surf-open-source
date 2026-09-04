import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  CalendarClock,
  ExternalLink,
  Eye,
  ReceiptText,
  Send,
  ShoppingBag,
  Video,
} from "lucide-react";
import type { ReactNode } from "react";
import { AppHeader } from "@/components/AppHeader";
import { publicProfileUrl } from "@/lib/application-urls";
import { formatCommerceMoney } from "@/lib/commerce";
import { getHomeDashboard } from "@/lib/home-dashboard.functions";
import { micro } from "@/lib/micro-app-ui";
import { getMyProfile } from "@/lib/profile.functions";

export const Route = createFileRoute("/_authenticated/home")({
  head: () => ({ meta: [{ title: "Home | bento.surf" }] }),
  loader: ({ context }) => {
    context.queryClient.prefetchQuery({
      queryKey: ["my-profile"],
      queryFn: () => getMyProfile(),
    });
    context.queryClient.prefetchQuery({
      queryKey: ["home-dashboard"],
      queryFn: () => getHomeDashboard(),
    });
  },
  component: HomePage,
});

function HomePage() {
  const { data: profile } = useQuery({
    queryKey: ["my-profile"],
    queryFn: () => getMyProfile(),
    staleTime: 60_000,
  });
  const { data } = useQuery({
    queryKey: ["home-dashboard"],
    queryFn: () => getHomeDashboard(),
    staleTime: 30_000,
  });
  const name = profile?.display_name?.trim() || profile?.username || "creator";
  const profileUrl = profile?.username
    ? publicProfileUrl(profile.username, null, import.meta.env.VITE_PUBLIC_URL)
    : null;

  return (
    <main className={micro.shell}>
      <AppHeader
        title="Home"
        actions={
          profileUrl ? (
            <a
              href={profileUrl}
              target="_blank"
              rel="noreferrer"
              className={micro.btnPrimaryCompact}
            >
              View page <ExternalLink className="size-3.5" />
            </a>
          ) : null
        }
      />

      <div className={`${micro.main} py-6 sm:py-7`}>
        <h2 className="font-ui-display text-3xl text-foreground sm:text-4xl">
          Welcome back, {name}.
        </h2>

        <section className="mt-5 overflow-hidden rounded-[1.35rem] bg-[#17213a] text-white shadow-[0_30px_70px_-42px_rgba(23,33,58,0.9)]">
          <div className="flex items-center justify-between px-5 pt-5 sm:px-6 sm:pt-6">
            <h3 className="font-ui-display text-xl">Your pulse</h3>
            <span className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-white/40">
              Last 7 days
            </span>
          </div>

          <div className="mt-5 grid grid-cols-2 sm:grid-cols-4">
            <PulseMetric
              icon={<ShoppingBag className="size-4" />}
              label="Sales"
              value={formatMetric(data?.pulse.sales.current ?? 0)}
              trend={trendLabel(data?.pulse.sales)}
            />
            <PulseMetric
              icon={<Eye className="size-4" />}
              label="Exposure"
              value={formatMetric(data?.pulse.impressions.current ?? 0)}
              trend={trendLabel(data?.pulse.impressions)}
            />
            <PulseMetric
              icon={<Send className="size-4" />}
              label="Published"
              value={formatMetric(data?.pulse.posts.current ?? 0)}
              trend={trendLabel(data?.pulse.posts)}
            />
            <PulseMetric
              icon={<CalendarClock className="size-4" />}
              label="Upcoming calls"
              value={formatMetric(data?.pulse.upcomingCalls ?? 0)}
              trend="Ahead"
            />
          </div>

          {data?.suggestion && (
            <Link
              to={data.suggestion.to}
              className="group mt-5 flex items-center gap-4 border-t border-white/10 bg-white/[0.035] px-5 py-4 transition-colors hover:bg-white/[0.07] sm:px-6"
            >
              <span className="text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-white/35">
                Next move
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-white">
                  {data.suggestion.title}
                </span>
                <span className="block truncate text-xs text-white/45">
                  {data.suggestion.detail}
                </span>
              </span>
              <ArrowUpRight className="size-4 text-white/45 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-white" />
            </Link>
          )}
        </section>

        {!!data?.attention.length && (
          <section className="mt-4 flex flex-col gap-2 rounded-2xl border border-[#e6a63d]/20 bg-[#fff3df] p-3 sm:flex-row sm:items-center">
            <div className="flex shrink-0 items-center gap-2 px-1 text-xs font-semibold text-[#8b5b0c]">
              <AlertCircle className="size-4" /> Needs attention
            </div>
            <div className="flex min-w-0 flex-1 flex-wrap gap-2">
              {data.attention.map((item) => (
                <Link
                  key={item.id}
                  to={item.to}
                  className="group flex min-w-0 flex-1 items-center gap-2 rounded-xl bg-white/55 px-3 py-2 text-xs text-[#5f461e] transition-colors hover:bg-white/90"
                >
                  <strong className="shrink-0">{item.title}</strong>
                  <span className="truncate text-[#8b6b35]">{item.detail}</span>
                  <ArrowRight className="ml-auto size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />
                </Link>
              ))}
            </div>
          </section>
        )}

        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
          <DashboardCard
            title="Recent performance"
            icon={<BarChart3 className="size-4" />}
            to="/social-insights"
            tone="bg-[#2581FA]/10 text-[#2581FA]"
          >
            {data?.insights.length ? (
              data.insights.map((insight) => (
                <ActivityRow
                  key={insight.id}
                  title={insight.caption || `${capitalize(insight.provider)} post`}
                  detail={`${capitalize(insight.provider)} · ${capitalize(insight.contentType)} · ${formatRelativeDate(insight.publishedAt)}`}
                  value={
                    <div className="text-right tabular-nums">
                      <p className="text-sm font-semibold text-foreground">
                        {formatMetric(insight.impressions)} {insight.exposureLabel}
                      </p>
                      <p className={micro.mutedXs}>
                        {formatMetric(insight.engagements)} engagements
                      </p>
                    </div>
                  }
                />
              ))
            ) : (
              <EmptyState text="Connect an account to see performance." />
            )}
          </DashboardCard>

          <DashboardCard
            title="Recent posts"
            icon={<Send className="size-4" />}
            to="/post-scheduler"
            tone="bg-[#FC514E]/10 text-[#FC514E]"
          >
            {data?.posts.length ? (
              data.posts.map((post) => (
                <ActivityRow
                  key={post.id}
                  title={post.title || post.body || "Untitled post"}
                  detail={`${post.providers.length ? post.providers.map(capitalize).join(", ") : "No platform"} · ${formatRelativeDate(post.scheduledAt || post.createdAt)}`}
                  value={<StatusLabel>{post.status.replaceAll("_", " ")}</StatusLabel>}
                />
              ))
            ) : (
              <EmptyState text="Your publishing queue is empty." />
            )}
          </DashboardCard>

          <DashboardCard
            title="Upcoming calls"
            icon={<CalendarClock className="size-4" />}
            to="/calendar"
            tone="bg-[#22A06B]/10 text-[#22A06B]"
          >
            {data?.calls.length ? (
              data.calls.map((call) => (
                <ActivityRow
                  key={call.id}
                  title={call.buyerName || call.buyerEmail}
                  detail={formatDateTime(call.startsAt)}
                  value={
                    call.meetingUrl ? (
                      <a
                        href={call.meetingUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-lg border border-black/[0.07] bg-white/55 px-2.5 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-white"
                      >
                        <Video className="size-3.5" /> Join
                      </a>
                    ) : (
                      <span className={micro.mutedXs}>Scheduled</span>
                    )
                  }
                />
              ))
            ) : (
              <EmptyState text="No calls coming up." />
            )}
          </DashboardCard>

          <DashboardCard
            title="Recent sales"
            icon={<ReceiptText className="size-4" />}
            to="/store"
            search={{ tab: "orders" }}
            tone="bg-[#FDC307]/15 text-[#B68A00]"
          >
            {data?.sales.length ? (
              data.sales.map((sale) => (
                <ActivityRow
                  key={sale.id}
                  title={sale.productTitle || "Product sale"}
                  detail={`${sale.buyerName || sale.buyerEmail} · ${formatRelativeDate(sale.occurredAt)}`}
                  value={
                    <div className="text-right tabular-nums">
                      <p className="text-sm font-semibold text-foreground">
                        {formatCommerceMoney(
                          Math.max(0, sale.grossAmount - sale.refundedAmount),
                          sale.currency,
                        )}
                      </p>
                      <p className={micro.mutedXs}>{sale.status.replaceAll("_", " ")}</p>
                    </div>
                  }
                />
              ))
            ) : (
              <EmptyState text="No sales yet." />
            )}
          </DashboardCard>
        </div>
      </div>
    </main>
  );
}

function PulseMetric({
  icon,
  label,
  value,
  trend,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  trend: string;
}) {
  return (
    <div className="border-white/10 px-5 py-2 even:border-l sm:border-l sm:first:border-l-0 sm:px-6">
      <div className="flex items-center gap-2 text-xs text-white/45">
        {icon} {label}
      </div>
      <p className="mt-2 font-ui-display text-3xl tabular-nums text-white">{value}</p>
      <p className="mt-1 text-[0.68rem] font-medium text-[#8fd7ad]">{trend}</p>
    </div>
  );
}

function DashboardCard({
  title,
  icon,
  to,
  search,
  tone,
  children,
}: {
  title: string;
  icon: ReactNode;
  to: "/social-insights" | "/post-scheduler" | "/calendar" | "/store";
  search?: { tab: "orders" };
  tone: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 min-h-[275px] rounded-2xl border border-black/[0.06] bg-white p-4 shadow-[0_14px_35px_-30px_rgba(23,33,58,0.45)] sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className={`flex size-8 items-center justify-center rounded-lg ${tone}`}>
            {icon}
          </span>
          <h3 className="font-ui-display text-lg text-foreground">{title}</h3>
        </div>
        <Link
          to={to}
          search={search}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:bg-white/55 hover:text-foreground"
        >
          View all <ArrowRight className="size-3.5" />
        </Link>
      </div>
      <div className="mt-3 divide-y divide-black/[0.06]">{children}</div>
    </section>
  );
}

function ActivityRow({
  title,
  detail,
  value,
}: {
  title: string;
  detail: string;
  value: ReactNode;
}) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-4 py-3 first:pt-2 last:pb-0">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-foreground">{title}</p>
        <p className={`truncate ${micro.mutedXs}`}>{detail}</p>
      </div>
      <div className="shrink-0">{value}</div>
    </div>
  );
}

function StatusLabel({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md border border-black/[0.07] bg-white/50 px-2 py-1 text-xs font-medium capitalize text-muted-foreground">
      {children}
    </span>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className={`${micro.muted} py-10 text-center`}>{text}</p>;
}

function trendLabel(metric?: { current: number; previous: number }) {
  if (!metric || (!metric.current && !metric.previous)) return "No change";
  if (!metric.previous) return "New this week";
  const change = Math.round(((metric.current - metric.previous) / metric.previous) * 100);
  return `${change >= 0 ? "+" : ""}${change}% vs last week`;
}

function capitalize(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function formatMetric(value: number | null) {
  return value == null
    ? "-"
    : new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
        value,
      );
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatRelativeDate(value: string) {
  const elapsedDays = Math.round((new Date(value).getTime() - Date.now()) / 86_400_000);
  if (Math.abs(elapsedDays) < 7) {
    return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(elapsedDays, "day");
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(value),
  );
}
