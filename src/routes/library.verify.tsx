import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { LockKeyhole } from "lucide-react";
import { z } from "zod";
import { consumeCustomerLibraryLink } from "@/lib/customer-library.functions";
import { sanitizeCustomerLibraryReturnTo } from "@/lib/safe-url";

export const Route = createFileRoute("/library/verify")({
  validateSearch: z.object({
    // Treat malformed links like expired links instead of throwing a search
    // validation error into the global boundary.
    token: z.string().max(200).catch("").default(""),
    returnTo: z.unknown().optional().transform(sanitizeCustomerLibraryReturnTo),
  }),
  head: () => ({
    meta: [
      { title: "Secure library sign-in | bento.surf" },
      { name: "robots", content: "noindex, nofollow, noarchive" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  loaderDeps: ({ search }) => ({ token: search.token, returnTo: search.returnTo }),
  loader: ({ deps }) => ({ invalid: deps.token.length < 20 }),
  component: InvalidLibraryLink,
});

function InvalidLibraryLink() {
  const { returnTo, token } = Route.useSearch();
  const { invalid } = Route.useLoaderData();
  const confirm = useMutation({
    mutationFn: () => consumeCustomerLibraryLink({ data: { token } }),
    onSuccess: (result) => {
      if (result.ok) window.location.replace(returnTo);
    },
  });
  const expired = invalid || confirm.data?.ok === false;
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f4f6fb] px-4 text-[#17213a]">
      <section className="w-full max-w-md rounded-[32px] border border-black/[0.06] bg-white p-7 text-center shadow-[0_30px_100px_-65px_rgba(23,33,58,.7)] sm:p-9">
        <span className="mx-auto flex size-14 items-center justify-center rounded-[20px] bg-[#ffe2e4] text-[#e24c5a]">
          <LockKeyhole className="size-6" />
        </span>
        <h1 className="mt-5 font-display text-4xl">
          {expired ? "This sign-in link has expired." : "Your library is ready."}
        </h1>
        <p className="mt-3 text-sm leading-6 text-[#17213a]/48">
          {expired
            ? "Customer library links are single-use and expire after 15 minutes."
            : "Confirm below to open your purchases securely."}
        </p>
        {!expired && (
          <button
            type="button"
            disabled={confirm.isPending}
            onClick={() => confirm.mutate()}
            className="mt-6 w-full rounded-lg bg-[#17213a] px-5 py-3 font-semibold text-white disabled:opacity-50"
          >
            {confirm.isPending ? "Opening…" : "Open my library"}
          </button>
        )}
        {confirm.isError && (
          <p role="alert" className="mt-3 text-sm text-rose-700">
            Your library could not open. Please try again.
          </p>
        )}
        <Link
          to="/library"
          search={{ returnTo }}
          className="mt-6 inline-flex rounded-2xl bg-[#17213a] px-5 py-3 text-sm font-semibold text-white"
        >
          Request a new link
        </Link>
      </section>
    </main>
  );
}
