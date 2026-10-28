import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { getPublicCommerceProduct } from "@/lib/commerce.functions";
import { publicProductPath } from "@/lib/application-urls";

const LEGACY_DEMO_PRODUCT_PATHS: Record<string, string> = {
  "creator-launch-kit": "/features/digital-products",
  "members-studio": "/features/memberships",
  "audience-to-income": "/features/online-courses",
  "creator-strategy-call": "/features/coaching-and-bookings",
  "creator-community": "/features/paid-communities",
};

export function legacyDemoProductPath(slug: string) {
  return LEGACY_DEMO_PRODUCT_PATHS[slug] ?? null;
}

export const Route = createFileRoute("/p/$productSlug")({
  loader: async ({ params, location }) => {
    const data = await getPublicCommerceProduct({ data: { slug: params.productSlug } });
    if (data) {
      throw redirect({
        href: `${publicProductPath(
          data.creator.username,
          data.product.public_slug,
        )}${location.searchStr}`,
        statusCode: 308,
      });
    }
    const legacyPath = legacyDemoProductPath(params.productSlug);
    if (legacyPath) throw redirect({ href: legacyPath, statusCode: 301 });
    throw notFound();
  },
});
