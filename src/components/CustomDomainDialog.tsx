import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Copy, Globe2, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { UpgradeDialog } from "@/components/UpgradeDialog";
import {
  connectCustomDomain,
  getMyCustomDomain,
  refreshCustomDomain,
  removeCustomDomain,
} from "@/lib/custom-domains.functions";
import { captureProductEvent } from "@/lib/posthog";

export function CustomDomainDialog({
  isPro,
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
}: {
  isPro: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
}) {
  const queryClient = useQueryClient();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [hostname, setHostname] = useState("");
  const queryKey = ["my-custom-domain"];
  const domainQuery = useQuery({
    queryKey,
    queryFn: () => getMyCustomDomain(),
    enabled: open && isPro,
  });

  const updateCache = (value: Awaited<ReturnType<typeof getMyCustomDomain>>) => {
    queryClient.setQueryData(queryKey, value);
  };
  const connect = useMutation({
    mutationFn: () => connectCustomDomain({ data: { hostname } }),
    onSuccess: (value) => {
      updateCache(value);
      captureProductEvent("custom_domain_connected");
      setHostname("");
      toast.success("Domain added. Now update its DNS record.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Unable to connect domain"),
  });
  const refresh = useMutation({
    mutationFn: () => refreshCustomDomain(),
    onSuccess: (value) => {
      updateCache(value);
      toast.success(value.domain?.ready ? "Your domain is live." : "DNS is not active yet.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Unable to check domain"),
  });
  const remove = useMutation({
    mutationFn: () => removeCustomDomain(),
    onSuccess: () => {
      queryClient.setQueryData(queryKey, {
        domain: null,
        cnameTarget: domainQuery.data?.cnameTarget ?? "",
      });
      toast.success("Custom domain removed.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Unable to remove domain"),
  });

  const domain = domainQuery.data?.domain;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {showTrigger && (
        <DialogTrigger asChild>
          <button
            type="button"
            className="block w-full px-4 py-3 text-left transition hover:bg-accent/40"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Custom Domain</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {domain?.hostname ?? (isPro ? "Connect your own domain" : "Available on Creator")}
                </div>
              </div>
              <Globe2 className="size-4 text-muted-foreground" />
            </div>
          </button>
        </DialogTrigger>
      )}
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Custom domain</DialogTitle>
          <DialogDescription>
            Publish your bento at a domain you own. SSL is issued automatically after DNS verifies.
          </DialogDescription>
        </DialogHeader>

        {!isPro ? (
          <div className="space-y-4 rounded-xl border border-border bg-muted/30 p-4">
            <p className="text-sm text-muted-foreground">
              Custom domains are included with Creator. Upgrade to connect and secure your domain.
            </p>
            <UpgradeDialog feature="customDomain" />
          </div>
        ) : domainQuery.isLoading ? (
          <div className="flex min-h-32 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : domainQuery.isError ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {domainQuery.error instanceof Error
              ? domainQuery.error.message
              : "Unable to load custom domain."}
          </div>
        ) : !domain ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              connect.mutate();
            }}
          >
            <div>
              <label htmlFor="custom-domain" className="text-sm font-medium">
                Domain
              </label>
              <Input
                id="custom-domain"
                value={hostname}
                onChange={(event) => setHostname(event.target.value)}
                placeholder="links.example.com"
                autoCapitalize="none"
                autoCorrect="off"
                className="mt-2"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                A subdomain such as links.example.com is the simplest setup. Root domains require
                CNAME flattening, ALIAS, or ANAME support from your DNS provider.
              </p>
            </div>
            <Button type="submit" disabled={!hostname.trim() || connect.isPending}>
              {connect.isPending && <Loader2 className="size-4 animate-spin" />}
              Connect domain
            </Button>
          </form>
        ) : (
          <div className="space-y-5">
            <div className="flex items-start justify-between gap-3 rounded-xl border border-border p-4">
              <div>
                <div className="flex items-center gap-2 font-medium">
                  {domain.hostname}
                  {domain.ready && <CheckCircle2 className="size-4 text-emerald-500" />}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {domain.ready
                    ? "Live with SSL"
                    : `Domain: ${friendlyStatus(domain.status)} · SSL: ${friendlyStatus(domain.sslStatus)}`}
                </p>
              </div>
              {domain.ready && (
                <a
                  href={`https://${domain.hostname}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-medium text-primary hover:underline"
                >
                  Visit
                </a>
              )}
            </div>

            {!domain.ready && (
              <div>
                <h3 className="text-sm font-medium">1. Add this DNS record</h3>
                <DnsRecord
                  type="CNAME"
                  name={domain.hostname}
                  value={domainQuery.data?.cnameTarget ?? ""}
                />

                {domain.verificationRecords.length > 0 && (
                  <>
                    <h3 className="mt-4 text-sm font-medium">2. Add verification records</h3>
                    {domain.verificationRecords.map((record) => (
                      <DnsRecord
                        key={`${record.type}-${record.name}-${record.value}`}
                        type={record.type}
                        name={record.name}
                        value={record.value}
                      />
                    ))}
                  </>
                )}
                <p className="mt-3 text-xs text-muted-foreground">
                  Set the record to DNS-only if your DNS provider offers a proxy. Changes can take a
                  few minutes to propagate.
                </p>
              </div>
            )}

            {domain.lastError && (
              <p className="rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {domain.lastError}
              </p>
            )}

            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              <Button
                variant="outline"
                onClick={() => refresh.mutate()}
                disabled={refresh.isPending}
              >
                <RefreshCw className={`size-4 ${refresh.isPending ? "animate-spin" : ""}`} />
                Check DNS
              </Button>
              <Button
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={remove.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove ${domain.hostname}? Visitors will stop reaching your bento there.`,
                    )
                  ) {
                    remove.mutate();
                  }
                }}
              >
                <Trash2 className="size-4" /> Remove
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DnsRecord({ type, name, value }: { type: string; name: string; value: string }) {
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    toast.success("DNS value copied");
  };
  return (
    <div className="mt-2 grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-lg bg-muted/50 p-2 text-xs">
      <span className="rounded bg-background px-2 py-1 font-medium">{type}</span>
      <div className="min-w-0">
        <div className="truncate text-muted-foreground">{name}</div>
        <div className="truncate font-mono text-[11px] text-foreground">{value}</div>
      </div>
      <button
        type="button"
        aria-label="Copy DNS value"
        onClick={copy}
        className="rounded p-1.5 hover:bg-accent"
      >
        <Copy className="size-3.5" />
      </button>
    </div>
  );
}

function friendlyStatus(status: string) {
  return status.replaceAll("_", " ");
}
