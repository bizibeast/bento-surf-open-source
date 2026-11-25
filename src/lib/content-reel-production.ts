import { z } from "zod";
import { studioReelSchema, reelTimeline, type StudioReel } from "./content-studio";
import { socialPostInputSchema } from "./social-scheduler";

export const reelPublicationSchema = z
  .object({
    body: socialPostInputSchema.shape.body,
    scheduledAt: socialPostInputSchema.shape.scheduledAt,
    timezone: socialPostInputSchema.shape.timezone.refine((timezone) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: timezone });
        return true;
      } catch {
        return false;
      }
    }, "Choose a valid publishing timezone."),
    connectionOverrides: z
      .record(
        z.uuid(),
        z
          .object({
            bodyOverride: socialPostInputSchema.shape.body.optional(),
          })
          .strict(),
      )
      .optional(),
    connectionIds: z.array(z.uuid()).min(1).max(20),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.connectionIds).size === value.connectionIds.length &&
      Object.keys(value.connectionOverrides || {}).every((id) => value.connectionIds.includes(id)),
    "Choose each publishing account once before customizing its caption.",
  );

export const reelProductionInput = z
  .object({
    workspaceId: z.uuid(),
    entryId: z.uuid(),
    revision: z.number().int().positive(),
    requestId: z.uuid(),
    publication: reelPublicationSchema.optional(),
  })
  .strict();
export const reelProductionIdInput = z
  .object({ workspaceId: z.uuid(), productionId: z.uuid() })
  .strict();
export const reelProductionStateSchema = z
  .object({
    speech: z.record(z.string(), z.uuid()).default({}),
    avatars: z.record(z.string(), z.uuid()).default({}),
    costs: z.record(z.string(), z.number().int().positive().max(1_000_000)).default({}),
    renderCost: z.number().int().positive().optional(),
    renderRevision: z.number().int().positive().optional(),
    renderJobId: z.uuid().optional(),
    completedDocument: studioReelSchema.optional(),
  })
  .strict();
export type ReelProductionState = z.infer<typeof reelProductionStateSchema>;
export type ProductionSpeech = {
  jobId: string;
  durationSeconds: number | null;
  speechWords: Array<{ word: string; start: number; end: number }>;
};

export async function reelProductionRequestKey(values: unknown[]) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(["reel-production-v1", ...values])),
    ),
  );
  digest[6] = (digest[6] & 15) | 0x80;
  digest[8] = (digest[8] & 63) | 0x80;
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Actual audio determines lip-sync and captions. Never cut spoken words to fit a guessed duration. */
export function conformReelNarration(document: StudioReel, audio: Map<string, ProductionSpeech>) {
  const keepCaptionEdits =
    document.subtitles !== undefined &&
    document.scenes.every(
      (scene) =>
        !scene.avatarScript.trim() ||
        (scene.kind === "avatar" && scene.mediaId) ||
        scene.narrationJobId === audio.get(scene.id)?.jobId,
    );
  const target = document.scenes.reduce((sum, scene) => sum + scene.duration, 0);
  const scenes = document.scenes.map((scene) => {
    const speech = audio.get(scene.id);
    if (!scene.avatarScript.trim() || (scene.kind === "avatar" && scene.mediaId && !speech))
      return { ...scene };
    if (!speech?.durationSeconds || speech.durationSeconds > 20 || speech.durationSeconds < 0.25)
      throw new Error(
        "Narration must fit within a scene of 0.25 to 20 seconds. Revise its script.",
      );
    return {
      ...scene,
      ...(scene.kind === "avatar" ? { sourceStart: 0 } : {}),
      duration: speech.durationSeconds,
      narrationJobId: speech.jobId,
      mute: true,
    };
  });
  let spare = target - scenes.reduce((sum, scene) => sum + scene.duration, 0);
  if (spare < -0.05)
    throw new Error(
      "The narration is longer than the approved Reel. Shorten the script before generating avatars.",
    );
  // Preserve the approved holds before assigning any extra avatar padding.
  // Otherwise short narration collapses later cards and creates a long dead
  // pause on the first one, even when every spoken line fits its planned beat.
  for (let index = 0; index < scenes.length; index++) {
    const scene = scenes[index];
    if (scene.kind === "avatar") continue;
    const hold = Math.min(
      Math.max(0, spare),
      Math.max(0, document.scenes[index].duration - scene.duration),
    );
    scene.duration += hold;
    spare -= hold;
  }
  // Hold B-roll/cards between beats; do not buy additional avatar seconds for silent padding.
  for (const scene of scenes.filter((scene) => scene.kind !== "avatar")) {
    const extra = Math.min(Math.max(0, spare), 20 - scene.duration);
    scene.duration += extra;
    spare -= extra;
  }
  if (spare > 0.05)
    throw new Error(
      "Add a B-roll or text scene to preserve the approved duration without extra avatar footage.",
    );
  const subtitles: NonNullable<StudioReel["subtitles"]> = [];
  for (const { scene, start } of reelTimeline({ ...document, scenes })) {
    const speech = audio.get(scene.id);
    let words: ProductionSpeech["speechWords"] = [];
    const flush = () => {
      if (!words.length) return;
      subtitles.push({
        start: start + words[0].start,
        end: start + words.at(-1)!.end,
        text: words.map((word) => word.word).join(" "),
      });
      words = [];
    };
    let previousEnd = 0;
    for (const word of speech?.speechWords || []) {
      if (
        word.start < previousEnd ||
        word.end < word.start ||
        word.end > (speech?.durationSeconds ?? 0) + 0.01
      )
        throw new Error("The voice provider returned invalid word timing.");
      if (words.length >= 5 || [...words.map((word) => word.word), word.word].join(" ").length > 70)
        flush();
      words.push(word);
      previousEnd = word.end;
    }
    flush();
  }
  return studioReelSchema.parse({
    ...document,
    scenes,
    subtitles: keepCaptionEdits
      ? document.subtitles
      : subtitles.filter((cue) => cue.end > cue.start),
  });
}
