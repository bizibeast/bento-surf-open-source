import { z } from "zod";
import { carouselCopyIssues } from "./content-carousel";
import { parsePublicHttpUrl } from "./safe-url";
import { SOCIAL_PROVIDER_DEFINITIONS } from "./social-scheduler";

export const AUTOMATIC_EDITORIAL_FORMATS = {
  twitter: "post",
  linkedin: "post",
  instagram: "carousel",
} as const;
export type EditorialPlatform = keyof typeof AUTOMATIC_EDITORIAL_FORMATS;
export const carouselSlideSchema = z
  .object({
    heading: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(1500),
    visualBrief: z.string().trim().max(2000).optional(),
    mediaId: z.string().uuid().optional(),
  })
  .strict();
export const editorialMetadataSchema = z
  .object({
    sourceIds: z.array(z.string().max(500)).max(40),
    angle: z.string().max(2000),
    whyNow: z.string().max(2000),
    validationState: z.enum(["passed", "needs_review"]),
    revisionOf: z
      .object({ messageId: z.string().min(1).max(100), cardId: z.string().min(1).max(100) })
      .strict()
      .optional(),
  })
  .strict();
export const editorialDraftSchema = z
  .object({
    platform: z.enum(["twitter", "linkedin", "instagram"]),
    format: z.enum(["post", "carousel"]),
    title: z.string().max(300).default(""),
    angle: z.string().trim().min(10).max(2000),
    whyNow: z.string().trim().min(10).max(2000),
    sourceIds: z.array(z.string().max(500)).max(5).default([]),
    body: z.string().trim().min(1).max(10000),
    sourceUrls: z.array(z.string().url()).max(5).default([]),
    visualBrief: z.string().max(2000).nullable().optional(),
    slides: z
      .array(carouselSlideSchema)
      .max(SOCIAL_PROVIDER_DEFINITIONS.instagram.maxMedia)
      .optional(),
    claims: z
      .array(
        z
          .object({
            text: z.string().min(1).max(2000),
            sourceId: z.string(),
            quote: z.string().min(8).max(3000),
          })
          .strict(),
      )
      .max(30)
      .default([]),
  })
  .strict();
