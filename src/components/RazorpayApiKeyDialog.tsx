import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Copy, ExternalLink, Loader2, ShieldCheck } from "lucide-react";
import { SiRazorpay } from "react-icons/si";
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
  configureRazorpayWebhook,
  connectRazorpayApiKeys,
  getMyRazorpayConnection,
} from "@/integrations/razorpay/connection.functions";

function randomWebhookSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

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

export function RazorpayApiKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [replaceKey, setReplaceKey] = useState(false);
  const connectionQuery = useQuery({
    queryKey: ["my-razorpay-connection"],
    queryFn: () => getMyRazorpayConnection(),
    enabled: open,
  });
  const connection = connectionQuery.data;

  useEffect(() => {
    if (!open) {
      setKeyId("");
      setKeySecret("");
      setWebhookSecret("");
      setReplaceKey(false);
    }
  }, [open]);

  useEffect(() => {
    if (open && connection && !connection.webhookReady && !webhookSecret) {
      setWebhookSecret(randomWebhookSecret());
    }
  }, [connection, open, webhookSecret]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["my-razorpay-connection"] }),
      queryClient.invalidateQueries({ queryKey: ["creator-payment-settings"] }),
    ]);
  };

  const connect = useMutation({
    mutationFn: () => connectRazorpayApiKeys({ data: { keyId, keySecret } }),
    onSuccess: async (next) => {
      setKeyId("");
      setKeySecret("");
      setReplaceKey(false);
      queryClient.setQueryData(["my-razorpay-connection"], next);
      if (next && !next.webhookReady) setWebhookSecret(randomWebhookSecret());
      await refresh();
      toast.success(
        next?.webhookReady
          ? "Razorpay is connected and ready."
          : "API keys verified. Add the signed webhook to finish.",
      );
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not connect Razorpay"),
  });

  const configureWebhook = useMutation({
    mutationFn: () => configureRazorpayWebhook({ data: { webhookSecret } }),
    onSuccess: async (next) => {
      queryClient.setQueryData(["my-razorpay-connection"], next);
      setWebhookSecret("");
      await refresh();
      toast.success("Razorpay webhook saved. Checkout is ready.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not save Razorpay webhook"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] w-[calc(100vw-1.5rem)] max-w-xl overflow-y-auto rounded-[28px] border-border bg-card p-5 sm:p-7">
        <DialogHeader className="pr-7 text-left">
          <div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-[#2b84ea]/10 text-[#2b84ea]">
            <SiRazorpay className="size-7" aria-hidden="true" />
          </div>
          <DialogTitle className="font-ui-display text-3xl">Connect Razorpay</DialogTitle>
          <DialogDescription className="leading-6">
            Accept UPI, cards, netbanking, and supported wallets in your own Razorpay account. Sales
            settle to you and Bento charges 0% platform fee.
          </DialogDescription>
        </DialogHeader>

        {connectionQuery.isLoading ? (
          <div className="flex min-h-32 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-5">
            {connection?.webhookReady && !replaceKey && (
              <div className="rounded-2xl bg-tint-mint p-4 ring-1 ring-emerald-500/15">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
                  <div>
                    <p className="font-semibold">Razorpay is ready</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {connection.environment === "production" ? "Live" : "Test"} mode · signed
                      webhook configured
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-4"
                  onClick={() => setReplaceKey(true)}
                >
                  Replace API keys
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
                  <p className="font-semibold">Generate keys in Razorpay</p>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
                    <li>Open Razorpay Dashboard → Account &amp; Settings → API Keys.</li>
                    <li>
                      Choose Test Mode on staging or Live Mode on bento.surf, then generate keys.
                    </li>
                    <li>Copy the Key ID and Key Secret. Razorpay shows the secret only once.</li>
                  </ol>
                  <a
                    href="https://link.razorpay.com/app/website-app-settings/api-keys"
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex items-center gap-1.5 font-semibold text-primary"
                  >
                    Open Razorpay API keys <ExternalLink className="size-3.5" />
                  </a>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="razorpay-key-id" className="text-sm font-semibold">
                      Key ID
                    </label>
                    <Input
                      id="razorpay-key-id"
                      value={keyId}
                      onChange={(event) => setKeyId(event.target.value)}
                      placeholder="rzp_test_… or rzp_live_…"
                      autoComplete="off"
                      spellCheck={false}
                      className="mt-2 font-mono"
                    />
                  </div>
                  <div>
                    <label htmlFor="razorpay-key-secret" className="text-sm font-semibold">
                      Key Secret
                    </label>
                    <Input
                      id="razorpay-key-secret"
                      type="password"
                      value={keySecret}
                      onChange={(event) => setKeySecret(event.target.value)}
                      placeholder="Paste the complete secret"
                      autoComplete="off"
                      spellCheck={false}
                      className="mt-2 font-mono"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    disabled={!keyId.trim() || keySecret.trim().length < 16 || connect.isPending}
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

            {connection && !connection.webhookReady && !replaceKey && (
              <form
                className="space-y-4 rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  configureWebhook.mutate();
                }}
              >
                <div>
                  <p className="font-semibold">Add the signed webhook</p>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
                    <li>Open Razorpay → Account &amp; Settings → Webhooks → Add New Webhook.</li>
                    <li>Paste the URL and secret below.</li>
                    <li>
                      Select payment.captured, payment.failed, and refund.processed, then enable the
                      webhook.
                    </li>
                  </ol>
                  <a
                    href="https://link.razorpay.com/app/website-app-settings/webhooks"
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-primary"
                  >
                    Open Razorpay webhooks <ExternalLink className="size-3.5" />
                  </a>
                </div>
                <CopyField label="Webhook URL" value={connection.webhookUrl} />
                <CopyField label="Webhook secret" value={webhookSecret} />
                <Button
                  type="submit"
                  disabled={webhookSecret.length < 16 || configureWebhook.isPending}
                >
                  {configureWebhook.isPending && <Loader2 className="size-4 animate-spin" />}I
                  enabled this webhook
                </Button>
                <p className="text-xs leading-5 text-muted-foreground">
                  Use this generated webhook secret exactly. It is separate from your Razorpay Key
                  Secret.
                </p>
              </form>
            )}

            <div className="flex items-start gap-2 rounded-2xl bg-muted/45 p-4 text-xs leading-5 text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-foreground" />
              The Key Secret and webhook secret are AES-GCM encrypted, used only by server-side
              payment code, never sent to buyers, and deleted from Bento when you disconnect.
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
