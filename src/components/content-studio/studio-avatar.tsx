import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  approveHeyGenGeneration,
  getHeyGenGeneration,
  listHeyGenAvatars,
  listHeyGenVoices,
  prepareHeyGenGeneration,
  startHeyGenGeneration,
} from "@/lib/external-tools.functions";
import { heyGenEstimateUsd, heyGenEstimateRenderSeconds } from "@/lib/external-tools";
import {
  avatarSegmentRequestKey,
  planAvatarSegments,
  type AvatarSegment,
} from "@/lib/content-studio-avatar";
import type { StudioReel } from "@/lib/content-studio";
import { studioAvatarJobKey as jobKey, type StudioAvatarJob } from "@/hooks/use-studio-avatar-jobs";
import { StudioLabel, StudioSelect } from "./studio-controls";

type Job = StudioAvatarJob;
type AvatarList = Awaited<ReturnType<typeof listHeyGenAvatars>>;
type VoiceList = Awaited<ReturnType<typeof listHeyGenVoices>>;

export function StudioAvatarPanel({
  workspaceId,
  document,
  jobs,
  onChange,
  onSaveUpdate,
  onError,
  onBusyChange,
  disabled,
}: {
  workspaceId: string;
  document: StudioReel;
  jobs: Map<string, Job>;
  onChange: (next: StudioReel) => void;
  onSaveUpdate: (next: StudioReel) => Promise<void>;
  onError: (error: unknown) => void;
  onBusyChange: (status: string) => void;
  disabled: boolean;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [scope, setScope] = useState<"private" | "public">("private");
  const [avatars, setAvatars] = useState<AvatarList | null>(null);
  const [voices, setVoices] = useState<VoiceList | null>(null);
  const plan = planAvatarSegments(document);
  if (!plan.segments.length && !plan.existingClipSeconds) return null;

  const updateJob = (job: Job) => {
    queryClient.setQueryData(jobKey(workspaceId, job.jobId), job);
    return job;
  };
  const run = async (action: () => Promise<unknown>) => {
    if (pending || disabled) return;
    setPending(true);
    onBusyChange("Updating avatar footage…");
    try {
      await action();
    } catch (error) {
      onError(error);
    } finally {
      setPending(false);
      onBusyChange("");
    }
  };

  const select = (avatarId: string, voiceId: string) =>
    onChange({
      ...document,
      avatarId,
      voiceId,
      scenes: document.scenes.map((scene) => ({ ...scene, avatarJobId: null })),
    });

  const loadChoices = async (more?: "avatars" | "voices") =>
    run(async () => {
      if (more === "avatars") {
        if (!avatars?.nextToken) return;
        const next = await listHeyGenAvatars({ data: { scope, token: avatars.nextToken } });
        setAvatars({
          ...next,
          avatars: [
            ...new Map(
              [...avatars.avatars, ...next.avatars].map((entry) => [entry.id, entry]),
            ).values(),
          ],
        });
      } else if (more === "voices") {
        if (!voices?.nextToken) return;
        const next = await listHeyGenVoices({ data: { scope, token: voices.nextToken } });
        setVoices({
          ...next,
          voices: [
            ...new Map(
              [...voices.voices, ...next.voices].map((entry) => [entry.id, entry]),
            ).values(),
          ],
        });
      } else {
        const [avatarList, voiceList] = await Promise.all([
          listHeyGenAvatars({ data: { scope } }),
          listHeyGenVoices({ data: { scope } }),
        ]);
        setAvatars(avatarList);
        setVoices(voiceList);
      }
    });

  const attach = async (segment: AvatarSegment, jobId: string) => {
    const ids = new Set(segment.sceneIds);
    await onSaveUpdate({
      ...document,
      scenes: document.scenes.map((scene) =>
        ids.has(scene.id) ? { ...scene, avatarJobId: jobId } : scene,
      ),
    });
  };

  const prepare = async (segment: AvatarSegment, newAttempt = false) =>
    run(async () => {
      const job = updateJob(
        await prepareHeyGenGeneration({
          data: {
            avatarId: segment.avatarId,
            voiceId: segment.voiceId,
            script: segment.script,
            requestedSeconds: segment.requestedSeconds,
            requestKey: newAttempt ? crypto.randomUUID() : await avatarSegmentRequestKey(segment),
          },
        }),
      );
      await attach(segment, job.jobId);
    });

  const selectedAvatar = avatars?.avatars.find((item) => item.id === document.avatarId);
  const reusable = new Map(
    plan.segments.flatMap((segment) => {
      if (segment.jobId) return [];
      const match = [...jobs.values()].find(
        (job) =>
          job.status === "ready" &&
          job.avatarId === segment.avatarId &&
          job.voiceId === segment.voiceId &&
          job.script === segment.script &&
          (job.durationSeconds ?? 0) + 0.05 >= segment.requiredSourceSeconds,
      );
      return match ? [[segment.signature, match] as const] : [];
    }),
  );
  const newSeconds = plan.segments
    .filter((segment) => !segment.jobId && !reusable.has(segment.signature))
    .reduce((seconds, segment) => seconds + segment.requestedSeconds, 0);

  return (
    <section className="studio-avatar" aria-label="Avatar footage">
      <div className="studio-toolbar">
        <h3>Avatar footage</h3>
        <span className="studio-muted">{newSeconds}s of new footage planned</span>
      </div>
      <p className="studio-muted">
        The estimate includes a 3-second planning minimum, rounding to whole seconds, and a
        half-second tail handle. The expected spoken duration can increase the estimate for longer
        scripts. Your HeyGen account is billed for the duration HeyGen produces.
        {plan.existingClipSeconds > 0 &&
          ` Reused clips cover ${plan.existingClipSeconds} seconds on the timeline.`}
      </p>
      {plan.segments.some((segment) => !segment.jobId) && (
        <>
          <div className="studio-actions">
            <StudioLabel label="HeyGen catalog">
              <StudioSelect
                value={scope}
                disabled={pending || disabled}
                onChange={(event) => {
                  setScope(event.target.value as typeof scope);
                  setAvatars(null);
                  setVoices(null);
                }}
              >
                <option value="private">My account</option>
                <option value="public">Public catalog</option>
              </StudioSelect>
            </StudioLabel>
            <button
              type="button"
              className="content-action"
              disabled={pending || disabled}
              onClick={() => void loadChoices()}
            >
              Load avatars and voices
            </button>
            <a href="/mcp" className="content-action">
              HeyGen connection
            </a>
          </div>
          <div className="studio-dual">
            <div>
              <StudioLabel label="Avatar look">
                <StudioSelect
                  value={document.avatarId}
                  disabled={pending || disabled}
                  onChange={(event) => {
                    const avatar = avatars?.avatars.find((item) => item.id === event.target.value);
                    select(event.target.value, avatar?.defaultVoiceId || document.voiceId);
                  }}
                >
                  <option value="">Choose a look</option>
                  {document.avatarId &&
                    !avatars?.avatars.some(({ id }) => id === document.avatarId) && (
                      <option value={document.avatarId}>Previously selected look</option>
                    )}
                  {avatars?.avatars.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </StudioSelect>
              </StudioLabel>
              {avatars?.nextToken && (
                <button
                  className="content-action"
                  type="button"
                  disabled={pending || disabled}
                  onClick={() => void loadChoices("avatars")}
                >
                  More looks
                </button>
              )}
            </div>
            <div>
              <StudioLabel label="Voice">
                <StudioSelect
                  value={document.voiceId}
                  disabled={pending || disabled}
                  onChange={(event) => select(document.avatarId, event.target.value)}
                >
                  <option value="">Choose a voice</option>
                  {document.voiceId &&
                    !voices?.voices.some(({ id }) => id === document.voiceId) && (
                      <option value={document.voiceId}>Previously selected voice</option>
                    )}
                  {voices?.voices.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {item.language ? ` · ${item.language}` : ""}
                    </option>
                  ))}
                </StudioSelect>
              </StudioLabel>
              {voices?.nextToken && (
                <button
                  className="content-action"
                  type="button"
                  disabled={pending || disabled}
                  onClick={() => void loadChoices("voices")}
                >
                  More voices
                </button>
              )}
            </div>
          </div>
        </>
      )}
      {plan.segments.map((segment) => {
        const job = segment.jobId ? jobs.get(segment.jobId) : null;
        const price =
          job?.estimatedUsd ??
          (selectedAvatar
            ? heyGenEstimateUsd(
                heyGenEstimateRenderSeconds(segment.requestedSeconds, segment.script),
                selectedAvatar.estimatedUsdPerMinute,
              )
            : null);
        const existing = reusable.get(segment.signature);
        const canPrepare = Boolean(
          segment.avatarId && segment.voiceId && segment.script && segment.requestedSeconds <= 60,
        );
        const hasEnoughFootage =
          !job?.durationSeconds || job.durationSeconds + 0.05 >= segment.requiredSourceSeconds;
        return (
          <article className="studio-segment" key={segment.signature}>
            <strong>{segment.script || "Add a spoken script to the scene"}</strong>
            <p className="studio-muted">
              {segment.visibleSeconds}s on screen ·{" "}
              {segment.jobId
                ? "Saved segment"
                : existing
                  ? "Existing clip available"
                  : `${segment.requestedSeconds}s planned`}
              {!existing && price !== null && ` · estimated $${price.toFixed(2)}`}
            </p>
            {job && (
              <p className="studio-muted">
                {job.status.replaceAll("_", " ")}
                {job.estimatedRenderSeconds !== job.requestedSeconds &&
                  ` · ${job.estimatedRenderSeconds}s estimated from script length`}
                {job.durationSeconds ? ` · ${job.durationSeconds.toFixed(1)}s available` : ""}
                {!hasEnoughFootage && " · Shorten the scene or its trim offset to fit this clip."}
              </p>
            )}
            {!segment.jobId && !existing && segment.requestedSeconds > 60 && (
              <p className="studio-muted">
                Reduce the clip offset or scene duration to request at most 60 seconds.
              </p>
            )}
            {job?.status === "submission_unknown" && (
              <p className="studio-muted">
                Check your HeyGen account for this generation before submitting another request.
              </p>
            )}
            <div className="studio-actions">
              {existing && (
                <button
                  className="content-action"
                  type="button"
                  disabled={pending || disabled}
                  onClick={() => void run(() => attach(segment, existing.jobId))}
                >
                  Reuse rendered clip
                </button>
              )}
              {!segment.jobId && !existing && (
                <button
                  className="content-action"
                  type="button"
                  disabled={pending || disabled || !canPrepare}
                  onClick={() => void prepare(segment)}
                >
                  Review generation
                </button>
              )}
              {segment.jobId &&
                (!job || ["queued", "processing", "submitting", "ready"].includes(job.status)) && (
                  <button
                    className="content-action"
                    type="button"
                    disabled={pending || disabled}
                    onClick={() =>
                      void run(async () => {
                        updateJob(await getHeyGenGeneration({ data: { jobId: segment.jobId! } }));
                      })
                    }
                  >
                    {job?.status === "ready" ? "Refresh clip access" : "Refresh status"}
                  </button>
                )}
              {job?.status === "awaiting_approval" && (
                <button
                  className="content-action content-action-primary"
                  type="button"
                  disabled={pending || disabled}
                  onClick={() =>
                    void run(async () => {
                      updateJob(await approveHeyGenGeneration({ data: { jobId: job.jobId } }));
                    })
                  }
                >
                  Approve estimated ${job.estimatedUsd.toFixed(2)}
                </button>
              )}
              {job?.status === "approved" && (
                <button
                  className="content-action content-action-primary"
                  type="button"
                  disabled={pending || disabled}
                  onClick={() =>
                    void run(async () => {
                      try {
                        updateJob(await startHeyGenGeneration({ data: { jobId: job.jobId } }));
                      } finally {
                        void queryClient.invalidateQueries({
                          queryKey: jobKey(workspaceId, job.jobId),
                        });
                      }
                    })
                  }
                >
                  Generate with HeyGen
                </button>
              )}
              {job && ["failed", "revoked", "expired"].includes(job.status) && (
                <button
                  className="content-action"
                  type="button"
                  disabled={pending || disabled || !canPrepare}
                  onClick={() => void prepare(segment, true)}
                >
                  Review a new attempt
                </button>
              )}
              {segment.jobId && (
                <button
                  className="content-action"
                  type="button"
                  disabled={pending || disabled}
                  onClick={() => {
                    const ids = new Set(segment.sceneIds);
                    onChange({
                      ...document,
                      scenes: document.scenes.map((scene) =>
                        ids.has(scene.id) ? { ...scene, avatarJobId: null } : scene,
                      ),
                    });
                  }}
                >
                  Unlink segment
                </button>
              )}
            </div>
          </article>
        );
      })}
    </section>
  );
}
