import { z } from "zod";
import {
  carouselSlideSchema,
  editorialMetadataSchema,
  isAutomaticEditorialFormat,
} from "../content-editorial";
import { usernameSchema } from "../username";
import { parsePublicHttpUrl, safeMediaUrl } from "../safe-url";
import { isValidTimeZone } from "../timezones";
import { completeContentStrategy, contentProfileSchema } from "../content-brain";
import type { PaidPlanId } from "../plans";
import { onboardingEvidenceSchema } from "./evidence";

export const ONBOARDING_GOALS = [
  { id: "presence", label: "Build my online presence", detail: "One link for everything I do" },
  {
    id: "publish",
    label: "Create content consistently",
    detail: "Find my voice and get past the blank page",
  },
  { id: "grow", label: "Grow my audience", detail: "Discover ideas and reach the right people" },
  { id: "bookings", label: "Get leads and bookings", detail: "Turn interest into conversations" },
  { id: "sell", label: "Sell my work", detail: "Bring my offers into one simple store" },
] as const;
export const ONBOARDING_OUTPUT_PLATFORMS = ["twitter", "linkedin", "instagram"] as const;
export const ONBOARDING_PLATFORMS = [
  "instagram",
  "twitter",
  "linkedin",
  "facebook",
  "threads",
  "tiktok",
  "youtube",
] as const;
export const onboardingBriefSchema = z.object({
  displayName: z.string().trim().max(60).default(""),
  username: z.union([usernameSchema, z.literal("")]).default(""),
  bio: z.string().trim().max(280).default(""),
  avatarUrl: z
    .string()
    .max(2048)
    .refine((v) => !v || Boolean(safeMediaUrl(v)), "Use a public image URL.")
    .default(""),
  expertise: z.string().trim().max(500).default(""),
  audience: z.string().trim().max(500).default(""),
  offer: z.string().trim().max(500).default(""),
  goal: z.enum(["presence", "publish", "grow", "bookings", "sell"]).default("presence"),
  voice: z
    .string()
    .trim()
    .max(2000)
    .default("Clear, warm and practical. Avoid hype and unsupported claims."),
  writingSample: z.string().trim().max(4000).default(""),
  platform: z.enum(ONBOARDING_PLATFORMS).default("linkedin"),
  postsPerWeek: z.number().int().min(1).max(7).default(3),
  language: z.string().trim().min(2).max(12).default("en"),
  timezone: z.string().max(100).refine(isValidTimeZone).default("UTC"),
  style: z.enum(["blue", "mint", "rose"]).default("blue"),
  links: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(80),
        url: z
          .string()
          .trim()
          .max(2000)
          .refine((v) => Boolean(parsePublicHttpUrl(v)), "Use a public HTTP or HTTPS link."),
      }),
    )
    .max(8)
    .default([]),
  publishPage: z.boolean().default(false),
  primaryConnectionId: z.string().uuid().nullable().default(null),
});
export type OnboardingBrief = z.infer<typeof onboardingBriefSchema>;

const onboardingCandidateDraftSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(10000),
  platform: z.enum(ONBOARDING_PLATFORMS).optional(),
  format: z.enum(["post", "carousel", "short_script", "long_script", "thread"]).optional(),
  slides: z.array(carouselSlideSchema).max(10).optional(),
  sourceUrls: z.array(z.string().url()).max(5).optional(),
  rationale: z.string().max(2000).optional(),
  visualBrief: z.string().max(2000).nullable().optional(),
  editorial: editorialMetadataSchema.optional(),
  mediaIds: z.array(z.string().uuid()).max(1).optional(),
  photoSourcePostId: z.string().uuid().optional(),
  mediaNote: z.string().max(500).optional(),
  mediaPreview: z
    .object({
      mediaId: z.string().uuid(),
      url: z
        .string()
        .url()
        .refine((value) => Boolean(safeMediaUrl(value))),
      sourceUrl: z
        .string()
        .nullable()
        .refine((value) => !value || Boolean(parsePublicHttpUrl(value, { requireHttps: true }))),
      alt: z.string().max(300),
    })
    .optional(),
});

export const onboardingCandidatesSchema = z.object({
  brain: z
    .array(
      z.object({
        kind: z.enum(["profile", "instruction", "strategy", "story"]),
        title: z.string().min(1).max(160),
        content: z.string().min(1).max(20000),
      }),
    )
    .min(3)
    .max(12),
  evidence: onboardingEvidenceSchema.optional(),
  personalization: z
    .object({
      generation: z.number().int().min(1).max(2),
      status: z.enum(["running", "ready", "unavailable"]),
      profileCount: z.number().int().min(0).max(20),
      postCount: z.number().int().min(0).max(24),
      note: z.string().max(500),
    })
    .optional(),
  drafts: z.array(onboardingCandidateDraftSchema).max(3),
  // Kept in preparation/export only; explicitly excluded from starter activation.
  deferredDrafts: z.array(onboardingCandidateDraftSchema).max(20).optional(),
  nextAction: z.string().min(1).max(1000),
  warning: z.string().max(1000).nullable().default(null),
});
export type OnboardingCandidates = z.infer<typeof onboardingCandidatesSchema>;

