import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Check, LoaderCircle, TriangleAlert } from "lucide-react";
import { completePolarConnection } from "@/integrations/polar/connection.functions";

export const Route = createFileRoute("/integrations/polar/callback")({
  validateSearch: z.object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  }),
  head: () => ({ meta: [{ title: "Connect Polar | bento.surf" }] }),
  component: PolarCallbackPage,
});

function PolarCallbackPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const started = useRef(false);
  const [status, setStatus] = useState<"loading" | "done" | "error">("loading");
  const [message, setMessage] = useState("Securing your Polar connection…");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (search.error || !search.code || !search.state) {
      setStatus("error");
      setMessage(search.error_description || "Polar did not approve the connection.");
      return;
    }
    completePolarConnection({ data: { code: search.code, state: search.state } })
      .then(() => {
        setStatus("done");
        setMessage("Polar is connected. Your creator earnings stay in your Polar account.");
        window.setTimeout(() => {
          void navigate({ to: "/settings", search: { section: "payments", polar: "connected" } });
        }, 900);
      })
      .catch((error) => {
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "Polar could not be connected.");
      });
  }, [navigate, search.code, search.error, search.error_description, search.state]);

  const Icon = status === "loading" ? LoaderCircle : status === "done" ? Check : TriangleAlert;
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7f8fc] px-4 text-[#17213a]">
      <div className="w-full max-w-md rounded-[34px] border border-white bg-white/90 p-8 text-center shadow-[0_35px_100px_-50px_rgba(23,33,58,.65)] backdrop-blur-xl">
        <span className="mx-auto flex size-16 items-center justify-center rounded-full bg-[#eef4ff] text-[#3478f6]">
          <Icon className={`size-7 ${status === "loading" ? "animate-spin" : ""}`} />
        </span>
        <h1 className="mt-5 font-display text-3xl">
          {status === "error" ? "Connection paused" : "Connect Polar"}
        </h1>
        <p className="mt-3 text-sm leading-6 text-[#17213a]/55">{message}</p>
        {status === "error" && (
          <Link
            to="/settings"
            search={{ section: "payments", polar: "error" }}
            className="mt-6 inline-flex rounded-2xl bg-[#17213a] px-5 py-3 text-sm font-semibold text-white"
          >
            Back to payment settings
          </Link>
        )}
      </div>
    </main>
  );
}
