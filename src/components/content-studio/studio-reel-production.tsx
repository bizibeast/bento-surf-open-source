import { useRef, useState } from "react";
import { AvatarLookGallery } from "./avatar-look-gallery";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  getLatestStudioReelProduction,
  prepareStudioReelProduction,
  approveStudioReelProduction,
  cancelStudioReelProduction,
  previewStudioReelProduction,
  approveStudioReelForScheduler,
} from "@/lib/content-reel-production.functions";
import { listHeyGenAvatars, listHeyGenVoices } from "@/lib/external-tools.functions";
import type { StudioEntry, StudioReel } from "@/lib/content-studio";

const active = ["queued", "narrating", "avatars", "rendering"];
const dollars = (microusd: number) => (Math.ceil(microusd / 10_000) / 100).toFixed(2);
const labels: Record<string, string> = {
  awaiting_approval: "Ready for your approval",
  queued: "Production queued",
  narrating: "Creating narration",
  avatars: "Creating visible avatar segments",
  rendering: "Rendering your video",
  ready: "Your video is ready",
  failed: "Production stopped",
  needs_revision: "Review the script or estimate",
  cancelled: "Production cancelled",
};

export function StudioReelProduction({
  workspaceId,
  entry,
  document,
  onChange,
  onPersist,
}: {
  workspaceId: string;
  entry: StudioEntry;
  document: StudioReel;
  onChange: (document: StudioReel) => void;
  onPersist: () => Promise<StudioEntry>;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const request = useRef({ signature: "", id: crypto.randomUUID() });
  const [scope, setScope] = useState<"private" | "public">("private");
  const [choices, setChoices] = useState<{
    avatars: Awaited<ReturnType<typeof listHeyGenAvatars>>;
    voices: Awaited<ReturnType<typeof listHeyGenVoices>>;
  }>();
  const key = ["reel-production", workspaceId, entry.id];
  const query = useQuery({
    queryKey: key,
    queryFn: () => getLatestStudioReelProduction({ data: { workspaceId, entryId: entry.id } }),
    retry: false,
    refetchInterval: (query) =>
      active.includes(query.state.data?.job?.status || "") ? 5_000 : false,
  });
  const job = query.data?.job;
  const pending = Boolean(job && active.includes(job.status));
  const [error, setError] = useState("");
  const preview = useQuery({
    queryKey: ["reel-preview", workspaceId, job?.id],
    enabled: job?.status === "ready",
    retry: false,
    staleTime: 10 * 60_000,
    queryFn: () => previewStudioReelProduction({ data: { workspaceId, productionId: job!.id } }),
  });
  const action = useMutation({
    mutationFn: async (
      action: "prepare" | "approve" | "cancel" | "schedule" | "choices" | "more",
    ) => {
      setError("");
      if (action === "choices" || action === "more") {
        const previous = action === "more" ? choices : undefined;
        const [avatars, voices] = await Promise.all([
          previous && !previous.avatars.nextToken
            ? Promise.resolve(previous.avatars)
            : listHeyGenAvatars({
                data: {
                  billing: "managed",
                  scope,
                  token: previous?.avatars.nextToken || undefined,
                },
              }),
          previous && !previous.voices.nextToken
            ? Promise.resolve(previous.voices)
            : listHeyGenVoices({
                data: { billing: "managed", scope, token: previous?.voices.nextToken || undefined },
              }),
        ]);
        setChoices({
          avatars: {
            ...avatars,
            avatars: [
              ...new Map(
                [...(previous?.avatars.avatars || []), ...avatars.avatars].map((item) => [
                  item.id,
                  item,
                ]),
              ).values(),
            ],
          },
          voices: {
            ...voices,
            voices: [
              ...new Map(
                [...(previous?.voices.voices || []), ...voices.voices].map((item) => [
                  item.id,
                  item,
                ]),
              ).values(),
            ],
          },
        });
        return;
      }
      if (action === "prepare") {
        const saved = await onPersist();
        const signature = JSON.stringify([saved.id, saved.revision, job?.id ?? null]);
        if (request.current.signature !== signature)
          request.current = { signature, id: crypto.randomUUID() };
        await prepareStudioReelProduction({
          data: {
            workspaceId,
            entryId: saved.id,
            revision: saved.revision,
            requestId: request.current.id,
          },
        });
      } else if (job && action === "approve") {
        const saved = await onPersist();
        if (saved.revision !== job.revision)
          throw new Error("Your project changed. Prepare and review a new estimate.");
        await approveStudioReelProduction({ data: { workspaceId, productionId: job.id } });
      } else if (job && action === "cancel")
        await cancelStudioReelProduction({ data: { workspaceId, productionId: job.id } });
      else if (job && action === "schedule") {
        const { postId } = await approveStudioReelForScheduler({
          data: { workspaceId, productionId: job.id },
        });
        await client.invalidateQueries({ queryKey: ["social-scheduler"] });
        await navigate({ to: "/post-scheduler", search: { postId } });
      }
      await client.invalidateQueries({ queryKey: key });
      if (job?.status === "ready")
        await client.invalidateQueries({ queryKey: ["content-studio", workspaceId] });
    },
    onError: (error) =>
      setError(error instanceof Error ? error.message : "This action could not be completed."),
  });
  if (!query.data?.available && !job) return null;
  const busy = action.isPending;
  return (
    <section className="studio-surface space-y-4" aria-label="Managed Reel production">
      <div>
        <h2 className="text-lg font-semibold">Produce your Reel</h2>
        <p className="studio-muted">
          Narration, captions and a finished video. Avatar footage is generated only where the
          avatar appears. Review the estimate before spending your allowance.
        </p>
      </div>
      {!pending && (
        <div className="space-y-3">
          <div className="studio-actions">
            <select
              aria-label="Avatar library"
              className="content-field"
              value={scope}
              onChange={(event) => {
                setScope(event.target.value as typeof scope);
                setChoices(undefined);
              }}
            >
              <option value="private">Your assigned avatars and voices</option>
              <option value="public">Stock avatars and voices</option>
            </select>
            <button
              type="button"
              className="content-action"
              disabled={busy}
              onClick={() => action.mutate("choices")}
            >
              Load avatars and voices
            </button>
          </div>
          {choices && (
            <div className="space-y-4">
              <AvatarLookGallery
                looks={choices.avatars.avatars}
                selectedId={document.avatarId}
                disabled={busy}
                onSelect={(id) =>
                  onChange({
                    ...document,
                    avatarId: id,
                    scenes: document.scenes.map((scene) => ({ ...scene, avatarJobId: null })),
                  })
                }
              />
              <label className="grid gap-2 text-sm">
                Voice
                <select
                  className="content-field"
                  value={document.voiceId}
                  onChange={(event) =>
                    onChange({
                      ...document,
                      voiceId: event.target.value,
                      scenes: document.scenes.map((scene) => ({
                        ...scene,
                        avatarJobId: null,
                        narrationJobId: null,
                      })),
                    })
                  }
                >
                  <option value="">Choose a voice</option>
                  {choices.voices.voices.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {choices && (!choices.avatars.avatars.length || !choices.voices.voices.length) && (
            <p className="studio-muted">
              Only assets authorized for your workspace appear here. A compatible voice is needed
              for narration.
            </p>
          )}
          {(choices?.avatars.nextToken || choices?.voices.nextToken) && (
            <button
              type="button"
              className="content-action"
              disabled={busy}
              onClick={() => action.mutate("more")}
            >
              Load more authorized options
            </button>
          )}
          <button
            type="button"
            className="content-action"
            disabled={busy || !document.voiceId}
            onClick={() => action.mutate("prepare")}
          >
            Prepare production estimate
          </button>
        </div>
      )}
      {job && (
        <div className="space-y-3">
          <p role="status">{labels[job.status] || job.status}</p>
          <p className="studio-muted">
            {job.duration.toFixed(1)}s Reel · {job.avatarSeconds}s new avatar footage planned ·
            approval limit ${dollars(job.estimatedMicrousd)}. Failed paid attempts count toward your
            allowance.
          </p>
          {job.publication && (
            <div className="rounded-xl border p-3 text-sm">
              <p className="font-medium">Publishing draft for review</p>
              <p className="whitespace-pre-wrap">{job.publication.body}</p>
              <p>
                {job.publication.connectionIds.length} connected account(s) ·{" "}
                {job.publication.scheduledAt
                  ? new Date(job.publication.scheduledAt).toLocaleString(undefined, {
                      timeZone: job.publication.timezone,
                    })
                  : "Choose a time in Scheduler"}
              </p>
              <p>
                {job.publication.timezone} · Per-platform captions are preserved for final review.
              </p>
            </div>
          )}
          {job.status === "awaiting_approval" && (
            <button
              className="content-action content-action-primary"
              type="button"
              disabled={busy}
              onClick={() => action.mutate("approve")}
            >
              Approve production · up to ${dollars(job.estimatedMicrousd)}
            </button>
          )}
          {(pending || job.status === "awaiting_approval") && (
            <button
              className="content-action"
              type="button"
              disabled={busy}
              onClick={() => action.mutate("cancel")}
            >
              Cancel remaining production
            </button>
          )}
          {job.errorCode && (
            <p className="studio-muted">
              {job.errorCode === "estimate_changed"
                ? "The measured audio or price exceeded your approval. Review a new estimate; no extra avatar footage was submitted."
                : "Your completed assets are saved. Check the script, available allowance and provider connection before preparing a new attempt."}
            </p>
          )}
          {job.status === "ready" && (
            <>
              {preview.data && (
                <video
                  className="mx-auto max-h-[540px] w-full rounded-xl bg-black"
                  controls
                  playsInline
                  preload="metadata"
                  src={preview.data.previewUrl}
                  aria-label="Finished Reel preview"
                />
              )}
              {(preview.error || preview.data) && (
                <button
                  className="content-action"
                  type="button"
                  onClick={() => void preview.refetch()}
                >
                  Refresh private preview
                </button>
              )}
              <p className="studio-muted">
                Preview your video before approving it. The next step creates a publishing copy and
                opens a draft for caption, account and schedule review.
              </p>
              <button
                className="content-action content-action-primary"
                type="button"
                disabled={busy}
                onClick={() => action.mutate("schedule")}
              >
                Approve video & review scheduling
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
