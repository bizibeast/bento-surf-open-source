import { z } from "zod";
import { CAROUSEL_BODY_LIMIT, CAROUSEL_HEADING_LIMIT } from "./content-carousel";
import { newReelScene, studioDocumentSchema, type StudioDocument } from "./content-studio";
import { reelDirectionSchema } from "./content-creation-harness";

const title = z.string().trim().min(1).max(120);
export const generatedStudioDraftSchema = z.discriminatedUnion("format", [
  z
    .object({
      format: z.literal("carousel"),
      title,
      slides: z
        .array(
          z
            .object({
              heading: z.string().trim().min(1).max(CAROUSEL_HEADING_LIMIT),
              body: z.string().trim().max(CAROUSEL_BODY_LIMIT),
              sourceSlideIndex: z.number().int().min(0).max(9).optional(),
            })
            .strict(),
        )
        .min(2)
        .max(10),
    })
    .strict(),
  z
    .object({
      format: z.literal("reel"),
      title,
      scenes: z
        .array(
          z
            .object({
              title: z.string().trim().min(1).max(64),
              caption: z.string().trim().max(160),
              duration: z.number().int().min(1).max(20),
              speakerScript: z.string().trim().max(450),
              avatarVisible: z.boolean(),
              direction: reelDirectionSchema.optional(),
              sourceSceneId: z.uuid().optional(),
            })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict(),
]);

export function applyGeneratedStudioDraft(document: StudioDocument, response: unknown) {
  const draft = generatedStudioDraftSchema.parse(response);
  if (draft.format !== document.format) {
    throw new Error("The selected model returned the wrong content format.");
  }

  const usedSceneIds = new Set<string>();
  const nextScenes =
    draft.format === "reel" && document.format === "reel"
      ? draft.scenes.map((scene) => {
          const kind = scene.avatarVisible ? "avatar" : "card";
          const identified = scene.sourceSceneId
            ? document.scenes.find((prior) => prior.id === scene.sourceSceneId)
            : undefined;
          if (scene.sourceSceneId && (!identified || usedSceneIds.has(scene.sourceSceneId)))
            throw new Error("The revision must reference each existing scene at most once.");
          const prior =
            identified ??
            document.scenes.find(
              (prior) =>
                !usedSceneIds.has(prior.id) &&
                prior.avatarScript.trim() === scene.speakerScript.trim() &&
                (prior.kind === "avatar") === scene.avatarVisible,
            );
          if (prior) usedSceneIds.add(prior.id);
          const sameSpeech = prior?.avatarScript.trim() === scene.speakerScript.trim();
          const samePresenter = (prior?.kind === "avatar") === scene.avatarVisible;
          // Keep independently reusable narration when an edit hides the presenter.
          // A speech change invalidates lip-sync footage and the old speech together.
          const reusable = prior && sameSpeech && samePresenter;
          return newReelScene({
            ...(reusable ? prior : {}),
            title: scene.title,
            caption: scene.caption,
            duration: scene.duration,
            avatarScript: scene.speakerScript,
            direction: scene.direction ?? prior?.direction,
            kind: reusable ? prior.kind : kind,
            ...(sameSpeech && prior?.narrationJobId
              ? { narrationJobId: prior.narrationJobId }
              : {}),
          });
        })
      : undefined;
  const sameSpeechTimeline =
    nextScenes &&
    document.format === "reel" &&
    nextScenes.length === document.scenes.length &&
    nextScenes.every(
      (scene, index) =>
        (scene.id === document.scenes[index].id ||
          (Boolean(scene.narrationJobId) &&
            scene.narrationJobId === document.scenes[index].narrationJobId)) &&
        scene.duration === document.scenes[index].duration,
    );
  const usedSlideIndices = new Set<number>();
  const nextSlides =
    draft.format === "carousel" && document.format === "carousel"
      ? draft.slides.map(({ sourceSlideIndex, heading, body }) => {
          const index =
            sourceSlideIndex ??
            document.slides.findIndex(
              (slide, index) =>
                !usedSlideIndices.has(index) &&
                slide.heading.trim() === heading &&
                slide.body.trim() === body,
            );
          if (
            sourceSlideIndex !== undefined &&
            (!document.slides[index] || usedSlideIndices.has(index))
          )
            throw new Error("The revision must reference each existing slide at most once.");
          if (index >= 0) usedSlideIndices.add(index);
          const mediaId = document.slides[index]?.mediaId;
          return { heading, body, ...(mediaId ? { mediaId } : {}) };
        })
      : undefined;
  const sameGlobalNarration =
    nextScenes &&
    document.format === "reel" &&
    nextScenes.length === document.scenes.length &&
    nextScenes.every(
      (scene, index) =>
        scene.avatarScript.trim() === document.scenes[index].avatarScript.trim() &&
        scene.duration === document.scenes[index].duration,
    );
  const updated =
    draft.format === "carousel" && document.format === "carousel"
      ? { ...document, slides: nextSlides! }
      : draft.format === "reel" && document.format === "reel"
        ? {
            ...document,
            scenes: nextScenes!,
            subtitles:
              sameSpeechTimeline || (document.audio?.narrationMediaId && sameGlobalNarration)
                ? document.subtitles
                : undefined,
            audio: sameGlobalNarration
              ? document.audio
              : document.audio
                ? { ...document.audio, narrationMediaId: null }
                : undefined,
          }
        : document;
  const parsed = studioDocumentSchema.safeParse(updated);
  if (!parsed.success)
    throw new Error("The draft did not fit the selected template or Reel duration.");
  return { title: draft.title, document: parsed.data };
}

/** Model-visible revision context includes timing and identity, never media URLs or provider IDs. */
export function studioDraftContext(document: StudioDocument) {
  return document.format === "carousel"
    ? document.slides.map(({ heading, body }, sourceSlideIndex) => ({
        sourceSlideIndex,
        heading,
        body,
      }))
    : document.scenes.map((scene) => ({
        sourceSceneId: scene.id,
        title: scene.title,
        caption: scene.caption,
        speakerScript: scene.avatarScript,
        duration: scene.duration,
        avatarVisible: scene.kind === "avatar",
        direction: scene.direction,
      }));
}
