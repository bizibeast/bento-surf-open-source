import { useState } from "react";
import { Check, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { createCheckout } from "@/lib/billing.functions";
import {
  BASE_MARKETING_CONTACTS,
  CONTACT_TIER_OPTIONS,
  CONTACT_TIER_PRICING,
  minimumPlanForEntitlement,
  PAID_PLAN_IDS,
  PLAN_HIGHLIGHTS,
  PLAN_PRICING,
  planName,
  storageAddonPrice,
  TRIAL_DAYS,
  type BillingPeriod,
  type ContactTier,
  type EntitlementKey,
  type PaidPlanId,
} from "@/lib/plans";
import { captureProductEvent } from "@/lib/posthog";
import { safeNavigationHref } from "@/lib/safe-url";

const PERIODS: BillingPeriod[] = ["monthly", "yearly"];
export function UpgradeDialog({
  trigger,
  feature,
  open,
  onOpenChange,
  showFreeOption = false,
}: {
  trigger?: React.ReactNode;
  feature?: EntitlementKey;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showFreeOption?: boolean;
}) {
  const [plan, setPlan] = useState<PaidPlanId>(() =>
    feature ? minimumPlanForEntitlement(feature) : "store",
  );
  const [period, setPeriod] = useState<BillingPeriod>("yearly");
  const [contactTier, setContactTier] = useState<ContactTier>(BASE_MARKETING_CONTACTS);
  const [storageUnits, setStorageUnits] = useState(0);
  const [loading, setLoading] = useState(false);
  const [showFreeComparison, setShowFreeComparison] = useState(false);
  const price = PLAN_PRICING[plan][period];
  const contactTierPrice =
    plan === "creator" && contactTier !== BASE_MARKETING_CONTACTS
      ? CONTACT_TIER_PRICING[contactTier][period]
      : 0;
  const storagePrice = storageAddonPrice(period, storageUnits);
  const storageUnitPrice = storageAddonPrice(period, 1);
  const estimatedTotal = price.amount + contactTierPrice + storagePrice;

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) setShowFreeComparison(false);
    onOpenChange?.(nextOpen);
  };

  const startCheckout = async () => {
    setLoading(true);
    captureProductEvent("upgrade_clicked", { contactTier, plan, period, storageUnits });
    try {
      const { url } = await createCheckout({
        data: { contactTier, plan, period, returnTo: "dashboard", storageUnits },
      });
      const destination = safeNavigationHref(url);
      if (!destination) throw new Error("Checkout returned an invalid destination.");
      captureProductEvent("checkout_started", { contactTier, plan, period, storageUnits });
      window.location.href = destination;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t start checkout.");
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger !== null && (
        <DialogTrigger asChild>
          {trigger ?? (
            <button
              type="button"
              style={{ background: "var(--ring, #3478f6)" }}
              className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:opacity-90"
            >
              <Sparkles className="size-3.5" /> Upgrade
            </button>
          )}
        </DialogTrigger>
      )}
      <DialogContent className="max-w-xl gap-0 overflow-x-hidden overflow-y-auto p-0">
        <DialogTitle className="sr-only">
          {showFreeComparison ? "Before you choose Free" : "Choose a Bento plan"}
        </DialogTitle>
        {showFreeComparison ? (
          <div className="p-6 sm:p-8">
            <span className="inline-flex items-center gap-2 rounded-full bg-[#fff0bd] px-3 py-1.5 text-xs font-semibold text-[#7a5b00]">
              <Sparkles className="size-3.5" /> One last look
            </span>
            <h2 className="mt-5 font-ui-display text-3xl">Before you continue with Free</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Free keeps your Bento live, but you will miss these {planName(plan)} features:
            </p>
            <ul className="mt-5 grid gap-3 rounded-[22px] border border-border bg-muted/45 p-4 text-sm">
              {PLAN_HIGHLIGHTS[plan].slice(0, 4).map((feature) => (
                <li key={feature} className="flex items-start gap-2">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-xs font-bold text-destructive"
                  >
                    ×
                  </span>
                  {feature}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={startCheckout}
              disabled={loading}
              className="mt-5 w-full rounded-2xl bg-[#3478f6] py-3.5 text-sm font-semibold text-white transition hover:bg-[#2168e5] disabled:opacity-60"
            >
              {loading
                ? "Opening secure checkout…"
                : `Start ${TRIAL_DAYS}-day ${planName(plan)} trial`}
            </button>
            <button
              type="button"
              onClick={() => handleOpenChange(false)}
              className="mt-2 w-full rounded-2xl py-3 text-sm font-semibold text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              Continue for Free
            </button>
            <p className="mt-2 text-center text-xs text-muted-foreground">
              The trial requires a card. $0 today, then {price.label} {price.cadence}. Continuing
              with Free does not.
            </p>
          </div>
        ) : (
          <>
            <div className="bg-[#17213a] p-6 text-white">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-[#ffc928]">Choose your Bento plan</p>
                  <p className="mt-1 text-xs text-white/55">
                    Store and Creator include a {TRIAL_DAYS}-day free trial.
                  </p>
                </div>
                <div className="inline-flex rounded-full bg-white/10 p-1 text-xs">
                  {PERIODS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setPeriod(value)}
                      className={`rounded-full px-3 py-1.5 font-medium capitalize transition ${
                        period === value
                          ? "bg-white text-[#17213a]"
                          : "text-white/70 hover:text-white"
                      }`}
                    >
                      {value === "yearly" ? "Yearly · 2 months free" : "Monthly"}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid gap-3 p-5 sm:grid-cols-2">
              {PAID_PLAN_IDS.map((value) => {
                const selected = value === plan;
                const valuePrice = PLAN_PRICING[value][period];
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setPlan(value);
                      if (value === "store") setContactTier(BASE_MARKETING_CONTACTS);
                    }}
                    className={`rounded-[22px] border p-4 text-left transition ${
                      selected
                        ? "border-[#3478f6] bg-[#dfeaff]/55 ring-4 ring-[#3478f6]/8"
                        : "border-border bg-card hover:border-[#3478f6]/35"
                    }`}
                  >
                    <span className="flex items-center justify-between">
                      <span className="text-lg font-semibold">{planName(value)}</span>
                      <span
                        className={`size-4 rounded-full border-4 ${selected ? "border-[#3478f6]" : "border-muted"}`}
                      />
                    </span>
                    <span className="mt-3 flex items-baseline gap-1">
                      <span className="text-3xl font-semibold tracking-tight">
                        {valuePrice.label}
                      </span>
                      <span className="text-xs text-muted-foreground">{valuePrice.cadence}</span>
                    </span>
                    {valuePrice.sublabel && (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {valuePrice.sublabel}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="px-6 pb-6">
              {plan === "creator" ? (
                <fieldset className="mb-5 min-w-0">
                  <legend className="text-sm font-semibold">Marketing contacts</legend>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Every Creator plan includes 500 contacts and unlimited marketing sends.
                  </p>
                  <div className="mt-3 grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
                    {CONTACT_TIER_OPTIONS.map((tier) => {
                      const included = tier === BASE_MARKETING_CONTACTS;
                      const selected = contactTier === tier;
                      return (
                        <label
                          key={tier}
                          className={`min-w-0 rounded-xl border p-2 text-xs transition focus-within:ring-2 focus-within:ring-[#3478f6]/20 ${
                            selected
                              ? "border-[#3478f6] bg-[#dfeaff]/55"
                              : "border-border hover:border-[#3478f6]/35"
                          }`}
                        >
                          <input
                            aria-label={`${tier.toLocaleString()} contacts`}
                            checked={selected}
                            className="sr-only"
                            name="upgrade-contact-tier"
                            onChange={() => setContactTier(tier)}
                            type="radio"
                            value={tier}
                          />
                          <span className="block font-semibold">
                            {tier.toLocaleString()} contacts
                          </span>
                          <span className="mt-1 block text-muted-foreground">
                            {included ? "Included" : `$${CONTACT_TIER_PRICING[tier][period]}`}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              ) : (
                <p className="mb-5 text-sm text-muted-foreground">
                  Email capture up to 500 contacts. Larger contact tiers are available on Creator.
                </p>
              )}
              <div className="mb-5 rounded-2xl border border-border bg-muted/35 p-4">
                <label
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm font-semibold"
                  htmlFor="upgrade-storage-units"
                >
                  Added storage in 10 GB units
                  <span className="text-xs font-medium text-muted-foreground">
                    {storageUnits * 10} GB added
                  </span>
                </label>
                <input
                  aria-label="Added storage in 10 GB units"
                  aria-describedby="upgrade-storage-copy"
                  className="mt-3 w-full accent-[#3478f6]"
                  id="upgrade-storage-units"
                  max="100"
                  min="0"
                  onChange={(event) => setStorageUnits(Number(event.target.value))}
                  step="1"
                  type="range"
                  value={storageUnits}
                />
                <p id="upgrade-storage-copy" className="mt-2 text-xs text-muted-foreground">
                  ${storageUnitPrice} per 10 GB {period === "monthly" ? "per month" : "per year"},
                  up to 1 TB.
                </p>
              </div>
              <div className="mb-4 rounded-2xl bg-[#17213a] px-4 py-3 text-white">
                <p className="text-xs text-white/65">Estimated subscription total</p>
                <p className="mt-1 text-xl font-semibold">
                  ${estimatedTotal}
                  {price.cadence} before taxes
                </p>
                <p className="mt-1 text-xs text-white/65">
                  Dodo confirms the final tax and currency at checkout.
                </p>
              </div>
              <ul className="grid gap-2 sm:grid-cols-2">
                {PLAN_HIGHLIGHTS[plan].map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-xs text-foreground">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-[#3478f6]" />
                    {feature}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={startCheckout}
                disabled={loading}
                className="mt-5 w-full rounded-2xl bg-[#3478f6] py-3.5 text-sm font-semibold text-white transition hover:bg-[#2168e5] disabled:opacity-60"
              >
                {loading
                  ? "Opening secure checkout…"
                  : `Start ${TRIAL_DAYS}-day ${planName(plan)} trial`}
              </button>
              {showFreeOption && (
                <button
                  type="button"
                  onClick={() => setShowFreeComparison(true)}
                  className="mt-2 w-full rounded-2xl py-3 text-sm font-semibold text-muted-foreground transition hover:bg-muted hover:text-foreground"
                >
                  Continue for Free
                </button>
              )}
              <p className="mt-2 text-center text-xs text-muted-foreground">
                The trial requires a card. $0 today, then {price.label} {price.cadence}. Continuing
                with Free does not. Cancel anytime; canceled accounts move to Free after the trial
                or current billing period.
              </p>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
