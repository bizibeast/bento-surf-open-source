import { createFileRoute } from "@tanstack/react-router";
import { Bot, Check, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AuthShell } from "@/components/AuthShell";
import { supabase } from "@/integrations/supabase/client";
import { requireAuthenticatedCreator } from "@/lib/auth-entry";
import { useWebMcpTools, webMcpResult } from "@/lib/webmcp";

type AuthorizationDetails = {
  authorization_id: string;
  client: { name?: string; client_name?: string };
  redirect_uri: string;
  scope: string;
};

export const Route = createFileRoute("/oauth/consent")({
  validateSearch: (search) => ({
    authorization_id:
      typeof search.authorization_id === "string" ? search.authorization_id.slice(0, 512) : "",
  }),
  beforeLoad: async ({ location }) => {
    await requireAuthenticatedCreator(location.pathname, location.href);
  },
  head: () => ({ meta: [{ title: "Connect AI agent | bento.surf" }] }),
  component: OAuthConsentPage,
});

function OAuthConsentPage() {
  const { authorization_id: authorizationId } = Route.useSearch();
  const [details, setDetails] = useState<AuthorizationDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState<"approve" | "deny" | null>(null);

  useEffect(() => {
    if (!authorizationId) {
      setError("This authorization request is missing its ID.");
      return;
    }
    let active = true;
    void supabase.auth.oauth.getAuthorizationDetails(authorizationId).then(({ data, error }) => {
      if (!active) return;
      if (error || !data) {
        setError(error?.message || "This authorization request is invalid or expired.");
        return;
      }
      if (!("authorization_id" in data)) {
        window.location.assign(data.redirect_url);
        return;
      }
      setDetails(data as AuthorizationDetails);
    });
    return () => {
      active = false;
    };
  }, [authorizationId]);

  const respond = async (nextDecision: "approve" | "deny") => {
    if (!authorizationId) return;
    setDecision(nextDecision);
    setError(null);
    const result =
      nextDecision === "approve"
        ? await supabase.auth.oauth.approveAuthorization(authorizationId, {
            skipBrowserRedirect: true,
          })
        : await supabase.auth.oauth.denyAuthorization(authorizationId, {
            skipBrowserRedirect: true,
          });
    if (result.error || !result.data?.redirect_url) {
      setDecision(null);
      setError(result.error?.message || "Bento could not complete this authorization.");
      return;
    }
    window.location.assign(result.data.redirect_url);
  };

  const clientName = details?.client.name || details?.client.client_name || "AI agent";
  const scopes = useMemo(() => details?.scope.split(/\s+/).filter(Boolean) || [], [details?.scope]);
  const webMcpTools = useMemo(
    () => [
      {
        name: "bento_get_oauth_authorization_request",
        title: "OAuth authorization request",
        description:
          "Reads the visible Bento OAuth authorization request so the user can understand it. Approval and denial remain explicit button actions for the user.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: () =>
          webMcpResult("Loaded the visible OAuth authorization request.", {
            status: error ? "error" : details ? "ready" : "loading",
            clientName,
            scopes,
            returnAddress: details?.redirect_uri ?? null,
            error,
          }),
      },
    ],
    [clientName, details, error, scopes],
  );
  useWebMcpTools(webMcpTools);

  return (
    <AuthShell>
      <div className="flex size-12 items-center justify-center rounded-2xl bg-black text-white">
        <Bot className="size-5" aria-hidden="true" />
      </div>
      <h1 className="mt-6 font-display text-4xl leading-none sm:text-5xl">Connect {clientName}</h1>
      <p className="mt-4 text-sm leading-6 text-black/55">
        This agent wants to use Bento on your behalf. It can only access your workspace and the
        actions exposed by Bento’s MCP server.
      </p>

      {details && (
        <div className="mt-6 rounded-2xl border border-black/10 bg-black/[0.02] p-4">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-semibold">Requested access</p>
              <ul className="mt-2 space-y-1 text-sm text-black/55">
                {scopes.length ? (
                  scopes.map((scope) => <li key={scope}>• {scope}</li>)
                ) : (
                  <li>• Bento workspace access</li>
                )}
              </ul>
              <p className="mt-3 break-all text-xs text-black/40">
                Return address: {details.redirect_uri}
              </p>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div
          className="mt-5 rounded-xl border border-red-500/15 bg-red-50 px-4 py-3 text-sm text-red-700"
          role="alert"
        >
          {error}
        </div>
      )}

      {!details && !error && (
        <p className="mt-6 text-sm text-black/50" role="status">
          Loading authorization request…
        </p>
      )}

      {details && (
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            disabled={decision !== null}
            onClick={() => void respond("deny")}
            className="inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-black/10 px-4 text-sm font-medium transition hover:bg-black/[0.04] disabled:opacity-50"
          >
            <X className="size-4" aria-hidden="true" />
            {decision === "deny" ? "Denying…" : "Deny"}
          </button>
          <button
            type="button"
            disabled={decision !== null}
            onClick={() => void respond("approve")}
            className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-black px-4 text-sm font-medium text-white transition hover:bg-black/85 disabled:opacity-50"
          >
            <Check className="size-4" aria-hidden="true" />
            {decision === "approve" ? "Connecting…" : "Allow access"}
          </button>
        </div>
      )}

      <p className="mt-6 text-xs leading-5 text-black/40">
        You can revoke this connection later from your Bento account.
      </p>
    </AuthShell>
  );
}
