import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  CalendarDays,
  Download,
  LibraryBig,
  Loader2,
  LogOut,
  Mail,
  ReceiptText,
  ShieldCheck,
  ShoppingBag,
  UsersRound,
} from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { BentoFullLogo } from "@/components/BentoBrand";
import {
  createCustomerLibraryAccess,
  getCustomerLibrary,
  logoutCustomerLibrary,
  requestCustomerLibraryLink,
} from "@/lib/customer-library.functions";
import { safeMediaUrl, sanitizeCustomerLibraryReturnTo } from "@/lib/safe-url";
import { DecodedImage } from "@/components/DecodedImage";
import {
  handleWebMcpFormSubmit,
  requireWebMcpUserConfirmation,
  useWebMcpTools,
  webMcpResult,
} from "@/lib/webmcp";
import { configuredPublicOrigin } from "@/lib/application-urls";

type LibraryData = NonNullable<Awaited<ReturnType<typeof getCustomerLibrary>>>;
type LibraryEntry = LibraryData["entries"][number];

export const Route = createFileRoute("/library/")({
  validateSearch: z.object({
    returnTo: z.unknown().optional().transform(sanitizeCustomerLibraryReturnTo),
  }),
  head: () => ({
    meta: [
      { title: "Your customer library | bento.surf" },
      {
        name: "description",
        content: "Open your Bento purchases, courses, bookings, and communities in one place.",
      },
      { name: "robots", content: "noindex, nofollow, noarchive" },
    ],
  }),
  loader: () => getCustomerLibrary(),
  component: CustomerLibraryPage,
});

function CustomerLibraryPage() {
  const data = Route.useLoaderData() as LibraryData | null;
  const { returnTo } = Route.useSearch();
  return data ? <LibraryHome data={data} /> : <LibraryLogin returnTo={returnTo} />;
}

export function LibraryLogin({ returnTo = "/library" }: { returnTo?: string }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const requestLink = useMutation({
    mutationFn: () => requestCustomerLibraryLink({ data: { email, returnTo } }),
    onSuccess: () => setSent(true),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "The sign-in link could not be sent."),
  });
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#f4f6fb] px-4 py-10 text-[#17213a]">
      <div className="pointer-events-none absolute -left-32 top-[-8rem] size-96 rounded-full bg-[#dceaff] blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 right-[-8rem] size-[28rem] rounded-full bg-[#ffe2e4] blur-3xl" />
      <section className="relative w-full max-w-lg rounded-[36px] border border-white/90 bg-white/88 p-6 shadow-[0_38px_120px_-65px_rgba(23,33,58,.68)] backdrop-blur-xl sm:p-9">
        <a
          href={configuredPublicOrigin(import.meta.env.VITE_PUBLIC_URL)}
          aria-label="Bento Surf home"
        >
          <BentoFullLogo className="h-8 w-auto" />
        </a>
        <span className="mt-10 flex size-14 items-center justify-center rounded-[20px] bg-[#17213a] text-white">
          <LibraryBig className="size-6" />
        </span>
        <h1 className="mt-5 font-display text-4xl leading-[0.98] sm:text-5xl">
          Everything you bought, together.
        </h1>
        <p className="mt-4 max-w-md text-sm leading-6 text-[#17213a]/52">
          Enter the email you used at checkout. We’ll send a secure, passwordless link to your
          customer library.
        </p>
        {sent ? (
          <div className="mt-7 rounded-[24px] bg-[#e7f7ee] p-5 text-[#197a4d]">
            <div className="flex items-center gap-2 font-semibold">
              <Mail className="size-4" /> Check your inbox
            </div>
            <p className="mt-2 text-xs leading-5 text-[#197a4d]/75">
              If that email has Bento purchases, a sign-in link is on its way. It expires in 15
              minutes.
            </p>
            <button
              type="button"
              onClick={() => setSent(false)}
              className="mt-4 text-xs font-semibold underline underline-offset-4"
            >
              Use another email
            </button>
          </div>
        ) : (
          <form
            className="mt-7"
            toolname="bento_prepare_customer_library_sign_in"
            tooldescription="Fills the customer-library email form for the user to review and submit."
            onSubmit={(event) =>
              handleWebMcpFormSubmit(event, async () => {
                try {
                  await requestLink.mutateAsync();
                  return { ok: true, message: "Customer-library sign-in link requested." };
                } catch {
                  return {
                    ok: false,
                    message: "The sign-in link could not be sent. Review the form and try again.",
                  };
                }
              })
            }
          >
            <label htmlFor="library-email" className="text-xs font-semibold text-[#17213a]/65">
              Checkout email
            </label>
            <input
              id="library-email"
              name="email"
              toolparamdescription="Email address used for Bento purchases."
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              className="mt-2 w-full rounded-2xl border border-black/[0.08] bg-[#f7f8fc] px-4 py-3.5 text-sm outline-none focus:border-[#3478f6]/45 focus:ring-4 focus:ring-[#3478f6]/10"
            />
            <button
              type="submit"
              disabled={requestLink.isPending}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#3478f6] px-5 py-3.5 text-sm font-semibold text-white disabled:opacity-55"
            >
              {requestLink.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Mail className="size-4" />
              )}
              Email my sign-in link
            </button>
          </form>
        )}
        <div className="mt-7 flex items-center gap-2 text-[11px] leading-5 text-[#17213a]/38">
          <ShieldCheck className="size-4 shrink-0" />
          No password to remember. Links are single-use and sessions can be revoked.
        </div>
      </section>
    </main>
  );
}

