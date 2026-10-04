import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, RefreshCw, Trash2, Unplug } from "lucide-react";
import { SiGithub, SiNotion } from "react-icons/si";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  beginContentKnowledgeConnection,
  deleteContentKnowledgeData,
  disconnectContentKnowledgeConnection,
  getContentKnowledgeResources,
  syncContentKnowledgeConnection,
  updateContentKnowledgeResources,
} from "@/lib/content-connections.functions";
import type { ContentProvider } from "@/lib/content-connections";
import { micro } from "@/lib/micro-app-ui";

function GranolaLogo({ className }: { className?: string }) {
  return <img src="/brands/granola.png" alt="" className={className} />;
}

function SlackLogo({ className }: { className?: string }) {
  return <img src="/brands/slack.png" alt="" className={className} />;
}

const providers = {
  notion: {
    label: "Notion",
    description: "Use selected pages as context for ideas and drafts.",
    color: "#111111",
    icon: SiNotion,
  },
  granola: {
    label: "Granola",
    description: "Use meeting notes and available transcripts.",
    color: "#111111",
    icon: GranolaLogo,
  },
  github: {
    label: "GitHub",
    description: "Use activity from repositories selected in the GitHub App.",
    color: "#181717",
    icon: SiGithub,
  },
  slack: {
    label: "Slack",
    description: "Use selected joined public channels. Direct messages stay private.",
    color: "#111111",
    icon: SlackLogo,
  },
} as const;

export type KnowledgeConnectionView = {
  id: string;
  provider: string;
  displayName: string | null;
  status: string;
  selectedResources: Record<string, unknown>;
  lastSuccessAt: string | null;
  lastError: string | null;
};

