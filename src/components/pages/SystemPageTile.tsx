import {
  BarChart3,
  CalendarDays,
  Clock3,
  Eye,
  Mail,
  MessageCircle,
  Send,
  ShoppingBag,
  UsersRound,
} from "lucide-react";
import { BookingReviewCard } from "@/components/bookings/BookingReviewCard";
import { DecodedImage } from "@/components/DecodedImage";
import { pricingLabel, type CommercePricingType } from "@/lib/commerce";
import type { SystemPageItem } from "@/lib/page-system-layout";
import { findPlatform } from "@/lib/platforms";
import { safeMediaUrl } from "@/lib/safe-url";
import { publicNewsletterPublicationPath, publicProductPath } from "@/lib/application-urls";

// Link shares these labels/routes with the tile so editor navigation cannot drift.
// eslint-disable-next-line react-refresh/only-export-components
export const systemPageManagement = {
  calendar: { label: "Manage Calendar", href: "/calendar", icon: CalendarDays },
  store: { label: "Manage Store", href: "/store", icon: ShoppingBag },
  insights: { label: "Manage Insights", href: "/social-insights", icon: BarChart3 },
  newsletter: { label: "Manage Newsletters", href: "/email-marketing", icon: Mail },
} as const;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const compact = (value: unknown) =>
  typeof value === "number"
    ? new Intl.NumberFormat(undefined, { notation: "compact" }).format(value)
    : "-";

const METRIC_ICONS = {
  followers: UsersRound,
  views: Eye,
  engagements: MessageCircle,
  posts: Send,
} as const;

const ACCOUNT_METRICS = [
  ["followers", "Followers"],
  ["views", "Views"],
  ["posts", "Posts"],
  ["engagements", "Engagement"],
] as const;

export function SystemPageTile({
  item,
  publicUsername,
}: {
  item: SystemPageItem;
  publicUsername?: string;
}) {
  const { data, kind } = item;
  const isPublic = publicUsername !== undefined;
  const { icon: Icon } = systemPageManagement[item.system];
  const image = safeMediaUrl(data.coverUrl ?? data.cover_url ?? data.logoUrl ?? data.avatarUrl);
  const provider = kind === "account" ? findPlatform(text(data.provider)) : undefined;
  const MetricIcon = METRIC_ICONS[text(data.metric) as keyof typeof METRIC_ICONS];
  const TileIcon = provider?.icon ?? MetricIcon ?? Icon;
  const publicHref = isPublic
    ? kind === "publication"
      ? publicNewsletterPublicationPath(publicUsername, text(data.slug))
      : kind === "session" || kind === "product"
        ? publicProductPath(publicUsername, text(data.public_slug ?? data.slug))
        : null
    : null;
  const publicAction =
    kind === "publication"
      ? "View publication"
      : data.soldOut === true
        ? "View session"
        : text(data.ctaLabel ?? data.cta_label) ||
          (kind === "session" ? "Book session" : "View product");

  return (
    <article
      aria-label={item.title}
      className="flex h-full min-w-0 flex-col gap-2 overflow-hidden rounded-[28px] border border-border/70 bg-card p-3 shadow-sm"
    >
      <div className="min-h-0 flex-1 overflow-hidden">
        {kind === "review" ? (
          <BookingReviewCard
            review={{
              reviewerName: text(data.reviewerName),
              rating: typeof data.rating === "number" ? data.rating : null,
              body: text(data.body),
            }}
          />
        ) : (
          <>
            <div className="flex items-center gap-3">
              {!provider &&
                (image ? (
                  <DecodedImage
                    src={image}
                    alt=""
                    loading="lazy"
                    className={`${isPublic || kind === "account" ? "size-8" : "size-10"} shrink-0 rounded-xl object-cover`}
                  />
                ) : item.system === "insights" ? (
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-accent/80 text-foreground">
                    <TileIcon aria-hidden="true" className="size-4" />
                  </span>
                ) : (
                  <TileIcon aria-hidden="true" className="size-6 shrink-0 text-primary" />
                ))}
              <h2
                className={`${isPublic || kind === "account" ? "line-clamp-1 text-lg" : "line-clamp-2 text-xl"} font-display leading-tight`}
              >
                {item.title}
              </h2>
            </div>
            {kind === "intro" && (
              <p className="mt-3 line-clamp-3 text-sm text-muted-foreground">
                {text(data.description)}
              </p>
            )}
            {(kind === "session" || kind === "product" || kind === "publication") && (
              <p
                className={`${isPublic ? "mt-2 line-clamp-1" : "mt-3 line-clamp-2"} text-sm text-muted-foreground`}
              >
                {text(data.subtitle) || text(data.description)}
              </p>
            )}
            {kind === "session" && (
              <div
                className={`${isPublic ? "mt-2" : "mt-3"} flex flex-wrap items-center gap-2 text-xs`}
              >
                <span className="inline-flex items-center gap-1 rounded-full bg-accent px-2.5 py-1.5">
                  <Clock3 className="size-3.5" />
                  {typeof data.durationMinutes === "number" ? data.durationMinutes : 60} min
                </span>
                <span className="rounded-full bg-accent px-2.5 py-1.5 font-semibold">
                  {text(data.priceLabel)}
                </span>
                {data.soldOut === true && <span>Sold out</span>}
              </div>
            )}
            {kind === "product" && (
              <p className={`${isPublic ? "mt-2" : "mt-3"} text-sm font-semibold`}>
                {pricingLabel(
                  (text(data.pricing_type) || "free") as CommercePricingType,
                  typeof data.price_amount === "number" ? data.price_amount : 0,
                  text(data.currency) || "usd",
                  text(data.billing_interval) || null,
                )}
              </p>
            )}
            {kind === "summary" && (
              <>
                <p className="mt-3 font-display text-3xl tabular-nums">{compact(data.value)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {item.key === "summary:followers"
                    ? "Current followers"
                    : data.displayPeriodDays === 365
                      ? "Last year"
                      : `Last ${typeof data.displayPeriodDays === "number" ? data.displayPeriodDays : 30} days`}
                </p>
              </>
            )}
            {kind === "account" && (
              <>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {provider && (
                    <span
                      aria-label={`${provider.label} logo`}
                      className="flex size-4 shrink-0 items-center justify-center rounded-[5px]"
                      style={{ background: provider.color, color: provider.fg }}
                    >
                      <TileIcon className="size-2.5" />
                    </span>
                  )}
                  <span className="truncate">@{text(data.handle)}</span>
                </div>
                <div className="mt-2 grid grid-cols-4 gap-1">
                  {ACCOUNT_METRICS.map(([metric, label]) => (
                    <div
                      key={metric}
                      className="min-w-0 rounded-lg bg-accent/65 px-1 py-1 text-center"
                    >
                      <p className="text-sm font-semibold tabular-nums">{compact(data[metric])}</p>
                      <p className="truncate text-[10px] text-muted-foreground">{label}</p>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
      {isPublic && publicHref && (
        <a
          href={publicHref}
          aria-label={`${publicAction}: ${item.title}`}
          className="no-drag shrink-0 truncate text-xs font-semibold text-primary hover:underline"
        >
          {publicAction} →
        </a>
      )}
    </article>
  );
}
