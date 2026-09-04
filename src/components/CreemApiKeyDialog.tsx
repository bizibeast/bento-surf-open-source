import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Copy, ExternalLink, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  configureCreemWebhook,
  connectCreemApiKey,
  getMyCreemConnection,
} from "@/integrations/creem/connection.functions";

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-semibold">{label}</div>
      <div className="mt-1.5 flex items-center gap-2 rounded-xl bg-card px-3 py-2.5 ring-1 ring-border">
        <code className="min-w-0 flex-1 break-all text-[11px] text-muted-foreground">{value}</code>
        <button
          type="button"
          className="shrink-0 text-muted-foreground transition hover:text-foreground"
          aria-label={`Copy ${label}`}
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            toast.success(`${label} copied`);
          }}
        >
          <Copy className="size-4" />
        </button>
      </div>
    </div>
  );
}

export function CreemApiKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [replaceKey, setReplaceKey] = useState(false);
  const [environment, setEnvironment] = useState<"test" | "production">(() =>
    import.meta.env.VITE_APP_ENV === "production" ? "production" : "test",
  );
  const connectionQuery = useQuery({
    queryKey: ["my-creem-connection"],
    queryFn: () => getMyCreemConnection(),
    enabled: open,
  });
  const connection = connectionQuery.data;

  useEffect(() => {
    if (!open) {
      setApiKey("");
      setWebhookSecret("");
      setReplaceKey(false);
    }
  }, [open]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["my-creem-connection"] }),
      queryClient.invalidateQueries({ queryKey: ["creator-payment-settings"] }),
    ]);
  };

  const connect = useMutation({
    mutationFn: () => connectCreemApiKey({ data: { apiKey, environment } }),
    onSuccess: async (next) => {
      setApiKey("");
      setReplaceKey(false);
      queryClient.setQueryData(["my-creem-connection"], next);
      await refresh();
      toast.success(
        next?.webhookReady
          ? "Creem is connected and ready."
          : "API key verified. Add the signed webhook to finish.",
      );
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not connect Creem"),
  });

  const configureWebhook = useMutation({
    mutationFn: () => configureCreemWebhook({ data: { webhookSecret } }),
    onSuccess: async (next) => {
      queryClient.setQueryData(["my-creem-connection"], next);
      setWebhookSecret("");
      await refresh();
      toast.success("Creem webhook saved. Checkout is ready.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not save Creem webhook"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] w-[calc(100vw-1.5rem)] max-w-xl overflow-y-auto rounded-[28px] border-border bg-card p-5 sm:p-7">
        <DialogHeader className="pr-7 text-left">
          <div className="mb-3 flex size-12 items-center justify-center overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/[0.06]">
            <img src="/brands/creem.svg?v=20260721" alt="" className="size-full object-cover" />
          </div>
          <DialogTitle className="font-ui-display text-3xl">Connect Creem</DialogTitle>
          <DialogDescription className="leading-6">
            Sell eligible digital products and subscriptions through your own Creem account. Creem
            handles merchant-of-record checkout and pays you; Bento charges 0% platform fee.
          </DialogDescription>
        </DialogHeader>

        {connectionQuery.isLoading ? (
          <div className="flex min-h-32 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-5">
            {connection?.webhookReady && !replaceKey ? (
              <div className="rounded-2xl bg-tint-mint p-4 ring-1 ring-emerald-500/15">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">Creem is ready</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {connection.environment === "production" ? "Live" : "Test"} checkout and
                      signed fulfillment are enabled.
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-4"
                  onClick={() => setReplaceKey(true)}
                >
                  Replace API key
                </Button>
              </div>
            ) : !connection || replaceKey ? (
              <div className="space-y-4 rounded-2xl bg-muted/45 p-4 ring-1 ring-border/70">
                <div>
                  <div className="text-sm font-semibold">1. Verify your API key</div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    In Creem, open Developers → API Keys. Use a Test key on staging and a Live key
                    on bento.surf.
                  </p>
                </div>
                <label className="block text-xs font-semibold">
                  Environment
                  <select
                    value={environment}
                    onChange={(event) =>
                      setEnvironment(event.target.value as "test" | "production")
                    }
                    className="mt-1.5 h-11 w-full rounded-xl border border-border bg-card px-3 text-sm"
                  >
                    <option value="test">Test</option>
                    <option value="production">Live</option>
                  </select>
                </label>
                <label className="block text-xs font-semibold">
                  API key
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    autoComplete="off"
                    placeholder="Paste your Creem API key"
                    className="mt-1.5"
                  />
                </label>
                <Button
                  type="button"
                  disabled={apiKey.trim().length < 16 || connect.isPending}
                  onClick={() => connect.mutate()}
                >
                  {connect.isPending ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="mr-2 size-4" />
                  )}
                  Verify securely
                </Button>
              </div>
            ) : null}

            {connection && !connection.webhookReady && !replaceKey && (
              <div className="space-y-4 rounded-2xl bg-tint-blue p-4 ring-1 ring-sky-500/15">
                <div>
                  <div className="text-sm font-semibold">2. Add the signed webhook</div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    In Creem, open Developers → Webhooks, add this URL, select the events below,
                    then paste the webhook secret Creem gives you.
                  </p>
                </div>
                <CopyField label="Webhook URL" value={connection.webhookUrl} />
                <CopyField label="Events" value={connection.webhookEvents.join(", ")} />
                <label className="block text-xs font-semibold">
                  Webhook secret
                  <Input
                    type="password"
                    value={webhookSecret}
                    onChange={(event) => setWebhookSecret(event.target.value)}
                    autoComplete="off"
                    placeholder="Paste the Creem webhook secret"
                    className="mt-1.5"
                  />
                </label>
                <Button
                  type="button"
                  disabled={webhookSecret.trim().length < 16 || configureWebhook.isPending}
                  onClick={() => configureWebhook.mutate()}
                >
                  {configureWebhook.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Save webhook and enable checkout
                </Button>
              </div>
            )}

            <a
              href="https://docs.creem.io/api-reference/introduction"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary"
            >
              Open Creem’s official API guide <ExternalLink className="size-3.5" />
            </a>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
