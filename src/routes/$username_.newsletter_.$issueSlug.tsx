import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";
import {
  NewsletterDocument,
  NewsletterPaidPost,
} from "@/components/email-marketing/NewsletterDocument";
import { PublicNewsletterTheme } from "@/components/email-marketing/PublicNewsletterArchive";
import { DecodedImage } from "@/components/DecodedImage";
import { getPublicNewsletterIssue } from "@/lib/newsletter.functions";
import { resolveNewsletterTemplate } from "@/lib/newsletter-templates";
import { publicNewsletterIssueHead } from "@/lib/open-graph";
import {
  normalizePublicUsername,
  publicNewsletterIssuePath,
  publicNewsletterPublicationPath,
  publicProductPath,
} from "@/lib/application-urls";
import { safeMediaUrl } from "@/lib/safe-url";

export const Route = createFileRoute("/$username_/newsletter_/$issueSlug")({
  loader: async ({ params, location }) => {
    const requestedUsername = normalizePublicUsername(params.username);
    const data = await getPublicNewsletterIssue({
      data: { username: requestedUsername, issueSlug: params.issueSlug },
    });
    if (!data) throw notFound();
    if (data.creator.username !== requestedUsername) {
      throw redirect({
        href: `${publicNewsletterIssuePath(data.creator.username, data.issue.slug)}${location.searchStr}`,
        statusCode: 307,
      });
    }
    return data;
  },
  head: ({ loaderData }) =>
    loaderData
      ? publicNewsletterIssueHead(loaderData, import.meta.env.VITE_PUBLIC_URL)
      : { meta: [{ title: "Newsletter post not found | bento.surf" }] },
  component: PublicNewsletterIssue,
});

function PublicNewsletterIssue() {
  const data = Route.useLoaderData();
  return <PublicNewsletterPostView data={data} />;
}

export function PublicNewsletterPostView({
  data,
}: {
  data: ReturnType<typeof Route.useLoaderData>;
}) {
  const logoUrl = safeMediaUrl(data.publication.logoUrl);
  return (
    <PublicNewsletterTheme creator={data.creator}>
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
        <Link
          to={publicNewsletterPublicationPath(data.creator.username, data.publication.slug)}
          className="mb-5 inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground"
        >
          {logoUrl ? (
            <DecodedImage src={logoUrl} alt="" className="size-7 rounded-md object-cover" />
          ) : null}
          ← {data.publication.title}
        </Link>
        {data.issue.visibility === "paid" ? (
          <NewsletterPaidPost
            subject={data.issue.subject}
            previewText={data.issue.previewText}
            paidProduct={
              data.paidProduct
                ? {
                    title: data.paidProduct.title,
                    url: publicProductPath(data.creator.username, data.paidProduct.publicSlug),
                  }
                : null
            }
          />
        ) : data.issue.content ? (
          <NewsletterDocument
            subject={data.issue.subject}
            previewText={data.issue.previewText}
            content={data.issue.content}
            presentation={resolveNewsletterTemplate(data.issue.templateId)?.presentation}
          />
        ) : null}
        <footer className="mt-10 text-center text-xs text-muted-foreground">
          {data.publication.postalAddress}
        </footer>
      </div>
    </PublicNewsletterTheme>
  );
}
