import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { useEffect, useRef, useState } from "react";
import { completeGranolaContentConnection } from "@/lib/content-connections.functions";
import { settingsIntegrationsSearch } from "@/lib/settings-integrations";

export const Route = createFileRoute("/integrations/granola/callback")({
  ssr: false,
  pendingMs: 0,
  validateSearch: z.object({
    code: z.string().max(4_000).optional(),
    state: z.string().max(100).optional(),
    error: z.string().max(200).optional(),
    error_description: z.string().max(500).optional(),
  }),
  component: GranolaCallback,
});

function GranolaCallback() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const started = useRef(false);
  const [message, setMessage] = useState("Connecting Granola…");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (search.error || !search.code || !search.state) {
      setMessage(search.error_description || "Granola connection was cancelled.");
      return;
    }
    void completeGranolaContentConnection({ data: { code: search.code, state: search.state } })
      .then(() =>
        navigate({
          to: "/settings",
          search: settingsIntegrationsSearch("knowledge"),
          replace: true,
        }),
      )
      .catch((error) =>
        setMessage(error instanceof Error ? error.message : "Granola connection failed."),
      );
  }, [navigate, search.code, search.error, search.error_description, search.state]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7f9fd] px-6">
      <p className="rounded-2xl bg-white px-6 py-5 text-sm text-[#17213a] shadow-sm">{message}</p>
    </main>
  );
}
