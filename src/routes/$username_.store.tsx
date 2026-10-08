import { PublicCreatorShell } from "@/components/public/PublicCreatorShell";
import { PublicSystemPageCanvas } from "@/components/public/PublicSystemPageCanvas";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { ArrowUpRight, ShoppingBag } from "lucide-react";
import { useMemo } from "react";
import { getPublicCommerceStore } from "@/lib/commerce.functions";
import { commerceKind, pricingLabel, type CommerceProductRecord } from "@/lib/commerce";
import {
  normalizePublicUsername,
  publicProductPath,
  publicProfileUrl,
  publicStorePath,
} from "@/lib/application-urls";
import { creatorIndexingMeta } from "@/lib/open-graph";
import { safeMediaUrl } from "@/lib/safe-url";
import { useWebMcpTools, webMcpResult } from "@/lib/webmcp";

export const Route = createFileRoute("/$username_/store")({
  loader: async ({ params, location }) => {
    const data = await getPublicCommerceStore({
      data: { username: normalizePublicUsername(params.username) },
    });
    if (!data) throw notFound();
    if (data.profile.username !== normalizePublicUsername(params.username)) {
      throw redirect({
        href: `${publicStorePath(data.profile.username)}${location.searchStr}`,
        statusCode: 307,
      });
    }
    return data;
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData
          ? `${loaderData.profile.display_name || loaderData.profile.username}'s Store | bento.surf`
          : "Store not found | bento.surf",
      },
      {
        name: "description",
        content: loaderData?.profile.bio || "Products from a bento.surf creator.",
      },
      ...creatorIndexingMeta(loaderData?.profile ?? {}),
    ],
    links: loaderData
      ? [
          {
            rel: "canonical",
            href: publicProfileUrl(
              loaderData.profile.username,
              "store",
              import.meta.env.VITE_PUBLIC_URL,
            ),
          },
        ]
      : [],
  }),
  component: PublicStorePage,
});

function PublicStorePage() {
  const data = Route.useLoaderData();
  const { profile, products } = data;
  const webMcpTools = useMemo(
    () => [
      {
        name: "bento_get_public_store",
        title: "Get public Bento store",
        description:
          "Returns the public creator identity and up to 100 published products visible in this Store.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: () =>
          webMcpResult("Loaded the public Bento Store.", {
            creator: {
              username: profile.username,
              displayName: profile.display_name,
              bio: profile.bio,
            },
            totalProducts: products.length,
            products: products.slice(0, 100).map((product: CommerceProductRecord) => ({
              id: product.id,
              slug: product.public_slug,
              kind: product.kind,
              title: product.title,
              subtitle: product.subtitle,
              pricingType: product.pricing_type,
              priceAmount: product.price_amount,
              currency: product.currency,
              billingInterval: product.billing_interval,
              url: publicProductPath(profile.username, product.public_slug),
            })),
          }),
      },
    ],
    [products, profile],
  );
  useWebMcpTools(webMcpTools);
  if (!data.isStandalone)
    return (
      <PublicCreatorShell chrome={data.chrome} activePageId={data.page.id}>
        <PublicSystemPageCanvas
          username={profile.username}
          blocks={data.blocks}
          systemItems={data.systemItems}
          systemLayout={data.systemLayout}
        />
      </PublicCreatorShell>
    );
  return (
    <PublicCreatorShell
      chrome={data.chrome}
      activePageId={data.chrome.pages.find((page) => page.system === "store")?.id ?? null}
    >
      <div className="min-w-0 pb-10">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          <ShoppingBag className="size-5" />
        </div>
        <h1 className="mt-5 font-display text-4xl leading-none text-foreground sm:text-5xl">
          Store
        </h1>

        {products.length ? (
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {products.map((product: CommerceProductRecord) => {
              const definition = commerceKind(product.kind);
              const coverUrl = safeMediaUrl(product.cover_url);
              return (
                <a
                  key={product.id}
                  href={publicProductPath(profile.username, product.public_slug)}
                  className="group overflow-hidden rounded-[28px] border border-border/70 bg-card shadow-sm transition hover:-translate-y-1 hover:shadow-md"
                >
                  {coverUrl ? (
                    <div
                      className="aspect-[16/10] bg-cover bg-center"
                      style={{
                        backgroundImage: `url("${coverUrl.replaceAll('"', "%22")}")`,
                      }}
                    />
                  ) : null}
                  <div className="p-5">
                    <span className="inline-flex rounded-xl bg-accent px-2.5 py-1 text-[10px] font-semibold text-accent-foreground">
                      {definition.shortLabel}
                    </span>
                    <div className="mt-4 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="font-display text-2xl leading-tight text-foreground">
                          {product.title}
                        </h2>
                        {product.subtitle && (
                          <p className="mt-2 line-clamp-2 text-sm leading-5 text-muted-foreground">
                            {product.subtitle}
                          </p>
                        )}
                      </div>
                      <ArrowUpRight className="mt-1 size-4 shrink-0 text-muted-foreground transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                    </div>
                    <div className="mt-5 text-sm font-semibold text-foreground">
                      {pricingLabel(
                        product.pricing_type,
                        product.price_amount,
                        product.currency,
                        product.billing_interval,
                      )}
                    </div>
                  </div>
                </a>
              );
            })}
          </div>
        ) : (
          <div className="mt-8 rounded-[28px] border border-border/70 bg-card p-8 text-sm text-muted-foreground">
            This creator has not published any products yet.
          </div>
        )}
      </div>
    </PublicCreatorShell>
  );
}
