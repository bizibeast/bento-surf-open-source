import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { useEffect, useRef, useState } from "react";
import { completeGitHubContentConnection } from "@/lib/content-connections.functions";
import { settingsIntegrationsSearch } from "@/lib/settings-integrations";

export const Route = createFileRoute("/integrations/github/callback")({
  ssr: false,
  pendingMs: 0,
  validateSearch: z.object({
    installation_id: z.string().max(20).optional(),
    setup_action: z.string().max(50).optional(),
    state: z.string().max(100).optional(),
  }),
  component: GitHubCallback,
});

function GitHubCallback() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const started = useRef(false);
  const [message, setMessage] = useState("Connecting GitHub…");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!search.installation_id || !search.state) {
      setMessage("GitHub App installation was cancelled.");
      return;
    }
    void completeGitHubContentConnection({
      data: { installationId: search.installation_id, state: search.state },
    })
      .then(() =>
        navigate({
          to: "/settings",
          search: settingsIntegrationsSearch("knowledge"),
          replace: true,
        }),
      )
      .catch((error) =>
        setMessage(error instanceof Error ? error.message : "GitHub connection failed."),
      );
  }, [navigate, search.installation_id, search.state]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7f9fd] px-6">
      <p className="rounded-2xl bg-white px-6 py-5 text-sm text-[#17213a] shadow-sm">{message}</p>
    </main>
  );
}