export function KnowledgeIntegrationCard({
  provider,
  connection,
  ready,
  onChanged,
}: {
  provider: ContentProvider;
  connection: KnowledgeConnectionView | null;
  ready: boolean;
  onChanged: () => void;
}) {
  const definition = providers[provider];
  const Icon = definition.icon;
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const connected = connection?.status === "active";
  const resources = useQuery({
    queryKey: ["content-knowledge-resources", connection?.id],
    queryFn: () => getContentKnowledgeResources({ data: { id: connection?.id || "" } }),
    enabled: open && connected,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!resources.data) return;
    setSelected(new Set(resources.data.selectedIds));
  }, [resources.data]);

  const connect = useMutation({
    mutationFn: () => beginContentKnowledgeConnection({ data: { provider } }),
    onSuccess: ({ url }) => window.open(url, "_blank", "noopener,noreferrer"),
    onError: showError,
  });
  const save = useMutation({
    mutationFn: () =>
      updateContentKnowledgeResources({
        data: { id: connection?.id || "", resourceIds: [...selected] },
      }),
    onSuccess: async () => {
      await resources.refetch();
      onChanged();
      toast.success(`${definition.label} sources saved`);
    },
    onError: showError,
  });
  const sync = useMutation({
    mutationFn: () => syncContentKnowledgeConnection({ data: { id: connection?.id || "" } }),
    onSuccess: (result) => {
      onChanged();
      toast.success(`Imported ${result.imported} ${definition.label} items`);
    },
    onError: showError,
  });
  const disconnect = useMutation({
    mutationFn: () => disconnectContentKnowledgeConnection({ data: { id: connection?.id || "" } }),
    onSuccess: () => {
      setOpen(false);
      onChanged();
      toast.success(`${definition.label} disconnected`);
    },
    onError: showError,
  });
  const deleteData = useMutation({
    mutationFn: (includeConfirmedBrain: boolean) =>
      deleteContentKnowledgeData({
        data: { id: connection?.id || "", includeConfirmedBrain },
      }),
    onSuccess: () => {
      setOpen(false);
      onChanged();
      toast.success(`${definition.label} data deleted`);
    },
    onError: showError,
  });

  const status = connected
    ? connection.displayName || "Connected"
    : connection?.status === "expired"
      ? "Reconnect"
      : ready
        ? "Available"
        : "Setup pending";
  const resourceRows = useMemo(() => resources.data?.resources || [], [resources.data]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Manage ${definition.label} integration, ${connected ? "connected" : "not connected"}`}
        className="group flex min-h-28 min-w-0 flex-col items-center rounded-xl px-1 py-2 text-center outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-[#f7f9fd] active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-[#3478f6]/35"
      >
        <span
          className="relative flex size-14 items-center justify-center rounded-[18px] bg-white shadow-sm ring-1 ring-black/[0.08] transition-[box-shadow,transform] duration-150 ease-out group-hover:-translate-y-0.5 group-hover:shadow-md"
          style={{ color: definition.color }}
        >
          <Icon className="size-7" />
          {connected && (
            <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-lg bg-emerald-500 text-white ring-2 ring-white">
              <Check className="size-3" strokeWidth={3} />
            </span>
          )}
        </span>
        <span className="mt-2.5 text-xs font-semibold text-[#17213a]">{definition.label}</span>
        <span className="mt-0.5 max-w-full truncate text-[10px] text-[#17213a]/48">{status}</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg rounded-[24px] p-0">
          <div className="border-b border-black/[0.06] p-5 sm:p-6">
            <DialogHeader>
              <div className="flex items-center gap-4 pr-10 text-left">
                <span
                  className="flex size-14 items-center justify-center rounded-[18px] bg-white shadow-sm ring-1 ring-black/[0.08]"
                  style={{ color: definition.color }}
                >
                  <Icon className="size-7" />
                </span>
                <div>
                  <DialogTitle className="font-ui-display text-2xl text-[#17213a]">
                    {definition.label}
                  </DialogTitle>
                  <DialogDescription className="mt-1 text-left">
                    {definition.description}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
          </div>
          <div className="space-y-4 p-5 sm:p-6">
            {!ready ? (
              <p className="rounded-xl bg-[#f7f9fd] p-4 text-sm text-[#17213a]/60">
                Awaiting secure provider configuration.
              </p>
            ) : !connected ? (
              <button
                type="button"
                disabled={connect.isPending}
                onClick={() => connect.mutate()}
                className={`${micro.btnPrimary} w-full justify-center`}
              >
                Connect {definition.label}
              </button>
            ) : (
              <>
                <div className="flex items-center justify-between rounded-xl bg-[#f7f9fd] p-4">
                  <div>
                    <p className="text-sm font-semibold text-[#17213a]">
                      {connection.displayName || `${definition.label} account`}
                    </p>
                    <p className={micro.mutedXs}>Connected</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={connect.isPending}
                      onClick={() => connect.mutate()}
                      className={micro.btnOutline}
                    >
                      Replace connection
                    </button>
                    <button
                      type="button"
                      aria-label={`Disconnect ${definition.label}`}
                      onClick={() => disconnect.mutate()}
                      className="inline-flex size-10 items-center justify-center rounded-lg text-[#17213a]/45 hover:bg-white"
                    >
                      <Unplug className="size-4" />
                    </button>
                  </div>
                </div>

                <fieldset className="max-h-56 overflow-y-auto rounded-xl border border-black/[0.07] p-3">
                  <legend className="px-1 text-xs font-semibold text-[#17213a]">Sources</legend>
                  {resources.isLoading ? (
                    <p className={micro.mutedXs}>Loading available sources…</p>
                  ) : resourceRows.length ? (
                    <div className="grid gap-2">
                      {resourceRows.map((resource) => (
                        <label
                          key={resource.id}
                          className="flex items-center gap-2 text-sm text-[#17213a]"
                        >
                          <input
                            type="checkbox"
                            aria-label={resource.name}
                            checked={selected.has(resource.id)}
                            onChange={(event) => {
                              const next = new Set(selected);
                              if (event.target.checked) next.add(resource.id);
                              else next.delete(resource.id);
                              setSelected(next);
                            }}
                          />
                          <span className="truncate">{resource.name}</span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className={micro.mutedXs}>No provider-visible sources yet.</p>
                  )}
                </fieldset>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={save.isPending || resources.isLoading}
                    onClick={() => save.mutate()}
                    className={micro.btnPrimaryCompact}
                  >
                    Save sources
                  </button>
                  <button
                    type="button"
                    disabled={sync.isPending || !selected.size}
                    onClick={() => sync.mutate()}
                    className={micro.btnOutline}
                  >
                    <RefreshCw className={`size-4 ${sync.isPending ? "animate-spin" : ""}`} />
                    Sync now
                  </button>
                </div>

                {connection.lastError && (
                  <p className="rounded-xl bg-rose-50 p-3 text-xs text-rose-700">
                    {connection.lastError}
                  </p>
                )}

                <DeleteProviderData
                  label={definition.label}
                  pending={deleteData.isPending}
                  onDelete={(includeConfirmed) => deleteData.mutate(includeConfirmed)}
                />
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DeleteProviderData({
  label,
  pending,
  onDelete,
}: {
  label: string;
  pending: boolean;
  onDelete: (includeConfirmed: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between border-t border-black/[0.06] pt-4">
      <span className={micro.mutedXs}>Remove imported source records and Brain suggestions.</span>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <button type="button" className={micro.btnOutline} disabled={pending}>
            <Trash2 className="size-4" /> Delete data
          </button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {label} data?</AlertDialogTitle>
            <AlertDialogDescription>
              Suggested items will be removed. Confirmed or locked Brain items stay unless you
              choose full deletion.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => onDelete(false)}>
              Delete cached data
            </AlertDialogAction>
            <AlertDialogAction onClick={() => onDelete(true)}>
              Delete all provider data
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function showError(error: unknown) {
  toast.error(error instanceof Error ? error.message : "The integration could not be updated.");
}
