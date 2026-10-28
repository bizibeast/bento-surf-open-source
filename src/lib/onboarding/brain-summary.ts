import type { OnboardingCandidates } from "./brief";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What onboarding actually created: chapters written from the creator's evidence, and starter
 * notes built only from their answers. Older sessions without a count are treated as personal
 * only when personalization finished.
 */
export function brainChapterCounts(candidates: OnboardingCandidates | null | undefined) {
  const total = candidates?.brain.length ?? 0;
  const personalization = candidates?.personalization;
  const personal =
    personalization?.status === "ready"
      ? Math.min(total, personalization.personalChapters ?? total)
      : 0;
  return { personal, starter: total - personal, total };
}

export function brainChapterSummary(candidates: OnboardingCandidates | null | undefined) {
  const { personal, starter } = brainChapterCounts(candidates);
  const parts = [
    personal ? count(personal, "personal Brain chapter", "personal Brain chapters") : "",
    starter
      ? count(starter, "starter note from your answers", "starter notes from your answers")
      : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" and ") : "Your Brain is being prepared";
}
