import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_BRANDING } from "./content-agent-branding";
import { applyGeneratedStudioDraft, studioDraftContext } from "./content-studio-generation";
import { studioStarter } from "./content-studio";

describe("Studio generated drafts", () => {
  it("keeps saved settings and provenance and accepts only editable slide data", () => {
    const starter = studioStarter("carousel", "editorial", DEFAULT_AGENT_BRANDING);
    const sourceUrl = "https://publisher.example/story";
    const result = applyGeneratedStudioDraft(
      { ...starter.document, sourceUrl },
      {
        format: "carousel",
        title: "Start here",
        slides: [
          { heading: "First", body: "A fact" },
          { heading: "Second", body: "A decision" },
        ],
      },
    );
    expect(result).toMatchObject({
      title: "Start here",
      document: {
        format: "carousel",
        layout: "editorial",
        sourceUrl,
        slides: [
          { heading: "First", body: "A fact" },
          { heading: "Second", body: "A decision" },
        ],
      },
    });
    expect(() =>
      applyGeneratedStudioDraft(starter.document, {
        format: "carousel",
        title: "Injected media",
        slides: [
          { heading: "First", body: "A fact", mediaId: crypto.randomUUID() },
          { heading: "Second", body: "A decision" },
        ],
      }),
    ).toThrow();
  });

  it("leaves imagery and identity approval unresolved and rejects out-of-bounds timelines", () => {
    const starter = studioStarter("reel", "tutorial", DEFAULT_AGENT_BRANDING);
    const scene = {
      title: "Hook",
      caption: "Open",
      duration: 10,
      speakerScript: "Your script",
      avatarVisible: true,
    };
    const result = applyGeneratedStudioDraft(starter.document, {
      format: "reel",
      title: "A Reel",
      scenes: [scene],
    });
    expect(result.document).toMatchObject({
      format: "reel",
      style: "tutorial",
      avatarId: "",
      voiceId: "",
      scenes: [
        {
          kind: "avatar",
          mediaId: null,
          avatarJobId: null,
          avatarScript: "Your script",
          duration: 10,
        },
      ],
    });
    expect(() =>
      applyGeneratedStudioDraft(starter.document, {
        format: "reel",
        title: "Too long",
        scenes: Array.from({ length: 10 }, () => scene),
      }),
    ).toThrow("Reel duration");
  });
  it("persists validated scene directions and the creation brief without executing code", () => {
    const original = studioStarter("reel", "kinetic", DEFAULT_AGENT_BRANDING).document;
    const generated = {
      format: "reel",
      title: "An editing plan",
      scenes: [
        {
          title: "Start with the hook",
          caption: "Hook / Proof / Payoff",
          duration: 5,
          speakerScript: "A short hook",
          avatarVisible: false,
          direction: { layout: "stack", motion: "punch" },
        },
      ],
    };
    const result = applyGeneratedStudioDraft(original, generated);
    expect(result.document).toMatchObject({
      scenes: [{ direction: { layout: "stack", motion: "punch" } }],
    });
    expect(() =>
      applyGeneratedStudioDraft(original, {
        ...generated,
        scenes: [{ ...generated.scenes[0], direction: { layout: "<script>", motion: "punch" } }],
      }),
    ).toThrow();
  });
  it("reuses paid speech and footage on visual revisions and clears timings for changed speech", () => {
    const original = studioStarter("reel", "captions", DEFAULT_AGENT_BRANDING).document;
    if (original.format !== "reel") throw Error("fixture");
    const scene = original.scenes[0];
    scene.avatarScript = "Same words";
    scene.kind = "avatar";
    scene.avatarJobId = crypto.randomUUID();
    scene.narrationJobId = crypto.randomUUID();
    original.scenes = [scene];
    original.subtitles = [{ start: 0, end: 1, text: "Edited captions" }];
    const draft = {
      format: "reel",
      title: "Revision",
      scenes: [
        {
          title: "New title",
          caption: "New overlay",
          duration: scene.duration,
          speakerScript: "Same words",
          avatarVisible: true,
        },
      ],
    };
    expect(applyGeneratedStudioDraft(original, draft).document).toMatchObject({
      scenes: [
        { id: scene.id, avatarJobId: scene.avatarJobId, narrationJobId: scene.narrationJobId },
      ],
      subtitles: original.subtitles,
    });
    draft.scenes[0].speakerScript = "Different words";
    const revised = applyGeneratedStudioDraft(original, draft).document;
    if (revised.format !== "reel") throw Error("fixture");
    expect(revised.scenes[0].avatarJobId).toBeNull();
    expect(revised.scenes[0].narrationJobId).toBeUndefined();
    expect(revised.subtitles).toBeUndefined();
  });

  it("retains the correct footage when identical spoken lines are reordered", () => {
    const document = studioStarter("reel", "captions", DEFAULT_AGENT_BRANDING).document;
    if (document.format !== "reel") throw Error("fixture");
    document.scenes = [0, 1].map((index) => ({
      ...document.scenes[0],
      id: crypto.randomUUID(),
      title: `Visual ${index}`,
      kind: "media" as const,
      mediaId: crypto.randomUUID(),
      sourceStart: index * 3,
      avatarScript: "Watch this",
      narrationJobId: crypto.randomUUID(),
    }));
    const draft = {
      format: "reel",
      title: "Reordered",
      scenes: studioDraftContext(document).slice().reverse(),
    };
    const revised = applyGeneratedStudioDraft(document, draft).document;
    if (revised.format !== "reel") throw Error("fixture");
    expect(revised.scenes.map((s) => [s.id, s.mediaId, s.sourceStart, s.narrationJobId])).toEqual(
      document.scenes
        .slice()
        .reverse()
        .map((s) => [s.id, s.mediaId, s.sourceStart, s.narrationJobId]),
    );
    expect(() =>
      applyGeneratedStudioDraft(document, {
        ...draft,
        scenes: [draft.scenes[0], draft.scenes[0]],
      }),
    ).toThrow(/at most once/);
    expect(() =>
      applyGeneratedStudioDraft(document, {
        ...draft,
        scenes: [{ ...draft.scenes[0], sourceSceneId: crypto.randomUUID() }],
      }),
    ).toThrow(/existing scene/);
  });

  it("invalidates old lip sync and whole-reel narration when the script changes, keeping music", () => {
    const document = studioStarter("reel", "captions", DEFAULT_AGENT_BRANDING).document;
    if (document.format !== "reel") throw Error("fixture");
    document.scenes = [
      {
        ...document.scenes[0],
        kind: "avatar",
        avatarScript: "Approved script",
        mediaId: crypto.randomUUID(),
        avatarJobId: crypto.randomUUID(),
        narrationJobId: crypto.randomUUID(),
      },
    ];
    document.audio = {
      narrationMediaId: crypto.randomUUID(),
      musicMediaId: crypto.randomUUID(),
      narrationVolume: 1,
      musicVolume: 0.12,
      sourceStart: 0,
    };
    document.subtitles = [{ start: 0, end: 1, text: "Approved script" }];
    const scenes = studioDraftContext(document);
    const revised = applyGeneratedStudioDraft(document, {
      format: "reel",
      title: "Updated",
      scenes: [{ ...scenes[0], speakerScript: "New script" }],
    }).document;
    if (revised.format !== "reel") throw Error("fixture");
    expect(revised.scenes[0]).toMatchObject({ mediaId: null, avatarJobId: null });
    expect(revised.scenes[0].narrationJobId).toBeUndefined();
    expect(revised.audio).toEqual({ ...document.audio, narrationMediaId: null });
    expect(revised.subtitles).toBeUndefined();
  });

  it("reuses separate narration when an edit hides the presenter without buying another voice", () => {
    const document = studioStarter("reel", "captions", DEFAULT_AGENT_BRANDING).document;
    if (document.format !== "reel") throw Error("fixture");
    document.scenes = [
      {
        ...document.scenes[0],
        kind: "avatar",
        avatarScript: "Keep my voice",
        mediaId: crypto.randomUUID(),
        avatarJobId: crypto.randomUUID(),
        narrationJobId: crypto.randomUUID(),
      },
    ];
    document.audio = {
      narrationMediaId: crypto.randomUUID(),
      musicMediaId: null,
      narrationVolume: 1,
      musicVolume: 0.12,
      sourceStart: 0,
    };
    document.subtitles = [{ start: 0, end: 1, text: "Keep my voice" }];
    const revised = applyGeneratedStudioDraft(document, {
      format: "reel",
      title: "Graphics only",
      scenes: [{ ...studioDraftContext(document)[0], avatarVisible: false }],
    }).document;
    if (revised.format !== "reel") throw Error("fixture");
    expect(revised.scenes[0]).toMatchObject({
      kind: "card",
      mediaId: null,
      avatarJobId: null,
      narrationJobId: document.scenes[0].narrationJobId,
    });
    expect(revised.audio).toEqual(document.audio);
    expect(revised.subtitles).toEqual(document.subtitles);
  });

  it("keeps carousel photos attached to their original slides during copy changes and reordering", () => {
    const document = studioStarter("carousel", "editorial", DEFAULT_AGENT_BRANDING).document;
    if (document.format !== "carousel") throw Error("fixture");
    document.slides[0].mediaId = crypto.randomUUID();
    document.slides[1].mediaId = crypto.randomUUID();
    const slides = studioDraftContext(document);
    const revised = applyGeneratedStudioDraft(document, {
      format: "carousel",
      title: "New design",
      slides: [{ ...slides[1], heading: "A revised headline" }, slides[0]],
    }).document;
    if (revised.format !== "carousel") throw Error("fixture");
    expect(revised.slides.map((s) => s.mediaId)).toEqual([
      document.slides[1].mediaId,
      document.slides[0].mediaId,
    ]);
    expect(() =>
      applyGeneratedStudioDraft(document, {
        format: "carousel",
        title: "Invalid",
        slides: [slides[0], slides[0]],
      }),
    ).toThrow(/at most once/);
    expect(() =>
      applyGeneratedStudioDraft(document, {
        format: "carousel",
        title: "Foreign",
        slides: [{ ...slides[0], sourceSlideIndex: 9 }, slides[1]],
      }),
    ).toThrow(/existing slide/);
    const legacy = applyGeneratedStudioDraft(document, {
      format: "carousel",
      title: "Unchanged",
      slides: document.slides.map(({ heading, body }) => ({ heading, body })),
    }).document;
    expect(legacy).toEqual(document);
  });
});
