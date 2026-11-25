import { describe, expect, it } from "vitest";
import { conformReelNarration, reelProductionRequestKey } from "./content-reel-production";
import { newReelScene, studioReelSchema, type StudioReel } from "./content-studio";
import { DEFAULT_AGENT_BRANDING } from "./content-agent-branding";
import { planAvatarSegments, reviseReelScene } from "./content-studio-avatar";

export const productionFixture = (): StudioReel =>
  studioReelSchema.parse({
    schemaVersion: 1,
    format: "reel",
    style: "captions",
    brand: DEFAULT_AGENT_BRANDING,
    avatarId: "creator_avatar",
    voiceId: "creator_voice",
    scenes: [
      newReelScene({
        kind: "avatar",
        title: "Hook",
        avatarScript: "A useful opening",
        duration: 8,
      }),
      newReelScene({
        title: "Explain",
        avatarScript: "Explain the first useful idea",
        duration: 15,
        sourceStart: 12,
      }),
      newReelScene({
        title: "Demonstrate",
        avatarScript: "Demonstrate the idea in practice",
        duration: 15,
      }),
      newReelScene({
        kind: "avatar",
        title: "CTA",
        avatarScript: "Save this for later",
        duration: 7,
      }),
    ],
  });

describe("audio-first visible avatar production", () => {
  it("preserves three approved card beats when short narration fits each one", () => {
    const scenes = ["First", "Second", "Third"].map((title) =>
      newReelScene({ kind: "card", title, avatarScript: title, duration: 4 }),
    );
    const document = studioReelSchema.parse({ ...productionFixture(), scenes });
    const audio = new Map(
      scenes.map((scene, index) => [
        scene.id,
        {
          jobId: crypto.randomUUID(),
          durationSeconds: [1.63, 1.63, 2.35][index],
          speechWords: [{ word: scene.title, start: 0.1, end: 1.2 }],
        },
      ]),
    );
    const result = conformReelNarration(document, audio);
    expect(result.scenes.map((scene) => scene.duration)).toEqual([4, 4, 4]);
    expect(result.subtitles?.map((cue) => cue.start)).toEqual([0.1, 4.1, 8.1]);
    expect(result.scenes.map((scene) => scene.narrationJobId)).toEqual(
      scenes.map((scene) => audio.get(scene.id)!.jobId),
    );
  });

  it("plans fifteen avatar seconds for a forty-five second Reel without generating hidden video", () => {
    const document = productionFixture();
    const audio = new Map(
      document.scenes.map((scene) => [
        scene.id,
        {
          jobId: crypto.randomUUID(),
          durationSeconds: scene.duration,
          speechWords: [
            { word: "Hello", start: 0, end: 0.5 },
            { word: "creator", start: 0.5, end: 1 },
          ],
        },
      ]),
    );
    const final = conformReelNarration(document, audio);
    expect(final.scenes.reduce((sum, scene) => sum + scene.duration, 0)).toBe(45);
    expect(
      final.scenes
        .filter((scene) => scene.kind === "avatar")
        .reduce((sum, scene) => sum + scene.duration, 0),
    ).toBe(15);
    expect(final.scenes.every((scene) => scene.narrationJobId)).toBe(true);
    expect(final.subtitles).toEqual(
      expect.arrayContaining([{ start: 8, end: 9, text: "Hello creator" }]),
    );
    expect(final.scenes[1].sourceStart).toBe(12);
  });
  it("puts silent timing padding on B-roll rather than buying extra avatar footage", () => {
    const document = productionFixture();
    const audio = new Map(
      document.scenes.map((scene, index) => [
        scene.id,
        {
          jobId: crypto.randomUUID(),
          durationSeconds: scene.duration - (index === 0 ? 2 : 0),
          speechWords: [],
        },
      ]),
    );
    const final = conformReelNarration(document, audio);
    expect(final.scenes[0].duration).toBe(6);
    expect(final.scenes[1].duration).toBe(17);
    expect(final.scenes.reduce((sum, scene) => sum + scene.duration, 0)).toBe(45);
    expect(planAvatarSegments(final).segments).toHaveLength(2);
  });
  it("stops before avatars when narration overruns the approved duration or word timings are invalid", () => {
    const document = productionFixture();
    const audio = new Map(
      document.scenes.map((scene) => [
        scene.id,
        {
          jobId: crypto.randomUUID(),
          durationSeconds: scene.duration + 1,
          speechWords: [],
        },
      ]),
    );
    expect(() => conformReelNarration(document, audio)).toThrow(/longer than the approved/);
    audio.forEach((speech, id) => {
      speech.durationSeconds = document.scenes.find((scene) => scene.id === id)!.duration;
    });
    audio.get(document.scenes[0].id)!.speechWords = [{ word: "late", start: 7, end: 10 }] as never;
    expect(() => conformReelNarration(document, audio)).toThrow(/invalid word timing/);
  });
  it("reuses speech through visual revisions and invalidates only speech changes", async () => {
    const scene = {
      ...productionFixture().scenes[0],
      avatarJobId: crypto.randomUUID(),
      narrationJobId: crypto.randomUUID(),
    };
    expect(reviseReelScene(scene, { caption: "A new caption" })).toMatchObject({
      avatarJobId: scene.avatarJobId,
      narrationJobId: scene.narrationJobId,
    });
    expect(reviseReelScene(scene, { avatarScript: "New speech" })).toMatchObject({
      avatarJobId: null,
      narrationJobId: null,
    });
    expect(await reelProductionRequestKey(["speech", "voice", "same words"])).toBe(
      await reelProductionRequestKey(["speech", "voice", "same words"]),
    );
    expect(await reelProductionRequestKey(["speech", "voice", "new words"])).not.toBe(
      await reelProductionRequestKey(["speech", "voice", "same words"]),
    );
  });
});
