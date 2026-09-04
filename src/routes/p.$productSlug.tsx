import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { getPublicCommerceProduct } from "@/lib/commerce.functions";
import { publicProductPath } from "@/lib/application-urls";

export const Route = createFileRoute("/p/$productSlug")({
  loader: async ({ params, location }) => {
    const data = await getPublicCommerceProduct({ data: { slug: params.productSlug } });
    if (!data) throw notFound();
    throw redirect({
      href: `${publicProductPath(
        data.creator.username,
        data.product.public_slug,
      )}${location.searchStr}`,
      statusCode: 308,
    });
  },
});
