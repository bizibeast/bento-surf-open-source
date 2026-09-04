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
import {
  connectPayPalApiCredentials,
  getMyPayPalConnection,
} from "@/integrations/paypal/connection.functions";

export function PayPalApiCredentialsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [environment, setEnvironment] = useState<"sandbox" | "production">(
    import.meta.env.VITE_APP_ENV === "production" ? "production" : "sandbox",
  );
  const [replaceCredentials, setReplaceCredentials] = useState(false);
  const connectionQuery = useQuery({
    queryKey: ["my-paypal-connection"],
    queryFn: () => getMyPayPalConnection(),
    enabled: open,
  });
  const connection = connectionQuery.data;

  useEffect(() => {
    if (!open) {
      setClientId("");
      setClientSecret("");
      setReplaceCredentials(false);
    }
  }, [open]);

  const connect = useMutation({
    mutationFn: () =>
      connectPayPalApiCredentials({ data: { clientId, clientSecret, environment } }),
    onSuccess: async (next) => {
      setClientId("");
      setClientSecret("");
      setReplaceCredentials(false);
      queryClient.setQueryData(["my-paypal-connection"], next);
      await queryClient.invalidateQueries({ queryKey: ["creator-payment-settings"] });
      toast.success("PayPal connected and ready for one-time checkout.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not connect PayPal"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] w-[calc(100vw-1.5rem)] max-w-xl overflow-y-auto rounded-[28px] border-border bg-card p-5 sm:p-7">
        <DialogHeader className="pr-7 text-left">
          <div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ring-black/[0.06]">
            <img src="/brands/paypal.svg" alt="" className="size-7" />
          </div>
          <DialogTitle className="font-ui-display text-3xl">Connect your PayPal</DialogTitle>
          <DialogDescription className="leading-6">
            Buyers pay your PayPal Business account directly. Bento charges 0% platform fee and
            creates the signed webhook automatically.
          </DialogDescription>
        </DialogHeader>

        {connectionQuery.isLoading ? (
          <div className="flex min-h-32 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-5">
            {connection?.webhookReady && !replaceCredentials ? (
              <div className="rounded-2xl bg-tint-mint p-4 ring-1 ring-emerald-500/15">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
                  <div className="min-w-0">
                    <p className="font-semibold">PayPal is ready</p>
                    <p className="mt-1 text-sm leading-5 text-muted-foreground">
                      {connection.accountName} ·{" "}
                      {connection.environment === "production" ? "Live" : "Sandbox"}
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-4"
                  onClick={() => setReplaceCredentials(true)}
                >
                  Replace credentials
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
                  <p className="font-semibold">Create a dedicated PayPal REST app</p>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
                    <li>Open PayPal Developer → Apps &amp; Credentials.</li>
                    <li>Select Sandbox for staging or Live for production.</li>
                    <li>Create an app for Bento, then copy its Client ID and Client Secret.</li>
                    <li>Paste both below. Bento verifies them and registers its webhook.</li>
                  </ol>
                  <a
                    href="https://developer.paypal.com/link/applications/"
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex items-center gap-1.5 font-semibold text-primary"
                  >
                    Open PayPal Apps &amp; Credentials <ExternalLink className="size-3.5" />
                  </a>
                </div>
                <div className="grid grid-cols-2 gap-2 rounded-2xl bg-muted/55 p-1.5">
                  {(["sandbox", "production"] as const).map((mode) => (
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
                      {mode === "sandbox" ? "Sandbox" : "Live"}
                    </button>
                  ))}
                </div>
                <div>
                  <label htmlFor="paypal-client-id" className="text-sm font-semibold">
                    Client ID
                  </label>
                  <Input
                    id="paypal-client-id"
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                    placeholder="Paste the PayPal Client ID"
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-2 font-mono"
                  />
                </div>
                <div>
                  <label htmlFor="paypal-client-secret" className="text-sm font-semibold">
                    Client Secret
                  </label>
                  <Input
                    id="paypal-client-secret"
                    type="password"
                    value={clientSecret}
                    onChange={(event) => setClientSecret(event.target.value)}
                    placeholder="Paste the PayPal Client Secret"
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-2 font-mono"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    disabled={
                      clientId.trim().length < 20 ||
                      clientSecret.trim().length < 20 ||
                      connect.isPending
                    }
                  >
                    {connect.isPending && <Loader2 className="size-4 animate-spin" />}
                    Verify and connect
                  </Button>
                  {replaceCredentials && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setReplaceCredentials(false)}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            )}

            <div className="flex items-start gap-2 rounded-2xl bg-muted/45 p-4 text-xs leading-5 text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-foreground" />
              Your Client Secret is encrypted with AES-GCM, available only to server-side payment
              code, never returned to the browser, and deleted from Bento when you disconnect.
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
