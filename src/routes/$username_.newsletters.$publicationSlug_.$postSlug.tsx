import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { PublicNewsletterPostView } from "./$username_.newsletter_.$issueSlug";
import { getPublicNewsletterIssue } from "@/lib/newsletter.functions";
import { publicNewsletterIssueHead } from "@/lib/open-graph";
import { normalizePublicUsername, publicNewsletterPostPath } from "@/lib/application-urls";

export const Route = createFileRoute("/$username_/newsletters/$publicationSlug_/$postSlug")({
  loader: async ({ params, location }) => {
    const requestedUsername = normalizePublicUsername(params.username);
    const data = await getPublicNewsletterIssue({
      data: {
        username: requestedUsername,
        publicationSlug: params.publicationSlug,
        issueSlug: params.postSlug,
      },
    });
    if (!data) throw notFound();
    if (data.creator.username !== requestedUsername) {
      throw redirect({
        href: `${publicNewsletterPostPath(
          data.creator.username,
          data.publication.slug,
          data.issue.slug,
        )}${location.searchStr}`,
        statusCode: 307,
      });
    }
    return data;
  },
  head: ({ loaderData }) =>
    loaderData
      ? publicNewsletterIssueHead(loaderData, import.meta.env.VITE_PUBLIC_URL)
      : { meta: [{ title: "Newsletter post not found | bento.surf" }] },
  component: PublicNewsletterPost,
});

function PublicNewsletterPost() {
  return <PublicNewsletterPostView data={Route.useLoaderData()} />;
}
