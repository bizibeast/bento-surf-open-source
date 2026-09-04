import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { ArrowLeft, ArrowUpRight, ShoppingBag } from "lucide-react";
import { useMemo } from "react";
import { BentoFullLogo } from "@/components/BentoBrand";
import { DecodedImage } from "@/components/DecodedImage";
import { FontApplier } from "@/components/FontApplier";
import { getPublicCommerceStore } from "@/lib/commerce.functions";
import { commerceKind, pricingLabel, type CommerceProductRecord } from "@/lib/commerce";
import {
  configuredPublicOrigin,
  normalizePublicUsername,
  publicProductPath,
  publicProfilePath,
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
  const { profile, products } = Route.useLoaderData();
  const avatarUrl = safeMediaUrl(profile.avatar_url);
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
  return (
    <div className="min-h-screen bg-[#f7f8fc] text-[#17213a]">
      <FontApplier headline={profile.secondary_font} body={profile.primary_font} />
      <header className="border-b border-black/[0.05] bg-white/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <a
            href={publicProfilePath(profile.username)}
            aria-label="Back to creator page"
            className="inline-flex size-10 items-center justify-center rounded-2xl border border-black/[0.07] bg-white"
          >
            <ArrowLeft className="size-4" />
          </a>
          <a href={publicProfilePath(profile.username)} className="flex min-w-0 items-center gap-3">
            {avatarUrl ? (
              <DecodedImage
                src={avatarUrl}
                alt=""
                width={72}
                height={72}
                className="size-9 rounded-full object-cover"
              />
            ) : (
              <span className="flex size-9 items-center justify-center rounded-full bg-[#17213a] font-display text-white">
                {String(profile.display_name || profile.username)
                  .slice(0, 1)
                  .toUpperCase()}
              </span>
            )}
            <span className="truncate text-sm font-semibold">
              {profile.display_name || profile.username}
            </span>
          </a>
          <a
            href={configuredPublicOrigin(import.meta.env.VITE_PUBLIC_URL)}
            className="ml-auto"
            aria-label="Bento Surf home"
          >
            <BentoFullLogo className="h-6 w-auto" />
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="max-w-2xl">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-[#dceaff] text-[#245fd0]">
            <ShoppingBag className="size-5" />
          </div>
          <h1 className="mt-5 font-display text-5xl leading-none sm:text-6xl">Store</h1>
          {profile.bio && <p className="mt-4 text-sm leading-6 text-[#17213a]/55">{profile.bio}</p>}
        </div>

        {products.length ? (
          <div className="mt-9 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((product: CommerceProductRecord) => {
              const definition = commerceKind(product.kind);
              const coverUrl = safeMediaUrl(product.cover_url);
              return (
                <a
                  key={product.id}
                  href={publicProductPath(profile.username, product.public_slug)}
                  className="group overflow-hidden rounded-[28px] border border-black/[0.06] bg-white shadow-[0_28px_70px_-55px_rgba(23,33,58,.6)] transition hover:-translate-y-1 hover:shadow-[0_32px_75px_-48px_rgba(23,33,58,.7)]"
                >
                  <div
                    className="aspect-[16/10] p-5"
                    style={{
                      background: coverUrl
                        ? `linear-gradient(180deg,rgba(23,33,58,.02),rgba(23,33,58,.45)),url("${coverUrl.replaceAll('"', "%22")}") center/cover`
                        : `linear-gradient(145deg,${definition.accent}24,#f8faff 72%)`,
                    }}
                  >
                    <span
                      className="inline-flex rounded-xl px-2.5 py-1 text-[10px] font-semibold text-white"
                      style={{ background: definition.accent }}
                    >
                      {definition.shortLabel}
                    </span>
                  </div>
                  <div className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="font-display text-2xl leading-tight">{product.title}</h2>
                        {product.subtitle && (
                          <p className="mt-2 line-clamp-2 text-sm leading-5 text-[#17213a]/50">
                            {product.subtitle}
                          </p>
                        )}
                      </div>
                      <ArrowUpRight className="mt-1 size-4 shrink-0 text-[#17213a]/35 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                    </div>
                    <div className="mt-5 text-sm font-semibold">
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
          <div className="mt-9 rounded-[28px] border border-black/[0.06] bg-white p-8 text-sm text-[#17213a]/50">
            This creator has not published any products yet.
          </div>
        )}
      </main>
    </div>
  );
}
