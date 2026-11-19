import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GranolaMcpGatewaySettings } from "./GranolaMcpGatewaySettings";
import {
  approveHeyGenGeneration,
  getExternalToolConnections,
  removeExternalToolConnection,
  reviewHeyGenGeneration,
  saveExternalToolConnection,
} from "@/lib/external-tools.functions";
import { heyGenJobInput } from "@/lib/external-tools";
import { getWorkspaceSession, switchWorkspace } from "@/lib/workspace.functions";

const providers = [
  {
    id: "heygen",
    name: "HeyGen",
    keyLabel: "Scoped HeyGen API key",
    description:
      "Browse compatible avatars and voices, and generate videos after you approve each request. Your connected HeyGen account pays for generation.",
    help: "Create a scoped key with Read for Avatars and Voices, and Write for Videos.",
    docs: "https://developers.heygen.com/docs/api-key-permissions",
  },
  {
    id: "github_mcp",
    name: "GitHub MCP",
    keyLabel: "Fine-grained GitHub personal access token",
    description:
      "Let your Bento MCP clients check your GitHub login and read pull requests from one repository you approve.",
    help: "Use a fine-grained token. If you approve a repository, limit the token to that repository and give it read access to pull requests.",
    docs: "https://docs.github.com/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
  },
] as const;

