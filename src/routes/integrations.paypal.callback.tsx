import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Check, LoaderCircle, TriangleAlert } from "lucide-react";
import { completePayPalConnection } from "@/integrations/paypal/connection.functions";

export const Route = createFileRoute("/integrations/paypal/callback")({
  validateSearch: z.object({
    state: z.string().optional(),
    merchantIdInPayPal: z.string().optional(),
    permissionsGranted: z.string().optional(),
  }),
  head: () => ({ meta: [{ title: "Connect PayPal | bento.surf" }] }),
  component: PayPalCallbackPage,
});

function PayPalCallbackPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const started = useRef(false);
  const [status, setStatus] = useState<"loading" | "done" | "error">("loading");
  const [message, setMessage] = useState("Checking your PayPal seller account…");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!search.state || !search.merchantIdInPayPal) {
      setStatus("error");
      setMessage("PayPal did not return the seller details Bento expected.");
      return;
    }
    completePayPalConnection({
      data: {
        state: search.state,
        merchantId: search.merchantIdInPayPal,
        permissionsGranted: search.permissionsGranted === "true",
      },
    })
      .then(({ ready }) => {
        setStatus("done");
        setMessage(
          ready
            ? "PayPal is connected and ready for one-time sales."
            : "PayPal is connected, but seller review still needs to finish.",
        );
        window.setTimeout(() => {
          void navigate({ to: "/settings", search: { section: "payments", paypal: "connected" } });
        }, 1_000);
      })
      .catch((error) => {
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "PayPal could not be connected.");
      });
  }, [navigate, search.merchantIdInPayPal, search.permissionsGranted, search.state]);

  const Icon = status === "loading" ? LoaderCircle : status === "done" ? Check : TriangleAlert;
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7f8fc] px-4 text-[#17213a]">
      <div className="w-full max-w-md rounded-[34px] border border-white bg-white/90 p-8 text-center shadow-[0_35px_100px_-50px_rgba(23,33,58,.65)] backdrop-blur-xl">
        <span className="mx-auto flex size-16 items-center justify-center rounded-full bg-[#e8f2ff] text-[#0070ba]">
          <Icon className={`size-7 ${status === "loading" ? "animate-spin" : ""}`} />
        </span>
        <h1 className="mt-5 font-display text-3xl">
          {status === "error" ? "Connection paused" : "Connect PayPal"}
        </h1>
        <p className="mt-3 text-sm leading-6 text-[#17213a]/55">{message}</p>
        {status === "error" && (
          <Link
            to="/settings"
            search={{ section: "payments", paypal: "error" }}
            className="mt-6 inline-flex rounded-2xl bg-[#17213a] px-5 py-3 text-sm font-semibold text-white"
          >
            Back to payment settings
          </Link>
        )}
      </div>
    </main>
  );
}
