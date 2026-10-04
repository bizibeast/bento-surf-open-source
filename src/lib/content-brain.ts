import { z } from "zod";
import { SOCIAL_PROVIDERS, type SocialProvider } from "./social-scheduler";
import { isValidTimeZone } from "./timezones";

export const CONTENT_BRAIN_KINDS = [
  "profile",
  "instruction",
  "strategy",
  "story",
  "inspiration",
  "file",
  "photo",
  "link",
] as const;

export type ContentBrainKind = (typeof CONTENT_BRAIN_KINDS)[number];
export type BrainItemStatus = "suggested" | "confirmed";
export type BrainItemProvenance = "creator" | "social_post" | "agent_chat" | "file" | "link";

const platformFrequenciesSchema = z
  .record(z.string(), z.number().int().min(0).max(21))
  .superRefine((value, context) => {
    for (const provider of Object.keys(value)) {
      if (!(SOCIAL_PROVIDERS as readonly string[]).includes(provider)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [provider],
          message: "Choose a supported social platform.",
        });
      }
    }
  });

export const contentProfileSchema = z.object({
  goal: z.enum(["consistent_publishing", "reach_growth"]).default("consistent_publishing"),
  nicheKeywords: z
    .array(z.string().trim().min(1).max(80))
    .max(20)
    .default([])
    .transform((keywords) => [...new Set(keywords.map((keyword) => keyword.toLowerCase()))]),
  language: z.string().trim().min(2).max(12).default("en"),
  region: z.string().trim().min(2).max(32).default("global"),
  timezone: z.string().trim().min(1).max(100).default("UTC").refine(isValidTimeZone, {
    message: "Choose a valid timezone.",
  }),
  platformFrequencies: platformFrequenciesSchema.default({}),
});

const safeSourceUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2_000)
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "https:" || protocol === "http:";
    } catch {
      return false;
    }
  }, "Use an HTTP or HTTPS source URL.");

export const brainItemInputSchema = z.object({
  id: z.string().uuid().optional(),
  kind: z.enum(CONTENT_BRAIN_KINDS),
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(20_000),
  provenance: z.enum(["creator", "social_post", "agent_chat", "file", "link", "integration"]),
  sourceUrl: safeSourceUrlSchema.nullable().optional(),
  sourceRef: z.string().trim().max(500).nullable().optional(),
  status: z.enum(["suggested", "confirmed"]).default("suggested"),
  locked: z.boolean().default(false),
  tags: z.array(z.string().trim().min(1).max(80)).max(8).optional(),
});

export type ContentProfile = z.infer<typeof contentProfileSchema>;
export type BrainItemInput = z.infer<typeof brainItemInputSchema>;