function ProviderConnection({
  provider,
  connected,
  approvedRepository,
  workspaceId,
}: {
  provider: (typeof providers)[number];
  connected: boolean;
  approvedRepository?: string;
  workspaceId: string;
}) {
  const queryClient = useQueryClient();
  const [credential, setCredential] = useState("");
  const [repository, setRepository] = useState(approvedRepository ?? "");
  const [consent, setConsent] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["external-tool-connections", workspaceId] });

  const disconnect = useMutation({
    mutationFn: () => removeExternalToolConnection({ data: { provider: provider.id } }),
    onSuccess: async () => {
      setEditing(false);
      await refresh();
    },
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!consent || !credential.trim() || saving) return;
    setSaving(true);
    setSaveError(null);
    setCredential("");
    setConsent(false);
    try {
      await saveExternalToolConnection({
        data: {
          provider: provider.id,
          credential,
          consent: true,
          ...(provider.id === "github_mcp" && repository.trim()
            ? { githubRepository: repository.trim() }
            : {}),
        },
      });
      setEditing(false);
      await refresh();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "The connection could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{provider.name}</h3>
        <span className="text-xs text-muted-foreground">
          {connected ? "Connected" : "Disconnected"}
        </span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{provider.description}</p>
      {approvedRepository && connected && !editing && (
        <p className="mt-2 text-sm text-muted-foreground">
          Approved repository: {approvedRepository}
        </p>
      )}
      {connected && !editing ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
            Replace key
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            Disconnect
          </Button>
        </div>
      ) : (
        <form className="mt-4 grid gap-3" onSubmit={submit}>
          <Label htmlFor={`external-key-${provider.id}`}>{provider.keyLabel}</Label>
          <Input
            id={`external-key-${provider.id}`}
            type="password"
            autoComplete="off"
            required
            value={credential}
            maxLength={512}
            onChange={(event) => setCredential(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {provider.help}{" "}
            <a
              className="underline underline-offset-2"
              href={provider.docs}
              target="_blank"
              rel="noreferrer"
            >
              Provider documentation
            </a>
          </p>
          {provider.id === "github_mcp" && (
            <>
              <Label htmlFor="external-github-repository">Approved repository (optional)</Label>
              <Input
                id="external-github-repository"
                placeholder="owner/repository"
                maxLength={140}
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
              />
            </>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input
              className="mt-0.5"
              type="checkbox"
              checked={consent}
              required
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>
              Allow my authorized Bento MCP clients to use this connection in this workspace.
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={!consent || !credential.trim() || saving}>
              {saving ? "Connecting…" : `Connect ${provider.name}`}
            </Button>
            {editing ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditing(false);
                  setCredential("");
                  setConsent(false);
                  setRepository(approvedRepository ?? "");
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      )}
      {saveError || disconnect.isError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {saveError ?? disconnect.error?.message ?? "The connection could not be updated."}
        </p>
      ) : null}
    </div>
  );
}

function HeyGenApproval({ jobId, workspaceId }: { jobId: string; workspaceId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["external-tool-heygen-review", workspaceId, jobId] as const;
  const review = useQuery({
    queryKey,
    queryFn: () => reviewHeyGenGeneration({ data: { jobId } }),
    retry: false,
  });
  const approve = useMutation({
    mutationFn: () => approveHeyGenGeneration({ data: { jobId } }),
    onSuccess: (result) => queryClient.setQueryData(queryKey, result),
  });
  const [consent, setConsent] = useState(false);
  if (review.isPending)
    return <p className="text-sm text-muted-foreground">Loading HeyGen request…</p>;
  if (!review.data)
    return (
      <p role="alert" className="text-sm text-destructive">
        This HeyGen request is unavailable. Select the workspace where the request was prepared.
      </p>
    );
  const job = review.data;
  return (
    <div className="grid gap-3 rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium">Review HeyGen generation</h3>
      <dl className="space-y-1 text-sm">
        <div>
          <dt className="inline text-muted-foreground">Avatar </dt>
          <dd className="inline">{job.avatarName}</dd>
        </div>
        <div>
          <dt className="inline text-muted-foreground">Voice </dt>
          <dd className="inline">{job.voiceName}</dd>
        </div>
        <div>
          <dt className="inline text-muted-foreground">Output </dt>
          <dd className="inline">{job.model}</dd>
        </div>
        <div>
          <dt className="inline text-muted-foreground">Estimate </dt>
          <dd className="inline">
            {job.estimatedRenderSeconds} seconds ·
            {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
              job.estimatedUsd,
            )}
          </dd>
        </div>
      </dl>
      <blockquote className="whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-sm">
        {job.script}
      </blockquote>
      {job.status === "awaiting_approval" ? (
        <>
          <p className="text-sm text-muted-foreground">
            HeyGen bills your connected account for the actual video duration. One approval covers
            this exact request.
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>
              I have permission to use the selected avatar and voice, and approve the HeyGen charge.
            </span>
          </label>
          <Button
            type="button"
            className="w-fit"
            size="sm"
            disabled={!consent || approve.isPending}
            onClick={() => approve.mutate()}
          >
            Approve HeyGen charge
          </Button>
          {approve.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {approve.error.message}
            </p>
          ) : null}
        </>
      ) : job.status === "approved" ? (
        <p role="status" className="text-sm">
          Approved. Return to the client that prepared this request to start generation.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">Status {job.status.replaceAll("_", " ")}</p>
      )}
    </div>
  );
}

export function ExternalToolSettings() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const search = useRouterState({ select: (state) => state.location.search }) as Record<
    string,
    unknown
  >;
  const job = heyGenJobInput.safeParse({ jobId: search.heygenJob });
  const session = useQuery({
    queryKey: ["workspace-session"],
    queryFn: () => getWorkspaceSession(),
    staleTime: 60_000,
  });
  const workspaceId = session.data?.workspaceId;
  const settings = useQuery({
    queryKey: ["external-tool-connections", workspaceId],
    queryFn: () => getExternalToolConnections(),
    enabled: session.data?.workspace.status === "active",
    retry: false,
  });
  const target = session.data?.workspaces.find(
    (workspace) => workspace.id === search.heygenWorkspace && workspace.status === "active",
  );
  const changeWorkspace = useMutation({
    mutationFn: (nextWorkspaceId: string) =>
      switchWorkspace({ data: { workspaceId: nextWorkspaceId } }),
    onSuccess: async () => {
      await queryClient.cancelQueries();
      queryClient.clear();
      await router.invalidate();
    },
  });
  if (!settings.data?.enabled || !workspaceId) return null;
  return (
    <section aria-label="External tools" className="grid gap-4">
      <div>
        <h2 className="text-base font-semibold">External tools</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Each connection belongs to you in{" "}
          {session.data?.workspace.displayName ?? "this Bento workspace"}.
        </p>
      </div>
      {job.success ? (
        target && target.id !== workspaceId ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
            <p className="text-sm">This HeyGen request was prepared in {target.displayName}.</p>
            <Button
              type="button"
              size="sm"
              disabled={changeWorkspace.isPending}
              onClick={() => changeWorkspace.mutate(target.id)}
            >
              Switch workspace
            </Button>
            {changeWorkspace.isError ? (
              <p role="alert" className="text-sm text-destructive">
                Could not switch workspaces.
              </p>
            ) : null}
          </div>
        ) : (
          <HeyGenApproval
            key={`${workspaceId}:${job.data.jobId}`}
            jobId={job.data.jobId}
            workspaceId={workspaceId}
          />
        )
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {providers.map((provider) => (
          <ProviderConnection
            key={`${workspaceId}:${provider.id}`}
            provider={provider}
            connected={settings.data.connections.some(
              (connection) => connection.provider === provider.id,
            )}
            approvedRepository={
              provider.id === "github_mcp"
                ? settings.data.connections
                    .find((connection) => connection.provider === provider.id)
                    ?.capabilities.find((capability) => capability.startsWith("pull_request_read:"))
                    ?.slice("pull_request_read:".length)
                : undefined
            }
            workspaceId={workspaceId}
          />
        ))}
      </div>
      <GranolaMcpGatewaySettings key={workspaceId} workspaceId={workspaceId} />
    </section>
  );
}
