import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { PublicNewsletterArchiveView } from "./$username_.newsletter";
import {
  getPublicNewsletterArchive,
  validateNewsletterSubscriptionConfirmation,
} from "@/lib/newsletter.functions";
import { publicNewsletterArchiveHead } from "@/lib/open-graph";
import { normalizePublicUsername, publicNewsletterPublicationPath } from "@/lib/application-urls";

export const Route = createFileRoute("/$username_/newsletters/$publicationSlug")({
  validateSearch: z.object({ confirm: z.string().max(4_096).optional() }),
  loader: async ({ params, location }) => {
    const requestedUsername = normalizePublicUsername(params.username);
    const data = await getPublicNewsletterArchive({
      data: { username: requestedUsername, publicationSlug: params.publicationSlug },
    });
    if (!data) throw notFound();
    if (data.creator.username !== requestedUsername) {
      throw redirect({
        href: `${publicNewsletterPublicationPath(data.creator.username, data.publication.slug)}${location.searchStr}`,
        statusCode: 307,
      });
    }
    const token = new URLSearchParams(location.searchStr).get("confirm");
    return {
      ...data,
      confirmation: token
        ? {
            token,
            ...(await validateNewsletterSubscriptionConfirmation({ data: { token } })),
          }
        : null,
    };
  },
  head: ({ loaderData }) =>
    loaderData
      ? publicNewsletterArchiveHead(loaderData, import.meta.env.VITE_PUBLIC_URL)
      : { meta: [{ title: "Newsletter not found | bento.surf" }] },
  component: PublicNewsletterPublication,
});

function PublicNewsletterPublication() {
  return <PublicNewsletterArchiveView data={Route.useLoaderData()} />;
}
