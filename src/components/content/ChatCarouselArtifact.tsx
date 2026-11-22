import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, Layers, LoaderCircle } from "lucide-react";
import { getStudioCarouselJob, startStudioCarouselJob } from "@/lib/studio-carousel-jobs.functions";
import { listContentStudioMedia } from "@/lib/content-studio.functions";
import { usePageActivity } from "@/hooks/use-page-activity";
import { pagePollInterval } from "@/lib/page-poll";
import { micro } from "@/lib/micro-app-ui";
export function ChatCarouselArtifact({
  workspaceId,
  entryId,
  revision,
}: {
  workspaceId: string;
  entryId: string;
  revision: number;
}) {
  const client = useQueryClient();
  const activity = usePageActivity();
  const [selection, setSelection] = useState({ jobId: "", index: 0 });
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const input = { workspaceId, entryId, revision, format: "carousel" as const };
  const key = ["studio-background-render", workspaceId, entryId, revision, "carousel"];
  const status = useQuery({
    queryKey: key,
    queryFn: () => getStudioCarouselJob({ data: input }),
    retry: false,
    refetchInterval: (q) =>
      ["queued", "rendering"].includes(q.state.data?.job?.status || "")
        ? pagePollInterval(5000, activity, { idleMs: 30000 })
        : false,
    refetchIntervalInBackground: false,
  });
  const job = status.data?.job;
  const media = useQuery({
    queryKey: ["chat-carousel-media", workspaceId, job?.id],
    enabled: job?.status === "ready",
    queryFn: () =>
      listContentStudioMedia({ data: { workspaceId, page: 0, selectedIds: job!.media_ids } }),
    retry: false,
  });
  const create = useMutation({
    mutationFn: () => startStudioCarouselJob({ data: input }),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  const index =
    selection.jobId === job?.id
      ? Math.min(selection.index, Math.max(0, (job?.media_ids.length ?? 1) - 1))
      : 0;
  const selected = media.data?.assets.find((asset) => asset.id === job?.media_ids[index]);
  const select = (next: number) => {
    if (job)
      setSelection({ jobId: job.id, index: Math.max(0, Math.min(next, job.media_ids.length - 1)) });
  };
  return (
    <div className="space-y-3">
      {job?.status === "ready" ? (
        <>
          <div className="overflow-hidden rounded-xl border border-border/70 bg-muted/25">
            <div
              aria-label="Carousel preview"
              aria-roledescription="carousel"
              role="region"
              tabIndex={0}
              className="touch-pan-y px-4 py-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
              onTouchStart={(event) => {
                const touch = event.touches[0];
                touchStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
              }}
              onTouchCancel={() => {
                touchStart.current = null;
              }}
              onTouchEnd={(event) => {
                const start = touchStart.current;
                touchStart.current = null;
                const end = event.changedTouches[0];
                if (!start || !end) return;
                const dx = end.clientX - start.x;
                if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(end.clientY - start.y) * 1.5)
                  select(index + (dx < 0 ? 1 : -1));
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                  event.preventDefault();
                  select(index + (event.key === "ArrowRight" ? 1 : -1));
                }
              }}
            >
              {selected ? (
                <img
                  key={selected.id}
                  src={selected.url}
                  alt={`Slide ${index + 1}`}
                  className="mx-auto aspect-[4/5] w-full max-w-[360px] rounded-lg object-contain shadow-sm"
                />
              ) : (
                <div
                  role="status"
                  className="mx-auto flex aspect-[4/5] w-full max-w-[360px] items-center justify-center rounded-lg bg-muted px-5 text-center text-sm text-muted-foreground"
                >
                  {media.isPending
                    ? "Opening your slides…"
                    : "This slide is unavailable. Try reloading the preview."}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-border/70 bg-card px-3 py-2">
              <button
                type="button"
                aria-label="Previous slide"
                className="grid size-10 place-items-center rounded-lg hover:bg-muted disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                disabled={index === 0 || !job.media_ids.length}
                onClick={() => select(index - 1)}
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
              </button>
              <p
                role="status"
                aria-live="polite"
                className="text-xs tabular-nums text-muted-foreground"
              >
                {job.media_ids.length
                  ? `Slide ${index + 1} of ${job.media_ids.length}`
                  : "No slides available"}
              </p>
              <button
                type="button"
                aria-label="Next slide"
                className="grid size-10 place-items-center rounded-lg hover:bg-muted disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                disabled={index >= job.media_ids.length - 1}
                onClick={() => select(index + 1)}
              >
                <ChevronRight className="size-4" aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Choose a slide">
            {job.media_ids.map((id, i) => {
              const asset = media.data?.assets.find((a) => a.id === id);
              return (
                <button
                  type="button"
                  key={id}
                  aria-label={`View slide ${i + 1}`}
                  aria-current={i === index ? "true" : undefined}
                  onClick={() => select(i)}
                  className={`relative h-16 w-12 shrink-0 overflow-hidden rounded-md border-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${index === i ? "border-foreground" : "border-transparent opacity-60 hover:opacity-100"}`}
                >
                  {asset ? (
                    <img
                      src={asset.url}
                      alt=""
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="grid h-full place-items-center bg-muted text-xs">{i + 1}</span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <p>Review the slides, then tell Benny what to change.</p>
            {selected && (
              <a
                href={selected.url}
                download
                className="inline-flex min-h-10 items-center gap-1.5 font-medium text-foreground hover:underline"
              >
                <Download className="size-3.5" aria-hidden="true" />
                Download slide {index + 1}
              </a>
            )}
          </div>
          {!media.isPending && (!selected || !job.media_ids.length) && !media.isError && (
            <button
              type="button"
              className={micro.btnSoft}
              disabled={media.isFetching}
              onClick={() => void media.refetch()}
            >
              Reload slides
            </button>
          )}
        </>
      ) : job ? (
        <div role="status" className="flex items-start gap-3 rounded-xl bg-muted/45 p-4 text-sm">
          {job.status !== "failed" && (
            <LoaderCircle
              className="mt-0.5 size-4 shrink-0 motion-safe:animate-spin"
              aria-hidden="true"
            />
          )}
          <p>
            {job.status === "failed"
              ? "The carousel stopped. Ask Benny to revise it before retrying."
              : "Creating your carousel. The slides will appear here when they’re ready."}
          </p>
        </div>
      ) : status.data?.available ? (
        <div className="space-y-3 rounded-xl bg-muted/45 p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Layers className="size-4" aria-hidden="true" />
            Your carousel draft is saved
          </p>
          <p className="text-sm leading-6 text-muted-foreground">
            Create the slides to review them right here.
          </p>
          <button
            type="button"
            className={micro.btnSoft}
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Starting…" : "Create carousel"}
          </button>
          {status.data.costMicrousd && (
            <p className="text-xs text-muted-foreground">
              Uses up to ${(status.data.costMicrousd / 1_000_000).toFixed(4)} of your included
              allowance per attempt.
            </p>
          )}
        </div>
      ) : status.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Checking your slides…
        </p>
      ) : null}
      {(status.isError || media.isError) && (
        <p role="alert" className="text-sm">
          Your carousel preview could not be loaded.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => {
              void status.refetch();
              if (job?.status === "ready") void media.refetch();
            }}
          >
            Try again
          </button>
        </p>
      )}
      {create.isError && (
        <p role="alert" className="text-sm">
          {create.error.message}
        </p>
      )}
    </div>
  );
}
