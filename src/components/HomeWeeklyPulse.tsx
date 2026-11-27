import { ArrowDownRight, ArrowUpRight, Mail, Minus, UsersRound, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { formatCommerceMoney } from "@/lib/commerce";
import {
  weeklyChange,
  type HomeWeeklyPulse as WeeklyPulse,
  type WeeklyComparison,
} from "@/lib/home-weekly-pulse";

export function HomeWeeklyPulse({
  data,
  loading = false,
}: {
  data: WeeklyPulse | null;
  loading?: boolean;
}) {
  const date = (value: string) =>
    new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(
      new Date(value),
    );
  return (
    <section
      aria-label="Weekly growth"
      aria-busy={loading}
      className="mt-6 border-b border-border pb-6"
    >
      <div className="grid gap-4 px-4 sm:grid-cols-3 sm:px-6">
        <Metric
          label="Followers gained via Auto DM"
          tone="sky"
          icon={<UsersRound className="size-4" />}
          value={data ? data.followers.current.toLocaleString("en") : "–"}
          metric={data?.followers}
          loading={loading}
          detail="Instagram follows verified after a follow prompt."
        />
        <Metric
          label="Leads generated"
          tone="amber"
          icon={<Mail className="size-4" />}
          value={data ? data.leads.current.toLocaleString("en") : "–"}
          metric={data?.leads}
          loading={loading}
          detail="New email leads from Auto DM and capture forms."
        />
        <Metric
          label="Total revenue"
          tone="mint"
          icon={<Wallet className="size-4" />}
          value={
            data
              ? data.revenue.length
                ? data.revenue.map((item) => (
                    <span key={item.currency} className="block">
                      {item.currency.toUpperCase()}{" "}
                      {formatCommerceMoney(item.current, item.currency)}
                      {data.revenue.length > 1 && (
                        <span className="mt-1 block font-sans text-xs text-muted-foreground">
                          {weeklyChange(item).text}
                        </span>
                      )}
                    </span>
                  ))
                : "0"
              : "–"
          }
          metric={
            data?.revenue.length === 1
              ? data.revenue[0]
              : data && !data.revenue.length
                ? { current: 0, previous: 0 }
                : null
          }
          loading={loading}
          detail="Paid orders less recorded refunds, by currency."
          multiCurrency={Boolean(data && data.revenue.length > 1)}
        />
      </div>
      <p className="mt-4 px-4 text-xs text-muted-foreground sm:px-6" role="status">
        {loading
          ? "Loading your weekly totals…"
          : data
            ? `${date(data.startedAt)} – ${date(data.endedAt)} (UTC). Compared with the previous seven days.`
            : "Weekly totals are temporarily unavailable. Your activity is still available below."}
      </p>
    </section>
  );
}

function Metric({
  tone,
  label,
  icon,
  value,
  metric,
  detail,
  loading,
  multiCurrency = false,
}: {
  tone: "sky" | "amber" | "mint";
  label: string;
  icon: ReactNode;
  value: ReactNode;
  metric?: WeeklyComparison | null;
  detail: string;
  loading: boolean;
  multiCurrency?: boolean;
}) {
  const colors = {
    sky: "border-tint-sky-fg/15 bg-tint-sky/70",
    amber: "border-tint-amber-fg/15 bg-tint-amber/70",
    mint: "border-tint-mint-fg/15 bg-tint-mint/70",
  }[tone];
  const ink = {
    sky: "text-tint-sky-fg",
    amber: "text-tint-amber-fg",
    mint: "text-tint-mint-fg",
  }[tone];
  const change = weeklyChange(metric);
  const Icon =
    change.direction === "up" ? ArrowUpRight : change.direction === "down" ? ArrowDownRight : Minus;
  return (
    <div className={`min-w-0 rounded-[12px] border p-4 ${colors}`}>
      <h4 className={`flex min-h-8 items-center gap-2 text-xs font-medium ${ink}`}>
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-card/70 [&_svg]:stroke-[1.5]"
          aria-hidden="true"
        >
          {icon}
        </span>
        {label}
      </h4>
      <div className="mt-3 break-words font-ui-sans text-3xl font-medium tabular-nums text-foreground">
        {value}
      </div>
      <p
        className={`mt-2 flex items-center gap-1 text-xs ${change.direction === "down" ? "text-tint-rose-fg" : change.direction === "up" ? "text-tint-mint-fg" : "text-muted-foreground"}`}
      >
        <Icon className="size-3 shrink-0" aria-hidden />
        {loading ? "Loading…" : multiCurrency ? "Currencies shown separately" : change.text}
      </p>
      <p className="mt-2 text-xs leading-5 text-foreground/70">{detail}</p>
    </div>
  );
}
