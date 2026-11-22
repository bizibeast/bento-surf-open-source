import { describe, expect, it } from "vitest";
import { studioStarter, type StudioReel } from "./content-studio";
import { studioHyperframesComposition } from "./studio-hyperframes";
import { DEFAULT_AGENT_BRANDING } from "./content-agent-branding";

describe("HyperFrames Studio compiler", () => {
  const reel = () =>
    studioStarter("reel", "captions", DEFAULT_AGENT_BRANDING).document as StudioReel;
  it("compiles a bounded portrait timeline with explicit timing and offline dependencies", () => {
    const document = reel();
    const html = studioHyperframesComposition({ document, assets: [] });
    expect(html).toContain('data-width="1080" data-height="1920"');
    expect(html).toContain(
      `data-duration="${document.scenes.reduce((sum, scene) => sum + scene.duration, 0)}"`,
    );
    expect(html).toContain("window.__timelines.bento=tl");
    expect(html).not.toContain("https://");
  });
  it("treats user and model text as text rather than executable HTML", () => {
    const document = reel();
    document.scenes[0].title = '</script><script>alert("x")';
    const html = studioHyperframesComposition({ document, assets: [] });
    expect(html).toContain("&lt;/script&gt;&lt;script&gt;alert(&quot;x&quot;)");
    expect(html).not.toContain("</script><script>alert");
  });
  it("renders the selected editing style and stages individually editable card items", () => {
    const document = reel();
    document.style = "kinetic";
    document.scenes[0].caption = "RAW / REFERENCES / EXPORTS";
    document.scenes[0].direction = { layout: "stack", motion: "slide" };
    const html = studioHyperframesComposition({ document, assets: [] });
    expect(html).toContain('data-editing-style="kinetic"');
    expect(html).toContain('data-layout="stack"');
    expect(html).toContain('class="card-item"');
    expect(html).toContain("REFERENCES");
    expect(html).toContain("stagger:");
    document.style = "interview";
    const other = studioHyperframesComposition({ document, assets: [] });
    expect(other).not.toEqual(html);
  });
  it("reframes letterboxed avatars without changing their timing or narration", () => {
    const document = reel();
    const clip = crypto.randomUUID();
    document.scenes = [{ ...document.scenes[0], kind: "avatar", mediaId: clip }];
    const html = studioHyperframesComposition(
      { document, assets: [{ id: clip, kind: "video" }] },
      { [clip]: ".mp4" },
      { [clip]: { top: 0.34, bottom: 0.66 } },
    );
    expect(html).toContain('class="footage avatar-footage"');
    expect(html).toContain("scale(3.125");
    expect(html).toContain('data-layout="full-bleed"');
    expect(html).toContain(`data-duration="${document.scenes[0].duration}"`);
  });
  it("rejects missing media and unvalidated properties before rendering", () => {
    const document = reel();
    document.scenes[0].kind = "avatar";
    expect(() => studioHyperframesComposition({ document, assets: [] })).toThrow(/owned, ready/);
    expect(() =>
      studioHyperframesComposition({ document: { ...reel(), shell: "bad" }, assets: [] } as never),
    ).toThrow();
  });
  it("mixes narration and quiet music while avoiding duplicate clip speech", () => {
    const document = reel();
    const [clip, speech, music] = Array.from({ length: 3 }, () => crypto.randomUUID());
    document.scenes = [
      { ...document.scenes[0], kind: "avatar", mediaId: clip, narrationJobId: speech, mute: false },
    ];
    document.audio = { musicMediaId: music, musicVolume: 0.12, narrationVolume: 1, sourceStart: 0 };
    document.subtitles = [{ start: 0.1, end: 1, text: "<b>Actual spoken words</b>" }];
    const html = studioHyperframesComposition(
      {
        document,
        assets: [
          { id: clip, kind: "video" },
          { id: speech, kind: "audio" },
          { id: music, kind: "video" },
        ],
      },
      { [clip]: ".mp4", [speech]: ".wav", [music]: ".mp4" },
    );
    expect(html).toContain(`src="assets/${speech}.wav"`);
    expect(html).toContain('data-volume="0.12"');
    expect(html).not.toContain(`id="scene-${document.scenes[0].id}-audio"`);
    expect(html).toContain("&lt;b&gt;Actual spoken words&lt;/b&gt;");
    expect(html).toContain('class="with-subtitles"');
    expect(() =>
      studioHyperframesComposition({
        document,
        assets: [
          { id: clip, kind: "video" },
          { id: music, kind: "video" },
        ],
      }),
    ).toThrow(/ready audio/);
  });
});
