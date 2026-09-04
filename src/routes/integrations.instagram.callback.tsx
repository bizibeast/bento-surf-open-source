import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, LoaderCircle, XCircle } from "lucide-react";
import { z } from "zod";
import {
  instagramOAuthFailureFromUnknown,
  instagramOAuthFailureMessage,
} from "@/lib/instagram-oauth-errors";
import { completeInstagramConnection } from "@/lib/social-connections.functions";
import { resolveInstagramConnectionReturn } from "@/lib/settings-integrations";

export const Route = createFileRoute("/integrations/instagram/callback")({
  ssr: false,
  pendingMs: 0,
  validateSearch: z.object({
    code: z.string().max(2_000).optional(),
    state: z.string().max(100).optional(),
    error: z.string().max(200).optional(),
    error_description: z.string().max(1_000).optional(),
  }),
  component: InstagramCallback,
});

function InstagramCallback() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const started = useRef(false);
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("Connecting your Instagram account…");
  const destination = resolveInstagramConnectionReturn(
    typeof window === "undefined"
      ? null
      : window.sessionStorage.getItem("instagramConnectionReturnTo"),
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (search.error || !search.code || !search.state) {
      setStatus("error");
      setMessage(
        instagramOAuthFailureMessage({
          error: search.error,
          errorDescription: search.error_description,
        }),
      );
      return;
    }
    void completeInstagramConnection({ data: { code: search.code, state: search.state } })
      .then((result) => {
        if (!result.ok) {
          setStatus("error");
          setMessage(result.failureMessage);
          return;
        }
        setStatus("success");
        setMessage("Instagram connected. Your account is ready to use in Bento.");
        window.sessionStorage.removeItem("instagramConnectionReturnTo");
        window.setTimeout(
          () =>
            void navigate({
              to: destination.to,
              search: destination.search,
              replace: true,
            }),
          1_200,
        );
      })
      .catch((error) => {
        setStatus("error");
        setMessage(instagramOAuthFailureFromUnknown(error));
      });
  }, [destination.search, destination.to, navigate, search]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#dfeaff] px-5">
      <div className="w-full max-w-md rounded-[32px] border border-white/80 bg-white p-8 text-center shadow-[0_30px_80px_-35px_rgba(23,33,58,0.5)]">
        <div className="mx-auto flex size-16 items-center justify-center rounded-3xl bg-[#f7f8fc]">
          {status === "loading" ? (
            <LoaderCircle className="size-8 animate-spin text-[#3478f6]" />
          ) : status === "success" ? (
            <CheckCircle2 className="size-8 text-emerald-500" />
          ) : (
            <XCircle className="size-8 text-rose-500" />
          )}
        </div>
        <h1 className="mt-5 font-display text-3xl text-[#17213a]">Instagram</h1>
        <p className="mt-2 text-sm leading-relaxed text-[#17213a]/65">{message}</p>
        {status === "error" && (
          <Link
            to={destination.to}
            search={destination.search}
            className="mt-6 inline-flex rounded-xl bg-[#3478f6] px-5 py-2.5 text-sm font-semibold text-white"
          >
            {destination.label}
          </Link>
        )}
      </div>
    </main>
  );
}
