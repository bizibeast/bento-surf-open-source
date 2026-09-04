import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod";
import { PublicNewsletterArchiveContent } from "@/components/email-marketing/PublicNewsletterArchive";
import {
  confirmNewsletterSubscription,
  getPublicNewsletterArchive,
  publicNewsletterArchiveFromRows,
  validateNewsletterSubscriptionConfirmation,
} from "@/lib/newsletter.functions";
import { publicNewsletterArchiveHead } from "@/lib/open-graph";
import { normalizePublicUsername, publicNewsletterPath } from "@/lib/application-urls";

export const Route = createFileRoute("/$username_/newsletter")({
  validateSearch: z.object({ confirm: z.string().max(4_096).optional() }),
  loader: async ({ params, location }) => {
    const requestedUsername = normalizePublicUsername(params.username);
    const data = await getPublicNewsletterArchive({ data: { username: requestedUsername } });
    if (!data) throw notFound();
    if (data.creator.username !== requestedUsername) {
      throw redirect({
        href: `${publicNewsletterPath(data.creator.username)}${location.searchStr}`,
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
  component: PublicNewsletterArchive,
});

function PublicNewsletterArchive() {
  const data = Route.useLoaderData();
  return <PublicNewsletterArchiveView data={data} />;
}

export function PublicNewsletterArchiveView({
  data,
}: {
  data: NonNullable<ReturnType<typeof publicNewsletterArchiveFromRows>> & {
    confirmation: { token: string; valid: boolean } | null;
  };
}) {
  const confirmation = useMutation({
    mutationFn: (token: string) => confirmNewsletterSubscription({ data: { token } }),
  });
  return (
    <PublicNewsletterArchiveContent
      data={data}
      emailCaptureInteractive
      beforeContent={
        data.confirmation ? (
          <p role="status" className="mb-6 rounded-2xl bg-white p-4 text-sm shadow-sm">
            {confirmation.data?.confirmed ? (
              "Your subscription is confirmed."
            ) : data.confirmation.valid ? (
              <button
                type="button"
                disabled={confirmation.isPending}
                onClick={() => confirmation.mutate(data.confirmation!.token)}
                className="rounded-xl bg-[#17213a] px-4 py-2.5 font-semibold text-white disabled:opacity-50"
              >
                Confirm subscription
              </button>
            ) : (
              "This confirmation link is no longer valid."
            )}
          </p>
        ) : null
      }
    />
  );
}
