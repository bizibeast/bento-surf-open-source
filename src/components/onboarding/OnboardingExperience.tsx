import { configuredPublicOrigin } from "@/lib/application-urls";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CreditCard,
  LockKeyhole,
  Loader2,
  Sparkles,
} from "lucide-react";
import { AuthBrand } from "@/components/AuthShell";
import {
  activateOnboarding,
  approveOnboarding,
  editOnboardingCandidates,
  exportOnboardingContent,
  getOnboarding,
  importOnboardingSocial,
  prepareOnboarding,
  publishOnboardingPage,
  saveOnboarding,
} from "@/lib/onboarding/functions";
import {
  ONBOARDING_OUTPUT_PLATFORMS,
  onboardingBriefSchema,
  onboardingStrategyTitle,
  resolveOnboardingPlatform,
  hasUnsupportedOnboardingDrafts,
  type OnboardingBrief,
  type OnboardingCandidates,
  type ONBOARDING_PLATFORMS,
} from "@/lib/onboarding/brief";
import type { OnboardingSession } from "@/lib/onboarding/session.server";
import { beginInstagramConnection } from "@/lib/social-connections.functions";
import { beginSocialConnection } from "@/lib/social-oauth.functions";
import { createCheckout } from "@/lib/billing.functions";
import {
  PAID_PLAN_IDS,
  PLAN_PRICING,
  TRIAL_DAYS,
  planName,
  type BillingPeriod,
  type PaidPlanId,
} from "@/lib/plans";
import { checkUsername } from "@/lib/profile.functions";
import { usernameSchema } from "@/lib/username";
import { clearOnboardedCache } from "@/lib/auth-entry";
import { safeNavigationHref } from "@/lib/safe-url";
import { publicProfileUrl } from "@/lib/application-urls";
import { captureProductEvent } from "@/lib/posthog";
import {
  checkoutFailureMessage,
  readCheckoutReturn,
  withoutCheckoutReturnParams,
} from "@/lib/checkout-return";
import { consumeReferralAttribution } from "@/lib/referral.functions";
import {
  clearPendingUsername,
  getPendingUsername,
  selectOnboardingUsername,
} from "@/lib/pending-username";
import {
  BrainBook,
  FirstDraft,
  OnboardingPlanChoices,
  LinkIdentity,
  PersonAvatar,
  PreparationInProgress,
  RelatedInspiration,
  SocialConnections,
  StandoutPost,
  type OnboardingConnection,
} from "./OnboardingScreens";
import { CapabilityShowcase } from "./CapabilityShowcase";
import { brainDraftOutcome } from "@/lib/onboarding/draft-outcome";
import { brainChapterSummary } from "@/lib/onboarding/brain-summary";
import {
  ONBOARDING_DEFAULT_TRIAL_PLAN,
  onboardingPlanAftercare,
} from "@/lib/onboarding/trial-plan";
import "./onboarding.css";

type ContextField = "displayName" | "expertise" | "audience";
const questions: Record<ContextField, { title: string; hint: string; placeholder: string }> = {
  displayName: {
    title: "What should we call you?",
    hint: "The name you want people to know you by.",
    placeholder: "Your name",
  },
  expertise: {
    title: "What do you create or know best?",
    hint: "A sentence is plenty. This helps Bento find the useful threads in your work.",
    placeholder: "I make photography feel simple for beginners…",
  },
  audience: {
    title: "Who is your target audience that you want to help?",
    hint: "Be as specific as you like. You can refine this in your Brain later.",
    placeholder: "People starting their first creative business…",
  },
};
const missingContext = (brief: OnboardingBrief) =>
  (["displayName", "expertise", "audience"] as const).find((key) => !brief[key].trim());
// Step 4 is the client-only capability showcase between the Brain and the trial step.
const chapterFor = (step: number) => (step === 0 ? 0 : step === 1 ? 1 : step < 4 ? 2 : 3);
const normalizedStep = (session: OnboardingSession) =>
  session.status === "applied" ? 6 : session.step === 4 ? 3 : session.step;

