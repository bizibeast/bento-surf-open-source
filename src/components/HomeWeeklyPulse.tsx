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
      className="mt-5 border-b border-white/10 pb-5"
    >
      <div className="grid gap-3 px-5 sm:grid-cols-3 sm:px-6">
        <Metric
          label="Followers gained via Auto DM"
          icon={<UsersRound className="size-4" />}
          value={data ? data.followers.current.toLocaleString("en") : "–"}
          metric={data?.followers}
          loading={loading}
          detail="Instagram follows verified after a follow prompt."
        />
        <Metric
          label="Leads generated"
          icon={<Mail className="size-4" />}
          value={data ? data.leads.current.toLocaleString("en") : "–"}
          metric={data?.leads}
          loading={loading}
          detail="New email leads from Auto DM and capture forms."
        />
        <Metric
          label="Total revenue"
          icon={<Wallet className="size-4" />}
          value={
            data
              ? data.revenue.length
                ? data.revenue.map((item) => (
                    <span key={item.currency} className="block">
                      {item.currency.toUpperCase()}{" "}
                      {formatCommerceMoney(item.current, item.currency)}
                      {data.revenue.length > 1 && (
                        <span className="mt-1 block font-sans text-xs text-white/55">
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
      <p className="mt-3 px-5 text-xs text-white/45 sm:px-6" role="status">
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
  label,
  icon,
  value,
  metric,
  detail,
  loading,
  multiCurrency = false,
}: {
  label: string;
  icon: ReactNode;
  value: ReactNode;
  metric?: WeeklyComparison | null;
  detail: string;
  loading: boolean;
  multiCurrency?: boolean;
}) {
  const change = weeklyChange(metric);
  const Icon =
    change.direction === "up" ? ArrowUpRight : change.direction === "down" ? ArrowDownRight : Minus;
  return (
    <div className="min-w-0 rounded-xl border border-white/10 bg-white/[0.035] p-4">
      <h4 className="flex items-center gap-2 text-xs font-medium text-white/65">
        {icon}
        {label}
      </h4>
      <div className="mt-3 break-words font-ui-display text-2xl tabular-nums text-white">
        {value}
      </div>
      <p
        className={`mt-2 flex items-center gap-1 text-xs ${change.direction === "down" ? "text-rose-300" : change.direction === "up" ? "text-[#8fd7ad]" : "text-white/50"}`}
      >
        <Icon className="size-3 shrink-0" aria-hidden />
        {loading ? "Loading…" : multiCurrency ? "Currencies shown separately" : change.text}
      </p>
      <p className="mt-2 text-[11px] leading-4 text-white/40">{detail}</p>
    </div>
  );
}
