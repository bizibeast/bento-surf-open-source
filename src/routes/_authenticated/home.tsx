import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  CalendarClock,
  ExternalLink,
  ReceiptText,
  Send,
  Video,
} from "lucide-react";
import type { ReactNode } from "react";
import { AppHeader } from "@/components/AppHeader";
import { HomeWeeklyPulse } from "@/components/HomeWeeklyPulse";
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
  const { data, isPending } = useQuery({
    queryKey: ["home-dashboard"],
    queryFn: () => getHomeDashboard(),
    staleTime: 30_000,
  });
  const profileUrl = profile?.username
    ? publicProfileUrl(profile.username, null, import.meta.env.VITE_PUBLIC_URL)
    : null;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <AppHeader
        title="Home"
        actions={
          profileUrl ? (
            <a
              href={profileUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-9 items-center gap-2 rounded-[8px] bg-[#245fd0] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#1d4faa] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              View page <ExternalLink className="size-3.5" />
            </a>
          ) : null
        }
      />

      <div className={`${micro.main} py-8 sm:px-8 sm:py-8`}>
        <h2 className="font-ui-display text-3xl text-foreground sm:text-4xl">Your workspace</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Your content, audience, and business at a glance
        </p>

        <section className="mt-8 overflow-hidden rounded-[16px] border border-border bg-card text-card-foreground">
          <div className="flex items-center justify-between px-4 pt-4 sm:px-6 sm:pt-6">
            <h3 className="font-ui-sans text-base font-medium">Your pulse</h3>
            <span className="text-xs text-muted-foreground">Last 7 days</span>
          </div>

          <HomeWeeklyPulse data={data?.weekly ?? null} loading={isPending} />
          {Boolean(data?.reels?.length) && (
            <div className="border-b border-border px-4 py-4 sm:px-6" aria-label="Reel activity">
              <h4 className="mb-2 text-sm font-semibold">Benny’s production queue</h4>
              {data!.reels!.map((reel) => (
                <Link
                  key={reel.id}
                  to="/content"
                  search={{ tab: "agent", project: reel.entryId }}
                  className="flex items-center justify-between gap-3 rounded-lg py-2 text-sm hover:bg-muted"
                >
                  <span className="min-w-0 truncate">{reel.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {reel.status === "awaiting_approval"
                      ? "Approve estimate"
                      : reel.status === "ready"
                        ? "Review video"
                        : ["failed", "needs_revision"].includes(reel.status)
                          ? "Needs attention"
                          : "In production"}
                  </span>
                </Link>
              ))}
            </div>
          )}

          <div className="mt-4 grid grid-cols-2 gap-y-4 pb-6 sm:grid-cols-4">
            <PulseMetric
              label="Sales"
              value={formatMetric(data?.pulse.sales.current ?? 0)}
              trend={trendLabel(data?.pulse.sales)}
            />
            <PulseMetric
              label="Views and impressions"
              value={formatMetric(data?.pulse.impressions.current ?? 0)}
              trend={trendLabel(data?.pulse.impressions)}
            />
            <PulseMetric
              label="Published"
              value={formatMetric(data?.pulse.posts.current ?? 0)}
              trend={trendLabel(data?.pulse.posts)}
            />
            <PulseMetric
              label="Upcoming calls"
              value={formatMetric(data?.pulse.upcomingCalls ?? 0)}
              trend={(data?.pulse.upcomingCalls ?? 0) > 0 ? "Scheduled" : "None scheduled"}
            />
          </div>

          {data?.suggestion && (
            <Link
              to={data.suggestion.to}
              className="group flex items-center gap-4 border-t border-border bg-muted/40 px-4 py-4 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-6"
            >
              <span className="hidden text-xs text-muted-foreground sm:block">Next step</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">
                  {data.suggestion.title}
                </span>
                <span className="mt-1 line-clamp-2 break-words text-xs leading-5 text-muted-foreground">
                  {data.suggestion.detail}
                </span>
              </span>
              <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          )}
        </section>

        {!!data?.attention.length && (
          <section className="mt-4 flex flex-col gap-2 rounded-[16px] border border-border bg-tint-amber p-3 sm:flex-row sm:items-center">
            <div className="flex shrink-0 items-center gap-2 px-1 text-xs font-semibold text-tint-amber-fg">
              <AlertCircle className="size-4" /> Needs attention
            </div>
            <div className="flex min-w-0 flex-1 flex-wrap gap-2">
              {data.attention.map((item) => (
                <Link
                  key={item.id}
                  to={item.to}
                  className="group flex min-w-0 flex-1 items-center gap-2 rounded-[12px] bg-background/60 px-3 py-2 text-xs text-tint-amber-fg transition-colors hover:bg-background"
                >
                  <strong className="shrink-0">{item.title}</strong>
                  <span className="truncate text-tint-amber-fg">{item.detail}</span>
                  <ArrowRight className="ml-auto size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />
                </Link>
              ))}
            </div>
          </section>
        )}

        <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[1.2fr_1fr]">
          <DashboardCard
            title="Recent performance"
            icon={<BarChart3 className="size-4" />}
            to="/social-insights"
          >
            {data?.insights.length ? (
              data.insights.map((insight) => (
                <ActivityRow
                  key={insight.id}
                  title={insight.caption || `${capitalize(insight.provider)} post`}
                  detail={`${capitalize(insight.provider)} · ${capitalize(insight.contentType)} · ${formatRelativeDate(insight.publishedAt)}`}
                  value={
                    <div className="text-right tabular-nums">
                      <p className="text-sm font-medium text-foreground">
                        {formatMetric(insight.impressions)} {insight.exposureLabel}
                      </p>
                      <p className="text-xs leading-5 text-muted-foreground">
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
                        className="inline-flex items-center gap-1 rounded-[8px] border border-border bg-muted/50 px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted"
                      >
                        <Video className="size-3.5" /> Join
                      </a>
                    ) : (
                      <span className="text-xs leading-5 text-muted-foreground">Scheduled</span>
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
          >
            {data?.sales.length ? (
              data.sales.map((sale) => (
                <ActivityRow
                  key={sale.id}
                  title={sale.productTitle || "Product sale"}
                  detail={`${sale.buyerName || sale.buyerEmail} · ${formatRelativeDate(sale.occurredAt)}`}
                  value={
                    <div className="text-right tabular-nums">
                      <p className="text-sm font-medium text-foreground">
                        {formatCommerceMoney(
                          Math.max(0, sale.grossAmount - sale.refundedAmount),
                          sale.currency,
                        )}
                      </p>
                      <p className="text-xs leading-5 text-muted-foreground">
                        {sale.status.replaceAll("_", " ")}
                      </p>
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

function PulseMetric({ label, value, trend }: { label: string; value: string; trend: string }) {
  return (
    <div className="border-border px-4 py-2 even:border-l sm:border-l sm:first:border-l-0 sm:px-6">
      <div className="min-h-10 text-sm text-muted-foreground sm:min-h-5">{label}</div>
      <p className="mt-3 font-sans text-3xl font-medium tabular-nums text-foreground">{value}</p>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{trend}</p>
    </div>
  );
}

function DashboardCard({
  title,
  icon,
  to,
  search,
  children,
}: {
  title: string;
  icon: ReactNode;
  to: "/social-insights" | "/post-scheduler" | "/calendar" | "/store";
  search?: { tab: "orders" };
  children: ReactNode;
}) {
  const iconTone = {
    "/social-insights": "bg-tint-sky text-tint-sky-fg",
    "/post-scheduler": "bg-tint-rose text-tint-rose-fg",
    "/calendar": "bg-tint-amber text-tint-amber-fg",
    "/store": "bg-tint-mint text-tint-mint-fg",
  }[to];
  return (
    <section className="min-w-0 rounded-[16px] border border-border bg-card p-4 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={`flex size-8 shrink-0 items-center justify-center rounded-[8px] [&_svg]:stroke-[1.5] ${iconTone}`}
            aria-hidden="true"
          >
            {icon}
          </span>
          <h3 className="font-ui-sans text-sm font-medium text-foreground">{title}</h3>
        </div>
        <Link
          to={to}
          search={search}
          className="inline-flex shrink-0 items-center gap-2 rounded-[8px] px-2 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="sr-only">{title}: </span>View all <ArrowRight className="size-3.5" />
        </Link>
      </div>
      <div className="mt-4 divide-y divide-border">{children}</div>
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
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
        <p className={"truncate text-xs leading-5 text-muted-foreground"}>{detail}</p>
      </div>
      <div className="shrink-0">{value}</div>
    </div>
  );
}

function StatusLabel({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md border border-border bg-muted/50 px-2 py-1 text-xs font-medium capitalize text-muted-foreground">
      {children}
    </span>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <p className="flex min-h-20 items-center justify-center px-4 py-8 text-center text-sm leading-6 text-muted-foreground">
      {text.replace(/\.$/, "")}
    </p>
  );
}

function trendLabel(metric?: { current: number; previous: number }) {
  if (!metric || (!metric.current && !metric.previous)) return "No change vs last week";
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
