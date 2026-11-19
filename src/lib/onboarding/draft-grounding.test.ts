import { describe, expect, it, vi } from "vitest";
import type { BrainSource } from "./brain-evidence";
import {
  applySentenceEdits,
  draftSentences,
  flaggedSentences,
  reframeAudienceAsExisting,
  unsupportedRiskyPhrases,
} from "./draft-grounding";
import { groundOnboardingDraft, type DraftChecker } from "./draft-grounding.server";

const answers = (expertise: string, audience: string, extra = ""): BrainSource[] => [
  {
    id: "answers",
    label: "Your onboarding answers",
    type: "answers",
    url: null,
    text: `Name: Lena\nExpertise: ${expertise}\nAudience: ${audience}${extra}`,
  },
];
const watercolor = answers(
  "I make watercolor botanical illustrations and teach beginner classes.",
  "Adults picking up painting as a calm hobby.",
);
const evidenceText = (sources: BrainSource[]) => sources.map((s) => s.text).join("\n");

// Verbatim lines from production and staging first drafts.
const INVENTED = [
  "This is also where I would start anyone in a first lesson, and it is the exercise I recommend when people ask how to begin on their own.",
  "Most beginners who get discouraged early made the same first mistake: they started with a full painting.",
  "Most beginners I teach start with too much water.",
  "In my experience, a single leaf teaches more than a full bouquet.",
  "The mistake I see most often is reaching for a big brush too early.",
  "My students are adults who want a calm hobby.",
];
const ALLOWED = [
  "Commit to one leaf.",
  "Fifteen minutes, one small piece of paper, one leaf from your kitchen or garden.",
  "A leaf is forgiving.",
  "Mix a green that is close enough, paint the outline loosely, and let it do its own thing.",
  "If it turns out wobbly, paint another one next week.",
  "I make watercolor botanical illustrations and teach beginner classes.",
];

