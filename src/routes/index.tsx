import { createFileRoute, redirect } from "@tanstack/react-router";
import { getPublicProfileForRequest } from "@/lib/profile.functions";
import { publicPageHead } from "@/lib/open-graph";
import { PublicProfileView } from "./$username";

export const Route = createFileRoute("/")({
  loader: async () => {
    const profile = await getPublicProfileForRequest({ data: { segments: [] } });
    if (!profile) throw redirect({ to: "/login", search: { redirect: "/link" } });
    return profile;
  },
  head: ({ loaderData }) =>
    loaderData ? publicPageHead(loaderData, import.meta.env.VITE_PUBLIC_URL) : {},
  component: HomeRoute,
});

function HomeRoute() {
  const data = Route.useLoaderData();
  return <PublicProfileView data={data} username={data.profile.username} activeSlug={null} />;
}
