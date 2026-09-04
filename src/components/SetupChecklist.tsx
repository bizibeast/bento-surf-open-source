import { useEffect, useMemo, useRef, useState } from "react";
import {
  AtSign,
  Camera,
  Check,
  ChevronDown,
  ExternalLink,
  LayoutGrid,
  Palette,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { captureProductEvent } from "@/lib/posthog";
import {
  getSetupChecklistSteps,
  setupChecklistProgress,
  type SetupChecklistBlock,
  type SetupChecklistProfile,
  type SetupChecklistStepId,
} from "@/lib/setup-checklist";

const STEP_ICONS = {
  profile: UserRound,
  photo: Camera,
  social: AtSign,
  content: LayoutGrid,
  design: Palette,
  share: ExternalLink,
} as const;

type Props = {
  profileId: string;
  profile: SetupChecklistProfile;
  blocks: readonly SetupChecklistBlock[];
  hasPreviewedOrShared: boolean;
  onAction: (step: SetupChecklistStepId) => void;
  openSignal?: number;
  onVisibilityChange?: (visible: boolean) => void;
};

export function SetupChecklist({
  profileId,
  profile,
  blocks,
  hasPreviewedOrShared,
  onAction,
  openSignal = 0,
  onVisibilityChange,
}: Props) {
  const steps = useMemo(
    () => getSetupChecklistSteps(profile, blocks, hasPreviewedOrShared),
    [profile, blocks, hasPreviewedOrShared],
  );
  const progress = setupChecklistProgress(steps);
  const firstIncomplete = steps.find((step) => !step.complete)?.id ?? "share";
  const [open, setOpen] = useState(false);
  const lastOpenSignal = useRef(openSignal);
  const [expanded, setExpanded] = useState<SetupChecklistStepId>(firstIncomplete);
  const [hidden, setHidden] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem(`bento:setup-hidden:${profileId}`) === "1",
  );

  useEffect(() => {
    setExpanded((current) => {
      const currentStep = steps.find((step) => step.id === current);
      return currentStep?.complete ? firstIncomplete : current;
    });
  }, [firstIncomplete, steps]);

  useEffect(() => {
    onVisibilityChange?.(!hidden);
  }, [hidden, onVisibilityChange]);

  useEffect(() => {
    if (!openSignal || openSignal === lastOpenSignal.current || hidden) return;
    lastOpenSignal.current = openSignal;
    setExpanded(firstIncomplete);
    setOpen(true);
    captureProductEvent("onboarding_checklist_opened", {
      completed_steps: progress.completed,
    });
  }, [firstIncomplete, hidden, openSignal, progress.completed]);

  useEffect(() => {
    if (progress.percentage !== 100) return;
    const completedKey = `bento:setup-completed:${profileId}`;
    const wasAlreadyCompleted = window.localStorage.getItem(completedKey) === "1";
    if (!wasAlreadyCompleted) {
      window.localStorage.setItem(completedKey, "1");
      captureProductEvent("onboarding_checklist_completed");
      toast.success("Setup complete. Your Bento is ready.");
    }

    const timer = window.setTimeout(
      () => {
        window.localStorage.setItem(`bento:setup-hidden:${profileId}`, "1");
        setOpen(false);
        setHidden(true);
      },
      wasAlreadyCompleted ? 0 : 2400,
    );
    return () => window.clearTimeout(timer);
  }, [profileId, progress.percentage]);

  if (hidden) return null;

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setExpanded(firstIncomplete);
      captureProductEvent("onboarding_checklist_opened", {
        completed_steps: progress.completed,
      });
    }
  };

  const runAction = (stepId: SetupChecklistStepId) => {
    captureProductEvent("onboarding_step_clicked", { step: stepId });
    setOpen(false);
    window.setTimeout(() => onAction(stepId), 120);
  };

  const skipSetup = () => {
    window.localStorage.setItem(`bento:setup-hidden:${profileId}`, "1");
    captureProductEvent("onboarding_checklist_dismissed", {
      completed_steps: progress.completed,
      total_steps: progress.total,
    });
    setOpen(false);
    setHidden(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => handleOpenChange(true)}
        className="fixed bottom-5 left-20 z-40 hidden w-[270px] items-center gap-3 rounded-2xl border border-[#17213a]/10 bg-white p-4 text-left text-[#17213a] shadow-[var(--shadow-float)] transition-colors hover:bg-[#f7f9fc] sm:flex"
        aria-label={`Open setup checklist, ${progress.completed} of ${progress.total} complete`}
      >
        <ProgressRing percentage={progress.percentage} compact />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">
            {progress.percentage === 100 ? "Your Bento is ready" : "Finish your setup"}
          </span>
          <span className="mt-0.5 block text-xs text-[#17213a]/48">
            {progress.completed} of {progress.total} complete
          </span>
        </span>
        <ChevronDown className="size-4 -rotate-90 text-[#17213a]/38" />
      </button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          overlayClassName="bg-[#17213a]/35"
          className="bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-3 right-3 top-auto flex max-h-[calc(100dvh-1.5rem-env(safe-area-inset-bottom))] w-auto max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden p-0 text-[#17213a] sm:bottom-5 sm:left-5 sm:right-auto sm:max-h-[calc(100dvh-2.5rem)] sm:w-[390px]"
        >
          <DialogHeader className="shrink-0 border-b border-[#17213a]/8 bg-[#f7f9fc] px-6 pb-5 pt-6 pr-14 text-left">
            <div className="flex items-center gap-4">
              <ProgressRing percentage={progress.percentage} />
              <div>
                <DialogTitle className="font-ui-display text-xl">
                  {progress.percentage === 100 ? "You're all set" : "Your setup checklist"}
                </DialogTitle>
                <DialogDescription className="mt-1 text-[#17213a]/52">
                  {progress.completed} of {progress.total} complete · Your progress saves
                  automatically
                </DialogDescription>
              </div>
            </div>
            <div className="mt-5 h-2 overflow-hidden rounded-full bg-[#17213a]/8">
              <div
                className="h-full rounded-full bg-[#3478f6] transition-[width] duration-500"
                style={{ width: `${progress.percentage}%` }}
              />
            </div>
          </DialogHeader>

          <div
            data-testid="setup-checklist-scroll-region"
            className="min-h-0 flex-1 overscroll-contain overflow-y-auto px-3 py-2"
          >
            {steps.map((step) => {
              const Icon = STEP_ICONS[step.id];
              const isExpanded = expanded === step.id;
              return (
                <div key={step.id} className="border-b border-[#17213a]/7 last:border-0">
                  <button
                    type="button"
                    onClick={() => setExpanded(step.id)}
                    className="flex w-full items-center gap-3 rounded-2xl px-3 py-3.5 text-left transition hover:bg-[#f5f7fb]"
                    aria-expanded={isExpanded}
                  >
                    <span
                      className={`flex size-9 shrink-0 items-center justify-center rounded-full ${
                        step.complete
                          ? "bg-[#dff7e8] text-[#22834b]"
                          : "border border-[#17213a]/10 bg-white text-[#3478f6]"
                      }`}
                    >
                      {step.complete ? <Check className="size-4" /> : <Icon className="size-4" />}
                    </span>
                    <span
                      className={`min-w-0 flex-1 text-sm font-semibold ${step.complete ? "text-[#17213a]/52" : ""}`}
                    >
                      {step.title}
                    </span>
                    <ChevronDown
                      className={`size-4 text-[#17213a]/35 transition ${isExpanded ? "rotate-180" : ""}`}
                    />
                  </button>

                  {isExpanded && (
                    <div className="pb-4 pl-[3.75rem] pr-3">
                      <p className="text-sm leading-relaxed text-[#17213a]/52">
                        {step.description}
                      </p>
                      {!step.complete && (
                        <button
                          type="button"
                          onClick={() => runAction(step.id)}
                          className="mt-3 inline-flex h-10 items-center justify-center rounded-xl bg-[#3478f6] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#2168e5]"
                        >
                          {step.action}
                        </button>
                      )}
                      {step.complete && (
                        <span className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-[#22834b]">
                          <Check className="size-3.5" /> Complete
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="shrink-0 border-t border-[#17213a]/8 bg-white/92 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {progress.percentage === 100 ? (
              <button
                type="button"
                onClick={skipSetup}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#17213a] text-sm font-semibold text-white hover:bg-[#0d1425]"
              >
                <Sparkles className="size-4" /> Back to my Bento
              </button>
            ) : (
              <button
                type="button"
                onClick={skipSetup}
                className="flex h-10 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold text-muted-foreground transition hover:bg-accent hover:text-foreground"
              >
                <X className="size-4" /> Skip setup
              </button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProgressRing({ percentage, compact = false }: { percentage: number; compact?: boolean }) {
  const size = compact ? 46 : 60;
  const stroke = compact ? 5 : 6;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;

  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg className="-rotate-90" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(52,120,246,0.13)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#3478f6"
          strokeLinecap="round"
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-500"
        />
      </svg>
      <span
        className={`absolute font-semibold text-[#245fd0] ${compact ? "text-[10px]" : "text-xs"}`}
      >
        {percentage}%
      </span>
    </span>
  );
}