/** Explicit manual continuation retains prior copy without applying it as starter posts. */
export function continueWithoutOnboardingDrafts(
  candidates: OnboardingCandidates,
): OnboardingCandidates {
  const previous = [...(candidates.deferredDrafts || []), ...candidates.drafts];
  return onboardingCandidatesSchema.parse({
    ...candidates,
    drafts: [],
    deferredDrafts: previous,
    nextAction: "Your page and Brain are ready. Create drafts in Agent when you're ready.",
    warning: previous.length
      ? "Continuing without starter drafts. Your earlier draft copy remains saved in your preparation download."
      : null,
  });
}

/** Readers accept legacy candidates, but new activation must use supported structured output. */
export function hasUnsupportedOnboardingDrafts(candidates: OnboardingCandidates) {
  return candidates.drafts.some(
    (draft) =>
      !draft.platform ||
      !draft.format ||
      !isAutomaticEditorialFormat(draft.platform, draft.format) ||
      (draft.format === "carousel" &&
        (!draft.slides || draft.slides.length < 2 || draft.slides.length > 10)),
  );
}

export function recommendedPlan(goal: OnboardingBrief["goal"]): PaidPlanId {
  return goal === "publish" ? "creator_plus" : goal === "grow" ? "creator" : "store";
}

export function buildManualCandidates(brief: OnboardingBrief): OnboardingCandidates {
  const goal = ONBOARDING_GOALS.find((item) => item.id === brief.goal)!.label;
  const pillars = [
    [
      "60",
      `Useful ideas about ${brief.expertise || "your expertise"}`,
      "Share a practical lesson you can explain accurately.",
    ],
    [
      "40",
      "Conversations with your audience",
      "Ask a focused question and use the response to choose your next topic.",
    ],
  ];
  return {
    brain: [
      {
        kind: "profile",
        title: "My Human",
        content: `# ${brief.displayName || "About me"}\n\nExpertise: ${brief.expertise || "To be confirmed"}\nAudience: ${brief.audience || "To be confirmed"}\nFirst goal: ${goal}\nOffer: ${brief.offer || "Not defined yet; explore ideas without claiming an existing offer."}\n\n${brief.bio}`,
      },
      {
        kind: "instruction",
        title: "Writing voice",
        content: `${brief.voice}\n\nLanguage: ${brief.language}. Do not invent personal stories, credentials, results, products, prices, or customer evidence.${brief.writingSample ? `\n\nCreator-supplied writing sample:\n${brief.writingSample}` : ""}`,
      },
      {
        kind: "strategy",
        title: `${brief.platform === "twitter" ? "X" : brief.platform === "linkedin" ? "LinkedIn" : brief.platform[0].toUpperCase() + brief.platform.slice(1)} Strategy`,
        content: `## Strategic Goal\n${goal}. Begin with a small, reviewable experiment.\n\n## Target Audience\n${brief.audience || "Confirm your audience"}\n\n## Content Pillars\n${pillars.map(([weight, title, share]) => `### ${weight}% ${title}\nCore Message: Help ${brief.audience || "your audience"} make progress.\nWhat I Share: ${share}\nWhy It Matters: Offer something useful before asking for an action.`).join("\n\n")}\n\n## Posting Rhythm\nAim for ${brief.postsPerWeek} posts per week on ${brief.platform}, in ${brief.timezone}. Review each draft before scheduling.\n\n## Notes\nThis is a starting strategy, not a claim about past performance. Review real responses after the first week. ${brief.offer ? `Only mention this confirmed offer when relevant: ${brief.offer}` : "Validate an offer idea before promising delivery or setting a price."}`,
      },
    ],
    drafts: [],
    nextAction:
      brief.goal === "sell"
        ? "Review your first offer in Store, then share your page."
        : brief.goal === "bookings"
          ? "Set your availability in Calendar and review a booking page."
          : brief.goal === "grow"
            ? "Explore a relevant idea in Discover and save it for your next post."
            : brief.goal === "publish"
              ? "Review your first draft and choose a realistic posting time."
              : "Copy your page link and add it to your social bio.",
    warning: null,
  };
}

export function preparationReady(brief: OnboardingBrief, candidates: OnboardingCandidates | null) {
  return Boolean(
    brief.displayName &&
    usernameSchema.safeParse(brief.username).success &&
    brief.expertise &&
    brief.audience &&
    brief.voice &&
    candidates &&
    candidates.brain.some((item) => item.kind === "profile") &&
    candidates.brain.some((item) => item.kind === "instruction") &&
    candidates.brain.some(
      (item) => item.kind === "strategy" && completeContentStrategy(item.content),
    ),
  );
}

export function onboardingContentProfile(brief: OnboardingBrief) {
  return contentProfileSchema.parse({
    goal: brief.goal === "grow" ? "reach_growth" : "consistent_publishing",
    nicheKeywords: brief.expertise
      .split(/[,;\n]/)
      .map((v) => v.trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 20),
    language: brief.language,
    timezone: brief.timezone,
    platformFrequencies: { [brief.platform]: brief.postsPerWeek },
  });
}
