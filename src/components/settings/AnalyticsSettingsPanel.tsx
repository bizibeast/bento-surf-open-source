import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  Clock3,
  Eye,
  Globe2,
  Link2,
  Lock,
  MapPin,
  MonitorSmartphone,
  MousePointerClick,
  Navigation,
  Smartphone,
  Trophy,
  UsersRound,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { IconType } from "react-icons";
import { FaLinkedin } from "react-icons/fa6";
import {
  SiFacebook,
  SiInstagram,
  SiPinterest,
  SiReddit,
  SiThreads,
  SiTiktok,
  SiX,
  SiYoutube,
} from "react-icons/si";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { getMyAnalytics } from "@/lib/analytics.functions";
import { planHasEntitlement, type PlanId } from "@/lib/plans";
import { browserTimeZone } from "@/lib/timezones";
import { UpgradeDialog } from "@/components/UpgradeDialog";
import { micro } from "@/lib/micro-app-ui";

type Range = "today" | "3d" | "7d" | "30d" | "90d" | "all";

const RANGE_LABELS: Record<Range, string> = {
  today: "Today",
  "3d": "3 days",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  all: "All time",
};

const FREE_RANGES: Range[] = ["today", "3d", "7d"];
const ADVANCED_RANGES: Range[] = ["today", "3d", "7d", "30d", "90d", "all"];
const DATA_BLUE = "#3478f6";
const MUTED_BLUE = "#9bbcf4";

