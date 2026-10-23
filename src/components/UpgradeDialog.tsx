import { useEffect, useState } from "react";
import { Check, Sparkles } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { createCheckout, getCheckoutOffer } from "@/lib/billing.functions";
import {
  minimumPlanForEntitlement,
  PAID_PLAN_IDS,
  PLAN_HIGHLIGHTS,
  PLAN_PRICING,
  planName,
  TRIAL_DAYS,
  type EntitlementKey,
  type BillingPeriod,
  type PaidPlanId,
} from "@/lib/plans";
import { safeNavigationHref } from "@/lib/safe-url";
import { OPEN_SOURCE_REPOSITORY_URL } from "@/lib/open-source";
import { motionTokens } from "@/lib/motion";

export function UpgradeDialog({
  trigger,
  feature,
  open,
  onOpenChange,
}: {
  trigger?: React.ReactNode;
  feature?: EntitlementKey;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showFreeOption?: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const [plan, setPlan] = useState<PaidPlanId>(() =>
    feature ? minimumPlanForEntitlement(feature) : "store",
  );
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
  const [offer, setOffer] = useState<{ trialEligible: boolean; active: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [offerError, setOfferError] = useState(false);
  const reduced = useReducedMotion();
  const price = PLAN_PRICING[plan][period];
  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    setOffer(null);
    setOfferError(false);
    void getCheckoutOffer()
      .then((value) => {
        if (live) setOffer(value);
      })
      .catch(() => {
        if (live) setOfferError(true);
      });
    return () => {
      live = false;
    };
  }, [isOpen]);
  async function startCheckout() {
    if (!offer) return;
    if (offer.active) {
      window.location.href = "/settings?section=plan";
      return;
    }
    setLoading(true);
    try {
      const { url } = await createCheckout({
        data: { plan, period, returnTo: "dashboard", storageUnits: 0, contactTier: 500 },
      });
      const destination = safeNavigationHref(url);
      if (!destination) throw new Error("Checkout returned an invalid destination.");
      window.location.href = destination;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start checkout.");
      setLoading(false);
    }
  }
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(value) => {
        setInternalOpen(value);
        onOpenChange?.(value);
      }}
    >
      {trigger !== null && (
        <DialogTrigger asChild>
          {trigger ?? (
            <button className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground">
              <Sparkles className="size-4" />
              Upgrade
            </button>
          )}
        </DialogTrigger>
      )}
      <DialogContent className="max-w-2xl overflow-x-hidden overflow-y-auto p-0">
        <div className="bg-[#17213a] p-6 text-white">
          <DialogTitle className="font-ui-display text-3xl">
            Room for your next chapter.
          </DialogTitle>
          <DialogDescription className="mt-2 text-white/65">
            Choose the tools your business needs. Cancel anytime.
          </DialogDescription>
        </div>
        <div className="px-6 pb-6">
          <div className="my-4 flex gap-2" role="group" aria-label="Billing period">
            {(["monthly", "yearly"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={period === value}
                onClick={() => setPeriod(value)}
                className={`rounded-full px-4 py-2 text-sm font-semibold ${period === value ? "bg-[#17213a] text-white" : "border border-border"}`}
              >
                {value === "monthly" ? "Monthly" : "Yearly · 2 months free"}
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {PAID_PLAN_IDS.map((value) => (
              <button
                key={value}
                aria-pressed={plan === value}
                onClick={() => setPlan(value)}
                className={`rounded-2xl border p-4 text-left transition-colors focus-visible:ring-2 focus-visible:ring-primary ${value === plan ? "border-primary bg-primary/5" : "border-border"}`}
              >
                <span className="block text-sm font-semibold">{planName(value)}</span>
                <span className="mt-3 block text-3xl font-semibold">
                  {PLAN_PRICING[value][period].label}
                  <span className="text-xs font-normal text-muted-foreground">
                    {PLAN_PRICING[value][period].cadence}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.ul
              key={plan}
              initial={reduced ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: reduced ? 1 : 0 }}
              transition={{ duration: reduced ? 0 : motionTokens.duration.fast }}
              className="my-6 grid gap-3 sm:grid-cols-2"
            >
              {PLAN_HIGHLIGHTS[plan].map((item) => (
                <li key={item} className="flex gap-2 text-sm">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                  {item}
                </li>
              ))}
            </motion.ul>
          </AnimatePresence>
          <p className="rounded-xl bg-muted p-4 text-sm leading-6">
            {offer?.active
              ? "Your current contract stays in place until you choose a change in Billing."
              : offer?.trialEligible
                ? `Credit card required. $0 today, then ${price.label}${price.cadence} plus applicable tax after ${TRIAL_DAYS} full days. We’ll email you one day before the first charge and ask for feedback. Cancel before renewal to avoid a charge. Your trial includes the ${planName(plan)} plan.`
                : offer
                  ? `Your trial has already been used. ${price.label}${price.cadence} plus applicable tax is due at checkout. Review the final total before paying.`
                  : offerError
                    ? "We couldn’t verify your billing eligibility. Reopen this dialog to try again."
                    : "Checking your trial eligibility…"}
          </p>
          <button
            onClick={() => void startCheckout()}
            disabled={!offer || loading}
            className="mt-5 w-full rounded-xl bg-primary py-3.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {loading
              ? "Opening secure checkout…"
              : offer?.active
                ? "Choose my plan in Billing"
                : offer?.trialEligible
                  ? `Start ${TRIAL_DAYS}-day ${planName(plan)} trial`
                  : "Continue to checkout"}
          </button>
          <p className="mt-3 text-center text-xs leading-5 text-muted-foreground">
            New accounts prepare their page and Brain before checkout. Add-ons are available after
            the trial.{" "}
            <a href={OPEN_SOURCE_REPOSITORY_URL} className="underline">
              Free Forever
            </a>{" "}
            is our self-hosted open-source edition.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
