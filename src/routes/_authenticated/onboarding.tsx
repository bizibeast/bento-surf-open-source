import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Twitter,
  Instagram,
  Linkedin,
  Github,
  Youtube,
  Dribbble,
  X,
  AtSign,
  FileText,
  Link as LinkIcon,
  Quote as QuoteIcon,
  Sparkles,
} from "lucide-react";
import { getMyProfile, updateProfile, checkUsername } from "@/lib/profile.functions";
import { createBlock, getMyBlocks } from "@/lib/blocks.functions";
import { BlockRenderer, type Block } from "@/components/blocks/BlockRenderer";
import { useUsernameAvailability } from "@/lib/use-username-availability";
import { normalizeUsername } from "@/lib/username";
import {
  clearPendingUsername,
  getPendingUsername,
  getUsernameClaimError,
  selectOnboardingUsername,
} from "@/lib/pending-username";
import { captureProductEvent } from "@/lib/posthog";
import { AuthBrand } from "@/components/AuthShell";
import { normalizePlan } from "@/lib/plans";
import { EXPLORE_CATEGORIES, exploreCategorySchema, type ExploreCategory } from "@/lib/explore";
import { markPostOnboardingUpgradePending } from "@/lib/post-onboarding-upgrade";
import { consumeReferralAttribution } from "@/lib/referral.functions";
import { rememberOnboarded } from "@/lib/auth-entry";
import { onboardingSocialBlock } from "@/lib/onboarding-blocks";

const lookupUsername = (username: string) => checkUsername({ data: { username } });

export const Route = createFileRoute("/_authenticated/onboarding")({
  head: () => ({ meta: [{ title: "Set up your creator storefront | bento.surf" }] }),
  component: Onboarding,
});

type Step = 1 | 2 | 3;
type UpdateProfilePatch = {
  username?: string;
  display_name?: string;
  onboarded?: boolean;
  explore_category?: ExploreCategory;
};
type NewBlockInput = {
  type: Block["type"];
  content: Record<string, unknown>;
  w: number;
  h: number;
};

const SOCIALS = [
  { key: "twitter", label: "Twitter", icon: Twitter, color: "#1d9bf0", fg: "#fff" },
  {
    key: "instagram",
    label: "Instagram",
    icon: Instagram,
    color: "linear-gradient(135deg,#f9ce34,#ee2a7b,#6228d7)",
    fg: "#fff",
  },
  { key: "linkedin", label: "LinkedIn", icon: Linkedin, color: "#0a66c2", fg: "#fff" },
  { key: "github", label: "GitHub", icon: Github, color: "#0f172a", fg: "#fff" },
  { key: "youtube", label: "YouTube", icon: Youtube, color: "#ff0000", fg: "#fff" },
  { key: "dribbble", label: "Dribbble", icon: Dribbble, color: "#ea4c89", fg: "#fff" },
] as const;

const ONBOARDING_STEPS = [
  { id: 1, label: "Your link" },
  { id: 2, label: "Socials" },
  { id: 3, label: "First block" },
] as const;

const STARTER_BLOCKS = [
  {
    key: "generic_link",
    label: "Feature a link",
    description: "Send people to your latest work.",
    icon: LinkIcon,
    color: "bg-[#dfeaff] text-[#245fd0]",
    create: () => ({
      type: "generic_link" as const,
      content: { title: "My latest link", url: "https://" },
      w: 2,
      h: 1,
    }),
  },
  {
    key: "note",
    label: "Introduce yourself",
    description: "Give visitors a quick hello.",
    icon: QuoteIcon,
    color: "bg-[#fff0bd] text-[#7a5b00]",
    create: (name: string) => ({
      type: "note" as const,
      content: { text: `Hi, I’m ${name}. Welcome to my corner of the internet.`, tint: "amber" },
      w: 2,
      h: 2,
    }),
  },
  {
    key: "heading",
    label: "Start a section",
    description: "Organize what visitors see next.",
    icon: FileText,
    color: "bg-[#ffe0e1] text-[#b82f32]",
    create: () => ({
      type: "heading" as const,
      content: { text: "Featured", shadow: false },
      w: 2,
      h: 1,
    }),
  },
] as const;