export function AnalyticsSettingsPanel({ plan }: { plan: PlanId }) {
  const advanced = planHasEntitlement(plan, "advancedAnalytics");
  const allowedRanges = advanced ? ADVANCED_RANGES : FREE_RANGES;
  const defaultRange: Range = "7d";
  const [range, setRange] = useState<Range>(defaultRange);
  const effectiveRange: Range = allowedRanges.includes(range) ? range : defaultRange;
  const detectedTimeZone = useMemo(browserTimeZone, []);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["analytics", effectiveRange, detectedTimeZone],
    queryFn: () =>
      getMyAnalytics({ data: { range: effectiveRange, browserTimeZone: detectedTimeZone } }),
  });
  return (
    <div className="space-y-4">
      {!advanced && (
        <div
          className={`flex flex-col gap-3 ${micro.bannerInfo} sm:flex-row sm:items-center sm:justify-between`}
        >
          <div>
            <p className="text-sm font-semibold text-[#17213a]">Seven days are included</p>
            <p className={`mt-1 ${micro.mutedXs}`}>
              Creator unlocks your complete Bento analytics history. Older data is retained while
              locked.
            </p>
          </div>
          <UpgradeDialog feature="advancedAnalytics" />
        </div>
      )}
      <div className={`${micro.card} flex flex-wrap items-center justify-between gap-3 p-2`}>
        <div className="px-2 text-sm font-medium text-[#17213a]/55">Choose a time range</div>
        <div className="flex flex-wrap items-center gap-1">
          {(Object.keys(RANGE_LABELS) as Range[]).map((item) => {
            const locked = !allowedRanges.includes(item);
            return (
              <button
                key={item}
                type="button"
                onClick={() => {
                  if (locked) {
                    toast.error(
                      plan === "free"
                        ? "Free includes 7 days of Bento analytics. Upgrade to Creator for full history."
                        : "This analytics range is not included in your plan.",
                    );
                    return;
                  }
                  setRange(item);
                }}
                aria-pressed={effectiveRange === item}
                className={`inline-flex items-center gap-1.5 rounded-2xl px-3 py-2 text-xs font-semibold transition ${
                  effectiveRange === item
                    ? "bg-[#17213a] text-white shadow-sm"
                    : "text-[#17213a]/55 hover:bg-[#f2f5fb] hover:text-[#17213a]"
                } ${locked ? "opacity-45" : ""}`}
              >
                {RANGE_LABELS[item]}
                {locked && <Lock className="size-3" />}
              </button>
            );
          })}
        </div>
      </div>

      {isError ? (
        <div className={`${micro.card} border-rose-200 bg-rose-50/85 p-8 text-center`}>
          <Wrench className="mx-auto size-6 text-rose-800" aria-hidden />
          <p className="mt-2 text-sm font-semibold text-rose-900">Analytics could not load</p>
          <p className="mt-1 text-xs text-rose-700/75">Your tracking data is safe. Try again.</p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="mt-4 rounded-2xl bg-rose-900 px-4 py-2 text-xs font-semibold text-white"
          >
            Try again
          </button>
        </div>
      ) : isLoading || !data ? (
        <div className={`${micro.card} p-12 text-center ${micro.muted}`}>
          Loading your analytics…
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <AnalyticsStat icon={Eye} label="Visits" value={data.totalViews} />
            <AnalyticsStat icon={UsersRound} label="Unique visitors" value={data.uniqueVisitors} />
            <AnalyticsStat icon={MousePointerClick} label="Block clicks" value={data.totalClicks} />
          </div>

          <AnalyticsCard title="Visits by hour" icon={Clock3}>
            <HourlyChart values={data.hourly} />
          </AnalyticsCard>

          {data.daily.length > 1 && (
            <AnalyticsCard title="Activity over time" icon={Activity}>
              <DailyChart values={data.daily} />
            </AnalyticsCard>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <AnalyticsCard title="Device type" icon={MonitorSmartphone}>
              <DeviceSplit data={data.mobileDesktop} />
            </AnalyticsCard>
            <AnalyticsCard title="Browsers" icon={Globe2}>
              <BarList items={data.browsers} empty="No browser data yet." kind="browser" />
            </AnalyticsCard>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <AnalyticsCard title="Top countries" icon={Globe2}>
              <BarList items={data.countries} empty="No country data yet." kind="country" />
            </AnalyticsCard>
            <AnalyticsCard title="Top cities" icon={MapPin}>
              <BarList items={data.cities} empty="No city data yet." kind="city" />
            </AnalyticsCard>
          </div>

          <AnalyticsCard title="Where visitors come from" icon={Navigation}>
            <BarList items={data.sources} empty="No referrer data yet." kind="source" />
          </AnalyticsCard>

          <AnalyticsCard title="Social traffic" icon={BarChart3}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {data.social.map((item) => (
                <div
                  key={item.label}
                  className="rounded-[20px] border border-black/[0.06] bg-[#f2f5fb] p-4"
                >
                  <div className="flex items-center gap-2.5 text-xs font-semibold text-[#17213a]/55">
                    <SocialLogo label={item.label} />
                    <span>{item.label}</span>
                  </div>
                  <div className="mt-2 font-ui-display text-2xl tabular-nums">
                    {item.count.toLocaleString()}
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/[0.06]">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${socialBarWidth(item.count, data.social)}%`,
                        backgroundColor: DATA_BLUE,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </AnalyticsCard>

          <AnalyticsCard title="Top-performing blocks" icon={Trophy}>
            {data.topBlocks.length === 0 ? (
              <p className={micro.muted}>No block clicks yet.</p>
            ) : (
              <ol className="space-y-2">
                {data.topBlocks.map((block, index) => (
                  <li
                    key={block.id}
                    className="flex items-center gap-3 rounded-2xl border border-black/[0.05] bg-[#f2f5fb] px-3 py-2.5"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-[#17213a] text-xs font-bold text-white">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-[#17213a]">
                      {block.label}
                    </span>
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold tabular-nums text-[#17213a]">
                      {block.clicks.toLocaleString()} clicks
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </AnalyticsCard>
        </>
      )}
    </div>
  );
}

function AnalyticsStat({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
}) {
  return (
    <div className={`${micro.stat} relative min-h-[150px] overflow-hidden`}>
      <div className="absolute inset-x-0 top-0 h-0.5 bg-[#3478f6]" aria-hidden />
      <div className={`flex items-center gap-2 ${micro.eyebrowMuted}`}>
        <span className={`${micro.iconWell} size-7 rounded-lg`} aria-hidden>
          <Icon className="size-3.5" />
        </span>
        {label}
      </div>
      <div className="mt-7 font-ui-display text-5xl tabular-nums text-[#17213a]">
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function AnalyticsCard({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <section className={`${micro.card} p-5 sm:p-6`}>
      <h3 className="mb-5 flex items-center gap-2 font-sans text-sm font-semibold text-[#17213a]">
        <Icon className="size-4 text-[#17213a]/45" aria-hidden />
        {title}
      </h3>
      {children}
    </section>
  );
}

function HourlyChart({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <div>
      <div className="flex h-40 items-end gap-1.5">
        {values.map((value, index) => (
          <div key={index} className="group relative flex h-full flex-1 items-end">
            <div
              className="w-full rounded-t-lg bg-[#3478f6] transition group-hover:brightness-95"
              style={{
                height: `${Math.max(value ? 8 : 2, (value / max) * 100)}%`,
                opacity: value ? 1 : 0.2,
              }}
              title={`${index}:00: ${value} visit${value === 1 ? "" : "s"}`}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-[#17213a]/45">
        <span>00h</span>
        <span>06h</span>
        <span>12h</span>
        <span>18h</span>
        <span>23h</span>
      </div>
    </div>
  );
}

function DailyChart({
  values,
}: {
  values: Array<{ date: string; views: number; clicks: number }>;
}) {
  const visible = values.slice(-30);
  const max = Math.max(1, ...visible.flatMap((item) => [item.views, item.clicks]));
  return (
    <div>
      <div className="mb-4 flex items-center gap-4 text-xs text-[#17213a]/55">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-[#3478f6]" /> Visits
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-[#9bbcf4]" /> Clicks
        </span>
      </div>
      <div className="flex h-36 items-end gap-1.5">
        {visible.map((item) => (
          <div key={item.date} className="flex h-full min-w-0 flex-1 items-end gap-px">
            <div
              className="w-1/2 rounded-t bg-[#3478f6]"
              style={{ height: `${Math.max(item.views ? 6 : 2, (item.views / max) * 100)}%` }}
              title={`${item.date}: ${item.views} visits`}
            />
            <div
              className="w-1/2 rounded-t bg-[#9bbcf4]"
              style={{ height: `${Math.max(item.clicks ? 6 : 2, (item.clicks / max) * 100)}%` }}
              title={`${item.date}: ${item.clicks} clicks`}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-[#17213a]/45">
        <span>{shortDate(visible[0]?.date)}</span>
        <span>{shortDate(visible.at(-1)?.date)}</span>
      </div>
    </div>
  );
}

function DeviceSplit({ data }: { data: { mobile: number; desktop: number; tablet: number } }) {
  const total = Math.max(1, data.mobile + data.desktop + data.tablet);
  const rows = [
    { label: "Desktop", icon: MonitorSmartphone, value: data.desktop, color: DATA_BLUE },
    { label: "Mobile", icon: Smartphone, value: data.mobile, color: "#76a2ed" },
    { label: "Tablet", icon: MonitorSmartphone, value: data.tablet, color: MUTED_BLUE },
  ];
  return (
    <div className="space-y-4">
      {rows.map((row) => {
        const percentage = (row.value / total) * 100;
        return (
          <div key={row.label}>
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                <row.icon className="size-4 text-[#17213a]/45" aria-hidden /> {row.label}
              </span>
              <span className="tabular-nums text-[#17213a]/55">
                {row.value.toLocaleString()} · {percentage.toFixed(0)}%
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/[0.06]">
              <div
                className="h-full rounded-full"
                style={{ width: `${percentage}%`, backgroundColor: row.color }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BarList({
  items,
  empty,
  kind,
}: {
  items: Array<{ label: string; count: number }>;
  empty: string;
  kind: "country" | "city" | "source" | "browser";
}) {
  if (items.length === 0) return <p className={micro.muted}>{empty}</p>;
  const visible = items.slice(0, 10);
  const max = Math.max(1, ...visible.map((item) => item.count));
  return (
    <ol className="space-y-3">
      {visible.map((item) => (
        <li key={item.label}>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">
              <BreakdownIcon kind={kind} label={item.label} />
              {item.label}
            </span>
            <span className="shrink-0 font-medium tabular-nums text-[#17213a]/55">
              {item.count.toLocaleString()}
            </span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-black/[0.06]">
            <div
              className="h-full rounded-full"
              style={{
                width: `${(item.count / max) * 100}%`,
                backgroundColor: DATA_BLUE,
              }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

function countryFlag(value: string) {
  const code = value.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) {
    return String.fromCodePoint(...[...code].map((letter) => 127397 + letter.charCodeAt(0)));
  }
  const flags: Record<string, string> = {
    india: "🇮🇳",
    "united states": "🇺🇸",
    "united kingdom": "🇬🇧",
    "united arab emirates": "🇦🇪",
    canada: "🇨🇦",
    australia: "🇦🇺",
    germany: "🇩🇪",
    france: "🇫🇷",
    singapore: "🇸🇬",
    brazil: "🇧🇷",
    japan: "🇯🇵",
    "south korea": "🇰🇷",
    netherlands: "🇳🇱",
    spain: "🇪🇸",
    italy: "🇮🇹",
  };
  return flags[value.trim().toLowerCase()] ?? "•";
}

function BreakdownIcon({
  kind,
  label,
}: {
  kind: "country" | "city" | "source" | "browser";
  label: string;
}) {
  if (kind === "country") {
    return (
      <span className="mr-2" aria-hidden>
        {countryFlag(label)}
      </span>
    );
  }
  const Icon = kind === "city" ? MapPin : kind === "browser" ? Globe2 : Link2;
  return <Icon className="mr-2 inline size-4 text-[#17213a]/45" aria-hidden />;
}

const SOCIAL_LOGOS: Record<string, { icon: IconType; colorClass: string }> = {
  instagram: { icon: SiInstagram, colorClass: "text-[#e1306c]" },
  youtube: { icon: SiYoutube, colorClass: "text-[#ff0000]" },
  linkedin: { icon: FaLinkedin, colorClass: "text-[#0a66c2]" },
  twitter: { icon: SiX, colorClass: "text-[#111111]" },
  tiktok: { icon: SiTiktok, colorClass: "text-[#111111]" },
  reddit: { icon: SiReddit, colorClass: "text-[#ff4500]" },
  facebook: { icon: SiFacebook, colorClass: "text-[#1877f2]" },
  threads: { icon: SiThreads, colorClass: "text-[#111111]" },
  pinterest: { icon: SiPinterest, colorClass: "text-[#bd081c]" },
};

function SocialLogo({ label }: { label: string }) {
  const definition = SOCIAL_LOGOS[label.toLowerCase()];
  if (!definition) {
    return (
      <span
        className="flex size-8 items-center justify-center rounded-xl border border-black/[0.06] bg-white text-sm text-[#17213a]"
        role="img"
        aria-label={`${label} logo`}
      >
        ·
      </span>
    );
  }
  const Icon = definition.icon;
  return (
    <span
      className={`flex size-8 items-center justify-center rounded-xl border border-black/[0.06] bg-white ${definition.colorClass}`}
      role="img"
      aria-label={`${label} logo`}
    >
      <Icon className="size-4" />
    </span>
  );
}

function socialBarWidth(count: number, items: Array<{ count: number }>) {
  const max = Math.max(1, ...items.map((item) => item.count));
  return count ? Math.max(5, (count / max) * 100) : 0;
}

function shortDate(value?: string) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(
        date,
      );
}
