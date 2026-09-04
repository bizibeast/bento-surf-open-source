import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { PublicNewsletterDirectoryContent } from "@/components/email-marketing/PublicNewsletterArchive";
import { normalizePublicUsername, publicNewslettersPath } from "@/lib/application-urls";
import { getPublicNewsletterPublications } from "@/lib/newsletter.functions";
import { publicNewsletterDirectoryHead } from "@/lib/open-graph";

export const Route = createFileRoute("/$username_/newsletters/")({
  loader: async ({ params, location }) => {
    const requestedUsername = normalizePublicUsername(params.username);
    const data = await getPublicNewsletterPublications({ data: { username: requestedUsername } });
    if (!data) throw notFound();
    if (data.creator.username !== requestedUsername) {
      throw redirect({
        href: `${publicNewslettersPath(data.creator.username)}${location.searchStr}`,
        statusCode: 307,
      });
    }
    return data;
  },
  head: ({ loaderData }) =>
    loaderData
      ? publicNewsletterDirectoryHead(loaderData, import.meta.env.VITE_PUBLIC_URL)
      : { meta: [{ title: "Newsletters not found | bento.surf" }] },
  component: PublicNewsletters,
});

function PublicNewsletters() {
  return <PublicNewsletterDirectoryContent data={Route.useLoaderData()} />;
}
