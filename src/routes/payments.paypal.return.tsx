import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Check, LoaderCircle, TriangleAlert } from "lucide-react";
import { capturePayPalCheckout } from "@/integrations/paypal/checkout.functions";
import { BentoBrand } from "@/components/BentoBrand";
import { publicProductSuccessPath } from "@/lib/application-urls";

export const Route = createFileRoute("/payments/paypal/return")({
  validateSearch: z.object({
    token: z.string().min(8).max(128).optional(),
    session: z.string().uuid().optional(),
    capture: z.string().min(20).max(200).optional(),
    access: z.string().min(20).max(200).optional(),
  }),
  head: () => ({ meta: [{ title: "Confirming payment | bento.surf" }] }),
  component: PayPalReturnPage,
});

function PayPalReturnPage() {
  const search = Route.useSearch();
  const started = useRef(false);
  const [status, setStatus] = useState<"loading" | "done" | "error">("loading");
  const [message, setMessage] = useState("Confirming your payment securely…");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!search.token || !search.session || !search.capture) {
      setStatus("error");
      setMessage("This PayPal return link is incomplete.");
      return;
    }
    capturePayPalCheckout({
      data: {
        sessionId: search.session,
        captureToken: search.capture,
        orderId: search.token,
      },
    })
      .then(({ productSlug, creatorUsername, orderId }) => {
        setStatus("done");
        setMessage("Payment confirmed. Preparing your order…");
        window.setTimeout(() => {
          const query = new URLSearchParams({ order: orderId });
          if (search.access) query.set("access", search.access);
          const path = creatorUsername
            ? publicProductSuccessPath(creatorUsername, productSlug)
            : `/p/${encodeURIComponent(productSlug)}/success`;
          window.location.replace(`${path}?${query}`);
        }, 500);
      })
      .catch((error) => {
        setStatus("error");
        setMessage(
          error instanceof Error ? error.message : "PayPal payment could not be confirmed.",
        );
      });
  }, [search.access, search.capture, search.session, search.token]);

  const Icon = status === "loading" ? LoaderCircle : status === "done" ? Check : TriangleAlert;
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7f8fc] px-4 text-[#17213a]">
      <div className="w-full max-w-md rounded-[34px] border border-white bg-white/90 p-8 text-center shadow-[0_35px_100px_-50px_rgba(23,33,58,.65)] backdrop-blur-xl">
        <span className="mx-auto flex size-16 items-center justify-center rounded-full bg-[#e8f2ff] text-[#0070ba]">
          <Icon className={`size-7 ${status === "loading" ? "animate-spin" : ""}`} />
        </span>
        <h1 className="mt-5 font-display text-3xl">
          {status === "error" ? "Payment needs attention" : "PayPal payment"}
        </h1>
        <p className="mt-3 text-sm leading-6 text-[#17213a]/55">{message}</p>
        {status === "error" && (
          <Link
            to="/"
            className="mt-6 inline-flex rounded-2xl bg-[#17213a] px-5 py-3 text-sm font-semibold text-white"
          >
            <BentoBrand iconClassName="size-5" textClassName="text-white" />
          </Link>
        )}
      </div>
    </main>
  );
}