export function LibraryHome({ data }: { data: LibraryData }) {
  const openAccess = useMutation({
    mutationFn: (input: { grantId: string; signal?: AbortSignal }) => {
      input.signal?.throwIfAborted();
      return createCustomerLibraryAccess({ data: { grantId: input.grantId } });
    },
    onSuccess: ({ url }, input) => {
      input.signal?.throwIfAborted();
      window.location.assign(url);
    },
    onError: (error, input) => {
      if (input.signal?.aborted) return;
      toast.error(error instanceof Error ? error.message : "This purchase could not be opened.");
    },
  });
  const logout = useMutation({
    mutationFn: (input: { signal?: AbortSignal }) => {
      input.signal?.throwIfAborted();
      return logoutCustomerLibrary();
    },
    onSuccess: (_result, input) => {
      input.signal?.throwIfAborted();
      window.location.reload();
    },
  });
  const webMcpTools = useMemo(
    () => [
      {
        name: "bento_get_customer_library",
        title: "Customer library",
        description:
          "Lists the signed-in customer's Bento purchases and whether each item can be opened.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: () =>
          webMcpResult("Loaded the customer library.", {
            entries: data.entries.map((entry: LibraryEntry) => ({
              grantId: entry.grant.id,
              title: entry.product?.title || "Your purchase",
              kind: entry.product?.kind || null,
              creator: entry.creator?.display_name || entry.creator?.username || "Bento creator",
              canOpen: entry.canOpen,
              status: purchaseStatus(entry),
              receiptOrderId: entry.order?.id || null,
            })),
          }),
      },
      {
        name: "bento_open_customer_library_item",
        title: "Open customer library item",
        description:
          "Opens one available customer-library item after Bento shows a browser approval dialog.",
        inputSchema: {
          type: "object",
          properties: {
            grantId: { type: "string", format: "uuid" },
          },
          required: ["grantId"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: async (input: Record<string, unknown>, { signal }: { signal: AbortSignal }) => {
          const grantId = typeof input.grantId === "string" ? input.grantId : "";
          const entry = data.entries.find(
            (candidate: LibraryEntry) => candidate.grant.id === grantId,
          );
          if (!entry?.canOpen) throw new Error("Choose an available item from this library.");
          signal.throwIfAborted();
          await requireWebMcpUserConfirmation("Open this customer library item", { grantId });
          signal.throwIfAborted();
          await openAccess.mutateAsync({ grantId, signal });
          signal.throwIfAborted();
          return webMcpResult("Opening the selected customer-library item.");
        },
      },
      {
        name: "bento_sign_out_customer_library",
        title: "Sign out of customer library",
        description:
          "Signs out of the customer library after Bento shows a browser approval dialog.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async (_input: Record<string, unknown>, { signal }: { signal: AbortSignal }) => {
          signal.throwIfAborted();
          await requireWebMcpUserConfirmation("Sign out of the customer library");
          signal.throwIfAborted();
          await logout.mutateAsync({ signal });
          signal.throwIfAborted();
          return webMcpResult("Signed out of the customer library.");
        },
      },
    ],
    [data.entries, logout, openAccess],
  );
  useWebMcpTools(webMcpTools);
  return (
    <div className="min-h-screen bg-[#f4f6fb] text-[#17213a]">
      <header className="border-b border-black/[0.06] bg-white/88 backdrop-blur-xl">
        <div className="mx-auto flex min-h-16 max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <a
            href={configuredPublicOrigin(import.meta.env.VITE_PUBLIC_URL)}
            aria-label="Bento Surf home"
          >
            <BentoFullLogo className="h-8 w-auto" />
          </a>
          <div className="ml-auto min-w-0 text-right">
            <div className="truncate text-xs font-semibold">
              {data.customer.name || "Your library"}
            </div>
            <div className="max-w-40 truncate text-[10px] text-[#17213a]/40 sm:max-w-72">
              {data.customer.email}
            </div>
          </div>
          <button
            type="button"
            aria-label="Sign out"
            onClick={() => logout.mutate({})}
            disabled={logout.isPending}
            className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-black/[0.07] bg-white"
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
        <div className="max-w-2xl">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#3478f6]">
            Customer library
          </div>
          <h1 className="mt-2 font-display text-4xl leading-none sm:text-6xl">
            Your purchases have a home.
          </h1>
          <p className="mt-4 text-sm leading-6 text-[#17213a]/48">
            Downloads, courses, calls, events, and communities from every Bento creator appear here
            automatically.
          </p>
        </div>
        {data.entries.length ? (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.entries.map((entry: LibraryEntry) => (
              <LibraryCard
                key={entry.grant.id}
                entry={entry}
                opening={openAccess.isPending && openAccess.variables?.grantId === entry.grant.id}
                onOpen={() => openAccess.mutate({ grantId: entry.grant.id })}
              />
            ))}
          </div>
        ) : (
          <div className="mt-8 rounded-[30px] border border-dashed border-[#17213a]/14 bg-white/65 p-8 text-center sm:p-12">
            <ShoppingBag className="mx-auto size-7 text-[#17213a]/25" />
            <h2 className="mt-4 font-display text-3xl">No purchases yet.</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-[#17213a]/45">
              Use this email at checkout and eligible purchases will appear here automatically.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

function LibraryCard({
  entry,
  opening,
  onOpen,
}: {
  entry: LibraryEntry;
  opening: boolean;
  onOpen: () => void;
}) {
  const product = entry.product;
  const creator = entry.creator;
  const icon = productIcon(product?.kind);
  const cover = safeMediaUrl(product?.cover_url);
  return (
    <article className="flex min-h-72 flex-col overflow-hidden rounded-[30px] border border-black/[0.06] bg-white shadow-[0_28px_80px_-58px_rgba(23,33,58,.6)]">
      <div className="relative h-32 overflow-hidden bg-[linear-gradient(135deg,#dceaff,#fff3c6_58%,#ffe2e4)]">
        {cover && (
          <DecodedImage src={cover} alt="" loading="lazy" className="h-full w-full object-cover" />
        )}
        <span className="absolute left-4 top-4 flex size-10 items-center justify-center rounded-2xl bg-white/92 text-[#17213a] shadow-sm">
          {icon}
        </span>
      </div>
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-center gap-2">
          {safeMediaUrl(creator?.avatar_url) ? (
            <DecodedImage
              src={safeMediaUrl(creator.avatar_url)!}
              alt=""
              width={56}
              height={56}
              loading="lazy"
              className="size-7 rounded-full object-cover"
            />
          ) : (
            <span className="flex size-7 items-center justify-center rounded-full bg-[#17213a] text-[10px] text-white">
              {String(creator?.display_name || creator?.username || "B")
                .slice(0, 1)
                .toUpperCase()}
            </span>
          )}
          <span className="truncate text-xs text-[#17213a]/45">
            {creator?.display_name || creator?.username || "Bento creator"}
          </span>
        </div>
        <h2 className="mt-3 line-clamp-2 font-display text-2xl leading-[1.05]">
          {product?.title || "Your purchase"}
        </h2>
        <p className="mt-2 line-clamp-2 text-xs leading-5 text-[#17213a]/42">
          {product?.subtitle || purchaseStatus(entry)}
        </p>
        <div className="mt-auto flex gap-2 pt-4">
          <button
            type="button"
            onClick={onOpen}
            disabled={!entry.canOpen || opening}
            className="inline-flex min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl bg-[#17213a] px-4 py-3 text-sm font-semibold text-white disabled:bg-[#e9ebf0] disabled:text-[#17213a]/35"
          >
            {opening ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArrowRight className="size-4" />
            )}
            {entry.canOpen ? "Open" : purchaseStatus(entry)}
          </button>
          {entry.order?.id && (
            <a
              href={`/library/receipts/${encodeURIComponent(entry.order.id)}`}
              aria-label={`Receipt for ${product?.title || "purchase"}`}
              title="Receipt"
              className="inline-flex size-12 shrink-0 items-center justify-center rounded-2xl border border-black/[0.07] bg-white text-[#17213a]"
            >
              <ReceiptText className="size-4" />
            </a>
          )}
        </div>
      </div>
    </article>
  );
}

function productIcon(kind?: string) {
  if (kind === "digital_product") return <Download className="size-4" />;
  if (kind === "course") return <BookOpen className="size-4" />;
  if (kind === "coaching_call" || kind === "webinar") return <CalendarDays className="size-4" />;
  if (kind === "paid_community" || kind === "membership") return <UsersRound className="size-4" />;
  return <ShoppingBag className="size-4" />;
}

function purchaseStatus(entry: LibraryEntry) {
  if (entry.grant.status === "revoked") return "Access ended";
  if (entry.order?.status === "refunded") return "Refunded";
  if (entry.order?.status === "partially_refunded") return "Partially refunded";
  if (entry.grant.expires_at && new Date(entry.grant.expires_at).getTime() <= Date.now()) {
    return "Access expired";
  }
  return "Purchase confirmed";
}
