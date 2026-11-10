import { useEffect, useRef } from "react";
import { Loader2, X } from "lucide-react";
import { planName } from "@/lib/plans";
import { checkoutRecoveryProperties, type CheckoutRecovery } from "@/lib/checkout-recovery";
import { captureProductEvent } from "@/lib/posthog";

export function CheckoutRecoveryBanner({
  record,
  busy,
  onRetry,
  onDismiss,
  variant,
}: {
  record: CheckoutRecovery;
  busy: boolean;
  onRetry: () => void;
  onDismiss: () => void;
  variant: "onboarding" | "dialog";
}) {
  const surface = variant === "onboarding" ? "onboarding" : "upgrade_dialog";
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const key = JSON.stringify(record);
    if (shown.current === key) return;
    shown.current = key;
    captureProductEvent(
      "checkout_recovery_banner_shown",
      checkoutRecoveryProperties(record, surface),
    );
  }, [record, surface]);
  return (
    <div
      role="status"
      className="checkout-recovery relative my-4 rounded-xl border border-border bg-muted p-4 text-sm"
    >
      <p className="pr-8 font-semibold">Checkout didn't finish</p>
      <p className="mt-2">
        Pick up your {planName(record.plan)} {record.trial ? "trial" : "plan"} where you left off.
        UPI, cards and wallets are accepted.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={onRetry}
        className="mt-3 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 font-semibold text-primary-foreground disabled:opacity-50"
      >
        {busy && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
        Try checkout again
      </button>
      <button
        type="button"
        aria-label="Dismiss checkout reminder"
        onClick={onDismiss}
        className="absolute right-3 top-3 rounded p-1"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}
