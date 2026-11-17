import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_BRANDING } from "./content-agent-branding";
import { applyGeneratedStudioDraft } from "./content-studio-generation";
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
});
