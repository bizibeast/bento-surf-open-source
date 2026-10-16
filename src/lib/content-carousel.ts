import { z } from "zod";
import type { carouselSlideSchema } from "./content-editorial";
import { agentBrandingSchema } from "./content-agent-branding";
export type CarouselSlide = z.infer<typeof carouselSlideSchema>;
export const CAROUSEL_HEADING_LIMIT = 90;
export const CAROUSEL_BODY_LIMIT = 360;
export const agentDraftStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  exportRevision: z.number().int().nonnegative().optional(),
  mediaIds: z.array(z.string().uuid()).max(10).optional(),
  socialPostId: z.string().uuid().optional(),
  postUpdatedAt: z.string().optional(),
  branding: agentBrandingSchema.optional(),
  photoRequired: z.boolean().optional(),
  preparation: z.enum(["ready", "photo_needed", "visuals_needed"]).optional(),
  preparationNote: z.string().max(500).optional(),
});
export type AgentDraftState = z.infer<typeof agentDraftStateSchema>;
export type AgentDraftEdit = { body: string; slides?: CarouselSlide[]; revision: number };
export function carouselCopyIssues(slides: CarouselSlide[]) {
  const issues: string[] = [];
  if (slides.length < 2 || slides.length > 10)
    issues.push("Use 2–10 ordered slides, including a cover and final takeaway.");
  const promised = `${slides[0]?.heading || ""} ${slides[0]?.body || ""}`.match(
    /\b(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\s+(?:ways|steps|tips|lessons|ideas|mistakes|reasons|principles|examples|questions)\b/i,
  );
  if (promised) {
    const names = [
      "zero",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
      "ten",
    ];
    const count = /^\d+$/.test(promised[1])
      ? Number(promised[1])
      : names.indexOf(promised[1].toLowerCase());
    if (count !== slides.length - 2)
      issues.push(
        `The cover promises ${count} points but there are ${Math.max(0, slides.length - 2)} body slides. Match the promise to the delivered points; keep the final takeaway separate.`,
      );
  }
  slides.forEach((slide, index) => {
    if (
      !slide.heading.trim() ||
      !slide.body.trim() ||
      slide.heading.length > CAROUSEL_HEADING_LIMIT ||
      slide.body.length > CAROUSEL_BODY_LIMIT
    )
      issues.push(
        `Shorten slide ${index + 1}: use a heading up to ${CAROUSEL_HEADING_LIMIT} characters and body up to ${CAROUSEL_BODY_LIMIT} characters.`,
      );
  });
  return issues;
}
export function carouselReady(slides: CarouselSlide[], state?: AgentDraftState) {
  return (
    carouselCopyIssues(slides).length === 0 &&
    state?.exportRevision === state?.revision &&
    state?.mediaIds?.length === slides.length &&
    new Set(state?.mediaIds).size === slides.length
  );
}
