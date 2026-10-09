import { ArrowUpRight, CalendarDays, ShoppingBag } from "lucide-react";
import { commerceKind, pricingLabel, type CommerceProductRecord } from "@/lib/commerce";
import { publicProductPath } from "@/lib/application-urls";

export function PublicStoreProductCard({
  product,
  username,
}: {
  product: CommerceProductRecord;
  username: string;
}) {
  const definition = commerceKind(product.kind);
  const ProductIcon = product.kind === "coaching_call" ? CalendarDays : ShoppingBag;
  const price = pricingLabel(
    product.pricing_type,
    product.price_amount,
    product.currency,
    product.billing_interval,
  );

  return (
    <a
      href={publicProductPath(username, product.public_slug)}
      aria-label={`${product.title} · ${price}`}
      className="group flex aspect-square min-h-0 min-w-0 flex-col justify-between overflow-hidden rounded-[28px] border border-border/70 p-4 text-card-foreground shadow-sm transition hover:-translate-y-1 hover:border-primary/50 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:min-h-[280px] sm:rounded-[36px] sm:p-8"
      style={{
        background: `linear-gradient(145deg, color-mix(in srgb, ${definition.accent} 18%, var(--card)), var(--card) 72%)`,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-[15px] shadow-md sm:size-20 sm:rounded-[26px]"
          style={{ background: definition.accent, color: "white" }}
        >
          <ProductIcon aria-hidden="true" className="size-[18px] sm:size-9" strokeWidth={2} />
        </span>
        <ArrowUpRight
          aria-hidden="true"
          className="size-4 shrink-0 opacity-45 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5 sm:size-5"
        />
      </div>
      <div className="min-w-0">
        <h2 className="line-clamp-2 font-display text-lg leading-[1.05] sm:text-[clamp(1.7rem,2.6vw,2.125rem)]">
          {product.title}
        </h2>
        <p className="mt-2 text-xs font-semibold sm:mt-3 sm:text-2xl">{price}</p>
      </div>
    </a>
  );
}
