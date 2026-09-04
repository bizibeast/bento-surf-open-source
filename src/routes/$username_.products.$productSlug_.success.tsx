import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";
import { BentoBrand } from "@/components/BentoBrand";
import { FontApplier } from "@/components/FontApplier";
import {
  ArrowRight,
  CircleAlert,
  Check,
  ExternalLink,
  LoaderCircle,
  LockKeyhole,
  ShoppingBag,
} from "lucide-react";
import {
  getCommerceAccess,
  getCommerceOrderConfirmation,
  getPublicCommerceProduct,
} from "@/lib/commerce.functions";
import {
  configuredPublicOrigin,
  normalizePublicUsername,
  publicProductPath,
  publicProductSuccessPath,
  publicProfileUrl,
} from "@/lib/application-urls";
import { clearCheckoutRecovery } from "@/lib/checkout-recovery";
import { stripUrlSearchParameters } from "@/lib/safe-url";

// The trailing underscore keeps this URL out of the product page's route layout.
// Buyers should see the confirmation page itself, not the parent checkout UI.

export const Route = createFileRoute("/$username_/products/$productSlug_/success")({
  validateSearch: z.object({
    order: z.string().min(8).max(200),
    access: z.string().min(20).max(200).optional(),
  }),
  head: () => ({
    meta: [
      { title: "You're in | bento.surf" },
      { name: "robots", content: "noindex, nofollow, noarchive" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  loader: async ({ params, location }) => {
    const data = await getPublicCommerceProduct({
      data: { username: normalizePublicUsername(params.username), publicSlug: params.productSlug },
    });
    if (!data) throw notFound();
    if (data.creator.username !== normalizePublicUsername(params.username)) {
      throw redirect({
        href: `${publicProductSuccessPath(
          data.creator.username,
          data.product.public_slug,
        )}${location.searchStr}`,
        statusCode: 307,
      });
    }
    return data;
  },
  component: CommerceSuccessPage,
});

function CommerceSuccessPage() {
  const data = Route.useLoaderData();
  const { access, order } = Route.useSearch();
  const [pollingExpired, setPollingExpired] = useState(false);
  useEffect(() => {
    if (!access) return;
    window.history.replaceState(
      window.history.state,
      "",
      stripUrlSearchParameters(window.location.href, ["access"]),
    );
  }, [access]);
  useEffect(() => {
    const timeout = window.setTimeout(() => setPollingExpired(true), 30_000);
    return () => window.clearTimeout(timeout);
  }, [order]);
  const confirmation = useQuery({
    queryKey: ["commerce-order-confirmation", data?.product.id, order],
    queryFn: () =>
      getCommerceOrderConfirmation({
        data: { productId: data!.product.id, reference: order },
      }),
    enabled: Boolean(data),
    refetchInterval: (query) =>
      !pollingExpired && query.state.data?.state === "processing" ? 1_500 : false,
    refetchIntervalInBackground: true,
    retry: 2,
  });
  const priorityDmRequestId = confirmation.data?.priorityDmRequestId;
  useEffect(() => {
    if (confirmation.data?.state !== "confirmed") return;
    if (!priorityDmRequestId) return;
    window.location.replace(`/library/priority-dm/${priorityDmRequestId}`);
  }, [confirmation.data?.state, priorityDmRequestId]);
  const isConfirmed = confirmation.data?.state === "confirmed";
  const accessStatus = useQuery({
    queryKey: ["commerce-access-ready", data?.product.id, access],
    queryFn: () => getCommerceAccess({ data: { token: access! } }),
    enabled: Boolean(data && access && isConfirmed),
    refetchInterval: (query) => (!pollingExpired && !query.state.data ? 1_000 : false),
    refetchIntervalInBackground: true,
    retry: 3,
  });
  useEffect(() => {
    if (!data || !isConfirmed) return;
    clearCheckoutRecovery(window.sessionStorage, data.product.id);
  }, [data, isConfirmed]);
  if (!data) return null;
  const confirmationState = confirmation.data?.state;
  const isProcessing =
    !pollingExpired && (confirmation.isPending || confirmationState === "processing");
  const isDelayed =
    pollingExpired &&
    !confirmation.isError &&
    (confirmation.isPending || confirmationState === "processing");
  const isUnavailable =
    confirmation.isError ||
    confirmationState === "not_found" ||
    confirmationState === "unavailable";
  const accessBelongsToProduct = accessStatus.data?.product?.id === data.product.id;
  const isAccessDelayed =
    Boolean(isConfirmed && access && !accessBelongsToProduct) && pollingExpired;
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#f7f8fc] px-4 py-10 text-[#17213a]">
      <FontApplier headline={data.creator.secondary_font} body={data.creator.primary_font} />
      <div className="pointer-events-none absolute -left-20 -top-20 size-72 rounded-full bg-[#dceaff] blur-2xl" />
      <div className="pointer-events-none absolute -bottom-24 right-[-3rem] size-80 rounded-full bg-[#ffc928]/25 blur-3xl" />
      <main className="relative w-full max-w-xl overflow-hidden rounded-[38px] border border-white bg-white/90 p-7 text-center shadow-[0_40px_120px_-55px_rgba(23,33,58,.7)] backdrop-blur-xl sm:p-10">
        <span
          className={`mx-auto flex size-16 items-center justify-center rounded-full text-white ${
            isConfirmed
              ? "bg-emerald-500 shadow-[0_16px_34px_-18px_rgba(16,185,129,.9)]"
              : isUnavailable
                ? "bg-rose-500"
                : "bg-[#3478f6]"
          }`}
        >
          {isConfirmed ? (
            <Check className="size-7" />
          ) : isUnavailable ? (
            <CircleAlert className="size-7" />
          ) : (
            <LoaderCircle className="size-7 animate-spin" />
          )}
        </span>
        <div
          className={`mt-6 text-[10px] font-semibold uppercase tracking-[0.18em] ${
            isConfirmed ? "text-emerald-600" : isUnavailable ? "text-rose-600" : "text-[#3478f6]"
          }`}
        >
          {isConfirmed
            ? "Order confirmed"
            : isUnavailable
              ? "Order not confirmed"
              : isDelayed
                ? "Payment is still processing"
                : "Confirming payment"}
        </div>
        <h1 className="mt-2 font-display text-4xl leading-tight sm:text-5xl">
          {isConfirmed
            ? "You're in."
            : isUnavailable
              ? "Let's check this."
              : isDelayed
                ? "This is taking longer."
                : "Almost there."}
        </h1>
        <p className="mt-4 text-sm leading-6 text-[#17213a]/55">
          {isConfirmed ? (
            <>
              Your order for <strong className="text-[#17213a]">{data.product.title}</strong> is
              confirmed.{" "}
              {data.product.kind === "priority_dm"
                ? "Your conversation link is on its way by email."
                : "Keep the private access link below."}
            </>
          ) : isUnavailable ? (
            <>
              We could not verify this order for{" "}
              <strong className="text-[#17213a]">{data.product.title}</strong>. Return to the
              product or check your customer library before trying again.
            </>
          ) : isDelayed ? (
            <>
              The provider has not finished confirming your order for{" "}
              <strong className="text-[#17213a]">{data.product.title}</strong>. You can safely check
              your customer library in a moment; please do not pay again.
            </>
          ) : (
            <>
              We are waiting for the payment provider to confirm your order for{" "}
              <strong className="text-[#17213a]">{data.product.title}</strong>. This usually takes
              only a few seconds.
            </>
          )}
        </p>
        {isConfirmed && access && accessBelongsToProduct ? (
          <Link
            to="/access/$token"
            params={{ token: access }}
            className="mt-7 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#3478f6] px-5 py-4 text-sm font-semibold text-white shadow-[0_16px_32px_-20px_rgba(52,120,246,.9)]"
          >
            Open my purchase <LockKeyhole className="size-4" />
          </Link>
        ) : isAccessDelayed ? (
          <a
            href="/library/"
            className="mt-7 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#17213a] px-5 py-4 text-sm font-semibold text-white"
          >
            Check customer library <ArrowRight className="size-4" />
          </a>
        ) : isConfirmed && access ? (
          <div className="mt-7 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#dceaff] px-5 py-4 text-sm font-semibold text-[#3478f6]">
            <LoaderCircle className="size-4 animate-spin" /> Preparing private access…
          </div>
        ) : isProcessing ? (
          <div className="mt-7 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#dceaff] px-5 py-4 text-sm font-semibold text-[#3478f6]">
            <LoaderCircle className="size-4 animate-spin" /> Checking secure payment…
          </div>
        ) : isDelayed ? (
          <a
            href="/library/"
            className="mt-7 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#17213a] px-5 py-4 text-sm font-semibold text-white"
          >
            Check customer library <ArrowRight className="size-4" />
          </a>
        ) : (
          <Link
            to={publicProductPath(data.creator.username, data.product.public_slug)}
            className="mt-7 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#17213a] px-5 py-4 text-sm font-semibold text-white"
          >
            Back to product <ArrowRight className="size-4" />
          </Link>
        )}
        <div className="mt-5 rounded-2xl bg-[#f2f5fb] px-4 py-3 text-left text-xs leading-5 text-[#17213a]/48">
          <div className="font-semibold text-[#17213a]/70">Order reference</div>
          <div className="mt-1 font-mono">{order}</div>
        </div>
        <a
          href="/library/"
          className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-[#3478f6] underline decoration-[#3478f6]/25 underline-offset-4"
        >
          Open customer library <ArrowRight className="size-3.5" />
        </a>
        <div className="mt-6 flex items-center justify-center gap-4 text-xs text-[#17213a]/42">
          <a
            href={publicProfileUrl(data.creator.username, null, import.meta.env.VITE_PUBLIC_URL)}
            className="inline-flex items-center gap-1.5 hover:text-[#17213a]"
          >
            <ShoppingBag className="size-3.5" /> Creator storefront
          </a>
          <a
            href={configuredPublicOrigin(import.meta.env.VITE_PUBLIC_URL)}
            className="inline-flex items-center gap-1.5 hover:text-[#17213a]"
          >
            <BentoBrand iconClassName="size-5" /> <ExternalLink className="size-3.5" />
          </a>
        </div>
      </main>
    </div>
  );
}
