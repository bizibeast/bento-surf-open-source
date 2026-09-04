import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, Loader2, ShieldCheck } from "lucide-react";
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
import { connectDodoApiKey, getMyDodoConnection } from "@/integrations/dodo/connection.functions";

export function DodoApiKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [environment, setEnvironment] = useState<"test_mode" | "live_mode">(
    import.meta.env.VITE_APP_ENV === "production" ? "live_mode" : "test_mode",
  );
  const [replaceKey, setReplaceKey] = useState(false);
  const connectionQuery = useQuery({
    queryKey: ["my-dodo-connection"],
    queryFn: () => getMyDodoConnection(),
    enabled: open,
  });
  const connection = connectionQuery.data;

  useEffect(() => {
    if (!open) {
      setApiKey("");
      setReplaceKey(false);
    }
  }, [open]);

  const connect = useMutation({
    mutationFn: () => connectDodoApiKey({ data: { apiKey, environment } }),
    onSuccess: async (next) => {
      setApiKey("");
      setReplaceKey(false);
      queryClient.setQueryData(["my-dodo-connection"], next);
      await queryClient.invalidateQueries({ queryKey: ["creator-payment-settings"] });
      toast.success(
        next?.chargesEnabled
          ? "Dodo Payments connected and ready."
          : "Dodo connected. Finish business verification in Dodo to accept live payments.",
      );
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not connect Dodo Payments"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] w-[calc(100vw-1.5rem)] max-w-xl overflow-y-auto rounded-[28px] border-border bg-card p-5 sm:p-7">
        <DialogHeader className="pr-7 text-left">
          <div className="mb-3 flex size-12 items-center justify-center overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/[0.06]">
            <img
              src="/brands/dodo-payments.svg?v=20260721"
              alt=""
              className="size-full object-cover"
            />
          </div>
          <DialogTitle className="font-ui-display text-3xl">Connect Dodo Payments</DialogTitle>
          <DialogDescription className="leading-6">
            Dodo is the merchant of record. Checkout, tax handling, invoices, and payouts stay in
            your Dodo business. Bento charges 0% platform fee.
          </DialogDescription>
        </DialogHeader>

        {connectionQuery.isLoading ? (
          <div className="flex min-h-32 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-5">
            {connection && connection.webhookReady && !replaceKey ? (
              <div className="rounded-2xl bg-tint-mint p-4 ring-1 ring-emerald-500/15">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
                  <div className="min-w-0">
                    <p className="font-semibold">Dodo Payments is connected</p>
                    <p className="mt-1 text-sm leading-5 text-muted-foreground">
                      {connection.accountName} ·{" "}
                      {connection.environment === "live_mode" ? "Live" : "Test"} mode
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
            ) : (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  connect.mutate();
                }}
              >
                <div className="rounded-2xl bg-muted/50 p-4 text-sm leading-6">
                  <p className="font-semibold">Create a dedicated API key</p>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
                    <li>Open Dodo Payments → Developer → API keys.</li>
                    <li>Create a new key for Bento and copy it once.</li>
                    <li>
                      Paste it below. Bento verifies your business and creates the signed webhook
                      automatically.
                    </li>
                  </ol>
                  <a
                    href="https://app.dodopayments.com/"
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex items-center gap-1.5 font-semibold text-primary"
                  >
                    Open Dodo API keys <ExternalLink className="size-3.5" />
                  </a>
                </div>
                <div className="grid grid-cols-2 gap-2 rounded-2xl bg-muted/55 p-1.5">
                  {(["test_mode", "live_mode"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setEnvironment(mode)}
                      className={`rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
                        environment === mode
                          ? "bg-card text-foreground shadow-sm"
                          : "text-muted-foreground"
                      }`}
                    >
                      {mode === "test_mode" ? "Test" : "Live"}
                    </button>
                  ))}
                </div>
                <div>
                  <label htmlFor="dodo-api-key" className="text-sm font-semibold">
                    API key
                  </label>
                  <Input
                    id="dodo-api-key"
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="Paste your Dodo API key"
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-2 font-mono"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={apiKey.trim().length < 20 || connect.isPending}>
                    {connect.isPending && <Loader2 className="size-4 animate-spin" />}
                    Verify and connect
                  </Button>
                  {replaceKey && (
                    <Button type="button" variant="outline" onClick={() => setReplaceKey(false)}>
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            )}

            <div className="flex items-start gap-2 rounded-2xl bg-muted/45 p-4 text-xs leading-5 text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-foreground" />
              The API key and webhook secret are encrypted with AES-GCM, used only by server-side
              payment code, and deleted from Bento when you disconnect.
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
