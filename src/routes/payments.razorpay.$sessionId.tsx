import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, ShieldCheck } from "lucide-react";
import { SiRazorpay } from "react-icons/si";
import { toast } from "sonner";
import {
  getRazorpayCheckout,
  verifyRazorpayCheckout,
} from "@/integrations/razorpay/checkout.functions";
import { safeNavigationHref } from "@/lib/safe-url";

type RazorpaySuccess = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

type RazorpayInstance = { open: () => void };

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

export const Route = createFileRoute("/payments/razorpay/$sessionId")({
  head: () => ({ meta: [{ title: "Secure Razorpay checkout | bento.surf" }] }),
  loader: ({ params }) => getRazorpayCheckout({ data: { sessionId: params.sessionId } }),
  component: RazorpayCheckoutPage,
});

function loadRazorpayCheckout() {
  return new Promise<void>((resolve, reject) => {
    if (window.Razorpay) return resolve();
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://checkout.razorpay.com/v1/checkout.js"]',
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Razorpay could not load.")), {
        once: true,
      });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Razorpay could not load."));
    document.head.appendChild(script);
  });
}

function RazorpayCheckoutPage() {
  const checkout = Route.useLoaderData();
  const [status, setStatus] = useState<"loading" | "ready" | "verifying" | "error">("loading");
  const opened = useRef(false);

  const openCheckout = async () => {
    try {
      setStatus("loading");
      await loadRazorpayCheckout();
      if (!window.Razorpay) throw new Error("Razorpay Checkout is unavailable.");
      setStatus("ready");
      const instance = new window.Razorpay({
        key: checkout.keyId,
        amount: checkout.amount,
        currency: checkout.currency,
        name: checkout.creatorName,
        description: checkout.productTitle,
        order_id: checkout.orderId,
        prefill: { name: checkout.buyerName, email: checkout.buyerEmail },
        notes: { bento_session_id: checkout.sessionId },
        theme: { color: "#2b84ea" },
        modal: {
          ondismiss: () => window.location.assign(checkout.cancelUrl),
        },
        handler: async (result: RazorpaySuccess) => {
          setStatus("verifying");
          try {
            const verified = await verifyRazorpayCheckout({
              data: {
                sessionId: checkout.sessionId,
                razorpayPaymentId: result.razorpay_payment_id,
                razorpayOrderId: result.razorpay_order_id,
                razorpaySignature: result.razorpay_signature,
              },
            });
            const destination = safeNavigationHref(verified.url);
            if (!destination) throw new Error("Razorpay returned an invalid destination.");
            window.location.assign(destination);
          } catch (error) {
            setStatus("error");
            toast.error(error instanceof Error ? error.message : "Payment verification failed");
          }
        },
      });
      instance.open();
    } catch (error) {
      setStatus("error");
      toast.error(error instanceof Error ? error.message : "Razorpay could not load");
    }
  };

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void openCheckout();
    // The checkout data is immutable for this route load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7f8fc] px-4 py-10 text-[#17213a]">
      <div className="w-full max-w-md rounded-[32px] border border-black/[0.06] bg-white p-7 text-center shadow-[0_32px_90px_-55px_rgba(23,33,58,.65)] sm:p-9">
        <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-[#2b84ea]/10 text-[#2b84ea]">
          <SiRazorpay className="size-8" aria-hidden="true" />
        </span>
        <h1 className="mt-5 font-display text-3xl">{checkout.productTitle}</h1>
        <p className="mt-2 text-sm text-[#17213a]/55">Secure checkout with Razorpay</p>
        {checkout.test && (
          <div className="mt-4 rounded-2xl bg-[#dceaff] px-4 py-3 text-xs font-semibold text-[#245fd0]">
            Razorpay Test Mode - no real money will move.
          </div>
        )}
        <button
          type="button"
          disabled={status === "loading" || status === "verifying"}
          onClick={() => void openCheckout()}
          className="mt-6 inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-[#17213a] px-5 text-sm font-semibold text-white transition hover:bg-[#25314f] disabled:opacity-60"
        >
          {(status === "loading" || status === "verifying") && (
            <Loader2 className="size-4 animate-spin" />
          )}
          {status === "verifying" ? "Verifying payment…" : "Continue with Razorpay"}
        </button>
        <a
          href={checkout.cancelUrl}
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-[#17213a]/50"
        >
          <ArrowLeft className="size-3.5" /> Back to product
        </a>
        <div className="mt-6 flex items-start gap-2 border-t border-black/[0.06] pt-5 text-left text-xs leading-5 text-[#17213a]/48">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[#2b84ea]" />
          Payment details are collected securely by Razorpay and never pass through Bento servers.
        </div>
      </div>
    </main>
  );
}
