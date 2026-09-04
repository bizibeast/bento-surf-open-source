import { createFileRoute, notFound, Link, redirect } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { getPublicProfileForRequest } from "@/lib/profile.functions";
import { PublicProfileView } from "./$username";
import { publicPageHead } from "@/lib/open-graph";
import { normalizePublicUsername, publicProfilePath } from "@/lib/application-urls";

const profileQuery = (username: string, pageSlug: string) =>
  queryOptions({
    queryKey: ["public-profile", username, pageSlug],
    queryFn: () => getPublicProfileForRequest({ data: { segments: [username, pageSlug] } }),
  });

// The trailing underscore in this file's `$username_` segment deliberately
// breaks file-route nesting. Public subpages are full sibling routes, not
// children of `/$username`; otherwise the homepage component keeps rendering
// when the URL changes to `/$username/$pageSlug`.
export const Route = createFileRoute("/$username_/$pageSlug")({
  loader: async ({ context, params, location }) => {
    const data = await context.queryClient.ensureQueryData(
      profileQuery(normalizePublicUsername(params.username), params.pageSlug),
    );
    if (!data || data.notFound) throw notFound();
    if (!data.customDomain && data.profile.username !== normalizePublicUsername(params.username)) {
      throw redirect({
        href: `${publicProfilePath(data.profile.username, params.pageSlug)}${location.searchStr}`,
        statusCode: 307,
      });
    }
    return data;
  },
  head: ({ loaderData }) => {
    if (!loaderData) return { meta: [{ title: "Not found" }] };
    return publicPageHead(loaderData, import.meta.env.VITE_PUBLIC_URL);
  },
  component: PublicPage,
});

function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="text-center">
        <div className="font-display text-6xl">404</div>
        <p className="mt-2 text-muted-foreground">That page doesn't exist.</p>
        <Link
          to="/"
          className="mt-4 inline-block rounded-lg bg-foreground px-4 py-2 text-sm text-background"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}

function PublicPage() {
  const params = Route.useParams();
  const username = normalizePublicUsername(params.username);
  const { data } = useSuspenseQuery(profileQuery(username, params.pageSlug));
  if (!data || data.notFound) return <NotFound />;
  return <PublicProfileView data={data} username={username} activeSlug={params.pageSlug} />;
}
