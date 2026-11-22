import { z } from "zod";
import type { ReelScene, StudioDocument, StudioReel } from "./content-studio";

export const reelDirectionSchema = z
  .object({
    layout: z.enum(["statement", "stack", "split", "full-bleed"]),
    motion: z.enum(["rise", "slide", "punch"]),
  })
  .strict();
export const creationBriefSchema = z
  .object({
    brief: z.string().trim().min(1).max(3000),
    analysisId: z.uuid().optional(),
  })
  .strict();

/** Shared by the model's editable plan, export compiler and review UI. */
export function reelSceneDirection(
  document: StudioReel,
  scene: ReelScene,
  index: number,
): z.infer<typeof reelDirectionSchema> {
  if (scene.kind === "avatar")
    return { layout: "full-bleed", motion: scene.direction?.motion ?? "rise" } as const;
  if (scene.direction) return scene.direction;
  const layout =
    scene.kind === "media"
      ? document.style === "split-screen" || document.style === "interview"
        ? "split"
        : "full-bleed"
      : document.style === "tutorial" || (document.style === "kinetic" && index % 2 === 1)
        ? "stack"
        : "statement";
  const motion =
    document.style === "kinetic" ? "punch" : document.style === "slideshow" ? "slide" : "rise";
  return { layout, motion };
}

export function reviewContentCreation(document: StudioDocument) {
  const findings: { code: string; message: string; sceneId?: string; slideIndex?: number }[] = [];
  const wordCount = (text: string) => (text.trim() ? text.trim().split(/\s+/u).length : 0);
  if (document.format === "carousel") {
    const headings = new Set<string>();
    for (const [slideIndex, slide] of document.slides.entries()) {
      const heading = slide.heading.trim().toLocaleLowerCase();
      if (!heading)
        findings.push({
          code: "missing_heading",
          slideIndex,
          message: `Slide ${slideIndex + 1} needs a clear headline.`,
        });
      else if (headings.has(heading))
        findings.push({
          code: "repeated_slide",
          slideIndex,
          message: `Slide ${slideIndex + 1} repeats an earlier headline. Check it adds a distinct idea.`,
        });
      headings.add(heading);
      if (wordCount(`${slide.heading} ${slide.body}`) > 65)
        findings.push({
          code: "dense_slide",
          slideIndex,
          message: `Shorten slide ${slideIndex + 1} or split it into separate ideas.`,
        });
    }
    return { format: document.format, findings, scenes: [] };
  }
  let at = 0;
  const scenes = document.scenes.map((scene, index) => {
    const start = at;
    at += scene.duration;
    const direction = reelSceneDirection(document, scene, index);
    const words = wordCount(`${scene.title} ${scene.caption}`);
    if (scene.kind === "card" && words === 0)
      findings.push({
        code: "empty_visual",
        sceneId: scene.id,
        message: "This scene has no visible content. Add a meaningful visual before rendering.",
      });
    if (wordCount(scene.avatarScript) / scene.duration > 3.5)
      findings.push({
        code: "rushed_narration",
        sceneId: scene.id,
        message:
          "The planned narration may sound rushed. Shorten it or allow more time; confirm against the actual recording.",
      });
    if (words / scene.duration > 5)
      findings.push({
        code: "dense_copy",
        sceneId: scene.id,
        message: "Shorten the on-screen copy or allow more reading time.",
      });
    if (scene.duration > 7 && scene.kind === "card")
      findings.push({
        code: "long_card",
        sceneId: scene.id,
        message: "Consider another visual beat during this long text scene.",
      });
    if (scene.kind !== "card" && !scene.mediaId && !scene.avatarJobId)
      findings.push({
        code: "pending_media",
        sceneId: scene.id,
        message: "This scene still needs its approved footage.",
      });
    return { id: scene.id, start, end: at, title: scene.title, kind: scene.kind, ...direction };
  });
  if (scenes.length > 3 && new Set(scenes.map((s) => s.layout)).size === 1)
    findings.push({
      code: "repeated_layout",
      message: "Vary the visual hierarchy across scenes while keeping the selected theme.",
    });
  if (
    !document.subtitles?.length &&
    (document.audio?.narrationMediaId || document.scenes.some((scene) => scene.narrationJobId))
  )
    findings.push({
      code: "missing_captions",
      message:
        "Recorded narration has no timed captions. Align captions to the actual speech before final review.",
    });
  return { format: document.format, findings, scenes };
}
