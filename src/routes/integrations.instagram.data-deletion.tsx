import { createFileRoute, Link } from "@tanstack/react-router";
import { CircleAlert, CheckCircle2, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { BentoBrand } from "@/components/BentoBrand";

export const Route = createFileRoute("/integrations/instagram/data-deletion")({
  validateSearch: z.object({ code: z.string().optional() }),
  component: InstagramDataDeletionStatus,
});

type DeletionStatus = "checking" | "completed" | "not_found" | "unavailable";

function InstagramDataDeletionStatus() {
  const { code } = Route.useSearch();
  const [status, setStatus] = useState<DeletionStatus>("checking");

  useEffect(() => {
    if (!code) {
      setStatus("not_found");
      return;
    }
    const controller = new AbortController();
    void fetch(
      `/api/integrations/instagram/data-deletion/status?code=${encodeURIComponent(code)}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then((response) => {
        if (response.ok) return response.json() as Promise<{ status?: string }>;
        if (response.status === 404) return { status: "not_found" };
        return { status: "unavailable" };
      })
      .then((result) => {
        if (result.status === "completed") setStatus("completed");
        else if (result.status === "not_found") setStatus("not_found");
        else setStatus("unavailable");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus("unavailable");
      });
    return () => controller.abort();
  }, [code]);

  const completed = status === "completed";
  const checking = status === "checking";

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#dfeaff] px-5">
      <div className="w-full max-w-md rounded-[32px] border border-white/80 bg-white p-8 text-center shadow-[0_30px_80px_-35px_rgba(23,33,58,0.5)]">
        {completed ? (
          <CheckCircle2 className="mx-auto size-12 text-emerald-500" />
        ) : checking ? (
          <LoaderCircle className="mx-auto size-12 animate-spin text-[#3478f6]" />
        ) : (
          <CircleAlert className="mx-auto size-12 text-amber-500" />
        )}
        <h1 className="mt-5 font-display text-3xl text-[#17213a]">
          {completed
            ? "Instagram data removed"
            : checking
              ? "Checking deletion status"
              : "Deletion status unavailable"}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-[#17213a]/65">
          {completed
            ? "The Instagram connection, stored access token, automations and delivery history have been deleted from bento.surf."
            : checking
              ? "We are verifying this confirmation code."
              : "This confirmation code is invalid, expired, or cannot be verified right now."}
        </p>
        {completed && code && (
          <p className="mt-4 break-all text-xs text-[#17213a]/45">Confirmation: {code}</p>
        )}
        <Link to="/" className="mt-6 inline-flex text-sm font-semibold text-[#3478f6]">
          <BentoBrand iconClassName="size-5" />
        </Link>
      </div>
    </main>
  );
}
