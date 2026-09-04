import { ArrowUpRight, CalendarDays, ShoppingBag } from "lucide-react";
import {
  COMMERCE_PRODUCT_KINDS,
  commerceKind,
  pricingLabel,
  type CommerceProductKind,
} from "@/lib/commerce";
import { safeMediaUrl, safeNavigationHref } from "@/lib/safe-url";

type CommerceTileContent = Record<string, unknown>;

function tileLayout(w: number, h: number) {
  if (w <= 1 && h <= 1) return "icon";
  if (h <= 1) return "strip";
  if (w <= 2 && h <= 2) return "square";
  if (w >= 4 && h <= 2) return "wide";
  if (w <= 2 && h >= 4) return "tall";
  return "large";
}

export function CommerceTile({
  content,
  w,
  h,
  shellClass,
}: {
  content: CommerceTileContent;
  w: number;
  h: number;
  shellClass: string;
}) {
  const kind = COMMERCE_PRODUCT_KINDS.includes(content.kind as CommerceProductKind)
    ? (content.kind as CommerceProductKind)
    : "custom_product";
  const definition = commerceKind(kind);
  const ProductIcon = kind === "coaching_call" ? CalendarDays : ShoppingBag;
  const published = content.status === "published";
  const href =
    safeNavigationHref(
      published
        ? String(content.href || `/p/${content.slug || ""}`)
        : `/store?edit=${content.productId || ""}`,
      { allowRelative: true },
    ) || "/store";
  const coverUrl = safeMediaUrl(content.coverUrl);
  const title = String(content.title || definition.label);
  const subtitle = typeof content.subtitle === "string" ? content.subtitle : "";
  const pricingType = ["free", "one_time", "subscription"].includes(String(content.pricingType))
    ? (content.pricingType as "free" | "one_time" | "subscription")
    : "free";
  const price = pricingLabel(
    pricingType,
    Number(content.priceAmount ?? 0),
    typeof content.currency === "string" ? content.currency : "usd",
    typeof content.billingInterval === "string" ? content.billingInterval : null,
  );
  const cta = published ? String(content.ctaLabel || definition.defaultCta) : "Finish setup";
  const draftLabel = "Draft · hidden from visitors";
  const layout = tileLayout(w, h);
  const style = {
    background: coverUrl
      ? `linear-gradient(180deg,rgba(10,18,35,.08),rgba(10,18,35,.82)),url("${coverUrl.replaceAll('"', "%22")}") center/cover`
      : `linear-gradient(145deg, color-mix(in srgb, ${definition.accent} 18%, var(--card)), var(--card) 72%)`,
    color: coverUrl ? "white" : "var(--card-foreground)",
  } as const;
  const accentStyle = coverUrl
    ? { background: "rgba(255,255,255,.92)", color: "#17213a" }
    : { background: definition.accent, color: "white" };

  if (layout === "icon") {
    return (
      <a
        href={href}
        aria-label={`${title} · ${price}`}
        data-testid="commerce-tile"
        data-layout={layout}
        className={`${shellClass} group relative flex items-center justify-center`}
        style={style}
      >
        <span
          className="flex size-10 items-center justify-center rounded-[15px] shadow-sm transition group-hover:scale-105"
          style={accentStyle}
        >
          <ProductIcon className="size-[18px]" />
        </span>
        {!published && (
          <span
            className="absolute right-2 top-2 size-2 rounded-full bg-amber-500 ring-2 ring-white/80"
            title={draftLabel}
            aria-label={draftLabel}
          />
        )}
      </a>
    );
  }

  if (layout === "strip") {
    return (
      <a
        href={href}
        data-testid="commerce-tile"
        data-layout={layout}
        className={`${shellClass} group flex items-center gap-3 px-3`}
        style={style}
      >
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-[13px] shadow-sm"
          style={accentStyle}
        >
          <ProductIcon className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate font-display text-[15px] leading-none">
          {title}
        </span>
        {!published && (
          <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-1 text-[9px] font-semibold text-amber-700">
            Draft
          </span>
        )}
        <span className="shrink-0 text-xs font-semibold">{price}</span>
        <ArrowUpRight className="size-3.5 shrink-0 opacity-50 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
      </a>
    );
  }

  if (layout === "square") {
    return (
      <a
        href={href}
        data-testid="commerce-tile"
        data-layout={layout}
        className={`${shellClass} group flex flex-col p-4`}
        style={style}
      >
        <div className="flex items-start justify-between gap-2">
          <span
            className="flex size-10 items-center justify-center rounded-[15px] shadow-sm"
            style={accentStyle}
          >
            <ProductIcon className="size-[18px]" />
          </span>
          {published ? (
            <ArrowUpRight className="size-4 opacity-45 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
          ) : (
            <span className="rounded-full bg-amber-500/15 px-2 py-1 text-[9px] font-semibold text-amber-700">
              Draft · hidden
            </span>
          )}
        </div>
        <div className="mt-auto min-w-0">
          <div className="line-clamp-2 font-display text-lg leading-[1.02]">{title}</div>
          <div className="mt-2 text-xs font-semibold">{price}</div>
        </div>
      </a>
    );
  }

  if (layout === "wide") {
    return (
      <a
        href={href}
        data-testid="commerce-tile"
        data-layout={layout}
        className={`${shellClass} group grid grid-cols-[1fr_auto] items-stretch gap-4 p-4`}
        style={style}
      >
        <div className="flex min-w-0 flex-col justify-between">
          <div className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.15em] opacity-60">
            <ProductIcon className="size-3" /> {published ? definition.shortLabel : draftLabel}
          </div>
          <div className="min-w-0">
            <div className="line-clamp-2 font-display text-xl leading-[1.02]">{title}</div>
            <div className="mt-2 text-sm font-semibold">{price}</div>
          </div>
        </div>
        <div className="flex w-24 shrink-0 flex-col items-end justify-between">
          <ArrowUpRight className="size-4 opacity-50 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
          <span
            className="max-w-full truncate rounded-xl px-3 py-2 text-[10px] font-semibold"
            style={accentStyle}
          >
            {cta}
          </span>
        </div>
      </a>
    );
  }

  return (
    <a
      href={href}
      data-testid="commerce-tile"
      data-layout={layout}
      className={`${shellClass} group flex flex-col p-5`}
      style={style}
    >
      <div className="flex items-start justify-between gap-3">
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.13em]"
          style={
            coverUrl
              ? { background: "rgba(255,255,255,.9)", color: "#17213a" }
              : { background: `${definition.accent}1f`, color: definition.accent }
          }
        >
          <ProductIcon className="size-3" /> {published ? definition.shortLabel : draftLabel}
        </span>
        <ArrowUpRight className="size-4 opacity-50 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
      </div>
      <div className={layout === "tall" ? "mt-auto" : "mt-auto max-w-[92%]"}>
        <div
          className={`line-clamp-3 font-display leading-[1.02] ${layout === "large" ? "text-3xl" : "text-2xl"}`}
        >
          {title}
        </div>
        {subtitle && <p className="mt-2 line-clamp-2 text-xs leading-4 opacity-62">{subtitle}</p>}
        <div className="mt-4 flex items-end justify-between gap-2">
          <span className="text-sm font-semibold">{price}</span>
          <span
            className="max-w-[62%] truncate rounded-xl px-3 py-2 text-[10px] font-semibold"
            style={accentStyle}
          >
            {cta}
          </span>
        </div>
      </div>
    </a>
  );
}
