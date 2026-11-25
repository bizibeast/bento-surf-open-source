import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_AGENT_BRANDING } from "./content-agent-branding";
import { carouselCopyIssues } from "./content-carousel";
import { avatarSegmentRequestKey, planAvatarSegments } from "./content-studio-avatar";
import {
  STUDIO_CAROUSEL_LAYOUTS,
  STUDIO_REEL_STYLES,
  newReelScene,
  reelTimeline,
  studioDocumentSchema,
  studioMediaReferences,
  studioStarter,
  type StudioReel,
} from "./content-studio";

function reel(patch: Partial<StudioReel> = {}): StudioReel {
  const entry = studioStarter("reel", "jump-cut", DEFAULT_AGENT_BRANDING);
  if (entry.document.format !== "reel") throw new Error("Expected a Reel.");
  return { ...entry.document, ...patch };
}

describe("Studio projects", () => {
  it("uses saved presenter defaults only for new Reel drafts", () => {
    const brand = {
      ...DEFAULT_AGENT_BRANDING,
      presenter: {
        avatarId: "look",
        name: "Annie",
        voiceId: "voice",
        billing: "managed" as const,
        scope: "public" as const,
      },
    };
    const entry = studioStarter("reel", "captions", brand);
    expect(entry.document).toMatchObject({ avatarId: "look", voiceId: "voice" });
    expect(studioDocumentSchema.safeParse(entry.document).success).toBe(true);
    expect(studioStarter("reel", "captions", DEFAULT_AGENT_BRANDING).document).toMatchObject({
      avatarId: "",
      voiceId: "",
    });
  });
  it("starts nine editable layouts and nine valid Reel timelines", () => {
    for (const layout of STUDIO_CAROUSEL_LAYOUTS) {
      const entry = studioStarter("carousel", layout, DEFAULT_AGENT_BRANDING);
      const document = studioDocumentSchema.parse(entry.document);
      if (document.format !== "carousel") throw new Error("Expected a carousel.");
      expect(document.layout).toBe(layout);
      expect(carouselCopyIssues(document.slides)).toEqual([]);
    }
    for (const style of STUDIO_REEL_STYLES) {
      const entry = studioStarter("reel", style, DEFAULT_AGENT_BRANDING);
      const document = studioDocumentSchema.parse(entry.document);
      if (document.format !== "reel") throw new Error("Expected a Reel.");
      expect(document.style).toBe(style);
      const timeline = reelTimeline(document);
      expect(timeline[0].start).toBe(0);
      for (let i = 1; i < timeline.length; i += 1) {
        expect(timeline[i].start).toBe(timeline[i - 1].end);
      }
    }
  });

  it("rejects overlong timelines and repeated scene IDs", () => {
    const scene = newReelScene({ duration: 20 });
    expect(studioDocumentSchema.safeParse(reel({ scenes: [scene, scene] })).success).toBe(false);
    expect(
      studioDocumentSchema.safeParse(
        reel({
          scenes: Array.from({ length: 5 }, () => newReelScene({ duration: 20 })),
        }),
      ).success,
    ).toBe(false);
  });

  it("checks owned media only when used by the selected cover treatment", () => {
    const heroPhotoId = crypto.randomUUID();
    const mediaId = crypto.randomUUID();
    const entry = studioStarter("carousel", "editorial", DEFAULT_AGENT_BRANDING);
    if (entry.document.format !== "carousel") throw new Error("Expected a carousel.");
    const document = { ...entry.document, brand: { ...entry.document.brand, heroPhotoId } };
    expect(studioMediaReferences(document).filter(Boolean)).toEqual([]);
    document.brand.coverStyle = "portrait";
    expect(studioMediaReferences(document).filter(Boolean)).toEqual([heroPhotoId]);
    document.slides[0].mediaId = mediaId;
    expect(studioMediaReferences(document).filter(Boolean)).toEqual([mediaId]);
  });
});

describe("Avatar footage planner", () => {
  it("sizes only visible avatar intervals and reuses matching footage and owned clips", () => {
    const mediaId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const plan = planAvatarSegments(
      reel({
        avatarId: "avatar",
        voiceId: "voice",
        scenes: [
          newReelScene({ kind: "card", duration: 20, avatarScript: "I am hidden" }),
          newReelScene({
            kind: "avatar",
            duration: 1,
            sourceStart: 0,
            avatarScript: " Hello   world ",
          }),
          newReelScene({
            kind: "avatar",
            duration: 2,
            sourceStart: 3,
            avatarScript: "Hello world",
          }),
          newReelScene({ kind: "avatar", duration: 1, avatarScript: "Minimum" }),
          newReelScene({ kind: "avatar", duration: 5, mediaId }),
          newReelScene({
            kind: "avatar",
            duration: 4,
            avatarJobId: jobId,
            avatarScript: "Already generated",
          }),
        ],
      }),
    );
    expect(plan.existingClipSeconds).toBe(5);
    expect(plan.newFootageSeconds).toBe(9);
    expect(
      plan.segments.map((segment) => ({
        script: segment.script,
        visible: segment.visibleSeconds,
        planned: segment.requestedSeconds,
      })),
    ).toEqual([
      { script: "Hello world", visible: 3, planned: 6 },
      { script: "Minimum", visible: 1, planned: 3 },
      { script: "Already generated", visible: 4, planned: 5 },
    ]);
  });

  it("uses a stable, UUID-form request ID regardless of project and scene IDs", async () => {
    const input = { avatarId: "avatar", voiceId: "voice" };
    const scene = () =>
      newReelScene({ kind: "avatar", duration: 4, avatarScript: "A reusable clip" });
    const [first] = planAvatarSegments(reel({ ...input, scenes: [scene()] })).segments;
    const [second] = planAvatarSegments(reel({ ...input, scenes: [scene()] })).segments;
    const key = await avatarSegmentRequestKey(first);
    expect(z.uuid().safeParse(key).success).toBe(true);
    expect(await avatarSegmentRequestKey(second)).toBe(key);
    expect(await avatarSegmentRequestKey({ ...first, voiceId: "another voice" })).not.toBe(key);
  });
});
