import { z } from "zod";
import { agentBrandingSchema } from "./content-agent-branding";
import { CAROUSEL_BODY_LIMIT, CAROUSEL_HEADING_LIMIT } from "./content-carousel";

export const STUDIO_CAROUSEL_LAYOUTS = [
  "editorial",
  "checklist",
  "split",
  "story",
  "metric",
  "quote",
  "steps",
  "catalog",
  "poster",
] as const;

export const STUDIO_REEL_STYLES = [
  "jump-cut",
  "montage",
  "split-screen",
  "captions",
  "slideshow",
  "tutorial",
  "kinetic",
  "interview",
  "product",
] as const;

const mediaId = z.string().uuid();
export const reelSceneSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().max(64),
    caption: z.string().max(160),
    duration: z.number().int().min(1).max(20),
    kind: z.enum(["card", "media", "avatar"]),
    mediaId: mediaId.nullable(),
    sourceStart: z.number().min(0).max(600),
    mute: z.boolean(),
    avatarScript: z.string().max(450),
    avatarJobId: z.string().uuid().nullable(),
  })
  .strict();

const sourceUrl = z
  .string()
  .url()
  .max(2000)
  .refine((url) => /^https?:\/\//i.test(url))
  .optional();

export const studioCarouselSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceUrl,
    format: z.literal("carousel"),
    layout: z.enum(STUDIO_CAROUSEL_LAYOUTS),
    brand: agentBrandingSchema,
    slides: z
      .array(
        z
          .object({
            heading: z.string().max(CAROUSEL_HEADING_LIMIT),
            body: z.string().max(CAROUSEL_BODY_LIMIT),
            mediaId: mediaId.optional(),
          })
          .strict(),
      )
      .min(2)
      .max(10),
  })
  .strict();

export const studioReelSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceUrl,
    format: z.literal("reel"),
    style: z.enum(STUDIO_REEL_STYLES),
    brand: agentBrandingSchema,
    avatarId: z.string().trim().max(200),
    voiceId: z.string().trim().max(200),
    scenes: z.array(reelSceneSchema).min(1).max(20),
  })
  .strict()
  .superRefine(({ scenes }, context) => {
    if (new Set(scenes.map(({ id }) => id)).size !== scenes.length) {
      context.addIssue({
        code: "custom",
        path: ["scenes"],
        message: "Each scene needs its own ID.",
      });
    }
    if (scenes.reduce((total, scene) => total + scene.duration, 0) > 90) {
      context.addIssue({
        code: "custom",
        path: ["scenes"],
        message: "A Reel can be up to 90 seconds.",
      });
    }
  });

export const studioDocumentSchema = z.discriminatedUnion("format", [
  studioCarouselSchema,
  studioReelSchema,
]);
export const studioEntrySchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["project", "preset"]),
  title: z.string().trim().min(1).max(120),
  revision: z.number().int().nonnegative(),
  document: studioDocumentSchema,
});
export const studioSaveInputSchema = studioEntrySchema.extend({ workspaceId: z.string().uuid() });
export const studioSchedulerDraftSchema = z.object({
  workspaceId: z.string().uuid(),
  requestId: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
  mediaIds: z
    .array(z.string().uuid())
    .min(1)
    .max(10)
    .refine((ids) => new Set(ids).size === ids.length, "Choose each export file once."),
});

export type StudioDocument = z.infer<typeof studioDocumentSchema>;
export type StudioEntry = z.infer<typeof studioEntrySchema>;
export type StudioCarousel = z.infer<typeof studioCarouselSchema>;
export type StudioReel = z.infer<typeof studioReelSchema>;
export type ReelScene = z.infer<typeof reelSceneSchema>;
export type StudioMedia = { id: string; name: string; kind: "image" | "video"; url: string };

export function studioCarouselPhotoId(document: StudioCarousel, index: number) {
  return (
    document.slides[index]?.mediaId ||
    (index === 0 && document.brand.coverStyle === "portrait" ? document.brand.heroPhotoId : null)
  );
}

export function studioMediaReferences(document: StudioDocument) {
  return document.format === "carousel"
    ? document.slides.map((_, index) => studioCarouselPhotoId(document, index))
    : document.scenes
        .filter((scene) => scene.kind === "media" || scene.kind === "avatar")
        .map((scene) => scene.mediaId);
}

