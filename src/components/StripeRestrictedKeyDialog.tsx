import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Copy, ExternalLink, KeyRound, Loader2, ShieldCheck } from "lucide-react";
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
  configureStripeWebhook,
  connectStripeRestrictedKey,
  getMyStripeConnection,
} from "@/integrations/stripe/connection.functions";

export function StripeRestrictedKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [restrictedKey, setRestrictedKey] = useState("");
  const [endpointId, setEndpointId] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [replaceKey, setReplaceKey] = useState(false);
  const connectionQuery = useQuery({
    queryKey: ["my-stripe-connection"],
    queryFn: () => getMyStripeConnection(),
    enabled: open,
  });
  const connection = connectionQuery.data;
  const webhookReady = Boolean(connection?.webhookReady);

  useEffect(() => {
    if (!open) {
      setRestrictedKey("");
      setEndpointId("");
      setSigningSecret("");
      setReplaceKey(false);
    }
  }, [open]);

  const refreshConnections = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["my-stripe-connection"] }),
      queryClient.invalidateQueries({ queryKey: ["creator-payment-settings"] }),
    ]);
  };

  const connect = useMutation({
    mutationFn: () => connectStripeRestrictedKey({ data: { restrictedKey } }),
    onSuccess: async (next) => {
      setRestrictedKey("");
      setReplaceKey(false);
      queryClient.setQueryData(["my-stripe-connection"], next);
      await refreshConnections();
      toast.success(
        next?.webhookReady
          ? "Stripe connected and webhook verified."
          : "Stripe connected. Finish the webhook step below.",
      );
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not connect Stripe"),
  });

  const configureWebhook = useMutation({
    mutationFn: () => configureStripeWebhook({ data: { endpointId, signingSecret } }),
    onSuccess: async (next) => {
      setEndpointId("");
      setSigningSecret("");
      queryClient.setQueryData(["my-stripe-connection"], next);
      await refreshConnections();
      toast.success("Stripe webhook verified. Payments are ready.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not verify webhook"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] w-[calc(100vw-1.5rem)] max-w-xl overflow-y-auto rounded-[28px] border-border bg-card p-5 sm:p-7">
        <DialogHeader className="pr-7 text-left">
          <div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-[#635bff]/10 text-[#635bff]">
            <KeyRound className="size-6" />
          </div>
          <DialogTitle className="font-ui-display text-3xl">Connect your Stripe</DialogTitle>
          <DialogDescription className="leading-6">
            Sales go directly to your Stripe account. Bento charges 0% platform fee and never sees
            your full key again after it is encrypted.
          </DialogDescription>
        </DialogHeader>

        {connectionQuery.isLoading ? (
          <div className="flex min-h-32 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-5">
            {connection && webhookReady && !replaceKey && (
              <div className="rounded-2xl bg-tint-mint p-4 ring-1 ring-emerald-500/15">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
                  <div className="min-w-0">
                    <p className="font-semibold">Stripe is ready</p>
                    <p className="mt-1 text-sm leading-5 text-muted-foreground">
                      {connection.accountName} ·{" "}
                      {connection.environment === "production" ? "Live" : "Test"} mode
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-4"
                  onClick={() => setReplaceKey(true)}
                >
                  Replace restricted key
                </Button>
              </div>
            )}

            {(!connection || replaceKey) && (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  connect.mutate();
                }}
              >
                <div className="rounded-2xl bg-muted/50 p-4 text-sm leading-6">
                  <p className="font-semibold">Create a dedicated restricted key</p>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
                    <li>Open Stripe → Developers → API keys → Create restricted key.</li>
                    <li>
                      Choose custom permissions, then set every permission and Connect permission to
                      None first.
                    </li>
                    <li>
                      Allow Checkout Sessions write; Payment Intents, Charges, and Subscriptions
                      read; Webhook Endpoints write.
                    </li>
                    <li>Copy the key beginning with rk_test_ or rk_live_.</li>
                  </ol>
                  <a
                    href="https://link.stripe.com/apikeys"
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex items-center gap-1.5 font-semibold text-primary"
                  >
                    Open Stripe API keys <ExternalLink className="size-3.5" />
                  </a>
                </div>
                <div>
                  <label htmlFor="stripe-restricted-key" className="text-sm font-semibold">
                    Restricted key
                  </label>
                  <Input
                    id="stripe-restricted-key"
                    type="password"
                    value={restrictedKey}
                    onChange={(event) => setRestrictedKey(event.target.value)}
                    placeholder="rk_test_… or rk_live_…"
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-2 font-mono"
                  />
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    For safety, Bento rejects unrestricted sk_test_ and sk_live_ secret keys.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={!restrictedKey.trim() || connect.isPending}
                    onClick={() => connect.mutate()}
                  >
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

            {connection && !webhookReady && !replaceKey && (
              <form
                className="space-y-4 rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  configureWebhook.mutate();
                }}
              >
                <div>
                  <p className="font-semibold">One manual webhook step remains</p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    Stripe could not create the webhook automatically. In Stripe, create a webhook
                    endpoint with the URL below and select these six events:
                  </p>
                  <ul className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                    {[
                      "checkout.session.completed",
                      "checkout.session.async_payment_succeeded",
                      "checkout.session.async_payment_failed",
                      "checkout.session.expired",
                      "charge.refunded",
                      "customer.subscription.deleted",
                    ].map((eventName) => (
                      <li key={eventName} className="font-mono">
                        {eventName}
                      </li>
                    ))}
                  </ul>
                </div>
                <CopyField label="Endpoint URL" value={connection.webhookUrl || ""} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="stripe-endpoint-id" className="text-xs font-semibold">
                      Endpoint ID
                    </label>
                    <Input
                      id="stripe-endpoint-id"
                      value={endpointId}
                      onChange={(event) => setEndpointId(event.target.value)}
                      placeholder="we_…"
                      className="mt-1.5 font-mono"
                    />
                  </div>
                  <div>
                    <label htmlFor="stripe-signing-secret" className="text-xs font-semibold">
                      Signing secret
                    </label>
                    <Input
                      id="stripe-signing-secret"
                      type="password"
                      value={signingSecret}
                      onChange={(event) => setSigningSecret(event.target.value)}
                      placeholder="whsec_…"
                      autoComplete="off"
                      className="mt-1.5 font-mono"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    disabled={
                      !endpointId.trim() || !signingSecret.trim() || configureWebhook.isPending
                    }
                  >
                    {configureWebhook.isPending && <Loader2 className="size-4 animate-spin" />}
                    Verify webhook
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setReplaceKey(true)}>
                    Replace key
                  </Button>
                </div>
              </form>
            )}

            <div className="flex items-start gap-2 rounded-2xl bg-muted/45 p-4 text-xs leading-5 text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-foreground" />
              Keys and webhook secrets are encrypted with AES-GCM, available only to server-side
              payment code, and deleted when you disconnect Stripe.
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-xs font-semibold">{label}</span>
      <div className="mt-1.5 flex items-center gap-2 rounded-xl bg-card px-3 py-2.5 ring-1 ring-border">
        <code className="min-w-0 flex-1 break-all text-xs">{value}</code>
        <button
          type="button"
          aria-label={`Copy ${label}`}
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            toast.success(`${label} copied`);
          }}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted"
        >
          <Copy className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
