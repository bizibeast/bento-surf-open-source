import { useState, type CSSProperties } from "react";
import { BlockRenderer } from "@/components/blocks/BlockRenderer";
import { SizePresetIcon } from "@/components/blocks/SizePresetIcon";
import { commerceKind, type CommercePricingType, type CommerceProductKind } from "@/lib/commerce";
import { ACCENT_PALETTE } from "@/lib/patterns/registry";

type ProductPreviewInput = {
  id?: string;
  slug?: string;
  kind: CommerceProductKind;
  title: string;
  subtitle: string;
  cover_url: string | null;
  pricing_type: CommercePricingType;
  price_amount: number;
  currency: string;
  billing_interval: "day" | "week" | "month" | "year" | null;
  cta_label: string;
};

type ProductPreviewProfile = {
  theme?: string | null;
  accent_color?: string | null;
};

const PREVIEW_SIZES = [
  { id: "icon", label: "Icon", dimensions: "1×1", w: 1, h: 1, width: 78, height: 78 },
  { id: "strip", label: "Strip", dimensions: "4×1", w: 4, h: 1, width: 250, height: 78 },
  { id: "square", label: "Square", dimensions: "2×2", w: 2, h: 2, width: 164, height: 164 },
  { id: "wide", label: "Wide", dimensions: "4×2", w: 4, h: 2, width: 250, height: 140 },
  { id: "tall", label: "Tall", dimensions: "2×4", w: 2, h: 4, width: 140, height: 250 },
  { id: "large", label: "Large", dimensions: "4×4", w: 4, h: 4, width: 250, height: 250 },
] as const;

function previewTheme(profile?: ProductPreviewProfile): {
  mode: "light" | "dark";
  style: CSSProperties;
} {
  const mode = profile?.theme === "dark" ? "dark" : "light";
  const accentId = profile?.accent_color || "indigo";
  const accentHex =
    ACCENT_PALETTE.find((accent) => accent.id === accentId)?.hex ??
    (/^#[0-9a-f]{6}$/i.test(accentId) ? accentId : "#6366f1");
  const style =
    mode === "dark"
      ? {
          "--background": `color-mix(in oklab, ${accentHex} 14%, #0b0b14)`,
          "--foreground": `color-mix(in oklab, ${accentHex} 35%, #ffffff)`,
          "--card": `color-mix(in oklab, ${accentHex} 10%, #11111b)`,
          "--muted": `color-mix(in oklab, ${accentHex} 18%, #1a1a22)`,
          "--muted-foreground": `color-mix(in oklab, ${accentHex} 40%, #ffffff)`,
          "--accent": `color-mix(in oklab, ${accentHex} 28%, #1f1f29)`,
          "--accent-foreground": `color-mix(in oklab, ${accentHex} 60%, #ffffff)`,
          "--primary": accentHex,
          "--primary-foreground": "#ffffff",
          "--ring": accentHex,
          "--border": `color-mix(in oklab, ${accentHex} 22%, #1f1f29)`,
        }
      : {
          "--background": `color-mix(in oklab, ${accentHex} 8%, #ffffff)`,
          "--foreground": `color-mix(in oklab, ${accentHex} 75%, #000000)`,
          "--card": `color-mix(in oklab, ${accentHex} 4%, #ffffff)`,
          "--muted": `color-mix(in oklab, ${accentHex} 14%, #ffffff)`,
          "--muted-foreground": `color-mix(in oklab, ${accentHex} 55%, #000000)`,
          "--accent": `color-mix(in oklab, ${accentHex} 18%, #ffffff)`,
          "--accent-foreground": `color-mix(in oklab, ${accentHex} 70%, #000000)`,
          "--primary": accentHex,
          "--primary-foreground": "#ffffff",
          "--ring": accentHex,
          "--border": `color-mix(in oklab, ${accentHex} 20%, #ffffff)`,
        };
  return { mode, style: style as CSSProperties };
}

function productBlockPreviewContent(product: ProductPreviewInput) {
  const definition = commerceKind(product.kind);
  return {
    productId: product.id || "product-preview",
    slug: product.slug || "product-preview",
    kind: product.kind,
    title: product.title || definition.label,
    subtitle: product.subtitle,
    coverUrl: product.cover_url,
    pricingType: product.pricing_type,
    priceAmount: product.price_amount,
    currency: product.currency,
    billingInterval: product.billing_interval,
    ctaLabel: product.cta_label || definition.defaultCta,
    status: "published",
    href: "#",
  };
}

export function ProductBlockPreview({
  product,
  profile,
  compact = false,
}: {
  product: ProductPreviewInput;
  profile?: ProductPreviewProfile;
  compact?: boolean;
}) {
  const [sizeId, setSizeId] = useState<(typeof PREVIEW_SIZES)[number]["id"]>("square");
  const size = PREVIEW_SIZES.find((option) => option.id === sizeId) ?? PREVIEW_SIZES[2];
  const theme = previewTheme(profile);

  return (
    <section
      className={`rounded-[24px] border p-3 ${
        compact ? "border-white/10 bg-white/[0.07]" : "border-black/[0.06] bg-[#f8faff]"
      }`}
      data-testid="product-block-preview"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div
            className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${
              compact ? "text-white/38" : "text-[#3478f6]"
            }`}
          >
            Live Bento block
          </div>
          <p className={`mt-1 text-xs ${compact ? "text-white/48" : "text-[#17213a]/48"}`}>
            Updates as you type
          </p>
        </div>
        <span
          className={`rounded-md px-2 py-1 text-[9px] font-semibold ${
            compact ? "bg-white/10 text-white/55" : "bg-[#e8eef9] text-[#17213a]/55"
          }`}
        >
          {size.dimensions}
        </span>
      </div>

      <div
        className={`mt-3 text-[9px] font-semibold uppercase tracking-[0.14em] ${
          compact ? "text-white/38" : "text-[#17213a]/42"
        }`}
      >
        Card size
      </div>
      <div
        data-testid="product-block-layouts"
        className={`mt-1.5 grid w-full grid-cols-6 gap-px rounded-lg p-1 ${
          compact ? "bg-black/18" : "bg-[#edf1f8]"
        }`}
        aria-label="Product block preview size"
      >
        {PREVIEW_SIZES.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setSizeId(option.id)}
            aria-pressed={size.id === option.id}
            aria-label={`Preview ${option.label} ${option.dimensions}`}
            title={`${option.label} · ${option.dimensions}`}
            className={`inline-flex min-w-0 items-center justify-center rounded-md py-1.5 transition ${
              size.id === option.id
                ? compact
                  ? "bg-white text-[#17213a]"
                  : "bg-white text-[#17213a] shadow-sm"
                : compact
                  ? "text-white/45 hover:text-white"
                  : "text-[#17213a]/42 hover:text-[#17213a]"
            }`}
          >
            <SizePresetIcon w={option.w} h={option.h} />
          </button>
        ))}
      </div>

      <div
        data-theme={theme.mode}
        style={{ ...theme.style, background: "var(--background)" }}
        className={`mt-3 flex min-h-[270px] items-center justify-center overflow-hidden rounded-[18px] p-2 ${
          theme.mode === "dark" ? "dark" : ""
        }`}
      >
        <div
          className="pointer-events-none shrink-0"
          style={{ width: size.width, height: size.height }}
          aria-label={`${size.label} product block preview`}
        >
          <BlockRenderer
            block={{
              id: "commerce-product-preview",
              type: "commerce",
              content: productBlockPreviewContent(product),
              cover_url: product.cover_url,
              w: size.w,
              h: size.h,
            }}
          />
        </div>
      </div>
    </section>
  );
}