export function reelTimeline(document: StudioReel) {
  let start = 0;
  return document.scenes.map((scene) => {
    const end = start + scene.duration;
    const entry = { scene, start, end };
    start = end;
    return entry;
  });
}

export function newReelScene(patch: Partial<ReelScene> = {}): ReelScene {
  return {
    id: crypto.randomUUID(),
    title: "",
    caption: "",
    duration: 4,
    kind: "card",
    mediaId: null,
    sourceStart: 0,
    mute: false,
    avatarScript: "",
    avatarJobId: null,
    ...patch,
  };
}

export const CAROUSEL_STARTERS = {
  editorial: {
    name: "Field guide",
    description: "An editorial guide with a bold cover and practical close.",
    slides: [
      ["A field guide to [topic]", "What to look for when you are starting out."],
      ["Know what matters", "Explain the signal your reader should pay the most attention to."],
      ["Try it in the real world", "Give your reader a small exercise to do today."],
    ],
  },
  checklist: {
    name: "Checklist",
    description: "An ordered checklist with a repeatable review step.",
    slides: [
      ["Before you publish", "Open this checklist when your draft is ready for review."],
      ["Check the opening", "State what readers get in the first line."],
      ["Check the evidence", "Look up the source and date behind the strongest claim."],
      ["Run the final check", "Read the draft out loud and revise what slows you down."],
    ],
  },
  split: {
    name: "Before and after",
    description: "A side-by-side treatment for a concrete transformation.",
    slides: [
      ["What changed?", "Set the scene and tell readers what improvement to look for."],
      ["Before", "Name the original constraint and give a concrete example."],
      ["After", "Show the change and point to its effect."],
      ["What you can copy", "Share the smallest step your reader can repeat."],
    ],
  },
  story: {
    name: "Mini case study",
    description: "A chaptered narrative with a problem, turn, and result.",
    slides: [
      [
        "The project that taught us [lesson]",
        "Set up the decision that makes this story interesting.",
      ],
      ["The starting point", "Describe the stakes and what you knew at the time."],
      ["The turning point", "Explain what you changed and why."],
      ["The result", "Show the evidence, then share what you would do again."],
    ],
  },
  metric: {
    name: "Data snapshot",
    description: "Large figures and compact context for an evidence-led post.",
    slides: [
      ["[Number] worth understanding", "Include the timeframe and the source of the figure."],
      ["The baseline", "Compare it against a useful prior period or benchmark."],
      ["The takeaway", "Explain what a reader can decide with this information."],
    ],
  },
  quote: {
    name: "Quote and commentary",
    description: "An oversized pull quote with room for attribution and context.",
    slides: [
      ["[Insert the exact quote]", "Attribute the quote to its speaker and source."],
      ["Why it lands", "Put the quote in context and explain what it reveals."],
      ["What to do with it", "Give one way to apply the idea this week."],
    ],
  },
  steps: {
    name: "Process walkthrough",
    description: "Numbered steps that move from setup to repeatable result.",
    slides: [
      ["How to [solve a problem]", "Set expectations for what readers will learn."],
      ["Set up the inputs", "Show what to gather before starting."],
      ["Run the workflow", "Describe the critical action and what to look for."],
      ["Review and repeat", "Explain how to tell it worked and what to change next time."],
    ],
  },
  catalog: {
    name: "Resource collection",
    description: "An image-forward collection with a card for each recommendation.",
    slides: [
      ["My [topic] starter kit", "Give readers a reason to save this collection."],
      ["The everyday resource", "Name a tool and describe the job it does well."],
      ["The deeper resource", "Share where to go when the basics stop being enough."],
      ["Where to begin", "Suggest one choice for readers short on time."],
    ],
  },
  poster: {
    name: "Announcement",
    description: "Full-bleed covers and centered type for an event or launch.",
    slides: [
      ["Introducing [name]", "Say what is launching and who it is for."],
      ["What to expect", "Show the main benefit, event format, or new feature."],
      ["Join us", "Add the date, time, and the next action."],
    ],
  },
} satisfies Record<
  StudioCarousel["layout"],
  { name: string; description: string; slides: string[][] }
