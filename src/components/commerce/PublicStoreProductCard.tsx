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
      className="group flex aspect-square min-h-[280px] min-w-0 flex-col justify-between overflow-hidden rounded-[36px] border border-border/70 p-8 text-card-foreground shadow-sm transition hover:-translate-y-1 hover:border-primary/50 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      style={{
        background: `linear-gradient(145deg, color-mix(in srgb, ${definition.accent} 18%, var(--card)), var(--card) 72%)`,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <span
          className="flex size-20 shrink-0 items-center justify-center rounded-[26px] shadow-md"
          style={{ background: definition.accent, color: "white" }}
        >
          <ProductIcon aria-hidden="true" className="size-9" strokeWidth={2} />
        </span>
        <ArrowUpRight
          aria-hidden="true"
          className="size-5 shrink-0 opacity-45 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
        />
      </div>
      <div className="min-w-0">
        <h2 className="line-clamp-2 font-display text-[clamp(1.7rem,2.6vw,2.125rem)] leading-[1.05]">
          {product.title}
        </h2>
        <p className="mt-3 text-2xl font-semibold">{price}</p>
      </div>
    </a>
  );
}