export function OnboardingExperience() {
  const queryClient = useQueryClient();
  const reduced = useReducedMotion();
  const [session, setSession] = useState<OnboardingSession | null>(null);
  const [brief, setBrief] = useState(() => onboardingBriefSchema.parse({}));
  const [candidates, setCandidates] = useState<OnboardingCandidates | null>(null);
  const [step, setStep] = useState(0);
  const [contextField, setContextField] = useState<ContextField>("audience");
  const [reveal, setReveal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Dodo sends people back with ?status=failed after a declined card. That is
  // never a success: show why and offer a fresh checkout.
  const [checkoutFailure, setCheckoutFailure] = useState<string | null>(null);
  const checkoutReturnRef = useRef<ReturnType<typeof readCheckoutReturn> | null>(null);
  const [savedLabel, setSavedLabel] = useState("Saved");
  const [plan, setPlan] = useState<PaidPlanId>(ONBOARDING_DEFAULT_TRIAL_PLAN);
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
  const [usernameStatus, setUsernameStatus] = useState<"idle" | "checking" | "available" | "taken">(
    "idle",
  );
  const sessionRef = useRef<OnboardingSession | null>(null);
  const briefRef = useRef(brief);
  const candidateEdits = useRef<OnboardingCandidates | null>(null);
  const saveQueue = useRef<Promise<OnboardingSession | null>>(Promise.resolve(null));
  const headingRef = useRef<HTMLHeadingElement>(null);
  // True while this tab waits for its own preparation request, so the waiting screen can show
  // the job's real progress before the request returns.
  const [watchingPreparation, setWatchingPreparation] = useState(false);
  const query = useQuery({
    queryKey: ["onboarding"],
    queryFn: () => getOnboarding(),
    refetchInterval: (current) =>
      watchingPreparation ||
      ["queued", "running"].includes(current.state.data?.session.jobStatus || "") ||
      current.state.data?.session.status === "prepared"
        ? 3000
        : false,
  });
  const connections = (query.data?.connections || []) as OnboardingConnection[];
  const hasHostedAccess = Boolean(
    query.data?.selfHosted || (query.data?.plan && query.data.plan !== "free"),
  );
  const trialEligible = query.data?.trialEligible !== false;
  // True while this tab starts a preparation request. Kept apart from `busy` so other
  // actions on the reveal (such as approving the draft) never bring back the Brain
  // progress screen.
  const [preparing, setPreparing] = useState(false);
  // Only a real preparation shows the "Connecting the dots" screen.
  const building =
    preparing || Boolean(session && ["queued", "running"].includes(session.jobStatus));
  // The polled session shows the running job's progress even before this tab accepts it.
  const liveSession =
    query.data?.session && session && query.data.session.revision === session.revision
      ? query.data.session
      : session;
  const livePersonalization = liveSession?.candidates?.personalization;
  const preparationProgress =
    livePersonalization && livePersonalization.generation === liveSession?.generationCount
      ? { status: livePersonalization.status, done: livePersonalization.progress ?? [] }
      : null;

  function updateBrief(value: OnboardingBrief) {
    briefRef.current = value;
    setBrief(value);
  }
  function patch<K extends keyof OnboardingBrief>(key: K, value: OnboardingBrief[K]) {
    updateBrief({ ...briefRef.current, [key]: value });
  }
  function accept(next: OnboardingSession, replaceBrief = false) {
    if (sessionRef.current && next.revision < sessionRef.current.revision) return;
    sessionRef.current = next;
    setSession(next);
    if (!candidateEdits.current) setCandidates(next.candidates);
    if (replaceBrief) updateBrief(next.brief);
  }
  useEffect(() => {
    void consumeReferralAttribution().catch(() => undefined);
  }, []);
  useEffect(() => {
    const returned = readCheckoutReturn(window.location.search);
    checkoutReturnRef.current = returned;
    if (returned.outcome === "none") return;
    if (returned.outcome === "failed") {
      setCheckoutFailure(checkoutFailureMessage(returned.status, returned.trial));
      captureProductEvent("onboarding_checkout_failed", {
        status: returned.status,
        trial: returned.trial,
      });
    } else {
      captureProductEvent("onboarding_checkout_returned", {
        status: returned.status,
        outcome: returned.outcome,
      });
    }
    window.history.replaceState(
      window.history.state,
      "",
      withoutCheckoutReturnParams(window.location.href),
    );
  }, []);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [step, contextField, reveal]);
  useEffect(() => {
    const next = query.data?.session;
    if (!next) return;
    if (!sessionRef.current) {
      const initial: OnboardingBrief = {
        ...next.brief,
        platform:
          next.step === 0 && next.generationCount === 0 && !next.candidates
            ? "linkedin"
            : (ONBOARDING_OUTPUT_PLATFORMS as readonly string[]).includes(next.brief.platform)
              ? next.brief.platform
              : "linkedin",
        goal:
          next.step === 0 &&
          next.generationCount === 0 &&
          !next.candidates &&
          next.brief.goal === "presence"
            ? "grow"
            : next.brief.goal,
        username:
          next.step === 0
            ? selectOnboardingUsername(
                next.brief.username,
                getPendingUsername(window.sessionStorage),
              )
            : next.brief.username,
        timezone: next.brief.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
      accept(
        {
          ...next,
          brief: initial,
          candidates:
            next.status !== "applied" &&
            next.candidates &&
            hasUnsupportedOnboardingDrafts(next.candidates)
              ? null
              : next.candidates,
        },
        true,
      );
      setStep(
        window.sessionStorage.getItem("bentoOnboardingSocialReturn") ? 1 : normalizedStep(next),
      );
      window.sessionStorage.removeItem("bentoOnboardingSocialReturn");
      if (next.status === "prepared" && checkoutReturnRef.current?.outcome === "failed") setStep(5);
      setContextField(missingContext(initial) || "audience");
      try {
        const choice = JSON.parse(window.sessionStorage.getItem("bentoPricingSelection") || "null");
        if (choice?.plan && PAID_PLAN_IDS.includes(choice.plan)) setPlan(choice.plan);
        if (choice?.period === "yearly") setPeriod("yearly");
      } catch {
        /* An invalid saved pricing preference does not block setup. */
      }
    } else if (
      next.revision === sessionRef.current.revision &&
      (["queued", "running"].includes(sessionRef.current.jobStatus) ||
        (next.status === "applied" && sessionRef.current.status !== "applied"))
    )
      accept(next);
    // A query refresh must not overwrite answers currently being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data]);
  const lastJobStatus = useRef<string | null>(null);
  // Set when this tab asks for a draft. The request can come back already finished, so the
  // client may never see a queued or running session.
  const awaitingDraft = useRef(false);
  useEffect(() => {
    if (!session) return;
    const previous = awaitingDraft.current ? "queued" : lastJobStatus.current;
    lastJobStatus.current = session.jobStatus;
    const outcome = brainDraftOutcome(previous, session, brief.platform);
    if (outcome) {
      awaitingDraft.current = false;
      captureProductEvent(outcome.event, outcome.properties);
    }
    // Only job transitions matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.jobStatus, session?.revision]);
  useEffect(() => {
    if (step !== 0) return;
    let current = true;
    const username = brief.username;
    if (!usernameSchema.safeParse(username).success) {
      setUsernameStatus("idle");
      return;
    }
    if (username === query.data?.currentUsername) {
      setUsernameStatus("available");
      return;
    }
    setUsernameStatus("checking");
    const timer = window.setTimeout(() => {
      void checkUsername({ data: { username } })
        .then((result) => {
          if (current) setUsernameStatus(result.available ? "available" : "taken");
        })
        .catch(() => {
          if (current) setUsernameStatus("idle");
        });
    }, 350);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [brief.username, query.data?.currentUsername, step]);

  function save(nextStep = step, value = briefRef.current) {
    const task = saveQueue.current
      .catch(() => null)
      .then(async () => {
        let latest = sessionRef.current;
        if (!latest) throw new Error("Your setup is still loading.");
        const edits = candidateEdits.current;
        if (edits) {
          latest = await editOnboardingCandidates({
            data: { revision: latest.revision, candidates: edits },
          });
          if (candidateEdits.current === edits) candidateEdits.current = null;
          accept(latest);
        }
        const saved = await saveOnboarding({
          data: { revision: latest.revision, step: Math.min(nextStep, 5), brief: value },
        });
        accept(saved);
        setSavedLabel("Saved");
        return saved;
      });
    saveQueue.current = task;
    return task;
  }
  useEffect(() => {
    if (
      !session ||
      session.status === "applied" ||
      busy ||
      !onboardingBriefSchema.safeParse(brief).success ||
      (!candidateEdits.current && JSON.stringify(brief) === JSON.stringify(session.brief))
    )
      return;
    setSavedLabel("Saving…");
    const timer = window.setTimeout(() => {
      void save().catch((cause) => {
        setSavedLabel("Not saved yet");
        setError(cause instanceof Error ? cause.message : "Could not save.");
      });
    }, 700);
    return () => window.clearTimeout(timer);
    // All writes are serialized against the latest server revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brief, candidates, busy, step]);
  async function action(run: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  async function activate() {
    accept(await activateOnboarding(), true);
    setStep(6);
    clearOnboardedCache();
    clearPendingUsername(window.sessionStorage);
    await queryClient.invalidateQueries({ queryKey: ["my-profile"] });
    captureProductEvent("onboarding_workspace_ready");
  }
  useEffect(() => {
    if (session?.status === "prepared" && step === 5 && hasHostedAccess && !busy)
      void action(activate);
    // Only verified server access can activate a workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.status, step, hasHostedAccess]);
  async function importProfile(id: string) {
    const imported = await importOnboardingSocial({ data: { connectionId: id } });
    const current = briefRef.current;
    const value: OnboardingBrief = {
      ...current,
      displayName: imported.displayName || current.displayName,
      avatarUrl: imported.avatarUrl || current.avatarUrl,
      primaryConnectionId: imported.primaryConnectionId,
      writingSample: imported.writingSample || current.writingSample,
      expertise: current.expertise || imported.bio,
      bio: imported.bio || current.bio,
      links: [
        ...current.links,
        ...imported.links.filter(
          (link) => !current.links.some((existing) => existing.url === link.url),
        ),
      ].slice(0, 8),
    };
    updateBrief(value);
    await save(1, value);
    return value;
  }
  async function connect(provider: (typeof ONBOARDING_PLATFORMS)[number]) {
    await action(async () => {
      await save(1);
      const result =
        provider === "instagram"
          ? await beginInstagramConnection({ data: { intent: "scheduler" } })
          : await beginSocialConnection({ data: { provider } });
      const href = safeNavigationHref(result.url);
      if (!href) throw new Error("The connection link was invalid.");
      window.sessionStorage.setItem("bentoOnboardingSocialReturn", "1");
      window.location.assign(href);
    });
  }
  async function prepare(value = briefRef.current, manual = false) {
    // Write for the connected account's platform, or one the creator named in their answers.
    const provider = connections.find((item) => item.id === value.primaryConnectionId)?.provider;
    const platform = resolveOnboardingPlatform(value, provider);
    if (platform !== value.platform) {
      value = { ...value, platform };
      updateBrief(value);
    }
    setPreparing(true);
    try {
      await prepareSteps(value, manual);
    } finally {
      setPreparing(false);
    }
  }
  async function prepareSteps(value: OnboardingBrief, manual: boolean) {
    const latest = await save(3, value);
    setStep(3);
    setReveal(0);
    if (!manual) awaitingDraft.current = true;
    setWatchingPreparation(!manual);
    try {
      accept(await prepareOnboarding({ data: { revision: latest.revision, generate: !manual } }));
    } finally {
      setWatchingPreparation(false);
    }
    await query.refetch();
  }
  async function forward() {
    await action(async () => {
      if (step === 0) {
        if (!usernameSchema.safeParse(brief.username).success)
          throw new Error("Choose 3–24 letters, numbers, or underscores for your link.");
        if (
          brief.username !== query.data?.currentUsername &&
          !(await checkUsername({ data: { username: brief.username } })).available
        )
          throw new Error("That link is already taken. Try another username.");
        await save(1);
        setStep(1);
        return;
      }
      if (step === 1) {
        let value = briefRef.current;
        if (
          connections.length &&
          !connections.some((item) => item.id === value.primaryConnectionId)
        )
          value = await importProfile(connections[0].id);
        const missing = missingContext(value);
        if (missing) {
          setContextField(missing);
          await save(2, value);
          setStep(2);
        } else await prepare(value);
        return;
      }
      if (step === 2) {
        if (!briefRef.current[contextField].trim())
          throw new Error("Add a little context so Bento can make this personal.");
        const missing = missingContext(briefRef.current);
        if (missing) {
          await save(2);
          setContextField(missing);
        } else await prepare();
        return;
      }
      if (step === 3) {
        if (reveal < reveals.length - 1) {
          setReveal((value) => value + 1);
          return;
        }
        const latest = await save(3);
        if (!latest.candidates) throw new Error("Prepare your Brain before continuing.");
        accept(
          await approveOnboarding({
            data: {
              revision: latest.revision,
              candidates: latest.candidates,
              allowPartial: latest.candidates.drafts.length === 0,
            },
          }),
        );
        // Free workspaces see what Bento can do before choosing a plan.
        setStep(hasHostedAccess ? 5 : 4);
        captureProductEvent("onboarding_preparation_ready");
        if (hasHostedAccess) await activate();
      }
    });
  }
  async function checkout() {
    captureProductEvent("trial_cta_clicked", {
      source: "onboarding",
      surface: "onboarding_trial_step",
      plan,
      billing_interval: period,
      trial: trialEligible,
      retry: Boolean(checkoutFailure),
    });
    await action(async () => {
      await saveQueue.current;
      const result = await createCheckout({
        data: { plan, period, returnTo: "onboarding", contactTier: 500, storageUnits: 0 },
      });
      const href = safeNavigationHref(result.url);
      if (!href) throw new Error("The checkout link was invalid.");
      const properties = {
        source: "onboarding",
        surface: "onboarding_trial_step",
        plan,
        billing_interval: period,
        trial: trialEligible,
      };
      captureProductEvent("onboarding_checkout_started", { plan });
      captureProductEvent("checkout_started", properties);
      window.location.assign(href);
    });
  }
  async function exportPreparation() {
    const content = await exportOnboardingContent();
    const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "my-bento-preparation.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }
  const evidence = candidates?.evidence;
  const reveals = [
    evidence?.standout ? "standout" : null,
    evidence?.inspirations.length ? "inspiration" : null,
    "brain",
    candidates?.drafts.length ? "draft" : null,
  ].filter(Boolean) as string[];
  const currentReveal = reveals[Math.min(reveal, reveals.length - 1)];
  const question = questions[contextField];
  const price = PLAN_PRICING[plan][period];
  const headings: Record<string, [string, string, string]> = {
    standout: [
      "A little proof of your potential",
      "You already have something worth sharing.",
      "We found a post your audience responded to. This is part of what makes your Brain personal.",
    ],
    inspiration: [
      "Your corner of the internet",
      "Good company for your next idea.",
      "A few sourced ideas from your space. Explore the originals whenever you like.",
    ],
    brain: [
      "Made from your world",
      `Meet your Brain, ${brief.displayName.split(" ")[0] || "creator"}.`,
      "Your story, your voice, and a direction to grow. Read a chapter, make it yours, and keep moving.",
    ],
    draft: [
      "Your first small win",
      "This already sounds more like you.",
      "A new piece of content built from your context. Your approval always comes before publishing.",
    ],
  };
  const intro =
    step === 0
      ? [
          "A little space, all yours",
          "First, make a name for yourself.",
          "Choose the link that brings your world together. You can change it later.",
        ]
      : step === 1
        ? [
            "Bring your world with you",
            "Your socials. Your starting point.",
            "Connect the accounts that feel most like you. Bento will use their available profiles and posts to get to know your work.",
          ]
        : step === 2
          ? ["One little thing", question.title, question.hint]
          : step === 3
            ? building
              ? [
                  "Making it personal",
                  "You're more than a bio.",
                  "Let's give your ideas, experience, and voice a home.",
                ]
              : headings[currentReveal]
            : step === 4
              ? [
                  "Everything in one place",
                  "Here's what you can do with Bento.",
                  "Your Brain is ready. These are the tools that put it to work. Pick the plan that fits.",
                ]
              : step === 5
                ? [
                    "Your next chapter",
                    hasHostedAccess
                      ? "Your workspace is ready to open."
                      : "You've seen the start. Make it yours.",
                    hasHostedAccess
                      ? "Your plan is active. Your personal preparation is saved."
                      : "Your Brain and your first ideas are waiting. Choose how you want to build with Bento.",
                  ]
                : [
                    "Welcome to your Bento",
                    "Your Bento is ready.",
                    "A home for your work. A Brain that grows with you. Your next idea starts here.",
                  ];

  if (query.isError && !session)
    return (
      <main className="onboarding ob-main">
        <AuthBrand />
        <div className="ob-intro">
          <h1>Your setup could not load.</h1>
          <p>Your saved answers are safe.</p>
        </div>
        <button className="ob-primary" onClick={() => void query.refetch()}>
          Try again
        </button>
      </main>
    );
  if (!session)
    return (
      <main className="onboarding">
        <div className="ob-main">
          <PreparationInProgress name="" accountCount={0} jobStatus="queued" />
        </div>
      </main>
    );
  if (session.status === "applied" && query.data?.plan === "free" && !query.data?.selfHosted)
    return (
      <main className="onboarding">
        <div className="ob-main ob-narrow">
          <AuthBrand />
          <div className="ob-intro">
            <h1>Your work is saved.</h1>
            <p>Review your billing to restore hosted access.</p>
          </div>
          <a className="ob-primary" href="/settings?section=plan">
            Review my billing <ArrowRight />
          </a>
          <button className="ob-secondary" onClick={() => void action(exportPreparation)}>
            Download my preparation
          </button>
        </div>
      </main>
    );

  return (
    <main className="onboarding auth-light">
      <header className="ob-header">
        <AuthBrand />
        <nav className="ob-progress" aria-label="Setup progress">
          {["Your link", "Your socials", "Your Brain", "Your Bento"].map((label, index) => (
            <span
              key={label}
              className={index < chapterFor(step) ? "ob-complete" : ""}
              aria-current={index === chapterFor(step) ? "step" : undefined}
            >
              <i />
              {label}
            </span>
          ))}
        </nav>
        <span className="ob-saved" role="status">
          {savedLabel}
        </span>
      </header>
      <div
        className={`ob-main ${step === 3 ? "ob-reveal-main" : ""} ${step === 0 || step === 2 || step === 6 ? "ob-narrow" : ""}`}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.section
            key={`${step}-${step === 2 ? contextField : step === 3 && !building ? currentReveal : ""}`}
            initial={reduced ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? {} : { opacity: 0, y: -8 }}
            transition={{ duration: reduced ? 0 : 0.24 }}
            onAnimationComplete={() => headingRef.current?.focus({ preventScroll: true })}
          >
            {step === 0 && <LinkIdentity username={brief.username} />}
            {step === 6 && (
              <div className="ob-ready-badge">
                <Check />
              </div>
            )}
            <div className="ob-intro">
              <span className="ob-eyebrow">
                <Sparkles />
                {intro[0]}
              </span>
              <h1 ref={headingRef} tabIndex={-1}>
                {intro[1]}
              </h1>
              <p>{intro[2]}</p>
            </div>
            {step === 0 && (
              <div className="ob-question">
                <label className="sr-only" htmlFor="bento-username">
                  Your Bento username
                </label>
                <div className="ob-username">
                  <span>
                    {new URL(configuredPublicOrigin(import.meta.env.VITE_PUBLIC_URL)).host}/
                  </span>
                  <input
                    id="bento-username"
                    value={brief.username}
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={24}
                    placeholder="your-name"
                    onChange={(event) => patch("username", event.target.value.toLowerCase())}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void forward();
                      }
                    }}
                  />
                </div>
                <p className="ob-username-status" aria-live="polite">
                  {usernameStatus === "available" ? (
                    <>
                      <CheckCircle2 />
                      Looks good. This link is available to you.
                    </>
                  ) : usernameStatus === "checking" ? (
                    <>
                      <Loader2 className="motion-safe:animate-spin" />
                      Checking your link…
                    </>
                  ) : usernameStatus === "taken" ? (
                    "That link is taken. Try another name."
                  ) : (
                    "3–24 letters, numbers, or underscores."
                  )}
                </p>
              </div>
            )}
            {step === 1 && (
              <>
                <SocialConnections
                  connections={connections}
                  primaryId={brief.primaryConnectionId}
                  busy={busy}
                  onConnect={(provider) => void connect(provider)}
                  onUse={(id) =>
                    void action(async () => {
                      await importProfile(id);
                    })
                  }
                />
                <p className="ob-center-note">
                  <LockKeyhole />
                  Connect with the permissions shown by each platform. You stay in control of what
                  gets published.
                </p>
              </>
            )}
            {step === 2 && (
              <div className="ob-question">
                <textarea
                  key={contextField}
                  className="ob-answer"
                  aria-label={question.title}
                  rows={contextField === "displayName" ? 1 : 3}
                  maxLength={contextField === "displayName" ? 60 : 500}
                  value={brief[contextField]}
                  placeholder={question.placeholder}
                  // Typing while the Brain is being prepared would change the answers it was built from.
                  readOnly={building || busy}
                  onChange={(event) => patch(contextField, event.target.value)}
                />
                <p className="ob-question-hint">
                  {contextField === "audience"
                    ? "For example: first-time founders, new photographers, or people finding their creative confidence."
                    : "A few honest words are a great start."}
                </p>
              </div>
            )}
            {step === 3 && (
              <>
                {building ? (
                  <PreparationInProgress
                    name={brief.displayName}
                    accountCount={connections.length}
                    jobStatus={liveSession?.jobStatus ?? session.jobStatus}
                    progress={preparationProgress}
                    strategyTitle={onboardingStrategyTitle(brief)}
                  />
                ) : candidates ? (
                  <>
                    {currentReveal === "standout" && evidence?.standout && (
                      <StandoutPost post={evidence.standout} brief={brief} />
                    )}
                    {currentReveal === "inspiration" && evidence && (
                      <RelatedInspiration items={evidence.inspirations} />
                    )}
                    {currentReveal === "brain" && (
                      <BrainBook
                        brief={brief}
                        candidates={candidates}
                        onEdit={(index, content) => {
                          const next = {
                            ...candidates,
                            brain: candidates.brain.map((item, i) =>
                              i === index ? { ...item, content } : item,
                            ),
                          };
                          candidateEdits.current = next;
                          setCandidates(next);
                        }}
                      />
                    )}
                    {currentReveal === "draft" && candidates.drafts[0] && (
                      <FirstDraft draft={candidates.drafts[0]} brief={brief} />
                    )}
                    <div className="ob-reveal-progress" aria-label="Your personal preview">
                      {reveals.map((item, index) => (
                        <span key={item} aria-current={index === reveal ? "step" : undefined} />
                      ))}
                    </div>
                    {session.jobError && <p className="ob-center-note">{session.jobError}</p>}
                    {((session.generationCount < 2 &&
                      (session.jobError || candidates.warning || !candidates.drafts.length)) ||
                      candidates.warning) && (
                      <div className="ob-ready-actions">
                        {session.generationCount < 2 &&
                          (session.jobError || candidates.warning || !candidates.drafts.length) && (
                            <button
                              className="ob-secondary"
                              type="button"
                              disabled={building || busy}
                              onClick={() => void action(() => prepare())}
                            >
                              Try the draft again
                            </button>
                          )}
                        {candidates.warning && (
                          <button
                            className="ob-secondary"
                            type="button"
                            disabled={building || busy}
                            onClick={() => void action(() => prepare(briefRef.current, true))}
                          >
                            Continue without this draft
                          </button>
                        )}
                      </div>
                    )}
                    {!candidates.drafts.length && (
                      <p className="ob-center-note">
                        Your Brain is saved. A starter draft is optional, and your page can still be
                        published.
                      </p>
                    )}
                  </>
                ) : (
                  <div className="ob-ready">
                    <p className="ob-small">
                      Your answers are saved. Let's prepare your personal starting point.
                    </p>
                    <button className="ob-primary" onClick={() => void action(() => prepare())}>
                      Prepare my Brain <Sparkles />
                    </button>
                    <button
                      className="ob-back"
                      onClick={() => void action(() => prepare(briefRef.current, true))}
                    >
                      Continue with my answers
                    </button>
                  </div>
                )}
              </>
            )}
            {step === 4 && (
              <CapabilityShowcase
                brainChapters={candidates?.brain.length || 0}
                onContinue={() => setStep(5)}
                onSkip={() => setStep(5)}
              />
            )}
            {step === 5 &&
              (hasHostedAccess ? (
                <div className="ob-ready">
                  <button
                    className="ob-primary"
                    disabled={busy}
                    onClick={() => void action(activate)}
                  >
                    {busy && <Loader2 className="motion-safe:animate-spin" />}Activate my workspace{" "}
                    <ArrowRight />
                  </button>
                </div>
              ) : (
                <div className="ob-payment">
                  <div className="ob-payment-person">
                    <PersonAvatar url={brief.avatarUrl} name={brief.displayName} />
                    <span>
                      <strong>{brief.displayName}'s Bento</strong>
                      <small>
                        {new URL(configuredPublicOrigin(import.meta.env.VITE_PUBLIC_URL)).host}/
                        {brief.username} · {brainChapterSummary(candidates)}
                      </small>
                    </span>
                    <CheckCircle2 />
                  </div>
                  <OnboardingPlanChoices
                    plan={plan}
                    period={period}
                    onPlan={setPlan}
                    onPeriod={setPeriod}
                  />
                  <div className="ob-price-row">
                    <div>
                      <span className="ob-eyebrow">Your selected plan</span>
                      <h2>Bento {planName(plan)}</h2>
                      <p>
                        {plan === "creator_plus"
                          ? "Your Brain, Agent, and tools to grow."
                          : "Your page and the tools included in your plan."}
                      </p>
                    </div>
                    <div className="ob-price">
                      <strong>{trialEligible ? "$0" : price.label}</strong>
                      <span>{trialEligible ? "today" : price.cadence}</span>
                    </div>
                  </div>
                  <p className="ob-center-note ob-plan-aftercare" data-testid="plan-aftercare">
                    {onboardingPlanAftercare(plan)}
                  </p>
                  {(session.jobError || !candidates?.drafts.length) &&
                    session.generationCount < 2 && (
                      <button
                        className="ob-secondary"
                        type="button"
                        disabled={busy}
                        onClick={() => void action(() => prepare())}
                      >
                        Try the draft again
                      </button>
                    )}
                  {session.jobError && <p className="ob-center-note">{session.jobError}</p>}
                  {checkoutFailure && (
                    <p className="ob-center-note ob-checkout-failed" role="alert">
                      {checkoutFailure}
                    </p>
                  )}
                  <button
                    className="ob-primary"
                    disabled={busy}
                    onClick={() => {
                      if (checkoutFailure)
                        captureProductEvent("onboarding_checkout_retry", { plan });
                      void checkout();
                    }}
                  >
                    {busy ? <Loader2 className="motion-safe:animate-spin" /> : <CreditCard />}
                    {checkoutFailure
                      ? "Try another card"
                      : trialEligible
                        ? `Start my ${TRIAL_DAYS}-day trial`
                        : "Activate my plan"}
                    <ArrowRight />
                  </button>
                  <p className="ob-billing-copy">
                    {trialEligible ? (
                      <>
                        Then {price.label}
                        {price.cadence} after {TRIAL_DAYS} days. Card, UPI or wallet required. No
                        charge if you cancel before the trial ends. We'll remind you 24 hours
                        before.
                      </>
                    ) : (
                      <>
                        {price.label}
                        {price.cadence}, charged at checkout. This account has already used its
                        trial.
                      </>
                    )}{" "}
                    Prices are in USD. Checkout may show the price in your local currency, plus any
                    tax that applies where you are.
                  </p>
                </div>
              ))}
            {step === 6 && (
              <div className="ob-ready">
                <div className="ob-ready-summary">
                  <span>
                    <Check />
                    Your page is prepared
                  </span>
                  <span>
                    <Check />
                    {brainChapterSummary(candidates)} saved
                  </span>
                  <span>
                    <Check />
                    {candidates?.drafts.length || 0} starter drafts saved
                  </span>
                </div>
                <div className="ob-ready-actions">
                  <a
                    className="ob-primary"
                    href={
                      query.data?.plan === "creator_plus" || query.data?.selfHosted
                        ? `/content?tab=agent${session.threadId ? `&thread=${encodeURIComponent(session.threadId)}` : ""}`
                        : "/link"
                    }
                  >
                    Open my workspace <ArrowRight />
                  </a>
                  <button
                    className="ob-secondary"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        if (brief.publishPage) {
                          await navigator.clipboard.writeText(publicProfileUrl(brief.username));
                          setSavedLabel("Link copied");
                        } else accept(await publishOnboardingPage(), true);
                      })
                    }
                  >
                    {brief.publishPage ? "Copy my page link" : "Publish my page"}
                  </button>
                </div>
                <p className="ob-center-note">
                  {brief.publishPage
                    ? "Your page is live."
                    : "Your page stays private until you choose to publish it."}
                </p>
                {query.data?.plan &&
                  query.data.plan !== "free" &&
                  query.data.plan !== "creator_plus" &&
                  !query.data.selfHosted && (
                    <p className="ob-center-note" data-testid="ready-aftercare">
                      Brain and Agent are included with Creator Plus only. Your Brain chapters and
                      starter drafts stay saved here, and you can download them below.
                    </p>
                  )}
                <button className="ob-text-link" onClick={() => void action(exportPreparation)}>
                  Download my Brain and drafts
                </button>
                {query.data?.trialEndsAt && (
                  <p className="ob-center-note">
                    Your trial ends {new Date(query.data.trialEndsAt).toLocaleDateString()}. Manage
                    your plan in{" "}
                    <a href="/settings?section=plan" className="ob-text-link">
                      Settings
                    </a>
                    .
                  </p>
                )}
              </div>
            )}
          </motion.section>
        </AnimatePresence>
        {error && (
          <div className="ob-error" role="alert">
            {error}
          </div>
        )}
        {step < 4 && !(step === 3 && (!candidates || building)) && (
          <div className="ob-footer">
            {step > 0 ? (
              <button
                className="ob-back"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  if (step === 3 && reveal > 0) setReveal((value) => value - 1);
                  else setStep(step === 3 ? 1 : step - 1);
                }}
              >
                <ArrowLeft />
                Back
              </button>
            ) : (
              <span className="ob-small">Your corner of the internet.</span>
            )}
            <button
              className="ob-primary"
              disabled={building || busy || (step === 0 && usernameStatus === "taken")}
              onClick={() => void forward()}
            >
              {busy && <Loader2 className="motion-safe:animate-spin" />}
              {step === 0
                ? "Make it mine"
                : step === 1
                  ? connections.length
                    ? "Continue"
                    : "Continue without connecting"
                  : step === 2
                    ? missingContext({ ...brief, [contextField]: "answered" })
                      ? "Continue"
                      : "Meet my Brain"
                    : reveal < reveals.length - 1
                      ? currentReveal === "standout" || currentReveal === "inspiration"
                        ? "Keep going"
                        : "See my first draft"
                      : candidates?.drafts.length
                        ? "This feels like me"
                        : "Continue with my Brain"}
              <ArrowRight />
            </button>
          </div>
        )}
        {step === 5 && (
          <div className="ob-footer">
            <button
              className="ob-back"
              disabled={busy}
              onClick={() => setStep(hasHostedAccess ? 3 : 4)}
            >
              <ArrowLeft />
              {hasHostedAccess ? "Back to my Brain" : "Back"}
            </button>
            {!hasHostedAccess && (
              <button
                className="ob-text-link"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await query.refetch();
                    await activate();
                  })
                }
              >
                Already checked out? Verify access
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