>;

type ReelStarter = { name: string; description: string; scenes: Array<Partial<ReelScene>> };

export const REEL_STARTERS: Record<StudioReel["style"], ReelStarter> = {
  "jump-cut": {
    name: "Jump cut",
    description: "Fast full-frame cuts with a punch-in and lower-third copy.",
    scenes: [
      { title: "Open on the hook", duration: 2 },
      { title: "Give the payoff", duration: 5 },
      { title: "Close with the takeaway", duration: 3 },
    ],
  },
  montage: {
    name: "B-roll montage",
    description: "Full-frame B-roll with slow zooms and dip transitions.",
    scenes: [
      { title: "Establish the scene", duration: 3 },
      { title: "Show the details", duration: 4 },
      { title: "End on the result", duration: 3 },
    ],
  },
  "split-screen": {
    name: "Split-screen comparison",
    description: "Media above and a separate comparison panel below.",
    scenes: [
      { title: "The starting point", caption: "Before", duration: 4 },
      { title: "The change", caption: "After", duration: 5 },
    ],
  },
  captions: {
    name: "Caption-led",
    description: "Large timed phrases over a dimmed moving or still background.",
    scenes: [
      { title: "Start with one strong line", duration: 3 },
      {
        title: "Make the point easy to read",
        caption: "Use a line break for each caption cue.",
        duration: 6,
      },
    ],
  },
  slideshow: {
    name: "Photo slideshow",
    description: "Image cards slide onto a paper background with captions underneath.",
    scenes: [
      { title: "First frame", duration: 3 },
      { title: "Second frame", duration: 3 },
      { title: "Final frame", duration: 3 },
    ],
  },
  tutorial: {
    name: "Tutorial",
    description: "Numbered instruction panels, a demo window, and a progress bar.",
    scenes: [
      { title: "Prepare the inputs", caption: "Show what needs to be ready.", duration: 5 },
      { title: "Demonstrate the task", duration: 7 },
      { title: "Check the result", duration: 5 },
    ],
  },
  kinetic: {
    name: "Kinetic type",
    description: "Text-led scenes with large animated words and alternating brand panels.",
    scenes: [
      { title: "One idea", caption: "Make it stick.", duration: 2 },
      { title: "Say it clearly", caption: "Use short phrases.", duration: 3 },
      { title: "End simply", duration: 2 },
    ],
  },
  interview: {
    name: "Interview",
    description: "Portrait framing with a question card and a speaker lower third.",
    scenes: [
      { title: "Ask the question", caption: "What changed your mind?", duration: 3 },
      { title: "Name the speaker", caption: "Use the strongest answer.", duration: 8 },
    ],
  },
  product: {
    name: "Product spotlight",
    description: "A product on a colored stage with a feature card and a closing action.",
    scenes: [
      { title: "Introduce the product", duration: 4 },
      { title: "Show it in use", duration: 5 },
      { title: "Add your call to action", duration: 4 },
    ],
  },
};

export function studioStarter(
  format: "carousel" | "reel",
  key: string,
  brand: StudioDocument["brand"],
): StudioEntry {
  const base = { id: crypto.randomUUID(), kind: "project" as const, revision: 0 };
  if (format === "carousel") {
    const layout = z.enum(STUDIO_CAROUSEL_LAYOUTS).parse(key);
    const starter = CAROUSEL_STARTERS[layout];
    return {
      ...base,
      title: starter.name,
      document: {
        schemaVersion: 1,
        format,
        layout,
        brand,
        slides: starter.slides.map(([heading, body]) => ({ heading, body })),
      },
    };
  }
  const style = z.enum(STUDIO_REEL_STYLES).parse(key);
  const starter = REEL_STARTERS[style];
  return {
    ...base,
    title: starter.name,
    document: {
      schemaVersion: 1,
      format,
      style,
      brand,
      avatarId: "",
      voiceId: "",
      scenes: starter.scenes.map((scene) => newReelScene(scene)),
    },
  };
}

export function moveStudioItem<T>(items: T[], index: number, delta: number) {
  const next = [...items];
  const target = index + delta;
  if (target >= 0 && target < items.length) {
    [next[index], next[target]] = [next[target], next[index]];
  }
  return next;
}