export type EditorialDraft = z.infer<typeof editorialDraftSchema>;
export type EditorialSource = {
  id: string;
  title: string;
  text: string;
  occurredAt: string | null;
  url?: string | null;
  external: boolean;
};
export type EditorialOutput = { id: string; body: string; createdAt?: string; platform?: string };
/** Resolved only from a workspace-owned persisted assistant card, never from client draft text. */
export type EditorialRevisionTarget = {
  id: string;
  messageId: string;
  cardId: string;
  platform: string;
  format: string;
  body: string;
  sourceIds: string[];
  sourceUrls: string[];
  sources: EditorialSource[];
  /** Ancestor IDs verified by the server through bounded persisted revisionOf links. */
  ancestorIds?: string[];
  /** Owned canonical posts with reverse bindings verified for the target/ancestors. */
  canonicalPostIds?: string[];
};
export type EditorialContext = {
  now?: string;
  request?: string;
  platform?: EditorialPlatform;
  brain: Array<Record<string, unknown> & { status?: string }>;
  sources: EditorialSource[];
  representativePosts?: EditorialOutput[];
  recentOutputs?: EditorialOutput[];
  revisionTarget?: EditorialRevisionTarget;
  feedback?: Array<Record<string, unknown>>;
};
export type EditorialBrief = {
  platform: EditorialPlatform;
  format: "post" | "carousel";
  request: string;
  angle: string;
  whyNow: string;
  now: string;
  sourceIds: string[];
  claimsAllowed: string[];
  sources: Array<
    EditorialSource & { ageDays: number | null; freshness: "recent" | "historical" | "unknown" }
  >;
  voiceProfile: { instructions: string[]; examples: string[] };
  strategy: string[];
  feedback: Array<Record<string, unknown>>;
  recentOutputs: EditorialOutput[];
  revisionTarget?: EditorialRevisionTarget;
};
export type EditorialIssue = { code: string; message: string };
function revisionOutputIds(target?: EditorialRevisionTarget): Set<string> {
  return new Set(
    target
      ? [
          target.id,
          ...(target.ancestorIds || []).slice(0, 20),
          ...(target.canonicalPostIds || []).slice(0, 21),
        ]
      : [],
  );
}
export function isAutomaticEditorialFormat(platform: string, format: string): boolean {
  return AUTOMATIC_EDITORIAL_FORMATS[platform as EditorialPlatform] === format;
}
const normalized = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
const evidenceExcerpt = (value: string, maxBytes: number) => {
  const bytes = new TextEncoder().encode(value);
  return bytes.length <= maxBytes
    ? value
    : new TextDecoder().decode(bytes.slice(0, maxBytes), { stream: true });
};
export function buildEditorialBrief(input: EditorialContext): EditorialBrief {
  const now = input.now || new Date().toISOString();
  const platform =
    input.platform ||
    (/\b(instagram|carousel)\b/i.test(input.request || "")
      ? "instagram"
      : /\blinkedin\b/i.test(input.request || "")
        ? "linkedin"
        : "twitter");
  const confirmed = input.brain.filter((item) => item.status === "confirmed");
  const terms = normalized(input.request || "")
    .split(" ")
    .filter((term) => term.length > 3);
  const targetSourceIds = new Set(input.revisionTarget?.sourceIds || []);
  const ranked = [
    ...new Map(
      [...(input.revisionTarget?.sources || []), ...input.sources].map((source) => [
        source.id,
        source,
      ]),
    ).values(),
  ]
    .map((source, index) => ({
      source,
      index,
      relevance:
        (targetSourceIds.has(source.id) ? 100 : 0) +
        terms.filter((term) => normalized(`${source.title} ${source.text}`).includes(term)).length,
    }))
    .sort((a, b) => b.relevance - a.relevance || a.index - b.index);
  // Keep a small evidence pack; each selected external source must be attributable.
  const fresh = ranked
    .filter(({ source }) => {
      const age = Date.parse(now) - Date.parse(source.occurredAt || "");
      return source.external && source.url && age >= 0 && age <= 7 * 86400000;
    })
    .slice(0, 3);
  const selected = [
    ...new Map(
      [
        ...ranked.filter(({ source }) => targetSourceIds.has(source.id)).slice(0, 5),
        ...fresh,
        ...ranked,
      ].map((item) => [item.source.id, item]),
    ).values(),
  ].slice(0, 12);
  const sources = selected.map(({ source }) => {
    const age = source.occurredAt
      ? (Date.parse(now) - Date.parse(source.occurredAt)) / 86400000
      : NaN;
    const ageDays = Number.isFinite(age) ? Math.floor(age) : null;
    return {
      ...source,
      id: source.id.slice(0, 500),
      url: source.url && parsePublicHttpUrl(source.url, { requireHttps: true }) ? source.url : null,
      title: evidenceExcerpt(source.title, 300),
      text: evidenceExcerpt(source.text, 2000),
      ageDays,
      freshness:
        ageDays === null || ageDays < 0
          ? ("unknown" as const)
          : ageDays > 30
            ? ("historical" as const)
            : ("recent" as const),
    };
  });
  const recentOutputs = [...(input.recentOutputs || [])]
    .filter((output) => !revisionOutputIds(input.revisionTarget).has(output.id))
    .sort((a, b) => (Date.parse(b.createdAt || "") || 0) - (Date.parse(a.createdAt || "") || 0))
    .slice(0, 60)
    .map((output) => ({ ...output, body: evidenceExcerpt(output.body, 600) }));
  const topic = (input.request || sources[0]?.title || "your work").slice(0, 500);
  const candidates = [
    `A practical decision the reader can make about ${topic}`,
    `A common assumption to test about ${topic}`,
    `A concrete tradeoff to consider about ${topic}`,
  ];
  const angle =
    candidates.find(
      (candidate) =>
        !recentOutputs.some((output) => normalized(output.body).includes(normalized(candidate))),
    ) || candidates[0];
  return {
    platform,
    format: AUTOMATIC_EDITORIAL_FORMATS[platform],
    request: input.request || "",
    now,
    angle,
    whyNow:
      "Explain the specific reader application during editing. Source age alone does not establish relevance or a current event.",
    sources,
    sourceIds: sources.map((source) => source.id),
    claimsAllowed: sources.filter((source) => source.text.trim()).map((source) => source.id),
    voiceProfile: {
      instructions: confirmed
        .filter((item) => item.kind === "instruction" || item.kind === "profile")
        .slice(0, 8)
        .map((item) => evidenceExcerpt(String(item.content || ""), 1500)),
      examples: [...(input.representativePosts || [])]
        .sort((a, b) => Number(b.platform === platform) - Number(a.platform === platform))
        .slice(0, 6)
        .map((post) => evidenceExcerpt(post.body, 1200)),
    },
    strategy: confirmed
      .filter((item) => item.kind === "strategy")
      .slice(0, 4)
      .map((item) => evidenceExcerpt(String(item.content || ""), 1500)),
    feedback: (input.feedback || []).slice(0, 8),
    recentOutputs,
    ...(input.revisionTarget ? { revisionTarget: input.revisionTarget } : {}),
  };
}
export function validateEditorialDraft(
  brief: EditorialBrief,
  draft: {
    platform: string;
    format: string;
    title?: string;
    angle?: string;
    whyNow?: string;
    body: string;
    sourceUrls?: string[];
    sourceIds?: string[];
    slides?: z.infer<typeof carouselSlideSchema>[];
    claims?: EditorialDraft["claims"];
  },
  recentOutputs: EditorialOutput[],
): EditorialIssue[] {
  const issues: EditorialIssue[] = [];
  const add = (code: string, message: string) => {
    if (!issues.some((issue) => issue.code === code)) issues.push({ code, message });
  };
  if (
    !isAutomaticEditorialFormat(draft.platform, draft.format) ||
    draft.platform !== brief.platform
  )
    add("format", "Use the selected platform's supported format.");
  if (draft.angle === brief.angle || draft.whyNow === brief.whyNow)
    add(
      "reader_value",
      "State the draft's actual new contribution and specific relevance to readers.",
    );
  const usedIds = new Set([
    ...(draft.sourceIds || []),
    ...(draft.claims || []).map((claim) => claim.sourceId),
  ]);
  const definition = SOCIAL_PROVIDER_DEFINITIONS[brief.platform];
  if (draft.body.length > definition.maxText)
    add("provider_limit", `Keep the post within ${definition.maxText} characters.`);
  if (
    brief.platform === "instagram" &&
    (!draft.slides || draft.slides.length < 2 || draft.slides.length > definition.maxMedia)
  )
    add(
      "carousel",
      "Supply a complete static carousel with two or more slides within the provider limit.",
    );
  if (draft.platform === "instagram")
    for (const issue of carouselCopyIssues(draft.slides || [])) add("carousel_copy", issue);
  const text = [
    draft.body,
    ...(draft.slides || []).map((slide) => `${slide.heading} ${slide.body}`),
  ].join("\n");
  if (/[\u2014]/u.test(`${draft.title || ""}\n${text}`))
    add(
      "voice_drift",
      "Do not use em dashes in a post, title or carousel slide. Rewrite the sentence in the creator's voice.",
    );
  const hook = normalized(text.split(/[\n.!?]/)[0]);
  const priorWriting = [
    ...recentOutputs.filter((output) => !revisionOutputIds(brief.revisionTarget).has(output.id)),
    ...brief.sources.map((source) => ({ id: source.id, body: source.text })),
    ...brief.voiceProfile.examples.map((body, index) => ({ id: `voice:${index}`, body })),
  ];
  for (const old of priorWriting) {
    const oldHook = normalized(old.body.split(/[\n.!?]/)[0]);
    const tokens = normalized(text).split(" ");
    const oldText = normalized(old.body);
    if (
      tokens.length >= 16 &&
      tokens.some(
        (_, index) =>
          index + 16 <= tokens.length &&
          oldText.includes(tokens.slice(index, index + 16).join(" ")),
      )
    )
      add(
        "copied_passage",
        "Write the explanation in a fresh way instead of reusing a long passage.",
      );
    if (hook.length >= 18 && hook === oldHook)
      add("copied_hook", "Write a new opening instead of copying a recent hook.");
    const words = new Set(
      normalized(text)
        .split(" ")
        .filter((word) => word.length > 3),
    );
    const prior = new Set(
      normalized(old.body)
        .split(" ")
        .filter((word) => word.length > 3),
    );
    if (
      words.size >= 6 &&
      [...words].filter((word) => prior.has(word)).length / Math.max(words.size, prior.size) > 0.75
    )
      add("overlap", "Develop a different argument from recent drafts.");
  }
  if (/\b(episode|part)\s*#?\d+|\b(?:next|new) (?:episode|installment)\b/i.test(text))
    add("stale_context", "Turn the historical series into a standalone lesson.");
  if (
    /\b(today|tomorrow|this week|next week|just launched|launching now)\b/i.test(text) &&
    /launch|event|join|release|webinar|conference/i.test(text) &&
    !brief.sources.some(
      (source) =>
        usedIds.has(source.id) &&
        source.freshness === "recent" &&
        (source.ageDays || 0) <= 2 &&
        /today|tomorrow|this week|next week/i.test(source.text),
    )
  )
    add("stale_context", "Do not turn an old or undated event into a current announcement.");
  const verified = (draft.claims || []).filter((claim) => {
    const source = brief.sources.find((item) => item.id === claim.sourceId);
    const valid = Boolean(source && source.text.includes(claim.quote) && text.includes(claim.text));
    if (!valid) add("unsupported_claim", "Ground each factual claim in an exact source excerpt.");
    return valid;
  });
  // Opinions are welcome; personal experiences and numerical claims need evidence.
  for (const sentence of text.split(/(?<=[.!?])\s+|\n/)) {
    if (
      /\b\d+(?:[.,]\d+)?\s*(?:%|customers|users|sales|million|revenue|followers)\b|\d+%|[$€£]\d|\b(?:I|we) (?:grew|earned|made|launched|built|sold|raised|interviewed|lost|hired|founded)\b/i.test(
        sentence,
      ) &&
      !verified.some((claim) => sentence.includes(claim.text))
    )
      add(
        "unsupported_claim",
        "Add a source for the claimed experience or result, or frame it as a question.",
      );
  }
  const urls = draft.sourceUrls || [];
  if ([...usedIds].some((id) => !brief.sources.some((source) => source.id === id)))
    add("missing_source", "Use only supplied evidence IDs.");
  if (
    brief.sources.some(
      (source) =>
        usedIds.has(source.id) && source.external && (!source.url || !urls.includes(source.url)),
    )
  )
    add("missing_source", "Include the original external source link.");
  if (urls.some((url) => !brief.sources.some((source) => source.url === url)))
    add("missing_source", "Use only supplied source links.");
  if (
    /\b(?:agree|thoughts)\s*\?\s*$/i.test(text) ||
    /\b(game[- ]changer|unlock your potential|in today's (?:fast-paced|digital)|delve|agree\?|comment (?:yes|below)|like and share|repost if|let that sink in)\b/i.test(
      text,
    )
  )
    add("formulaic", "Replace stock phrasing and engagement bait with a specific useful point.");
  return issues;
}
