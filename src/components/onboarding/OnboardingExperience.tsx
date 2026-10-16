import { consumeReferralAttribution } from "@/lib/referral.functions";
import {
  getPendingUsername,
  clearPendingUsername,
  selectOnboardingUsername,
} from "@/lib/pending-username";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Brain,
  Check,
  CheckCircle2,
  Copy,
  CreditCard,
  FileText,
  Globe,
  Loader2,
  LockKeyhole,
  Plus,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { SiFacebook, SiInstagram, SiThreads, SiTiktok, SiX, SiYoutube } from "react-icons/si";
import { FaLinkedinIn } from "react-icons/fa";
import { toast } from "sonner";
import { AuthBrand } from "@/components/AuthShell";
import { OnboardingPreview, previewThemes } from "./OnboardingPreview";
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
  ONBOARDING_GOALS,
  ONBOARDING_PLATFORMS,
  ONBOARDING_OUTPUT_PLATFORMS,
  onboardingBriefSchema,
  recommendedPlan,
  type OnboardingBrief,
  type OnboardingCandidates,
} from "@/lib/onboarding/brief";
import type { OnboardingSession } from "@/lib/onboarding/session.server";
import { beginInstagramConnection } from "@/lib/social-connections.functions";
import { beginSocialConnection } from "@/lib/social-oauth.functions";
import { SOCIAL_PROVIDER_DEFINITIONS } from "@/lib/social-scheduler";
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
import { clearOnboardedCache } from "@/lib/auth-entry";
import { safeNavigationHref } from "@/lib/safe-url";
import { publicProfileUrl } from "@/lib/application-urls";
import { captureProductEvent } from "@/lib/posthog";
import { motionTokens } from "@/lib/motion";

const icons = {
  instagram: SiInstagram,
  twitter: SiX,
  linkedin: FaLinkedinIn,
  facebook: SiFacebook,
  threads: SiThreads,
  tiktok: SiTiktok,
  youtube: SiYoutube,
};
const steps = ["Welcome", "Connect", "Direction", "Voice", "Your page", "Your trial", "Ready"];
const inputClass =
  "mt-2 w-full rounded-xl border border-black/10 bg-white px-4 py-3 text-sm text-[#17213a] outline-none transition-colors focus:border-[#3478f6] focus:ring-2 focus:ring-[#3478f6]/15";
const secondary =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-black/10 bg-white px-4 py-2.5 text-sm font-medium transition-colors hover:bg-slate-50 disabled:opacity-50";
const primary =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-[#3478f6] px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#2563db] disabled:opacity-50";
const headings = [
  "Let's get your business ready.",
  "Bring what you've already built.",
  "What should Bento help you achieve first?",
  "Make it sound like you.",
  "Make this your home on the internet.",
  "Your work is prepared. Make it yours.",
  "Your Bento is ready.",
];
const subtitles = [
  "A page for your work. A Brain that knows your voice. A clear next step.",
  "Connect one account. We'll use the profile and available posts to give you a head start.",
  "One priority is enough. We'll shape your page and content around it.",
  "Review what Bento should remember, so you don't have to explain yourself every time.",
  "A few finishing touches, and your page is ready for activation.",
  `Start ${TRIAL_DAYS} full days with Creator Plus. Choose the plan that continues afterward.`,
  "Your page, your voice, and your next move, in one workspace.",
];
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm font-medium">
      {label}
      {children}
      {hint && (
        <span className="mt-1.5 block text-xs font-normal leading-relaxed text-slate-500">
          {hint}
        </span>
      )}
    </label>
  );
}

