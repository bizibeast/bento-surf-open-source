import { useEffect, useRef, useState } from "react";
import { ArrowRight, Sparkles, X } from "lucide-react";
import { UpgradeDialog } from "@/components/UpgradeDialog";
import { captureProductEvent } from "@/lib/posthog";
import { TRIAL_DAYS } from "@/lib/plans";
import {
  dismissUpgradeBanner,
  isUpgradeBannerDismissed,
  shouldShowUpgradeBanner,
} from "@/lib/upgrade-banner";

/** Dashboard nudge for free hosted workspaces. Opens the existing upgrade flow. */
export function UpgradeBanner({
  profileId,
  planId,
  isPro,
}: {
  profileId: string | null | undefined;
  planId: unknown;
  isPro?: boolean | null;
}) {
  const eligible = Boolean(profileId) && shouldShowUpgradeBanner({ planId, isPro });
  // Hidden until storage is read so a dismissed banner never flashes.
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  const viewed = useRef<string | null>(null);
  useEffect(() => {
    if (!eligible || !profileId) {
      setVisible(false);
      return;
    }
    setVisible(!isUpgradeBannerDismissed(window.localStorage, profileId));
  }, [eligible, profileId]);
  useEffect(() => {
    if (!visible || !profileId || viewed.current === profileId) return;
    viewed.current = profileId;
    captureProductEvent("upgrade_banner_viewed", { surface: "dashboard_banner" });
  }, [visible, profileId]);
  if (!eligible || !profileId) return null;
  return (
    <>
      {visible && (
        <section
          className="relative mb-5 flex flex-col gap-3 overflow-hidden rounded-2xl bg-[#17213a] px-4 py-4 pr-12 text-white shadow-sm sm:flex-row sm:items-center sm:gap-5 sm:px-5"
          aria-label="Upgrade your Bento"
          data-testid="upgrade-banner"
        >
          <span
            className="hidden size-10 shrink-0 place-items-center rounded-xl bg-[#3478f6] sm:grid"
            aria-hidden="true"
          >
            <Sparkles className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Do more with your Bento.</p>
            <p className="mt-1 text-[13px] leading-5 text-white/70">
              Paid plans add selling, post scheduling and content ideas. The Brain and AI drafting
              are included with Creator Plus only. If you have not had a trial yet, start a{" "}
              {TRIAL_DAYS}-day trial of the plan you pick. Card required. No charge if you cancel
              before the trial ends.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              captureProductEvent("upgrade_banner_clicked", { surface: "dashboard_banner" });
              setOpen(true);
            }}
            className="inline-flex shrink-0 items-center justify-center gap-2 self-start rounded-full bg-[#3478f6] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:self-center"
          >
            See plans <ArrowRight className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              dismissUpgradeBanner(window.localStorage, profileId);
              setVisible(false);
              captureProductEvent("upgrade_banner_dismissed", { surface: "dashboard_banner" });
            }}
            className="absolute right-2 top-2 grid size-9 place-items-center rounded-full text-white/60 hover:bg-white/10 hover:text-white"
          >
            <X className="size-4" />
          </button>
        </section>
      )}
      <UpgradeDialog trigger={null} open={open} onOpenChange={setOpen} source="dashboard_banner" />
    </>
  );
}
