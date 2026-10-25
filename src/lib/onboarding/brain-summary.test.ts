import { describe, expect, it } from "vitest";
import { buildManualCandidates, onboardingBriefSchema } from "./brief";
import { brainChapterSummary } from "./brain-summary";

const base = buildManualCandidates(
  onboardingBriefSchema.parse({
    displayName: "Ari",
    expertise: "Light",
    audience: "New photographers",
  }),
);
const personalization = (status: "ready" | "unavailable", personalChapters?: number) => ({
  generation: 1,
  status,
  profileCount: 0,
  postCount: 0,
  note: "n",
  ...(personalChapters === undefined ? {} : { personalChapters }),
});

describe("Brain chapter summary", () => {
  it("names personal chapters and starter notes with real counts", () => {
    expect(brainChapterSummary({ ...base, personalization: personalization("ready", 3) })).toBe(
      "3 personal Brain chapters",
    );
    expect(brainChapterSummary({ ...base, personalization: personalization("ready", 2) })).toBe(
      "2 personal Brain chapters and 1 starter note from your answers",
    );
    expect(brainChapterSummary({ ...base, personalization: personalization("unavailable") })).toBe(
      "3 starter notes from your answers",
    );
    expect(brainChapterSummary(base)).toBe("3 starter notes from your answers");
    expect(brainChapterSummary(null)).toBe("Your Brain is being prepared");
    expect(brainChapterSummary(base)).not.toMatch(/[\u2013\u2014]/);
  });
});
