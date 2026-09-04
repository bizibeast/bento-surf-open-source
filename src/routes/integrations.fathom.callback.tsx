import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, LoaderCircle, XCircle } from "lucide-react";
import { z } from "zod";
import { completeFathomConnection } from "@/lib/booking.functions";
import { settingsIntegrationsSearch } from "@/lib/settings-integrations";

export const Route = createFileRoute("/integrations/fathom/callback")({
  ssr: false,
  pendingMs: 0,
  validateSearch: z.object({
    code: z.string().max(4_000).optional(),
    state: z.string().max(100).optional(),
    error: z.string().max(200).optional(),
    error_description: z.string().max(1_000).optional(),
  }),
  component: FathomCallback,
});

function FathomCallback() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const started = useRef(false);
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("Connecting Fathom…");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (search.error || !search.code || !search.state) {
      setStatus("error");
      setMessage(search.error_description || "Fathom connection was cancelled.");
      return;
    }
    void completeFathomConnection({ data: { code: search.code, state: search.state } })
      .then(({ email }) => {
        setStatus("success");
        setMessage(`${email || "Your Fathom account"} is connected for purchased recordings.`);
        window.setTimeout(
          () =>
            void navigate({
              to: "/settings",
              search: settingsIntegrationsSearch("bookings"),
              replace: true,
            }),
          900,
        );
      })
      .catch((error) => {
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "Fathom connection failed.");
      });
  }, [navigate, search.code, search.error, search.error_description, search.state]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#ffe7d8] px-5">
      <div className="w-full max-w-md rounded-[32px] border border-white/80 bg-white p-8 text-center shadow-[0_30px_80px_-35px_rgba(23,33,58,0.5)]">
        <div className="mx-auto flex size-16 items-center justify-center rounded-3xl bg-[#fff3eb]">
          {status === "loading" ? (
            <LoaderCircle className="size-8 animate-spin text-[#f07f4f]" />
          ) : status === "success" ? (
            <CheckCircle2 className="size-8 text-emerald-500" />
          ) : (
            <XCircle className="size-8 text-rose-500" />
          )}
        </div>
        <h1 className="mt-5 font-display text-3xl text-[#17213a]">Fathom</h1>
        <p className="mt-2 text-sm leading-relaxed text-[#17213a]/65">{message}</p>
        {status === "error" && (
          <Link
            to="/settings"
            search={settingsIntegrationsSearch("bookings")}
            className="mt-6 inline-flex rounded-xl bg-[#17213a] px-5 py-2.5 text-sm font-semibold text-white"
          >
            Back to Integrations
          </Link>
        )}
      </div>
    </main>
  );
}