const PREVIEW_LIGHT_VARS = {
  "--color-background": "#f7f8fc",
  "--color-foreground": "#17213a",
  "--color-card": "#ffffff",
  "--color-card-foreground": "#17213a",
  "--color-border": "rgba(23, 33, 58, 0.10)",
  "--color-tint-sky": "#e4efff",
  "--color-tint-sky-fg": "#245fd0",
  "--color-tint-rose": "#ffe0e1",
  "--color-tint-rose-fg": "#b82f32",
  "--color-tint-mint": "#e3f8ea",
  "--color-tint-mint-fg": "#2d8e57",
  "--color-tint-lavender": "#eee7ff",
  "--color-tint-lavender-fg": "#6340a5",
  "--color-tint-amber": "#fff0bd",
  "--color-tint-amber-fg": "#7a5b00",
  "--color-tint-neutral": "#ffffff",
  "--color-tint-neutral-fg": "#17213a",
} as CSSProperties;

function Onboarding() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: profile, isLoading } = useQuery({
    queryKey: ["my-profile"],
    queryFn: () => getMyProfile(),
  });
  const { data: blocks = [] } = useQuery({
    queryKey: ["my-blocks", null],
    queryFn: () => getMyBlocks({ data: { pageId: null } }),
  });

  const [step, setStep] = useState<Step>(1);
  const { username, setUsername, available, availabilityError, retry } = useUsernameAvailability(
    lookupUsername,
    350,
    profile?.username,
  );
  const [displayName, setDisplayName] = useState("");
  const [exploreCategory, setExploreCategory] = useState<ExploreCategory>("creator");
  const [claimError, setClaimError] = useState<string | null>(null);
  const [handles, setHandles] = useState<Record<string, string>>({});
  const [starterBlocksAdded, setStarterBlocksAdded] = useState<Set<string>>(new Set());
  const initializedProfileId = useRef<string | null>(null);
  const referralConsumed = useRef(false);

  useEffect(() => {
    if (profile) {
      if (profile.onboarded) navigate({ to: "/link", replace: true });
      if (initializedProfileId.current === profile.id) return;

      initializedProfileId.current = profile.id;
      setUsername(
        selectOnboardingUsername(profile.username, getPendingUsername(window.sessionStorage)),
      );
      setDisplayName(profile.display_name ?? "");
      setExploreCategory(exploreCategorySchema.catch("creator").parse(profile.explore_category));
    }
  }, [navigate, profile, setUsername]);

  useEffect(() => {
    if (!profile?.id || referralConsumed.current) return;
    referralConsumed.current = true;
    void consumeReferralAttribution().catch((error) => {
      console.error("[referral] attribution consumption failed", error);
    });
  }, [profile?.id]);

  const saveProfile = useMutation({
    mutationFn: async (patch: UpdateProfilePatch) => updateProfile({ data: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["my-profile"] }),
  });

  const addBlock = useMutation({
    mutationFn: async (input: NewBlockInput) => createBlock({ data: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["my-blocks"] }),
  });

  if (isLoading)
    return <div className="p-10 text-center text-sm text-muted-foreground">Loading…</div>;

  const next1 = async () => {
    if (available !== true) return;
    setClaimError(null);
    try {
      await saveProfile.mutateAsync({
        username,
        display_name: displayName || username,
        explore_category: exploreCategory,
      });
      captureProductEvent("username_claimed");
      clearPendingUsername(window.sessionStorage);
      setStep(2);
    } catch (error) {
      setClaimError(getUsernameClaimError(error));
    }
  };

  const next2 = async () => {
    const entries = Object.entries(handles).filter(([, v]) => v && v.trim());
    try {
      for (const [platform, handle] of entries) {
        await addBlock.mutateAsync(onboardingSocialBlock(platform, handle));
      }
      if (entries.length > 0) {
        captureProductEvent("first_block_added", { block_type: "social_link" });
      }
      setStep(3);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add those social links");
    }
  };

  const addStarter = async (starter: (typeof STARTER_BLOCKS)[number]) => {
    if (starterBlocksAdded.has(starter.key)) return;
    try {
      const input = starter.create(displayName.trim() || username || "there");
      await addBlock.mutateAsync(input);
      setStarterBlocksAdded((current) => new Set(current).add(starter.key));
      captureProductEvent("first_block_added", { block_type: starter.key });
      toast.success(`${starter.label} added`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add that block");
    }
  };

  const finishOnboarding = async () => {
    try {
      await saveProfile.mutateAsync({ onboarded: true });
      if (profile?.id) rememberOnboarded(profile.id, true);
      const plan = normalizePlan(profile?.plan_id, profile?.is_pro);
      if (profile?.id && plan === "free") {
        markPostOnboardingUpgradePending(window.localStorage, profile.id);
      }
      captureProductEvent("onboarding_completed", { plan });
      toast.success("Your Bento is ready.");
      navigate({ to: "/link", replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not finish setup");
    }
  };

  return (
    <div className="auth-light min-h-screen bg-[#f7f8fc] text-[#17213a] selection:bg-[#3478f6] selection:text-white">
      <header className="mx-auto flex h-20 max-w-[1440px] items-center justify-between border-b border-[#17213a]/[0.06] px-5 sm:px-8 lg:px-12">
        <AuthBrand />
        <span className="inline-flex items-center gap-2 text-xs font-medium text-[#17213a]/42">
          <span className="size-1.5 rounded-full bg-[#3ab86f]" />
          Your progress saves automatically
        </span>
      </header>

      <div className="mx-auto grid max-w-[1440px] grid-cols-1 gap-10 px-5 pb-12 pt-8 sm:px-8 lg:min-h-[calc(100vh-5rem)] lg:grid-cols-[minmax(0,0.9fr)_minmax(520px,1.1fr)] lg:items-center lg:gap-16 lg:px-12 lg:pb-16 lg:pt-6">
        <section className="mx-auto w-full max-w-[580px] lg:mx-0">
          <div className="mb-7 grid grid-cols-3 gap-2" aria-label={`Step ${step} of 3`}>
            {ONBOARDING_STEPS.map((item) => (
              <div key={item.id} className="min-w-0">
                <div
                  className={`h-1.5 rounded-full transition-colors ${
                    item.id <= step ? "bg-[#3478f6]" : "bg-[#17213a]/10"
                  }`}
                />
                <span
                  className={`mt-2 block truncate text-[11px] font-semibold sm:text-xs ${
                    item.id === step ? "text-[#245fd0]" : "text-[#17213a]/35"
                  }`}
                >
                  {item.id}. {item.label}
                </span>
              </div>
            ))}
          </div>

          <div className="mb-4 flex items-center justify-between rounded-2xl border border-[#17213a]/[0.07] bg-white px-4 py-3 text-xs lg:hidden">
            <span className="font-semibold">bento.surf/@{username || "yourname"}</span>
            <span className="text-[#17213a]/42">
              {blocks.length + entriesCount(handles)} block
              {blocks.length + entriesCount(handles) === 1 ? "" : "s"}
            </span>
          </div>

          <div className="rounded-[28px] border border-[#17213a]/[0.07] bg-white p-6 shadow-[0_24px_70px_-48px_rgba(23,33,58,0.32)] sm:p-9">
            {step > 1 && (
              <button
                type="button"
                onClick={() => setStep((current) => (current - 1) as Step)}
                className="relative mb-5 inline-flex size-10 items-center justify-center rounded-full border border-[#17213a]/8 bg-white/75 transition hover:bg-white"
                aria-label="Go back one step"
              >
                <ArrowLeft className="size-4" />
              </button>
            )}

            {step === 1 && (
              <div className="relative max-w-lg">
                <span className="inline-flex items-center gap-2 rounded-full bg-[#dfeaff] px-3 py-1.5 text-xs font-semibold text-[#245fd0]">
                  <Sparkles className="size-3.5" />
                  Make it feel like you
                </span>
                <h1 className="mt-5 text-balance font-sans text-4xl font-semibold leading-[0.98] tracking-[-0.055em] sm:text-5xl">
                  Give your storefront
                  <br />a name and a home.
                </h1>
                <p className="mt-4 max-w-md text-sm leading-relaxed text-[#17213a]/55 sm:text-base">
                  This is what visitors see first. You can change both later.
                </p>

                <label className="mt-8 block">
                  <span className="mb-2 flex items-center justify-between text-sm font-semibold">
                    Display name
                    <span className="text-xs font-normal text-[#17213a]/40">
                      Shown on your page
                    </span>
                  </span>
                  <input
                    autoFocus
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="Your name or brand"
                    autoComplete="name"
                    className="h-14 w-full rounded-2xl border border-[#17213a]/10 bg-white/72 px-4 text-[15px] outline-none transition placeholder:text-[#17213a]/30 focus:border-[#3478f6]/55 focus:bg-white focus:ring-4 focus:ring-[#3478f6]/10"
                  />
                </label>

                <label className="mt-4 block">
                  <span className="mb-2 flex items-center justify-between text-sm font-semibold">
                    Creator link
                    <span className="text-xs font-normal text-[#17213a]/40">3–24 characters</span>
                  </span>
                  <span className="flex h-14 items-center rounded-2xl border border-[#17213a]/10 bg-white/72 px-4 transition focus-within:border-[#3478f6]/55 focus-within:bg-white focus-within:ring-4 focus-within:ring-[#3478f6]/10">
                    <span className="shrink-0 text-sm text-[#17213a]/42">bento.surf/</span>
                    <input
                      value={username}
                      autoCapitalize="none"
                      autoCorrect="off"
                      onChange={(event) => {
                        setClaimError(null);
                        setUsername(
                          normalizeUsername(event.target.value).replace(/[^a-z0-9_]/g, ""),
                        );
                      }}
                      placeholder="yourname"
                      className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none placeholder:text-[#17213a]/25"
                    />
                    {available === true && (
                      <span className="ml-2 flex size-7 shrink-0 items-center justify-center rounded-full bg-[#3ab86f] text-white">
                        <Check className="size-4" />
                      </span>
                    )}
                    {available === false && (
                      <span className="ml-2 rounded-full bg-[#ffe0e1] px-2.5 py-1 text-xs font-semibold text-[#b82f32]">
                        Taken
                      </span>
                    )}
                  </span>
                </label>

                <label className="mt-4 block">
                  <span className="mb-2 flex items-center justify-between text-sm font-semibold">
                    What kind of page are you building?
                    <span className="text-xs font-normal text-[#17213a]/40">Used in Explore</span>
                  </span>
                  <select
                    value={exploreCategory}
                    onChange={(event) =>
                      setExploreCategory(exploreCategorySchema.parse(event.target.value))
                    }
                    className="h-14 w-full appearance-none rounded-2xl border border-[#17213a]/10 bg-white/72 px-4 text-[15px] outline-none transition focus:border-[#3478f6]/55 focus:bg-white focus:ring-4 focus:ring-[#3478f6]/10"
                  >
                    {EXPLORE_CATEGORIES.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.choiceLabel} - {category.description}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="mt-2 min-h-5 text-sm">
                  {availabilityError ? (
                    <span className="flex items-center gap-3 text-[#b82f32]" role="alert">
                      Couldn’t check that link.
                      <button type="button" onClick={retry} className="font-semibold underline">
                        Retry
                      </button>
                    </span>
                  ) : claimError ? (
                    <span className="text-[#b82f32]" role="alert">
                      {claimError}
                    </span>
                  ) : available === true ? (
                    <span className="font-medium text-[#2d8e57]">This link is yours.</span>
                  ) : username.length >= 3 ? (
                    <span className="text-[#17213a]/40">Checking availability…</span>
                  ) : (
                    <span className="text-[#17213a]/40">
                      Letters, numbers, and underscores work.
                    </span>
                  )}
                </div>

                <button
                  type="button"
                  onClick={next1}
                  disabled={available !== true || saveProfile.isPending}
                  className="group mt-4 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-[#3478f6] px-5 text-sm font-semibold text-white shadow-[0_16px_34px_-18px_rgba(52,120,246,0.85)] transition hover:-translate-y-0.5 hover:bg-[#2168e5] disabled:translate-y-0 disabled:opacity-40"
                >
                  {saveProfile.isPending ? "Saving your page…" : "Looks good. Keep going"}
                  {!saveProfile.isPending && (
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                  )}
                </button>
              </div>
            )}

            {step === 2 && (
              <div className="relative max-w-lg">
                <span className="inline-flex items-center gap-2 rounded-full bg-[#dfeaff] px-3 py-1.5 text-xs font-semibold text-[#245fd0]">
                  <AtSign className="size-3.5" />
                  Bring your audience with you
                </span>
                <h1 className="mt-5 text-balance font-sans text-4xl font-semibold leading-[0.98] tracking-[-0.055em] sm:text-5xl">
                  Where can people
                  <br />
                  already find you?
                </h1>
                <p className="mt-4 max-w-md text-sm leading-relaxed text-[#17213a]/55 sm:text-base">
                  Add any handles you want. Each one becomes a live Bento block.
                </p>

                <div className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {SOCIALS.map((social) => {
                    const value = handles[social.key] ?? "";
                    const filled = value.trim().length > 0;
                    const Icon = social.icon;
                    return (
                      <label
                        key={social.key}
                        className={`rounded-[20px] border p-3 transition ${
                          filled
                            ? "border-[#3478f6]/25 bg-[#dfeaff]/48"
                            : "border-[#17213a]/8 bg-white/62"
                        }`}
                      >
                        <span className="mb-2.5 flex items-center gap-2 text-xs font-semibold">
                          <span
                            className="flex size-7 items-center justify-center rounded-lg text-white"
                            style={{ background: social.color }}
                          >
                            <Icon className="size-3.5" />
                          </span>
                          {social.label}
                          {filled && <Check className="ml-auto size-3.5 text-[#2d8e57]" />}
                        </span>
                        <span className="flex h-10 items-center rounded-xl bg-white/76 px-3 text-sm ring-1 ring-[#17213a]/7 focus-within:ring-2 focus-within:ring-[#3478f6]/30">
                          <span className="text-[#17213a]/35">@</span>
                          <input
                            value={value}
                            onChange={(event) =>
                              setHandles((current) => ({
                                ...current,
                                [social.key]: event.target.value.replace(/^@/, ""),
                              }))
                            }
                            placeholder="username"
                            aria-label={`${social.label} username`}
                            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[#17213a]/25"
                          />
                          {filled && (
                            <button
                              type="button"
                              onClick={() =>
                                setHandles((current) => ({ ...current, [social.key]: "" }))
                              }
                              aria-label={`Clear ${social.label}`}
                              className="ml-1 flex size-7 items-center justify-center rounded-lg text-[#17213a]/35 hover:bg-[#f0f3fa] hover:text-[#17213a]"
                            >
                              <X className="size-3.5" />
                            </button>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>

                <button
                  type="button"
                  onClick={next2}
                  disabled={addBlock.isPending}
                  className="group mt-6 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-[#3478f6] px-5 text-sm font-semibold text-white shadow-[0_16px_34px_-18px_rgba(52,120,246,0.85)] transition hover:-translate-y-0.5 hover:bg-[#2168e5] disabled:translate-y-0 disabled:opacity-55"
                >
                  {addBlock.isPending
                    ? "Adding your socials…"
                    : entriesCount(handles) > 0
                      ? `Add ${entriesCount(handles)} social block${entriesCount(handles) === 1 ? "" : "s"}`
                      : "Continue without socials"}
                  {!addBlock.isPending && <ArrowRight className="size-4" />}
                </button>
                <p className="mt-3 text-center text-xs text-[#17213a]/38">
                  Optional. You can connect more platforms later.
                </p>
              </div>
            )}

            {step === 3 && (
              <div className="relative max-w-lg">
                <span className="inline-flex items-center gap-2 rounded-full bg-[#fff0bd] px-3 py-1.5 text-xs font-semibold text-[#7a5b00]">
                  <Sparkles className="size-3.5" />
                  Your first bit of content
                </span>
                <h1 className="mt-5 text-balance font-sans text-4xl font-semibold leading-[0.98] tracking-[-0.055em] sm:text-5xl">
                  Add one thing visitors
                  <br />
                  should see first.
                </h1>
                <p className="mt-4 max-w-md text-sm leading-relaxed text-[#17213a]/55 sm:text-base">
                  Choose a quick starter. It appears instantly and stays completely editable.
                </p>

                <div className="mt-7 grid gap-3">
                  {STARTER_BLOCKS.map((starter) => {
                    const Icon = starter.icon;
                    const added = starterBlocksAdded.has(starter.key);
                    return (
                      <button
                        key={starter.key}
                        type="button"
                        onClick={() => addStarter(starter)}
                        disabled={added || addBlock.isPending}
                        className={`flex items-center gap-4 rounded-[20px] border p-3.5 text-left transition ${
                          added
                            ? "border-[#3ab86f]/24 bg-[#e3f8ea]/70"
                            : "border-[#17213a]/8 bg-white/65 hover:-translate-y-0.5 hover:border-[#3478f6]/22 hover:bg-white"
                        } disabled:translate-y-0`}
                      >
                        <span
                          className={`flex size-11 shrink-0 items-center justify-center rounded-2xl ${starter.color}`}
                        >
                          <Icon className="size-5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold">{starter.label}</span>
                          <span className="mt-0.5 block text-xs text-[#17213a]/42">
                            {starter.description}
                          </span>
                        </span>
                        <span
                          className={`flex size-8 shrink-0 items-center justify-center rounded-full ${
                            added
                              ? "bg-[#3ab86f] text-white"
                              : "border border-[#17213a]/10 bg-white text-[#17213a]/40"
                          }`}
                        >
                          {added ? (
                            <Check className="size-4" />
                          ) : (
                            <span className="text-lg">+</span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <button
                  type="button"
                  onClick={finishOnboarding}
                  disabled={saveProfile.isPending}
                  className="group mt-6 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-[#17213a] px-5 text-sm font-semibold text-white shadow-[0_16px_34px_-18px_rgba(23,33,58,0.75)] transition hover:-translate-y-0.5 hover:bg-[#0d1425] disabled:translate-y-0 disabled:opacity-55"
                >
                  {saveProfile.isPending ? "Opening your dashboard…" : "Finish setup"}
                  {!saveProfile.isPending && (
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                  )}
                </button>
                <p className="mt-3 text-center text-xs text-[#17213a]/38">
                  {starterBlocksAdded.size > 0
                    ? "Nice. Your page already has a starting point."
                    : "You can start with an empty canvas and use Free for as long as you like."}
                </p>
              </div>
            )}
          </div>
        </section>

        <aside className="hidden lg:block">
          <div className="mx-auto w-full max-w-[620px]">
            <div className="mb-5 flex items-center justify-between px-2">
              <span className="inline-flex items-center gap-2 rounded-full border border-white bg-white/68 px-3 py-2 text-xs font-semibold shadow-sm backdrop-blur-xl">
                <span className="size-2 rounded-full bg-[#3ab86f]" />
                Live preview
              </span>
              <span className="text-xs text-[#17213a]/38">Updates as you build</span>
            </div>

            <div className="rounded-[32px] border border-[#17213a]/[0.07] bg-white p-5 shadow-[0_28px_80px_-52px_rgba(23,33,58,0.32)]">
              <div className="mb-4 flex items-center gap-3 rounded-[22px] border border-[#17213a]/[0.06] bg-[#fafbfc] p-3.5">
                <div className="flex size-12 items-center justify-center rounded-full bg-[#17213a] text-lg font-semibold text-white">
                  {(displayName.trim() || username || "B").slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="truncate font-semibold tracking-[-0.03em]">
                    {displayName.trim() || "Your name"}
                  </div>
                  <div className="truncate text-xs text-[#17213a]/42">
                    bento.surf/@{username || "yourname"}
                  </div>
                </div>
                <span className="ml-auto rounded-full bg-[#dfeaff] px-3 py-1.5 text-xs font-semibold text-[#245fd0]">
                  Preview
                </span>
              </div>

              <PreviewGrid blocks={blocks as Block[]} pendingHandles={handles} step={step} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function entriesCount(handles: Record<string, string>) {
  return Object.values(handles).filter((value) => value.trim().length > 0).length;
}

function PreviewGrid({
  blocks,
  pendingHandles,
  step,
}: {
  blocks: Block[];
  pendingHandles: Record<string, string>;
  step: Step;
}) {
  // Combine saved blocks + locally-pending preview tiles for step 2
  const previewBlocks = useMemo<Block[]>(() => {
    if (step !== 2) return blocks;
    const existingPlatforms = new Set(
      blocks.filter((b) => b.type === "social_link").map((b) => b.content?.platform),
    );
    const pending = Object.entries(pendingHandles)
      .filter(([k, v]) => v.trim() && !existingPlatforms.has(k))
      .map(([k, v]) => ({ id: `pending-${k}`, ...onboardingSocialBlock(k, v) }));
    return [...blocks, ...pending];
  }, [blocks, pendingHandles, step]);

  return (
    <div
      className="grid min-h-[428px] auto-rows-[100px] grid-cols-4 content-start gap-3"
      style={PREVIEW_LIGHT_VARS}
    >
      {previewBlocks.length === 0 && (
        <div className="col-span-4 row-span-2 flex flex-col items-center justify-center rounded-[26px] border-2 border-dashed border-[#17213a]/10 bg-white/38 px-6 text-center">
          <span className="flex size-11 items-center justify-center rounded-2xl bg-[#dfeaff] text-[#245fd0]">
            <Sparkles className="size-5" />
          </span>
          <p className="mt-3 text-sm font-semibold">Your first block will appear here</p>
          <p className="mt-1 max-w-xs text-xs leading-relaxed text-[#17213a]/40">
            Add a social handle or starter and watch your page take shape.
          </p>
        </div>
      )}
      {previewBlocks.map((b) => (
        <div
          key={b.id}
          style={{
            gridColumn: `span ${Math.min(b.w, 4)} / span ${Math.min(b.w, 4)}`,
            gridRow: `span ${Math.min(b.h, 4)} / span ${Math.min(b.h, 4)}`,
          }}
        >
          <BlockRenderer block={b} />
        </div>
      ))}
    </div>
  );
}