export function OnboardingExperience() {
  const reduced = useReducedMotion();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["onboarding"],
    queryFn: () => getOnboarding(),
    refetchInterval: (q) =>
      ["queued", "running"].includes(q.state.data?.session.jobStatus ?? "") ||
      q.state.data?.session.status === "prepared"
        ? 2500
        : false,
  });
  const [session, setSession] = useState<OnboardingSession | null>(null);
  const currentSession = useRef<OnboardingSession | null>(null);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const [brief, setBrief] = useState(() => onboardingBriefSchema.parse({}));
  const [candidates, setCandidates] = useState<OnboardingCandidates | null>(null);
  const candidateEdits = useRef<OnboardingCandidates | null>(null);
  const [step, setStep] = useState(0);
  const [plan, setPlan] = useState<PaidPlanId>("creator_plus");
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
  const selectedPrice = PLAN_PRICING[plan][period];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedLabel, setSavedLabel] = useState("Your progress is saved as you go");
  const [allowPartial, setAllowPartial] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [linkTitle, setLinkTitle] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  function accept(next: OnboardingSession, replaceBrief = false) {
    currentSession.current = next;
    setSession(next);
    if (!candidateEdits.current) setCandidates(next.candidates);
    if (replaceBrief) setBrief(next.brief);
  }
  useEffect(() => {
    const next = query.data?.session;
    if (!next) return;
    if (currentSession.current?.workspaceId !== next.workspaceId) {
      accept(next, true);
      setStep(next.step);
      if (next.step === 0)
        setBrief({
          ...next.brief,
          username: selectOnboardingUsername(
            next.brief.username,
            getPendingUsername(window.sessionStorage),
          ),
        });
      void consumeReferralAttribution().catch(() => undefined);
      const pricingSelection = window.sessionStorage.getItem("bentoPricingSelection");
      let preferred: { plan?: string; period?: string } | null = null;
      try {
        preferred = pricingSelection ? JSON.parse(pricingSelection) : null;
      } catch {
        preferred = null;
      }
      setPlan(
        preferred?.plan && PAID_PLAN_IDS.includes(preferred.plan as PaidPlanId)
          ? (preferred.plan as PaidPlanId)
          : recommendedPlan(next.brief.goal),
      );
      setPeriod(preferred?.period === "yearly" ? "yearly" : "monthly");
    } else if (
      ["running", "queued"].includes(currentSession.current.jobStatus) &&
      next.revision === currentSession.current.revision
    )
      accept(next);
  }, [query.data]);
  function save(nextStep: number, value = brief) {
    const pending = saveQueue.current
      .catch(() => undefined)
      .then(async () => {
        if (!currentSession.current) throw new Error("Your workspace is still loading.");
        const pendingEdits = candidateEdits.current;
        if (pendingEdits) {
          const edited = await editOnboardingCandidates({
            data: { revision: currentSession.current.revision, candidates: pendingEdits },
          });
          if (candidateEdits.current === pendingEdits) candidateEdits.current = null;
          accept(edited);
        }
        const next = await saveOnboarding({
          data: { revision: currentSession.current.revision, step: nextStep, brief: value },
        });
        accept(next);
        setSavedLabel("Saved to your workspace");
        return next;
      });
    saveQueue.current = pending;
    return pending;
  }
  useEffect(() => {
    if (
      !session ||
      session.status === "applied" ||
      busy ||
      (!candidateEdits.current && JSON.stringify(brief) === JSON.stringify(session.brief))
    )
      return;
    setSavedLabel("Saving your changes…");
    const timer = window.setTimeout(() => {
      void save(step).catch((cause) => {
        setSavedLabel("Changes need saving");
        setError(cause instanceof Error ? cause.message : "Could not save.");
      });
    }, 700);
    return () => window.clearTimeout(timer);
    // Writes are serialized against the latest server revision.
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
    const next = await activateOnboarding();
    accept(next, true);
    setStep(6);
    clearOnboardedCache();
    clearPendingUsername(window.sessionStorage);
    await queryClient.invalidateQueries({ queryKey: ["my-profile"] });
    captureProductEvent("onboarding_workspace_ready");
  }
  useEffect(() => {
    if (session?.status !== "prepared" || step !== 5 || busy) return;
    if (!query.data?.plan || query.data.plan === "free") return;
    void action(activate);
    // The server's verified access controls activation, never the return URL query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data?.plan, query.data?.selfHosted, session?.status, step]);
  function patch<K extends keyof OnboardingBrief>(key: K, value: OnboardingBrief[K]) {
    setBrief((current) => ({ ...current, [key]: value }));
  }
  async function forward() {
    await action(async () => {
      if (step === 2 && (!brief.displayName || !brief.expertise || !brief.audience))
        throw new Error("Add your name, expertise and audience so Bento can make this yours.");
      if (step === 3) {
        const latest = await save(3);
        if (!latest.candidates)
          throw new Error(
            "Your answers changed. Prepare your starting point again before continuing.",
          );
      }
      if (step === 4) {
        const current = await save(4);
        const available =
          brief.username === query.data?.currentUsername
            ? { available: true }
            : await checkUsername({ data: { username: brief.username } });
        if (!available.available)
          throw new Error("That link is already taken. Choose another username.");
        const reviewed = current.candidates;
        if (!reviewed) throw new Error("Prepare your Brain in the previous step first.");
        accept(
          await approveOnboarding({
            data: { revision: current.revision, candidates: reviewed, allowPartial },
          }),
        );
        setPlan(recommendedPlan(brief.goal));
        setStep(5);
        if (query.data?.selfHosted) await activate();
        captureProductEvent("onboarding_preparation_ready");
        return;
      }
      const next = await save(step + 1);
      setStep(step + 1);
      captureProductEvent("onboarding_step_completed", { step, flow_version: 1, goal: brief.goal });
      if (step === 2 && !next.candidates)
        accept(await prepareOnboarding({ data: { revision: next.revision, generate: true } }));
    });
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
  async function generate(manual = false) {
    await action(async () => {
      const current = await save(3);
      accept(await prepareOnboarding({ data: { revision: current.revision, generate: !manual } }));
      if (manual) setAllowPartial(true);
    });
  }
  async function exportPreparation() {
    const content = await exportOnboardingContent();
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "my-bento-preparation.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }
  async function checkout() {
    await action(async () => {
      await saveQueue.current;
      const result = await createCheckout({
        data: {
          plan,
          period,
          returnTo: "onboarding",
          contactTier: 500,
          storageUnits: 0,
        },
      });
      const href = safeNavigationHref(result.url);
      if (!href) throw new Error("The checkout link was invalid.");
      captureProductEvent("onboarding_checkout_started", { plan });
      window.location.assign(href);
    });
  }
  function textField(
    key:
      | "displayName"
      | "expertise"
      | "audience"
      | "offer"
      | "voice"
      | "writingSample"
      | "language"
      | "timezone"
      | "bio"
      | "username",
    label: string,
    hint?: string,
    rows?: number,
  ) {
    return (
      <Field label={label} hint={hint}>
        {rows ? (
          <textarea
            rows={rows}
            className={inputClass}
            value={brief[key]}
            onChange={(e) => patch(key, e.target.value)}
          />
        ) : (
          <input
            className={inputClass}
            value={brief[key]}
            onChange={(e) => patch(key, e.target.value)}
          />
        )}
      </Field>
    );
  }

  if (query.isError && !session)
    return (
      <main className="p-8">
        <h1 className="text-xl">Your setup could not load.</h1>
        <p className="my-3 text-sm">
          Your saved answers are safe. Try again when your connection is ready.
        </p>
        <button className={primary} onClick={() => void query.refetch()}>
          Retry
        </button>
      </main>
    );
  if (!session)
    return (
      <main className="flex min-h-dvh items-center justify-center gap-3 bg-[#f7f8fc]" role="status">
        <Loader2 className="size-5 motion-safe:animate-spin" /> Opening your workspace…
      </main>
    );
  if (session.status === "applied" && query.data?.plan === "free" && !query.data?.selfHosted)
    return (
      <main className="mx-auto max-w-xl px-6 py-20">
        <AuthBrand />
        <h1 className="mt-10 font-ui-display text-4xl">Your work is saved.</h1>
        <p className="my-5 leading-7 text-slate-500">
          Your hosted access has ended. Review your plan to make your page and eligible apps
          available again.
        </p>
        <a href="/settings?section=plan" className={primary}>
          Review my billing <ArrowRight className="size-4" />
        </a>
        <button
          className={`${secondary} mt-4`}
          disabled={busy}
          onClick={() => void action(exportPreparation)}
        >
          Download my Brain and saved drafts
        </button>
        {error && (
          <p role="alert" className="mt-4 text-sm text-rose-800">
            {error}
          </p>
        )}
      </main>
    );
  const selfHosted = Boolean(query.data?.selfHosted);
  const trialEligible = query.data?.trialEligible !== false;
  const premium = query.data?.plan === "creator_plus" || selfHosted;
  const building = busy || ["queued", "running"].includes(session.jobStatus);
  const transition = {
    duration: reduced ? 0 : motionTokens.duration.normal,
    ease: motionTokens.easing.smooth,
  };
  return (
    <main className="auth-light font-ui-sans min-h-dvh bg-[#f7f8fc] text-[#17213a]">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
        <AuthBrand />
        <span className="text-xs text-slate-500" role="status">
          {savedLabel}
        </span>
      </header>
      <div className="mx-auto max-w-6xl px-5 pb-12 sm:px-8">
        <nav aria-label="Setup progress" className="mb-10 flex items-center gap-1.5">
          {steps.map((label, index) => (
            <div key={label} className="min-w-0 flex-1">
              <div className="h-1 overflow-hidden rounded-full bg-slate-200">
                <motion.div
                  initial={false}
                  animate={{ width: index <= step ? "100%" : "0%" }}
                  transition={transition}
                  className="h-full bg-[#3478f6]"
                />
              </div>
              <span
                className={`mt-2 hidden text-[11px] sm:block ${index === step ? "font-semibold text-[#3478f6]" : "text-slate-400"}`}
                aria-current={index === step ? "step" : undefined}
              >
                {index === 5 && !trialEligible ? "Your plan" : label}
              </span>
            </div>
          ))}
        </nav>
        <div className={`grid gap-10 lg:gap-16 ${step < 5 ? "lg:grid-cols-[1.15fr_0.85fr]" : ""}`}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.section
              key={step}
              initial={reduced ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? {} : { opacity: 0, y: -8 }}
              transition={transition}
              onAnimationComplete={() => headingRef.current?.focus({ preventScroll: true })}
              className="min-w-0"
            >
              <p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase text-[#3478f6]">
                <Sparkles className="size-3.5" />{" "}
                {step === 6
                  ? "Ready when you are"
                  : `Step ${step + 1} · ${step === 5 && !trialEligible ? "Your plan" : steps[step]}`}
              </p>
              <h1
                ref={headingRef}
                tabIndex={-1}
                className="outline-none max-w-2xl font-[family-name:var(--font-ui-display)] text-4xl leading-[1.06] sm:text-5xl"
              >
                {headings[step]}
              </h1>
              <p className="mt-4 max-w-xl text-sm leading-6 text-slate-500 sm:text-base">
                {step === 5 && (selfHosted || !trialEligible)
                  ? selfHosted
                    ? "Your preparation is saved. Activate your self-hosted workspace."
                    : "Choose your plan and billing period. A new trial is not available for this workspace."
                  : subtitles[step]}
              </p>
              <div className="mt-8 space-y-5">
                {step === 0 && (
                  <>
                    <div className="grid gap-3">
                      {[
                        {
                          icon: Globe,
                          title: "Your page, already taking shape",
                          detail: "One link for your work, offers and socials.",
                        },
                        {
                          icon: Brain,
                          title: "Your voice, remembered",
                          detail: "Your audience, expertise and writing style in one Brain.",
                        },
                        {
                          icon: FileText,
                          title: "A head start on content",
                          detail: "Three editable starter drafts and a practical next step.",
                        },
                      ].map((item, index) => (
                        <motion.div
                          key={item.title}
                          initial={reduced ? false : { opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ ...transition, delay: reduced ? 0 : index * 0.08 }}
                          className="flex items-start gap-4 rounded-2xl border border-black/5 bg-white p-4"
                        >
                          <span className="rounded-xl bg-[#e9f0ff] p-3 text-[#3478f6]">
                            <item.icon className="size-5" />
                          </span>
                          <div>
                            <p className="text-sm font-semibold">{item.title}</p>
                            <p className="mt-1 text-sm text-slate-500">{item.detail}</p>
                          </div>
                        </motion.div>
                      ))}
                    </div>
                    <p className="text-xs leading-5 text-slate-500">
                      {selfHosted ? (
                        "Free Forever, on your own infrastructure. Connect your own services and make this workspace yours."
                      ) : trialEligible ? (
                        <>
                          Store $19 · Creator $39 · Creator Plus $49 per month. A card is required
                          at the end of setup. $0 today; your first charge follows the {TRIAL_DAYS}
                          -day trial unless you cancel. Free Forever is available with the
                          self-hosted open-source edition.
                        </>
                      ) : (
                        <>
                          Store $19 · Creator $39 · Creator Plus $49 per month. Your account has
                          already used its trial; the selected plan is charged at checkout after you
                          review your preparation.
                        </>
                      )}
                    </p>
                  </>
                )}
                {step === 1 && (
                  <>
                    {!!query.data?.connections.length && (
                      <div className="space-y-2">
                        {query.data.connections.map((connection) => (
                          <button
                            key={connection.id}
                            disabled={busy}
                            className={`${secondary} w-full justify-between text-left`}
                            onClick={() =>
                              void action(async () => {
                                const imported = await importOnboardingSocial({
                                  data: { connectionId: connection.id },
                                });
                                const value = {
                                  ...brief,
                                  ...imported,
                                  bio: imported.bio || brief.bio,
                                  links: [
                                    ...brief.links,
                                    ...imported.links.filter(
                                      (link) =>
                                        !brief.links.some((existing) => existing.url === link.url),
                                    ),
                                  ].slice(0, 8),
                                };
                                setBrief(value);
                                await save(1, value);
                                setImportNote(
                                  imported.importedPosts
                                    ? `Profile and ${imported.importedPosts} writing samples imported.`
                                    : "Profile imported. No post history is available yet; you can describe your voice in the next steps.",
                                );
                              })
                            }
                          >
                            <span>
                              <span className="block font-semibold">
                                {connection.provider_display_name || connection.provider_handle}
                              </span>
                              <span className="text-xs text-slate-500">{connection.provider}</span>
                            </span>
                            {brief.primaryConnectionId === connection.id ? (
                              <Check className="size-4 text-emerald-600" />
                            ) : (
                              "Use profile"
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      {ONBOARDING_PLATFORMS.map((provider) => {
                        const Icon = icons[provider];
                        return (
                          <button
                            key={provider}
                            className={`${secondary} justify-start`}
                            disabled={busy}
                            onClick={() => void connect(provider)}
                          >
                            <Icon className="size-4" />
                            {SOCIAL_PROVIDER_DEFINITIONS[provider].name}
                          </button>
                        );
                      })}
                    </div>
                    <p className="flex items-start gap-2 text-xs leading-5 text-slate-500">
                      <LockKeyhole className="mt-1 size-3.5 shrink-0" /> Connecting gives Bento the
                      permissions shown by the provider. Nothing is posted or sent automatically.
                    </p>
                    {importNote && (
                      <p
                        role="status"
                        className="rounded-xl bg-[#e8f3ea] p-3 text-sm text-emerald-800"
                      >
                        {importNote}
                      </p>
                    )}
                  </>
                )}
                {step === 2 && (
                  <>
                    <div className="space-y-2">
                      {ONBOARDING_GOALS.map((goal) => (
                        <button
                          key={goal.id}
                          type="button"
                          aria-pressed={brief.goal === goal.id}
                          onClick={() => patch("goal", goal.id)}
                          className={`flex w-full items-center justify-between rounded-xl border p-3.5 text-left transition-colors ${brief.goal === goal.id ? "border-[#3478f6] bg-[#e9f0ff]" : "border-black/8 bg-white hover:border-[#3478f6]/40"}`}
                        >
                          <span>
                            <span className="block text-sm font-semibold">{goal.label}</span>
                            <span className="mt-1 block text-xs text-slate-500">{goal.detail}</span>
                          </span>
                          {brief.goal === goal.id && (
                            <CheckCircle2 className="size-5 shrink-0 text-[#3478f6]" />
                          )}
                        </button>
                      ))}
                    </div>
                    {textField("displayName", "What should we call you?")}
                    {textField(
                      "expertise",
                      "What do you know or create?",
                      "For example: photography lessons, career coaching, or handmade ceramics.",
                    )}
                    {textField(
                      "audience",
                      "Who do you want to help?",
                      "Still exploring? Describe the people you'd like to reach.",
                    )}
                    {["sell", "bookings"].includes(brief.goal) &&
                      textField(
                        "offer",
                        brief.goal === "sell"
                          ? "Do you already have an offer?"
                          : "What could people book you for?",
                        "Optional. Leave this empty if you're still working it out.",
                      )}
                  </>
                )}
                {step === 3 && (
                  <>
                    {building && (
                      <div
                        className="flex items-center gap-3 rounded-2xl bg-white p-4 text-sm"
                        role="status"
                      >
                        <Loader2 className="size-5 motion-safe:animate-spin text-[#3478f6]" />
                        Writing and checking three distinct drafts… Completed drafts are saved if
                        preparation is interrupted.
                      </div>
                    )}
                    {textField("voice", "How should your writing feel?", undefined, 3)}
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Draft platform">
                        <select
                          className={inputClass}
                          value={brief.platform}
                          onChange={(e) =>
                            patch("platform", e.target.value as OnboardingBrief["platform"])
                          }
                        >
                          {!(ONBOARDING_OUTPUT_PLATFORMS as readonly string[]).includes(
                            brief.platform,
                          ) && (
                            <option value={brief.platform}>
                              Choose a supported draft platform
                            </option>
                          )}
                          {ONBOARDING_OUTPUT_PLATFORMS.map((provider) => (
                            <option key={provider} value={provider}>
                              {SOCIAL_PROVIDER_DEFINITIONS[provider].name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Posts per week">
                        <select
                          className={inputClass}
                          value={brief.postsPerWeek}
                          onChange={(e) => patch("postsPerWeek", Number(e.target.value))}
                        >
                          {[1, 2, 3, 4, 5, 6, 7].map((value) => (
                            <option key={value}>{value}</option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    <details className="rounded-xl border border-black/8 bg-white p-4">
                      <summary className="cursor-pointer text-sm font-medium">
                        Writing sample, language & timezone
                      </summary>
                      <div className="mt-4 space-y-3">
                        {textField(
                          "writingSample",
                          "An example of your writing",
                          "Optional. Imported posts appear here when available.",
                          3,
                        )}
                        {textField("language", "Language")}
                        {textField("timezone", "Timezone")}
                      </div>
                    </details>
                    {candidates?.warning && (
                      <p role="status" className="text-sm text-amber-800">
                        {candidates.warning}
                      </p>
                    )}
                    {session.jobError && (
                      <p role="status" className="text-sm leading-relaxed text-amber-800">
                        {session.jobError}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button
                        className={secondary}
                        disabled={building || session.generationCount >= 2}
                        onClick={() => void generate()}
                      >
                        <RefreshCw className="size-4" />
                        {session.generationCount ? "Refresh my drafts" : "Prepare my drafts"}
                      </button>
                      <button
                        className={secondary}
                        disabled={building}
                        onClick={() => void generate(true)}
                      >
                        Use my answers without AI drafts
                      </button>
                    </div>
                    {candidates && (
                      <>
                        <div className="rounded-2xl border border-[#3478f6]/15 bg-white p-5">
                          <p className="mb-3 flex items-center gap-2 text-xs font-semibold text-[#3478f6]">
                            <Sparkles className="size-4" />
                            {candidates.drafts.length
                              ? "A first draft in your voice"
                              : "Your Brain has a starting point"}
                          </p>
                          <p className="whitespace-pre-wrap text-sm leading-6">
                            {candidates.drafts[0]?.body || candidates.brain[1].content}
                          </p>
                          {candidates.drafts[0]?.slides?.map((slide, index) => (
                            <div key={index} className="mt-3 text-sm">
                              <strong>{slide.heading}</strong>
                              <p className="whitespace-pre-wrap">{slide.body}</p>
                            </div>
                          ))}
                          {candidates.warning && (
                            <p role="status" className="mt-3 text-sm">
                              {candidates.warning}
                            </p>
                          )}
                          {["instagram", "youtube", "tiktok"].includes(brief.platform) &&
                            candidates.drafts.length > 0 && (
                              <p className="mt-3 text-xs text-slate-500">
                                Review the copy and add any required media before publishing
                              </p>
                            )}
                        </div>
                        <details className="rounded-xl border border-black/8 bg-white p-4">
                          <summary className="cursor-pointer text-sm font-medium">
                            Review and edit what Brain remembers
                          </summary>
                          <div className="mt-4 space-y-4">
                            {candidates.brain.map((item, index) => (
                              <Field key={item.kind} label={item.title}>
                                <textarea
                                  className={inputClass}
                                  rows={index === 2 ? 10 : 5}
                                  value={item.content}
                                  onChange={(e) => {
                                    const next = {
                                      ...candidates,
                                      brain: candidates.brain.map((row, i) =>
                                        i === index ? { ...row, content: e.target.value } : row,
                                      ),
                                    };
                                    candidateEdits.current = next;
                                    setCandidates(next);
                                  }}
                                />
                              </Field>
                            ))}
                          </div>
                        </details>
                      </>
                    )}
                  </>
                )}
                {step === 4 && (
                  <>
                    {textField(
                      "username",
                      "Your Bento link",
                      "bento.surf/your-name · your page stays private until you publish.",
                    )}
                    {textField("bio", "A short introduction", undefined, 3)}
                    <fieldset>
                      <legend className="mb-3 text-sm font-medium">
                        Choose a visual direction
                      </legend>
                      <div className="flex gap-3">
                        {(Object.keys(previewThemes) as Array<keyof typeof previewThemes>).map(
                          (style) => (
                            <button
                              key={style}
                              aria-label={`${style} style`}
                              aria-pressed={brief.style === style}
                              onClick={() => patch("style", style)}
                              className={`flex h-14 flex-1 items-center justify-center rounded-xl border-2 transition-colors ${brief.style === style ? "border-[#17213a]" : "border-transparent"}`}
                              style={{ backgroundColor: previewThemes[style].background }}
                            >
                              {brief.style === style ? (
                                <Check className="size-5" />
                              ) : (
                                <span
                                  className="size-4 rounded-full"
                                  style={{ background: previewThemes[style].accent }}
                                />
                              )}
                            </button>
                          ),
                        )}
                      </div>
                    </fieldset>
                    <div className="space-y-2">
                      {brief.links.map((link, index) => (
                        <div
                          key={`${link.url}:${index}`}
                          className="flex items-center gap-2 rounded-xl bg-white p-3"
                        >
                          <span className="min-w-0 flex-1 truncate text-sm">{link.title}</span>
                          <button
                            aria-label={`Remove ${link.title}`}
                            onClick={() =>
                              patch(
                                "links",
                                brief.links.filter((_, i) => i !== index),
                              )
                            }
                          >
                            <X className="size-4 text-slate-400" />
                          </button>
                        </div>
                      ))}
                    </div>
                    <details className="rounded-xl border border-black/8 p-4">
                      <summary className="cursor-pointer text-sm font-medium">
                        Add a useful destination
                      </summary>
                      <div className="mt-3 space-y-3">
                        <Field label="Link title">
                          <input
                            className={inputClass}
                            value={linkTitle}
                            maxLength={80}
                            onChange={(e) => setLinkTitle(e.target.value)}
                          />
                        </Field>
                        <Field label="Destination URL">
                          <input
                            type="url"
                            className={inputClass}
                            value={linkUrl}
                            onChange={(e) => setLinkUrl(e.target.value)}
                          />
                        </Field>
                        <button
                          className={secondary}
                          onClick={() => {
                            const parsed = onboardingBriefSchema.safeParse({
                              ...brief,
                              links: [...brief.links, { title: linkTitle, url: linkUrl }],
                            });
                            if (!parsed.success) {
                              setError("Give your link a title and a valid public URL.");
                              return;
                            }
                            setBrief(parsed.data);
                            setLinkTitle("");
                            setLinkUrl("");
                          }}
                        >
                          <Plus className="size-4" />
                          Add link
                        </button>
                      </div>
                    </details>
                    <label className="flex items-start gap-3 rounded-xl border border-black/8 bg-white p-4 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1 size-4 accent-[#3478f6]"
                        checked={brief.publishPage}
                        onChange={(e) => patch("publishPage", e.target.checked)}
                      />
                      <span>
                        Publish this reviewed page when my trial starts.
                        <span className="mt-1 block text-xs text-slate-500">
                          Your Brain and drafts remain private.
                        </span>
                      </span>
                    </label>
                    <div className="flex flex-wrap gap-3 text-xs text-slate-500">
                      <span>Page prepared</span>
                      <span>Brain: {candidates ? "3 core documents" : "needs review"}</span>
                      <span>Starter drafts: {candidates?.drafts.length ?? 0}</span>
                      {!!candidates?.deferredDrafts?.length && (
                        <span>
                          {candidates.deferredDrafts.length} earlier drafts saved in your
                          preparation download; not included in activation.
                        </span>
                      )}
                    </div>
                    {!candidates?.drafts.length && (
                      <label className="flex items-start gap-2 text-sm text-slate-600">
                        <input
                          type="checkbox"
                          checked={allowPartial}
                          onChange={(e) => setAllowPartial(e.target.checked)}
                          className="mt-1"
                        />
                        Continue with my page and Brain. I'll create post drafts later.
                      </label>
                    )}
                  </>
                )}
                {step === 5 && !selfHosted && (
                  <>
                    <div className="flex items-center gap-4 rounded-2xl border border-black/5 bg-white p-4">
                      <Globe className="size-7 shrink-0 text-[#3478f6]" />
                      <div>
                        <p className="text-sm font-semibold">
                          {brief.displayName}'s Bento is prepared
                        </p>
                        <p className="mt-1 text-xs leading-5 text-slate-500">
                          bento.surf/{brief.username} · 3 core Brain documents ·{" "}
                          {candidates?.drafts.length ?? 0} starter drafts. Your reviewed work is
                          saved.
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2" role="group" aria-label="Billing period">
                      {(["monthly", "yearly"] as const).map((value) => (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={period === value}
                          onClick={() => setPeriod(value)}
                          className={`rounded-full px-4 py-2 text-sm font-semibold ${period === value ? "bg-[#17213a] text-white" : "border border-black/10 bg-white text-[#17213a]"}`}
                        >
                          {value === "monthly" ? "Monthly" : "Yearly · 2 months free"}
                        </button>
                      ))}
                    </div>
                    <div className="grid gap-4 md:grid-cols-3">
                      {PAID_PLAN_IDS.map((value) => (
                        <button
                          type="button"
                          key={value}
                          aria-pressed={plan === value}
                          onClick={() => setPlan(value)}
                          className={`rounded-2xl border bg-white p-5 text-left transition-colors ${plan === value ? "border-[#3478f6] ring-2 ring-[#3478f6]/10" : "border-black/10"}`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-semibold">{planName(value)}</span>
                            {plan === value && <CheckCircle2 className="size-5 text-[#3478f6]" />}
                          </div>
                          <p className="my-4">
                            <span className="text-3xl font-semibold">
                              {PLAN_PRICING[value][period].label}
                            </span>
                            <span className="text-sm text-slate-500">
                              {PLAN_PRICING[value][period].cadence}
                            </span>
                          </p>
                          {period === "yearly" && (
                            <p className="mb-4 text-xs font-medium text-[#245fd0]">2 months free</p>
                          )}
                          <ul className="space-y-2">
                            {{
                              store: [
                                "0% Bento commission",
                                "Link in bio and every store product",
                                "Bookings, Priority DMs, communities and courses",
                                "Basic Auto DMs without follow or email gates",
                              ],
                              creator: [
                                "Everything in Store",
                                "Discover and Post Scheduler",
                                "Advanced Auto DMs with follow and email gates",
                                "Social analytics and Newsletter",
                                "MCP posting and Auto DMs",
                              ],
                              creator_plus: [
                                "Everything in Creator",
                                "Brain remembers your business and voice",
                                "Agent turns context into content",
                                "Routines handle repeat work",
                                "Weekly strategy reviews",
                              ],
                            }[value].map((feature) => (
                              <li
                                key={feature}
                                className="flex gap-2 text-xs leading-5 text-slate-600"
                              >
                                <Check className="mt-1 size-3 shrink-0 text-[#3478f6]" />
                                {feature}
                              </li>
                            ))}
                          </ul>
                        </button>
                      ))}
                    </div>
                    <div className="flex flex-col gap-5 rounded-2xl bg-[#e9f0ff] p-6 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-2xl font-semibold">
                          {trialEligible ? "$0 today" : `${selectedPrice.label} today`}
                        </p>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          {trialEligible ? (
                            <>
                              Then {selectedPrice.label}
                              {selectedPrice.cadence} after {TRIAL_DAYS} full days, plus applicable
                              taxes. Cancel before then to avoid the charge. We'll email you 24
                              hours beforehand and ask how Bento is working for you.
                            </>
                          ) : (
                            <>
                              A new trial is not available for this workspace. {selectedPrice.label}
                              {selectedPrice.cadence}, plus applicable taxes, starts at checkout.
                              You can cancel renewal in Billing.
                            </>
                          )}
                        </p>
                        {plan !== "creator_plus" && (
                          <p className="mt-2 text-xs leading-5 text-slate-500">
                            {trialEligible
                              ? "Brain, Agent and Routines are included during your Plus trial. Afterward, "
                              : ""}
                            {planName(plan)} includes the features listed above. Your prepared Brain
                            and starter drafts remain saved and downloadable; ongoing Brain, Agent
                            and Routines require Creator Plus.
                          </p>
                        )}
                      </div>
                      <button
                        className={`${primary} shrink-0`}
                        disabled={busy}
                        onClick={() =>
                          void (query.data?.selfHosted ? action(activate) : checkout())
                        }
                      >
                        {busy ? (
                          <Loader2 className="size-4 motion-safe:animate-spin" />
                        ) : (
                          <CreditCard className="size-4" />
                        )}
                        {trialEligible ? `Start my ${TRIAL_DAYS}-day trial` : "Activate my plan"}
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
                      <span className="flex items-center gap-2">
                        <LockKeyhole className="size-3.5" />
                        Secure card checkout ·{" "}
                        {trialEligible
                          ? "no subscription charge today"
                          : `${selectedPrice.label}${selectedPrice.cadence}`}
                      </span>
                      <button
                        className="underline underline-offset-4"
                        onClick={() =>
                          void action(async () => {
                            await query.refetch();
                            await activate();
                          })
                        }
                      >
                        Already completed checkout? Verify my access
                      </button>
                    </div>
                  </>
                )}
                {step === 5 && selfHosted && (
                  <button className={primary} disabled={busy} onClick={() => void action(activate)}>
                    Activate my workspace <ArrowRight className="size-4" />
                  </button>
                )}
                {step === 6 && candidates && (
                  <>
                    <div className="grid gap-4 md:grid-cols-3">
                      <motion.div
                        initial={reduced ? false : { opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={transition}
                        className="rounded-2xl border border-black/8 bg-white p-6"
                      >
                        <Globe className="mb-6 size-6 text-[#3478f6]" />
                        <h2 className="text-lg font-semibold">
                          {brief.publishPage ? "Your page is live" : "Your page is prepared"}
                        </h2>
                        <p className="mb-6 mt-2 break-words text-sm text-slate-500">
                          {publicProfileUrl(brief.username)}
                        </p>
                        <button
                          className={primary}
                          disabled={busy}
                          onClick={() =>
                            void action(async () => {
                              if (brief.publishPage) {
                                await navigator.clipboard.writeText(
                                  publicProfileUrl(brief.username),
                                );
                                toast.success("Link copied");
                                captureProductEvent("onboarding_first_result_used", {
                                  result: "link",
                                });
                              } else accept(await publishOnboardingPage(), true);
                            })
                          }
                        >
                          <Copy className="size-4" />
                          {brief.publishPage ? "Copy my link" : "Publish my page"}
                        </button>
                      </motion.div>
                      {[
                        {
                          icon: Brain,
                          title: "Your Brain knows you",
                          detail: "Your identity, writing voice and starting strategy are saved.",
                          action: "Open my Brain",
                          href: "/content?tab=brain",
                        },
                        {
                          icon: FileText,
                          title: `${candidates.drafts.length} starter drafts`,
                          detail:
                            candidates.drafts[0]?.title ||
                            "Your core context is ready for your first writing session.",
                          action: "Open my drafts",
                          href: `/content?tab=agent${session.threadId ? `&thread=${session.threadId}` : ""}`,
                        },
                      ].map((card, index) => (
                        <motion.div
                          key={card.title}
                          initial={reduced ? false : { opacity: 0, y: 16 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ ...transition, delay: reduced ? 0 : (index + 1) * 0.1 }}
                          className="flex flex-col rounded-2xl border border-black/8 bg-white p-6"
                        >
                          <card.icon className="mb-6 size-6 text-[#3478f6]" />
                          <h2 className="text-lg font-semibold">{card.title}</h2>
                          <p className="mb-6 mt-2 flex-1 text-sm leading-6 text-slate-500">
                            {card.detail}
                          </p>
                          {premium ? (
                            <a className={secondary} href={card.href}>
                              {card.action}
                              <ArrowRight className="size-4" />
                            </a>
                          ) : (
                            <button
                              className={secondary}
                              onClick={() => void action(exportPreparation)}
                            >
                              Download my preparation
                            </button>
                          )}
                        </motion.div>
                      ))}
                    </div>
                    <button
                      className="text-sm text-slate-500 underline underline-offset-4"
                      onClick={() => void action(exportPreparation)}
                    >
                      Download my Brain and saved drafts
                    </button>
                    <div className="rounded-2xl bg-[#e8f3ea] p-5">
                      <p className="text-xs font-semibold text-emerald-800">YOUR NEXT SMALL WIN</p>
                      <p className="mt-2 text-sm leading-6">{candidates.nextAction}</p>
                      <a
                        className={`${secondary} mt-4`}
                        href={
                          brief.goal === "sell"
                            ? "/store"
                            : brief.goal === "bookings"
                              ? "/calendar"
                              : brief.goal === "grow"
                                ? "/content?tab=discover"
                                : brief.goal === "publish"
                                  ? "/content?tab=agent"
                                  : "/link"
                        }
                      >
                        Let's do this <ArrowRight className="size-4" />
                      </a>
                    </div>
                    {query.data?.trialEndsAt && (
                      <p className="text-xs text-slate-500">
                        Your trial ends {new Date(query.data.trialEndsAt).toLocaleString()}. Manage
                        or cancel your plan in{" "}
                        <a href="/settings?section=plan" className="underline">
                          Settings
                        </a>
                        .
                      </p>
                    )}
                  </>
                )}
              </div>
              {error && (
                <div
                  role="alert"
                  className="mt-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm leading-6 text-rose-800"
                >
                  {error}
                </div>
              )}
              {step < 5 && (
                <div className="mt-8 flex items-center justify-between gap-3 border-t border-black/5 pt-6">
                  {step > 0 ? (
                    <button
                      className={secondary}
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await save(step - 1);
                          setStep(step - 1);
                        })
                      }
                    >
                      <ArrowLeft className="size-4" />
                      Back
                    </button>
                  ) : (
                    <span />
                  )}
                  <button
                    className={primary}
                    disabled={building || (step === 3 && !candidates)}
                    onClick={() => void forward()}
                  >
                    {busy && <Loader2 className="size-4 motion-safe:animate-spin" />}
                    {step === 0
                      ? "Build my Bento"
                      : step === 1
                        ? brief.primaryConnectionId
                          ? "Use this head start"
                          : "Continue without connecting"
                        : step === 2
                          ? "Prepare my starting point"
                          : step === 3
                            ? "Use this Brain"
                            : selfHosted
                              ? "Activate my workspace"
                              : trialEligible
                                ? "Continue to plan & trial"
                                : "Continue to plan"}
                    <ArrowRight className="size-4" />
                  </button>
                </div>
              )}
              {step === 5 && (
                <button className={`${secondary} mt-6`} disabled={busy} onClick={() => setStep(4)}>
                  <ArrowLeft className="size-4" />
                  Review my preparation
                </button>
              )}
            </motion.section>
          </AnimatePresence>
          {step < 5 && (
            <aside className="lg:sticky lg:top-12 lg:self-start">
              <OnboardingPreview brief={brief} />
              <div className="mx-auto mt-6 max-w-sm rounded-2xl border border-black/5 bg-white/70 p-4">
                <p className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                  <Brain className="size-4 text-[#3478f6]" />
                  Answer once. Use it everywhere.
                </p>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  {step < 2
                    ? "Your profile becomes the starting point for your page and Brain."
                    : step === 2
                      ? "Your audience shapes what you say. Your goal shapes what visitors do next."
                      : step === 3
                        ? "Your confirmed voice and strategy guide future drafts and business advice."
                        : "The same context will help you set up each app, without another interview."}
                </p>
              </div>
            </aside>
          )}
        </div>
      </div>
    </main>
  );
}
