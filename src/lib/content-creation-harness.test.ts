import { expect, it } from "vitest";
import { studioStarter } from "./content-studio";
import { DEFAULT_AGENT_BRANDING } from "./content-agent-branding";
import { reelSceneDirection, reviewContentCreation } from "./content-creation-harness";

it("keeps avatar media full-frame while preserving the creator's motion choice", () => {
  const document = studioStarter("reel", "kinetic", DEFAULT_AGENT_BRANDING).document;
  if (document.format !== "reel") throw Error("fixture");
  const scene = {
    ...document.scenes[0],
    kind: "avatar" as const,
    direction: { layout: "stack" as const, motion: "punch" as const },
  };
  expect(reelSceneDirection(document, scene, 0)).toEqual({ layout: "full-bleed", motion: "punch" });
});
it("reviews real reading time and repeated layouts without discarding legacy projects", () => {
  const document = studioStarter("reel", "tutorial", DEFAULT_AGENT_BRANDING).document;
  if (document.format !== "reel") throw Error("fixture");
  document.scenes[0].duration = 1;
  document.scenes[0].caption = "This scene contains far too much text to read in a single second";
  document.scenes = Array.from({ length: 4 }, (_, i) => ({
    ...document.scenes[0],
    id: crypto.randomUUID(),
    duration: i === 0 ? 1 : 8,
  }));
  const review = reviewContentCreation(document);
  expect(review.scenes).toHaveLength(4);
  expect(review.findings.map((f) => f.code)).toEqual(
    expect.arrayContaining(["dense_copy", "long_card", "repeated_layout"]),
  );
  expect(review.scenes[0]).toMatchObject({ start: 0, end: 1, layout: "stack" });
});

it("flags unfinished visuals, rushed speech and missing timed captions without claiming playback QA", () => {
  const document = studioStarter("reel", "captions", DEFAULT_AGENT_BRANDING).document;
  if (document.format !== "reel") throw Error("fixture");
  document.scenes = [
    {
      ...document.scenes[0],
      title: "",
      caption: "",
      duration: 1,
      avatarScript: "These words cannot all be spoken comfortably in one second",
      narrationJobId: crypto.randomUUID(),
    },
  ];
  expect(reviewContentCreation(document).findings.map((f) => f.code)).toEqual(
    expect.arrayContaining(["empty_visual", "rushed_narration", "missing_captions"]),
  );
  document.scenes[0].title = "A visible hook";
  document.scenes[0].duration = 5;
  document.subtitles = [{ start: 0, end: 4, text: document.scenes[0].avatarScript }];
  expect(reviewContentCreation(document).findings).toEqual([]);
});

it("reviews carousel content rather than returning an automatic clean bill of health", () => {
  const document = studioStarter("carousel", "editorial", DEFAULT_AGENT_BRANDING).document;
  if (document.format !== "carousel") throw Error("fixture");
  document.slides = [
    { heading: "The hook", body: "One idea" },
    { heading: " the HOOK ", body: "word ".repeat(66).trim() },
    { heading: "", body: "" },
  ];
  expect(reviewContentCreation(document).findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "repeated_slide", slideIndex: 1 }),
      expect.objectContaining({ code: "dense_slide", slideIndex: 1 }),
      expect.objectContaining({ code: "missing_heading", slideIndex: 2 }),
    ]),
  );
  document.slides = [
    { heading: "The hook", body: "One idea" },
    { heading: "The payoff", body: "Try it" },
  ];
  expect(reviewContentCreation(document).findings).toEqual([]);
});