describe("deterministic draft grounding", () => {
  it.each(INVENTED)("flags an unsupported claim: %s", (sentence) => {
    expect(unsupportedRiskyPhrases(sentence, evidenceText(watercolor)).length).toBeGreaterThan(0);
  });
  it.each(ALLOWED)("leaves advice and supported facts alone: %s", (sentence) => {
    expect(unsupportedRiskyPhrases(sentence, evidenceText(watercolor))).toEqual([]);
  });
  it("accepts a phrase the creator used themselves", () => {
    const own = answers("Pottery", "New potters", "\nWriting sample: In my experience, clay wins.");
    expect(
      unsupportedRiskyPhrases("In my experience, centering takes patience.", evidenceText(own)),
    ).toEqual([]);
  });
  it("rewrites and drops sentences by id while keeping paragraphs", () => {
    const draft = {
      title: "Start with one leaf",
      body: "Most beginners I teach start big. Commit to one leaf.\n\nA leaf is forgiving. In my experience it works.",
    };
    const sentences = draftSentences(draft);
    expect(sentences.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    const edited = applySentenceEdits(
      draft,
      new Map([
        ["s2", "Many people start with a full painting \u2014 try smaller."],
        ["s5", ""],
      ]),
    );
    expect(edited.body).toBe(
      "Many people start with a full painting - try smaller. Commit to one leaf.\n\nA leaf is forgiving.",
    );
    expect(edited.body).not.toContain("\u2014");
  });
  it("drops a carousel slide whose body is removed", () => {
    const draft = {
      title: "One leaf",
      body: "Caption.",
      slides: [
        { heading: "Start", body: "Commit to one leaf." },
        { heading: "Why", body: "My students love it." },
        { heading: "Next", body: "Paint another next week." },
      ],
    };
    const flagged = flaggedSentences(draft, watercolor);
    expect(flagged.map((s) => s.field)).toEqual(["slide-1-body"]);
    const edited = applySentenceEdits(draft, new Map(flagged.map((s) => [s.id, ""])));
    expect(edited.slides?.map((s) => s.heading)).toEqual(["Start", "Next"]);
  });
  it("reframes the audience answer instead of calling them students", () => {
    expect(
      reframeAudienceAsExisting(
        "My students are adults picking up painting as a calm hobby. I write for my students.",
        evidenceText(watercolor),
      ),
    ).toBe(
      "The people I want to reach are adults picking up painting as a calm hobby. I write for the people I want to reach.",
    );
    const said = answers("Yoga", "Office workers", "\nBio: My students are office workers.");
    expect(reframeAudienceAsExisting("My students are office workers.", evidenceText(said))).toBe(
      "My students are office workers.",
    );
  });
});

const productionDraft = {
  title: "Start with one leaf",
  body: [
    "Most beginners who get discouraged early made the same first mistake: they started with a full painting. A whole composition, a blank sheet, high hopes.",
    "Here is the decision I suggest instead: commit to one leaf. Fifteen minutes, one small piece of paper, one leaf from your kitchen or garden.",
    "This is also where I would start anyone in a first lesson, and it is the exercise I recommend when people ask how to begin on their own. The scope is small enough that nothing can go badly wrong.",
    "So if you have been meaning to try painting: pick one leaf this week.",
  ].join("\n\n"),
};

describe("groundOnboardingDraft", () => {
  it("applies the checker's rewrites in one call when they are clean", async () => {
    const check = vi.fn<DraftChecker>(async ({ sentences }) => {
      const id = (start: string) => sentences.find((s) => s.text.startsWith(start))!.id;
      return {
        flags: [
          {
            id: id("Most beginners"),
            rewrite: "Starting with a full painting is a lot of pressure for a calm hobby.",
          },
          { id: id("Here is the decision"), rewrite: "Try this instead: commit to one leaf." },
          { id: id("This is also where"), rewrite: "" },
        ],
      };
    });
    const { draft, report } = await groundOnboardingDraft(
      productionDraft,
      watercolor,
      check,
      Date.now() + 60_000,
    );
    expect(check).toHaveBeenCalledOnce();
    expect(report).toMatchObject({ checks: 1, rewritten: 2, dropped: 1, forcedDrops: 0 });
    expect(draft.body).toContain("Try this instead: commit to one leaf.");
    expect(draft.body).toContain("The scope is small enough that nothing can go badly wrong.");
    expect(draft.body).not.toMatch(/most beginners|first lesson|people ask|I suggest/i);
  });

  it("retries once when a rewrite is still risky, then removes what is left", async () => {
    const check = vi
      .fn<DraftChecker>()
      .mockResolvedValueOnce({
        flags: [{ id: "s2", rewrite: "Most beginners I teach start with a full painting." }],
      })
      .mockResolvedValueOnce({ flags: [] });
    const { draft, report } = await groundOnboardingDraft(
      productionDraft,
      watercolor,
      check,
      Date.now() + 60_000,
    );
    expect(check).toHaveBeenCalledTimes(2);
    expect(check.mock.calls[1][0].focus?.length).toBeGreaterThan(0);
    expect(report.checks).toBe(2);
    expect(report.forcedDrops).toBeGreaterThan(0);
    expect(draft.body).not.toMatch(/most beginners|first lesson|people ask/i);
    expect(draft.body).toContain("pick one leaf this week");
  });

  it("falls back to the deterministic check when the checker fails twice", async () => {
    const check = vi.fn<DraftChecker>().mockRejectedValue(new Error("timeout"));
    const { draft, report } = await groundOnboardingDraft(
      productionDraft,
      watercolor,
      check,
      Date.now() + 60_000,
    );
    expect(check).toHaveBeenCalledTimes(2);
    expect(report.checkerFailed).toBe(true);
    expect(draft.body).not.toMatch(/most beginners|first lesson|people ask/i);
    expect(draft.body).toContain("commit to one leaf");
  });

  it("skips the model when there is no time left and still removes risky lines", async () => {
    const check = vi.fn<DraftChecker>();
    const { draft, report } = await groundOnboardingDraft(
      { title: "Staging", body: "In my experience, wet paper helps. Wet the paper first." },
      watercolor,
      check,
      Date.now() + 1_000,
    );
    expect(check).not.toHaveBeenCalled();
    expect(report.checks).toBe(0);
    expect(draft.body).toBe("Wet the paper first.");
  });

  it("ignores ids the checker invented", async () => {
    const check = vi.fn<DraftChecker>().mockResolvedValue({ flags: [{ id: "s99", rewrite: "" }] });
    const { draft } = await groundOnboardingDraft(
      { title: "Tip", body: "Wet the paper first." },
      watercolor,
      check,
      Date.now() + 60_000,
    );
    expect(draft.body).toBe("Wet the paper first.");
  });
});
