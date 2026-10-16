import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Check, Heart, Pause, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { micro } from "@/lib/micro-app-ui";
import { PLAN_CONFIG, PLAN_PRICING, planName, type PaidPlanId } from "@/lib/plans";
import {
  cancelMyRenewal,
  changeMyPlan,
  resumeMyRenewal,
  type MyBillingOverview,
} from "@/lib/billing.functions";
import {
  acceptMyRetentionDiscount,
  extendMyTrial,
  getMyCancellationImpact,
  pauseMySubscription,
  startMyCancellation,
  type CancellationReason,
} from "@/lib/cancellation.functions";

type Step = "reason" | "offer" | "loss" | "confirm" | "complete";
type Outcome =
  | "cancelled"
  | "trial_cancelled"
  | "paused"
  | "trial_extended"
  | "downgraded"
  | "discounted"
  | "resumed";
type Intent = Awaited<ReturnType<typeof startMyCancellation>>;
type Impact = Awaited<ReturnType<typeof getMyCancellationImpact>>;

const reasons: Array<{ id: CancellationReason; label: string; helper: string }> = [
  { id: "budget", label: "This plan does not fit my budget", helper: "I need a lower-cost option" },
  { id: "break", label: "I am taking a break", helper: "I am not creating or selling right now" },
  {
    id: "missing_capability",
    label: "Bento is missing something I need",
    helper: "A feature or integration is holding me back",
  },
  {
    id: "product_problem",
    label: "Setup or reliability has been difficult",
    helper: "Something did not work as expected",
  },
  {
    id: "moving_elsewhere",
    label: "I am moving my business elsewhere",
    helper: "I found another way to run it",
  },
];
const destinations = [
  "Linktree",
  "Beacons",
  "Stan Store",
  "Shopify",
  "Kajabi",
  "My own website",
  "Another service",
  "Leaving creator work",
];
const switchingReasons = [
  "Lower cost",
  "Better storefront",
  "Better social tools",
  "Easier setup",
  "More reliable",
  "A different audience",
  "Another reason",
];

