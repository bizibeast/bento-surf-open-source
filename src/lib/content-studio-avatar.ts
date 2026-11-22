import { reelTimeline, type StudioReel } from "./content-studio";

const MINIMUM_PLANNED_SECONDS = 3;
const TAIL_HANDLE_SECONDS = 0.5;
const PLANNING_INCREMENT_SECONDS = 1;

export type AvatarSegment = {
  signature: string;
  script: string;
  avatarId: string;
  voiceId: string;
  requestedSeconds: number;
  visibleSeconds: number;
  requiredSourceSeconds: number;
  sceneIds: string[];
  jobId: string | null;
};

function normalizeScript(script: string) {
  return script.trim().replace(/\s+/g, " ");
}

export function planAvatarSegments(document: StudioReel) {
  const segments = new Map<string, AvatarSegment>();
  let existingClipSeconds = 0;
  for (const { scene, start, end } of reelTimeline(document)) {
    if (scene.kind !== "avatar") continue;
    const duration = end - start;
    if (scene.mediaId) {
      existingClipSeconds += duration;
      continue;
    }
    const script = normalizeScript(scene.avatarScript);
    const signature = JSON.stringify([
      document.avatarId,
      document.voiceId,
      script,
      scene.avatarJobId,
    ]);
    const prior = segments.get(signature);
    const requiredSourceSeconds = Math.max(
      prior?.requiredSourceSeconds ?? 0,
      scene.sourceStart + duration,
    );
    const requestedSeconds =
      Math.ceil(
        Math.max(MINIMUM_PLANNED_SECONDS, requiredSourceSeconds + TAIL_HANDLE_SECONDS) /
          PLANNING_INCREMENT_SECONDS,
      ) * PLANNING_INCREMENT_SECONDS;
    segments.set(signature, {
      signature,
      script,
      avatarId: document.avatarId,
      voiceId: document.voiceId,
      requestedSeconds,
      requiredSourceSeconds,
      visibleSeconds: (prior?.visibleSeconds ?? 0) + duration,
      sceneIds: [...(prior?.sceneIds ?? []), scene.id],
      jobId: scene.avatarJobId,
    });
  }
  const pending = [...segments.values()];
  return {
    segments: pending,
    existingClipSeconds,
    newFootageSeconds: pending
      .filter((segment) => !segment.jobId)
      .reduce((total, segment) => total + segment.requestedSeconds, 0),
  };
}

/** Narration is audio only. Never create hidden avatar footage to obtain a voiceover. */
export function planNarrationSegments(document: StudioReel) {
  if (document.audio?.narrationMediaId) return [];
  return document.scenes.flatMap((scene) => {
    const script = normalizeScript(scene.avatarScript);
    if (scene.kind === "avatar" || !script) return [];
    return [
      {
        sceneId: scene.id,
        script,
        voiceId: document.voiceId,
        duration: scene.duration,
        jobId: scene.narrationJobId ?? null,
      },
    ];
  });
}

/** Keep generated segments through visual edits; speech changes invalidate the corresponding job. */
export function reviseReelScene(
  scene: StudioReel["scenes"][number],
  patch: Partial<StudioReel["scenes"][number]>,
) {
  const speechChanged =
    patch.avatarScript !== undefined && patch.avatarScript !== scene.avatarScript;
  const kindChanged = patch.kind !== undefined && patch.kind !== scene.kind;
  return {
    ...scene,
    ...patch,
    ...(speechChanged || kindChanged ? { avatarJobId: null, narrationJobId: null } : {}),
  };
}

export async function avatarSegmentRequestKey(segment: AvatarSegment) {
  const identity = JSON.stringify([
    "studio-avatar-v1",
    segment.avatarId,
    segment.voiceId,
    segment.script,
    segment.requestedSeconds,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
