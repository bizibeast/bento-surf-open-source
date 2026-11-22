import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Download,
  Film,
  Layers,
  LoaderCircle,
  MessageSquare,
} from "lucide-react";
import { getChatContentArtifact } from "@/lib/content-chat.functions";
import {
  getLatestStudioReelProduction,
  prepareStudioReelProduction,
  approveStudioReelProduction,
  cancelStudioReelProduction,
  previewStudioReelProduction,
  approveStudioReelForScheduler,
} from "@/lib/content-reel-production.functions";
import { usePageActivity } from "@/hooks/use-page-activity";
import { pagePollInterval } from "@/lib/page-poll";
import { micro } from "@/lib/micro-app-ui";
import { ChatCarouselArtifact } from "./ChatCarouselArtifact";
import { ChatVideoPreview } from "./ChatVideoPreview";

const active = ["queued", "narrating", "avatars", "rendering"];
const labels: Record<string, string> = {
  awaiting_approval: "Ready to create",
  queued: "Waiting in queue",
  narrating: "Recording your narration",
  avatars: "Creating your visuals",
  rendering: "Putting the final edit together",
  ready: "Ready to watch",
  failed: "Needs attention",
  needs_revision: "Ready for a revision",
  cancelled: "Creation cancelled",
};
export function ChatContentArtifact({
  workspaceId,
  entryId,
  onRevise,
}: {
  workspaceId: string;
  entryId: string;
  onRevise?: (id: string, title: string) => void;
}) {
  const client = useQueryClient();
  const activity = usePageActivity();
  const [publishingApproved, setPublishingApproved] = useState<string>();
  const [failedPreview, setFailedPreview] = useState<string>();
  const request = useRef({ revision: 0, id: crypto.randomUUID() });
  const artifact = useQuery({
    queryKey: ["chat-content-artifact", workspaceId, entryId],
    queryFn: () => getChatContentArtifact({ data: { workspaceId, entryId } }),
    retry: false,
  });
  const entry = artifact.data;
  const key = ["reel-production", workspaceId, entryId];
  const production = useQuery({
    queryKey: key,
    enabled: entry?.format === "reel" && entry.kind === "project",
    queryFn: () => getLatestStudioReelProduction({ data: { workspaceId, entryId } }),
    retry: false,
    refetchInterval: (q) =>
      active.includes(q.state.data?.job?.status || "")
        ? pagePollInterval(5000, activity, { idleMs: 30000 })
        : false,
    refetchIntervalInBackground: false,
  });
  const renderedRevision = production.data?.job?.renderRevision;
  const productionStatus = production.data?.job?.status;
  const entryRevision = entry?.revision;
  const refreshingRevision = Boolean(
    productionStatus === "ready" &&
    entryRevision !== undefined &&
    renderedRevision &&
    renderedRevision > entryRevision,
  );
  useEffect(() => {
    // Production saves its resolved assets as a newer revision before marking the video ready.
    if (refreshingRevision)
      void client.invalidateQueries({ queryKey: ["chat-content-artifact", workspaceId, entryId] });
  }, [client, workspaceId, entryId, refreshingRevision]);
  // Never preview or approve a render of an obsolete saved revision.
  const job =
    (production.data?.job?.renderRevision ?? production.data?.job?.revision) === entry?.revision
      ? production.data?.job
      : null;
  const preview = useQuery({
    queryKey: ["reel-preview", workspaceId, job?.id],
    enabled: job?.status === "ready",
    queryFn: () => previewStudioReelProduction({ data: { workspaceId, productionId: job!.id } }),
    retry: false,
    staleTime: 10 * 60_000,
    refetchInterval: job?.status === "ready" ? 10 * 60_000 : false,
    refetchIntervalInBackground: false,
  });
  const previewKey = `${job?.id}:${preview.dataUpdatedAt}`;
  const action = useMutation({
    mutationFn: async (intent: "prepare" | "approve" | "cancel" | "publishing") => {
      if (!entry) throw new Error("Refresh this content before continuing.");
      if (intent === "prepare") {
        if (request.current.revision !== entry.revision)
          request.current = { revision: entry.revision, id: crypto.randomUUID() };
        await prepareStudioReelProduction({
          data: { workspaceId, entryId, revision: entry.revision, requestId: request.current.id },
        });
      } else if (job && intent === "publishing") {
        await approveStudioReelForScheduler({ data: { workspaceId, productionId: job.id } });
        setPublishingApproved(job.id);
      } else if (job) {
        await (intent === "approve" ? approveStudioReelProduction : cancelStudioReelProduction)({
          data: { workspaceId, productionId: job.id },
        });
      }
    },
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  if (artifact.isPending)
    return (
      <p role="status" className="py-4 text-sm text-muted-foreground">
        Opening your content…
      </p>
    );
  if (artifact.isError)
    return (
      <div role="alert" className="my-4 rounded-2xl border border-border p-5 text-sm">
        <p>This content is unavailable.</p>
        <button
          type="button"
          className={`${micro.btnSoft} mt-3`}
          onClick={() => void artifact.refetch()}
        >
          Try again
        </button>
      </div>
    );
  if (!entry) return null;
  const isReady = job?.status === "ready";
  const Icon = entry.format === "reel" ? Film : Layers;
  const duration = job?.duration ?? entry.duration;
  const outline =
    entry.kind !== "preset" && (entry.outline?.length || entry.summary) ? (
      <details
        className="group rounded-xl border border-border/70"
        open={!isReady && !job?.status?.match(/queued|narrating|avatars|rendering/)}
      >
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
          {entry.format === "reel" ? "Script and visual plan" : "Carousel copy"}
          <ChevronDown
            className="size-4 shrink-0 text-muted-foreground group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <div
          role="region"
          aria-label={entry.format === "reel" ? "Script and visual plan" : "Carousel copy"}
          tabIndex={0}
          className="max-h-80 overflow-y-auto border-t border-border/70 px-4 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {entry.outline?.length ? (
            <ol className="divide-y divide-border/60">
              {entry.outline.map((part, index) => (
                <li key={index} className="space-y-1.5 py-3.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <h4 className="text-sm font-medium">
                      {part.heading ||
                        `${entry.format === "reel" ? "Scene" : "Slide"} ${index + 1}`}
                    </h4>
                    {part.duration != null && (
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {Math.round(part.duration * 10) / 10}s
                      </span>
                    )}
                  </div>
                  {part.text && (
                    <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                      {part.text}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="whitespace-pre-wrap py-3 text-sm leading-6 text-muted-foreground">
              {entry.summary}
            </p>
          )}
        </div>
      </details>
    ) : null;
  return (
    <section
      aria-label="Your content"
      className="my-4 min-w-0 overflow-hidden rounded-2xl border border-border bg-card shadow-sm"
    >
      <header className="flex items-start gap-3 p-4 sm:p-5">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted/70">
          <Icon className="size-5 text-foreground/75" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-xs text-muted-foreground">
            {entry.format === "reel" ? "Reel" : "Carousel"}
            {duration ? ` · ${Math.round(duration)} sec` : ""}
          </p>
          <h3 className="break-words text-base font-semibold leading-6">{entry.title}</h3>
        </div>
        <span
          role="status"
          className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
        >
          {isReady && <Check className="size-3" aria-hidden="true" />}
          {entry.kind === "preset"
            ? "Style saved"
            : entry.format === "reel"
              ? job
                ? active.includes(job.status)
                  ? "Creating"
                  : labels[job.status] || "Checking"
                : refreshingRevision
                  ? "Opening preview"
                  : "Draft"
              : "Slides"}
        </span>
      </header>
      {entry.kind === "preset" ? (
        <p className="px-4 pb-5 text-sm text-muted-foreground sm:px-5">
          Your reusable style is saved. Ask Benny to use it in your next creation.
        </p>
      ) : entry.format === "carousel" ? (
        <div className="space-y-4 px-4 pb-5 sm:px-5">
          <ChatCarouselArtifact
            workspaceId={workspaceId}
            entryId={entryId}
            revision={entry.revision}
          />
          {outline}
        </div>
      ) : (
        <>
          {isReady && (
            <div className="border-y border-border/70 bg-muted/25 p-4 sm:p-5">
              {preview.isPending && (
                <div
                  role="status"
                  className="mx-auto flex aspect-[9/16] w-full max-w-[320px] items-center justify-center rounded-xl bg-muted text-sm text-muted-foreground"
                >
                  <LoaderCircle
                    className="mr-2 size-4 motion-safe:animate-spin"
                    aria-hidden="true"
                  />
                  Opening your preview…
                </div>
              )}
              {preview.data && (
                <ChatVideoPreview
                  key={previewKey}
                  src={preview.data.previewUrl}
                  reloading={preview.isFetching}
                  onReload={() => void preview.refetch()}
                  onPlaybackError={() => setFailedPreview(previewKey)}
                />
              )}
              {preview.isError && (
                <div role="alert" className="py-12 text-center text-sm">
                  <p>Your video is saved, but the preview couldn’t be loaded.</p>
                  <button
                    type="button"
                    className={`${micro.btnSoft} mt-3`}
                    disabled={preview.isFetching}
                    onClick={() => void preview.refetch()}
                  >
                    Reload video preview
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="space-y-4 p-4 pt-0 sm:p-5 sm:pt-0">
            {isReady && (
              <div className="flex items-center justify-between gap-3 pt-4 text-xs text-muted-foreground">
                <span>Private preview · Review before posting</span>
                {preview.data && (
                  <a
                    className="inline-flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap font-medium text-foreground hover:underline"
                    href={preview.data.previewUrl}
                    download={`${entry.title.replace(/[^a-zA-Z0-9 -]/g, "").slice(0, 80) || "video"}.mp4`}
                  >
                    <Download className="size-3.5" aria-hidden="true" />
                    Download video
                  </a>
                )}
              </div>
            )}
            {production.isPending && (
              <p role="status" className="text-sm text-muted-foreground">
                Checking your video…
              </p>
            )}
            {refreshingRevision && (
              <p role="status" className="text-sm text-muted-foreground">
                Opening your latest video…
              </p>
            )}
            {production.isError && (
              <p role="alert" className="text-sm">
                Video status could not be loaded.{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => void production.refetch()}
                >
                  Try again
                </button>
              </p>
            )}
            {job && active.includes(job.status) && (
              <div className="rounded-xl bg-muted/45 p-4">
                <p role="status" className="mb-4 flex items-center gap-2 text-sm font-medium">
                  <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                  {labels[job.status]}
                </p>
                <ol aria-label="Video creation progress" className="space-y-3">
                  {["Narration", "Visuals", "Final edit"].map((step, index) => {
                    const stage = active.indexOf(job.status) - 1;
                    return (
                      <li
                        key={step}
                        className={`flex items-center gap-2.5 text-xs ${index <= stage ? "text-foreground" : "text-muted-foreground"}`}
                      >
                        <span
                          className={`grid size-4 place-items-center rounded-full border ${index < stage ? "border-foreground bg-foreground text-background" : "border-current"}`}
                        >
                          {index < stage && <Check className="size-2.5" aria-hidden="true" />}
                        </span>
                        {step}
                        {index < stage && <span className="sr-only"> complete</span>}
                        {index === stage && <span className="sr-only"> in progress</span>}
                      </li>
                    );
                  })}
                </ol>
                <p className="mt-4 text-xs leading-5 text-muted-foreground">
                  You can keep chatting. Your playable preview will appear here when it’s ready.
                </p>
              </div>
            )}
            {outline}
            {job?.status === "awaiting_approval" && (
              <div className="space-y-3 rounded-xl bg-muted/45 p-4 text-sm">
                <p className="font-medium">Your script is ready. Bring it to life?</p>
                <p className="leading-6 text-muted-foreground">
                  {job.duration.toFixed(0)} seconds · {job.avatarSeconds} seconds of new avatar
                  footage. This uses your included allowance. Paid attempts count toward usage.
                </p>
                <button
                  type="button"
                  className={micro.btnPrimary}
                  disabled={action.isPending}
                  onClick={() => action.mutate("approve")}
                >
                  {action.isPending
                    ? "Starting…"
                    : `Create video · up to $${(Math.ceil(job.estimatedMicrousd / 10000) / 100).toFixed(2)}`}
                </button>
              </div>
            )}
            {isReady &&
              (publishingApproved === job.id || job.mediaIds?.length ? (
                <p role="status" className="text-sm leading-6">
                  Video approved. Tell Benny where and when to post it. Nothing has been published.
                </p>
              ) : (
                <button
                  type="button"
                  className={micro.btnPrimary}
                  disabled={
                    action.isPending ||
                    !preview.data ||
                    preview.isError ||
                    failedPreview === previewKey
                  }
                  onClick={() => action.mutate("publishing")}
                >
                  {action.isPending ? "Approving…" : "Approve video for publishing"}
                </button>
              ))}
            {production.data?.available &&
              !refreshingRevision &&
              (!job || ["failed", "needs_revision", "cancelled"].includes(job.status)) && (
                <button
                  type="button"
                  className={micro.btnSoft}
                  disabled={action.isPending}
                  onClick={() => action.mutate("prepare")}
                >
                  {action.isPending ? "Preparing…" : "Prepare video"}
                </button>
              )}
            {job && (active.includes(job.status) || job.status === "awaiting_approval") && (
              <button
                type="button"
                className={`${micro.btnSoft} text-xs text-muted-foreground`}
                disabled={action.isPending}
                onClick={() => action.mutate("cancel")}
              >
                Cancel remaining creation
              </button>
            )}
            {job?.errorCode && (
              <p className="text-sm leading-6 text-muted-foreground">
                Your completed assets are saved. Ask Benny to revise this video before trying again.
              </p>
            )}
          </div>
        </>
      )}
      {(onRevise || action.isError) && (
        <footer className="border-t border-border/70 px-4 py-3 sm:px-5">
          {onRevise && (
            <button
              type="button"
              className={`${micro.btnSoft} text-sm`}
              onClick={() => onRevise(entryId, entry.title)}
            >
              <MessageSquare className="size-4" aria-hidden="true" />
              Request changes
            </button>
          )}
          {action.isError && (
            <p role="alert" className="mt-2 text-sm">
              {action.error.message}
            </p>
          )}
        </footer>
      )}
    </section>
  );
}