function date(value: string | null) {
  if (!value || Number.isNaN(Date.parse(value))) return "the end of your current period";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

export function RetentionCancellationDialog({
  open,
  onOpenChange,
  plan,
  billing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan: PaidPlanId;
  billing: MyBillingOverview;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("reason");
  const [reason, setReason] = useState<CancellationReason | null>(null);
  const [details, setDetails] = useState("");
  const [destination, setDestination] = useState("");
  const [switchWhy, setSwitchWhy] = useState("");
  const [intent, setIntent] = useState<Intent | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [pauseDays, setPauseDays] = useState<30 | 60 | 90>(30);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [resultDate, setResultDate] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const planLabel = planName(plan);
  const targetPlan = plan === "creator_plus" ? "creator" : "store";

  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => {
      setStep("reason");
      setReason(null);
      setDetails("");
      setDestination("");
      setSwitchWhy("");
      setIntent(null);
      setImpact(null);
      setPauseDays(30);
      setOutcome(null);
      setResultDate(null);
      setError(null);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [open]);

  async function prepare(skip = false) {
    setPending(true);
    setError(null);
    try {
      const next = await startMyCancellation({
        data: {
          reason: skip ? null : reason,
          details: details.trim() || undefined,
          switchDestination: reason === "moving_elsewhere" ? destination || undefined : undefined,
          switchWhy: reason === "moving_elsewhere" ? switchWhy || undefined : undefined,
        },
      });
      setIntent(next);
      if (skip || reason === "moving_elsewhere") setStep("confirm");
      else if (next.offerType) setStep("offer");
      else await showImpact();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Cancellation options could not be loaded.",
      );
    } finally {
      setPending(false);
    }
  }

  async function showImpact() {
    setError(null);
    try {
      setImpact(await getMyCancellationImpact());
    } catch {
      setImpact(null);
    }
    setStep("loss");
  }

  async function acceptOffer() {
    if (!intent?.intentId) return;
    setPending(true);
    setError(null);
    try {
      if (intent.offerType === "trial_extension") {
        const result = await extendMyTrial({ data: { intentId: intent.intentId } });
        setOutcome("trial_extended");
        setResultDate(result.trialEndsAt);
      } else if (intent.offerType === "pause") {
        const result = await pauseMySubscription({
          data: { intentId: intent.intentId, days: pauseDays },
        });
        setOutcome("paused");
        setResultDate(result.resumeAt);
      } else if (intent.offerType === "downgrade") {
        const result = await changeMyPlan({
          data: { plan: targetPlan, intentId: intent.intentId },
        });
        setOutcome("downgraded");
        setResultDate(result.billing.pendingPlanEffectiveAt);
      } else if (intent.offerType === "discount") {
        const result = await acceptMyRetentionDiscount({ data: { intentId: intent.intentId } });
        setOutcome("discounted");
        setResultDate(result.nextBillingDate);
      } else return;
      await queryClient.invalidateQueries({ queryKey: ["my-billing"] });
      setStep("complete");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The offer could not be applied.";
      setError(message);
      toast.error(message);
    } finally {
      setPending(false);
    }
  }

  async function confirmCancellation() {
    setPending(true);
    setError(null);
    try {
      const next = await cancelMyRenewal({
        data: {
          reason,
          details: details.trim() || undefined,
          intentId: intent?.intentId,
        },
      });
      await queryClient.invalidateQueries();
      const trialEnded = next.status === "canceled";
      setOutcome(trialEnded ? "trial_cancelled" : "cancelled");
      setResultDate(next.currentPeriodEnd);
      setStep("complete");
      toast.success(
        trialEnded
          ? "Trial cancelled. Your trial access has ended and no renewal is scheduled."
          : "Renewal cancelled. Your paid access continues until the date shown.",
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Renewal could not be cancelled.";
      setError(message);
      toast.error(message);
    } finally {
      setPending(false);
    }
  }

  async function restartRenewal() {
    setPending(true);
    setError(null);
    try {
      const next = await resumeMyRenewal();
      await queryClient.invalidateQueries({ queryKey: ["my-billing"] });
      setOutcome("resumed");
      setResultDate(next.currentPeriodEnd);
      toast.success("Your plan will renew normally.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your plan could not be restarted.");
    } finally {
      setPending(false);
    }
  }

  const offer = intent?.offerType;
  const impactItems = [
    impact?.publishedPages
      ? `${impact.publishedPages} visible ${impact.publishedPages === 1 ? "page" : "pages"}`
      : null,
    impact?.publishedProducts
      ? `${impact.publishedProducts} published ${impact.publishedProducts === 1 ? "product" : "products"}`
      : null,
    impact?.scheduledPosts
      ? `${impact.scheduledPosts} scheduled ${impact.scheduledPosts === 1 ? "post" : "posts"}`
      : null,
    impact?.activeAutoDms
      ? `${impact.activeAutoDms} active Auto DM ${impact.activeAutoDms === 1 ? "automation" : "automations"}`
      : null,
  ].filter(Boolean);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-lg overflow-y-auto rounded-[28px] p-5 sm:p-6">
        {step === "reason" && (
          <>
            <DialogHeader>
              <DialogTitle className="font-ui-display text-2xl">
                {billing.status === "trialing"
                  ? "Cancel your trial"
                  : `Cancel ${planLabel} renewal`}
              </DialogTitle>
              <DialogDescription className="leading-6">
                What is the main reason? Choose one, or skip this question.{" "}
                {billing.status === "trialing"
                  ? "Confirming cancellation ends your trial access immediately."
                  : `Your current access continues until ${date(billing.currentPeriodEnd)}.`}
              </DialogDescription>
            </DialogHeader>
            {billing.status === "trialing" && (
              <div className="rounded-2xl bg-[#dfeaff] p-4 text-sm leading-6">
                Cancel before your first charge to avoid renewal. Your trial ends as soon as you
                confirm cancellation. Your saved work remains available for export.
              </div>
            )}
            <div role="radiogroup" aria-label="Main cancellation reason" className="grid gap-2">
              {reasons.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={reason === option.id}
                  onClick={() => setReason(option.id)}
                  className={`rounded-2xl border p-3 text-left ${reason === option.id ? "border-[#3478f6] bg-[#dfeaff]" : "border-black/[0.08] hover:bg-[#f2f5fb]"}`}
                >
                  <span className="block text-sm font-semibold">{option.label}</span>
                  <span className="block text-xs text-[#17213a]/55">{option.helper}</span>
                </button>
              ))}
            </div>
            {reason === "moving_elsewhere" && (
              <div className="grid gap-3">
                <label className="grid gap-1 text-sm font-medium">
                  Where are you moving? <span className="font-normal opacity-60">Optional</span>
                  <select
                    className={micro.input}
                    value={destination}
                    onChange={(event) => setDestination(event.target.value)}
                  >
                    <option value="">Choose a destination</option>
                    {destinations.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm font-medium">
                  What works better there? <span className="font-normal opacity-60">Optional</span>
                  <select
                    className={micro.input}
                    value={switchWhy}
                    onChange={(event) => setSwitchWhy(event.target.value)}
                  >
                    <option value="">Choose the main difference</option>
                    {switchingReasons.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {reason && reason !== "moving_elsewhere" && (
              <label className="grid gap-1 text-sm font-medium">
                Anything else? <span className="font-normal opacity-60">Optional</span>
                <textarea
                  className={`${micro.input} min-h-20 resize-y`}
                  value={details}
                  maxLength={500}
                  onChange={(event) => setDetails(event.target.value)}
                />
              </label>
            )}
            <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
              <button
                type="button"
                disabled={pending || !reason}
                onClick={() => void prepare()}
                className={`${micro.btnPrimary} h-11 w-full disabled:opacity-45`}
              >
                Continue
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => void prepare(true)}
                className="h-11 w-full text-sm font-semibold text-[#17213a] underline underline-offset-4"
              >
                Skip and continue cancelling
              </button>
            </DialogFooter>
          </>
        )}

        {step === "offer" && (
          <>
            <DialogHeader>
              <DialogTitle className="font-ui-display text-2xl">
                {offer === "trial_extension"
                  ? "More time to try Bento"
                  : offer === "pause"
                    ? "Take a break from Bento"
                    : offer === "downgrade"
                      ? "A plan that fits better"
                      : offer === "discount"
                        ? "A one-time price option"
                        : "Can we help?"}
              </DialogTitle>
              <DialogDescription className="leading-6">
                This option is available on your first cancellation attempt. You can still continue
                cancelling.
              </DialogDescription>
            </DialogHeader>
            {offer === "trial_extension" && (
              <div className="rounded-2xl bg-[#dfeaff] p-4 text-sm leading-6">
                You have connected at least three integrations, including social, and started using
                Bento. Extend your trial from three to seven total days. We will show your exact new
                first-charge date and remind you before it.
              </div>
            )}
            {offer === "pause" && (
              <div className="grid gap-4 rounded-2xl bg-[#dfeaff] p-4 text-sm leading-6">
                <p>
                  Billing freezes and your paid time is saved. Your public page, store, and creator
                  tools go offline <strong>immediately</strong> until you resume.
                </p>
                <label className="grid gap-1 font-medium">
                  Pause duration
                  <select
                    className={micro.input}
                    value={pauseDays}
                    onChange={(event) => setPauseDays(Number(event.target.value) as 30 | 60 | 90)}
                  >
                    <option value={30}>30 days</option>
                    <option value={60}>60 days</option>
                    <option value={90}>90 days</option>
                  </select>
                </label>
                <p>
                  We will remind you before automatic resume. If resume cannot be confirmed, billing
                  stays paused.
                </p>
              </div>
            )}
            {offer === "downgrade" && (
              <div className="rounded-2xl bg-[#dfeaff] p-4 text-sm leading-6">
                <strong>Switch to {planName(targetPlan)}</strong> at{" "}
                {PLAN_PRICING[targetPlan][billing.billingPeriod ?? "monthly"].label}
                {PLAN_PRICING[targetPlan][billing.billingPeriod ?? "monthly"].cadence} at your next
                renewal. You keep your current features until then. Review the plan differences
                before accepting.
                <ul className="mt-2 list-disc pl-5">
                  {PLAN_CONFIG[targetPlan].highlights.slice(0, 3).map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            {offer === "discount" && (
              <div className="rounded-2xl bg-[#dfeaff] p-4 text-sm leading-6">
                Save {intent?.discountPercent ?? 25}% on your next three monthly base-plan charges.
                Your normal price resumes after those charges. Dodo must confirm the exact total
                before the offer is applied.
              </div>
            )}
            {offer === "support" && (
              <div className="rounded-2xl bg-[#dfeaff] p-4 text-sm leading-6">
                Tell us what is missing or difficult. You can contact{" "}
                <a className="underline" href="mailto:support@example.com">
                  support@example.com
                </a>{" "}
                for help. You do not need to wait for a reply to cancel.
              </div>
            )}
            <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
              {offer !== "support" && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void acceptOffer()}
                  className={`${micro.btnPrimary} h-11 w-full`}
                >
                  {pending
                    ? "Applying…"
                    : offer === "trial_extension"
                      ? "Extend to seven total days"
                      : offer === "pause"
                        ? "Pause my plan"
                        : offer === "downgrade"
                          ? `Switch to ${planName(targetPlan)}`
                          : "Apply one-time discount"}
                </button>
              )}
              <button
                type="button"
                disabled={pending}
                onClick={() => void showImpact()}
                className="h-11 w-full text-sm font-semibold text-[#17213a] underline underline-offset-4"
              >
                No thanks, continue cancelling
              </button>
            </DialogFooter>
          </>
        )}

        {step === "loss" && (
          <>
            <DialogHeader>
              <DialogTitle className="font-ui-display text-2xl">
                What changes for your workspace
              </DialogTitle>
              <DialogDescription className="leading-6">
                Your paid access stays active through {date(billing.currentPeriodEnd)}. Then your
                hosted page, store, and creator tools pause.
              </DialogDescription>
            </DialogHeader>
            {impactItems.length > 0 && (
              <div className="rounded-2xl bg-[#f2f5fb] p-4 text-sm">
                <p className="font-semibold">Currently active in your workspace</p>
                <ul className="mt-2 grid gap-1">
                  {impactItems.map((item) => (
                    <li key={item}>
                      <Check className="mr-2 inline size-4 text-[#3478f6]" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-sm leading-6 text-[#17213a]/65">
              Your work remains available for export or renewal during Bento’s 90-day retention
              window. Other workspaces are unaffected.
            </p>
            <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
              <button
                type="button"
                onClick={() => setStep("confirm")}
                className={`${micro.btnPrimary} h-11 w-full`}
              >
                Continue to cancellation
              </button>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="h-11 w-full text-sm font-semibold underline underline-offset-4"
              >
                Keep my plan
              </button>
            </DialogFooter>
          </>
        )}

        {step === "confirm" && (
          <>
            <DialogHeader>
              <DialogTitle className="font-ui-display text-2xl">
                Review your cancellation
              </DialogTitle>
              <DialogDescription className="leading-6">
                {billing.status === "trialing"
                  ? "Your trial ends immediately when you confirm. This workspace’s hosted page, store, and creator tools pause now, and no renewal is scheduled."
                  : `Your plan will not renew. You keep ${planLabel} until ${date(billing.currentPeriodEnd)}. After that, this workspace’s hosted page, store, and creator tools pause.`}{" "}
                You can renew or export during the 90-day retention window.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-2xl bg-[#f2f5fb] p-4 text-sm">
              <p className="font-semibold">No further renewal is scheduled after you confirm.</p>
              <p className="mt-1 text-[#17213a]/65">
                Only this workspace is affected. Account deletion is a separate action.
              </p>
            </div>
            <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
              <button
                type="button"
                disabled={pending}
                onClick={() => void confirmCancellation()}
                className="h-11 w-full rounded-2xl bg-destructive px-4 text-sm font-semibold text-white disabled:opacity-50"
              >
                {pending ? "Cancelling renewal…" : "Confirm cancellation"}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => onOpenChange(false)}
                className="h-11 w-full text-sm font-semibold underline underline-offset-4"
              >
                Keep my plan
              </button>
            </DialogFooter>
          </>
        )}

        {step === "complete" && (
          <>
            <DialogHeader>
              <div className={`${micro.iconWell} mb-2 size-12`}>
                {outcome === "paused" ? (
                  <Pause className="size-6" />
                ) : outcome === "cancelled" || outcome === "trial_cancelled" ? (
                  <Heart className="size-6" />
                ) : (
                  <Sparkles className="size-6" />
                )}
              </div>
              <DialogTitle className="font-ui-display text-2xl">
                {outcome === "trial_cancelled"
                  ? "Your trial has ended"
                  : outcome === "cancelled"
                    ? intent?.displayName
                      ? `Thank you, ${intent.displayName}, for building with Bento`
                      : "Thank you for building with Bento"
                    : outcome === "paused"
                      ? "Your Bento is paused"
                      : outcome === "trial_extended"
                        ? "You have more time"
                        : outcome === "downgraded"
                          ? "Your plan change is scheduled"
                          : outcome === "resumed"
                            ? "Welcome back"
                            : "Your offer is active"}
              </DialogTitle>
              <DialogDescription className="leading-6">
                {outcome === "trial_cancelled"
                  ? "Your trial is cancelled and access has ended. No renewal is scheduled. Your work is saved for 90 days; you can export it or choose a paid plan in Billing."
                  : outcome === "cancelled"
                    ? `Renewal is cancelled. Your ${planLabel} access continues until ${date(resultDate)}. You can change your mind before then.`
                    : outcome === "paused"
                      ? `Billing is frozen and hosted access is offline now. Your pause is scheduled to end ${date(resultDate)}. Your work is saved.`
                      : outcome === "trial_extended"
                        ? `Your trial now ends ${date(resultDate)}. We will remind you before the first charge.`
                        : outcome === "downgraded"
                          ? `You keep ${planLabel} until ${date(resultDate)}, then your lower plan takes effect.`
                          : outcome === "resumed"
                            ? `Your plan will renew at ${date(resultDate)}.`
                            : `Your next billing date is ${date(resultDate)}.`}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              {outcome === "cancelled" && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void restartRenewal()}
                  className={`${micro.btnPrimary} h-11 w-full`}
                >
                  {pending ? "Restarting…" : "Keep my plan"}
                </button>
              )}
              <Link
                to="/settings"
                search={{ section: "account" }}
                onClick={() => onOpenChange(false)}
                className={`${micro.btnOutline} h-11 w-full justify-center`}
              >
                Export my work
              </Link>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="h-11 text-sm font-semibold underline underline-offset-4"
              >
                Done
              </button>
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