export type BrainItem = BrainItemInput & {
  id: string;
  sourceUrl: string | null;
  sourceRef: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BrainSuggestion = Omit<
  BrainItemInput,
  "id" | "status" | "locked" | "sourceUrl" | "sourceRef"
> & {
  sourceUrl?: string | null;
  sourceRef?: string | null;
  evidence?: Array<{ sourceRef: string; quote: string }>;
};

export function buildContentStrategy(
  platform: "twitter" | "linkedin",
  profile: ContentProfile,
  items: readonly BrainItem[],
) {
  const niche = profile.nicheKeywords.join(", ") || "your work and areas of expertise";
  const cadence = profile.platformFrequencies[platform] ?? 3;
  const confirmed = items.filter((item) => item.status === "confirmed");
  const rules = confirmed
    .filter((item) => item.kind === "instruction")
    .map((item) => `- ${item.content}`)
    .join("\n");
  const stories = confirmed
    .filter((item) => item.kind === "story")
    .slice(0, 8)
    .map((item) => `- ${item.title}`)
    .join("\n");
  return `# Creator Content Strategy - One-Pager

## Strategic Goal
${profile.goal === "reach_growth" ? "Grow qualified reach and build trust with the right audience." : "Publish consistently and learn which ideas build lasting trust."}

## Target Audience
**Primary:** People interested in ${niche} who value lessons from real work.

**Secondary:** Practitioners and collaborators looking for useful, specific examples.

**Positioning Line:** Share the decisions, proof, and tradeoffs behind your work. Refresh from your posts to tailor this draft to your actual audience.

## Content Pillars
### ${platform === "twitter" ? "45% Opinion and lessons" : "45% Practical lessons and distribution"}
**Core Message:** Make one useful point grounded in experience.

**What I Share:** Decisions, experiments, and lessons about ${niche}.

**Why It Matters:** Readers can apply a concrete lesson to their own work.

### 20% Product and building
**Core Message:** Explain the choices behind what you are building.

**What I Share:** Actual work, tradeoffs, and customer learning.

**Why It Matters:** Showing the process earns trust.

### 20% Personal proof and lived examples
**Core Message:** Lead with what really happened.

**What I Share:** Confirmed stories and evidence from my Brain.

**Why It Matters:** Specific examples make a lesson credible.

### 15% Niche observations
**Core Message:** Add a useful perspective to cited developments.

**What I Share:** Current news about ${niche}, with source links.

**Why It Matters:** Help the audience understand what changes for them.

## Posting Rhythm
**Cadence:** ${cadence === 0 ? "Publishing is paused for this platform." : `Prepare ${cadence} posts per week.`}

**Formats:** ${platform === "twitter" ? "Short observations, opinion posts, build updates, and occasional threads." : "Story-led posts, useful frameworks, and practical carousels."}

**Windows:** Follow the actual posting schedule in ${profile.timezone}. Check existing posts before proposing a slot.

## Notes
**What I Lean Into:**
- Story-first structure: open with a moment or tension before the lesson.
- Concrete proof and direct, specific language.
${rules}

**What I Avoid:**
- Inventing events, metrics, client names, or results.
- Generic advice, corporate language, and repeating the same hook.

${stories ? `**Stories to Draw From:**\n${stories}` : "Build your Brain from your posts to add source-backed stories."}`;
}

export function groupBrainItems(items: readonly BrainItem[]) {
  const groups = Object.fromEntries(
    CONTENT_BRAIN_KINDS.map((kind) => [kind, [] as BrainItem[]]),
  ) as unknown as Record<ContentBrainKind, BrainItem[]>;
  for (const item of items) groups[item.kind].push(item);
  return groups;
}

function normalized(value: string | null | undefined) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function topicKey(item: Pick<BrainItemInput, "kind" | "title">) {
  return `${item.kind}:${normalized(item.title)}`;
}

function sourceKey(item: Pick<BrainItemInput, "kind" | "title" | "sourceRef">) {
  return `${topicKey(item)}:${normalized(item.sourceRef)}`;
}

export function mergeBrainSuggestions(
  existing: readonly BrainItem[],
  candidates: readonly BrainSuggestion[],
) {
  const protectedTopics = new Set(
    existing
      .filter((item) => item.locked || item.status === "confirmed")
      .map((item) => topicKey(item)),
  );
  const seen = new Set(existing.map((item) => sourceKey(item)));
  const suggestions: BrainSuggestion[] = [];
  for (const candidate of candidates) {
    const parsed = brainItemInputSchema.parse({ ...candidate, status: "suggested", locked: false });
    const key = sourceKey(parsed);
    if (protectedTopics.has(topicKey(parsed)) || seen.has(key)) continue;
    seen.add(key);
    suggestions.push(candidate);
  }
  return { kept: [...existing], suggestions };
}

export function brainItemFromRow(row: {
  id: string;
  kind: string;
  title: string;
  content: string;
  provenance: string;
  source_url: string | null;
  source_ref: string | null;
  status: string;
  locked: boolean;
  created_at: string;
  updated_at: string;
  tags?: string[];
}): BrainItem {
  return {
    id: row.id,
    kind: row.kind as ContentBrainKind,
    title: row.title,
    content: row.content,
    provenance: row.provenance as BrainItemProvenance,
    sourceUrl: row.source_url,
    sourceRef: row.source_ref,
    status: row.status as BrainItemStatus,
    locked: row.locked,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: row.tags || [],
  };
}

export function contentProfileFromRow(row: {
  goal: string;
  niche_keywords: string[];
  language: string;
  region: string;
  timezone: string;
  platform_frequencies: unknown;
}): ContentProfile {
  return contentProfileSchema.parse({
    goal: row.goal,
    nicheKeywords: row.niche_keywords,
    language: row.language,
    region: row.region,
    timezone: row.timezone,
    platformFrequencies: row.platform_frequencies,
  });
}

export function contentProfileToRow(profile: ContentProfile) {
  return {
    goal: profile.goal,
    niche_keywords: profile.nicheKeywords,
    language: profile.language,
    region: profile.region,
    timezone: profile.timezone,
    platform_frequencies: profile.platformFrequencies as Partial<Record<SocialProvider, number>>,
  };
}
