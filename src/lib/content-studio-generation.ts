import { z } from "zod";
import { CAROUSEL_BODY_LIMIT, CAROUSEL_HEADING_LIMIT } from "./content-carousel";
import { newReelScene, studioDocumentSchema, type StudioDocument } from "./content-studio";

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

  const updated =
    draft.format === "carousel" && document.format === "carousel"
      ? { ...document, slides: draft.slides }
      : draft.format === "reel" && document.format === "reel"
        ? {
            ...document,
            scenes: draft.scenes.map((scene) =>
              newReelScene({
                title: scene.title,
                caption: scene.caption,
                duration: scene.duration,
                avatarScript: scene.speakerScript,
                kind: scene.avatarVisible ? "avatar" : "card",
              }),
            ),
          }
        : document;
  const parsed = studioDocumentSchema.safeParse(updated);
  if (!parsed.success)
    throw new Error("The draft did not fit the selected template or Reel duration.");
  return { title: draft.title, document: parsed.data };
}
