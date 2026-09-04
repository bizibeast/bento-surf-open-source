import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, LoaderCircle, XCircle } from "lucide-react";
import { z } from "zod";
import { completeSocialConnection } from "@/lib/social-oauth.functions";
import { SOCIAL_PROVIDERS, SOCIAL_PROVIDER_DEFINITIONS } from "@/lib/social-scheduler";
import {
  resolveFacebookConnectionReturn,
  resolveTwitterConnectionReturn,
  settingsIntegrationsSearch,
} from "@/lib/settings-integrations";

const callbackProviders = SOCIAL_PROVIDERS.filter((provider) => provider !== "instagram");

export const Route = createFileRoute("/integrations/social/$provider/callback")({
  ssr: false,
  pendingMs: 0,
  params: {
    parse: (params) => ({
      provider: z
        .enum(
          callbackProviders as [
            (typeof callbackProviders)[number],
            ...(typeof callbackProviders)[number][],
          ],
        )
        .parse(params.provider),
    }),
  },
  validateSearch: z.object({
    code: z.string().max(4_000).optional(),
    state: z.string().max(100).optional(),
    error: z.string().max(200).optional(),
    error_description: z.string().max(1_000).optional(),
  }),
  component: SocialCallback,
});

function SocialCallback() {
  const search = Route.useSearch();
  const { provider } = Route.useParams();
  const navigate = useNavigate();
  const started = useRef(false);
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const definition = SOCIAL_PROVIDER_DEFINITIONS[provider];
  const [message, setMessage] = useState(`Connecting ${definition.name}…`);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (search.error || !search.code || !search.state) {
      setStatus("error");
      setMessage(search.error_description || `${definition.name} connection was cancelled.`);
      return;
    }
    void completeSocialConnection({ data: { provider, code: search.code, state: search.state } })
      .then(({ connected }) => {
        setStatus("success");
        setMessage(
          `${connected} ${definition.name} account${connected === 1 ? "" : "s"} connected.`,
        );
        window.setTimeout(() => {
          const twitterReturn =
            provider === "twitter"
              ? window.sessionStorage.getItem("twitterConnectionReturnTo")
              : null;
          if (twitterReturn) {
            window.sessionStorage.removeItem("twitterConnectionReturnTo");
            const destination = resolveTwitterConnectionReturn(twitterReturn);
            void navigate({
              to: destination.to,
              search: destination.search,
              replace: true,
            });
            return;
          }
          const facebookReturn =
            provider === "facebook"
              ? window.sessionStorage.getItem("facebookConnectionReturnTo")
              : null;
          if (facebookReturn) {
            window.sessionStorage.removeItem("facebookConnectionReturnTo");
            const destination = resolveFacebookConnectionReturn(facebookReturn);
            void navigate({
              to: destination.to,
              search: destination.search,
              replace: true,
            });
            return;
          }
          void navigate({
            to: "/settings",
            search: settingsIntegrationsSearch("social"),
            replace: true,
          });
        }, 1_000);
      })
      .catch((error) => {
        setStatus("error");
        setMessage(
          error instanceof Error ? error.message : `${definition.name} connection failed.`,
        );
      });
  }, [
    definition.name,
    navigate,
    provider,
    search.code,
    search.error,
    search.error_description,
    search.state,
  ]);

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
        <h1 className="mt-5 font-display text-3xl text-[#17213a]">{definition.name}</h1>
        <p className="mt-2 text-sm leading-relaxed text-[#17213a]/65">{message}</p>
        {status === "error" && (
          <Link
            to="/settings"
            search={settingsIntegrationsSearch("social")}
            className="mt-6 inline-flex rounded-xl bg-[#3478f6] px-5 py-2.5 text-sm font-semibold text-white"
          >
            Back to Integrations
          </Link>
        )}
      </div>
    </main>
  );
}
