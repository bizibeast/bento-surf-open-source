import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { getStudioCarouselJob, startStudioCarouselJob } from "@/lib/studio-carousel-jobs.functions";
import { openStudioSchedulerDraft } from "@/lib/content-studio.functions";

export function StudioCarouselBackground({
  workspaceId,
  entryId,
  revision,
  title,
  format,
  requiresPhoto,
}: {
  workspaceId: string;
  entryId: string;
  revision: number;
  title: string;
  format: "carousel" | "reel";
  requiresPhoto: boolean;
}) {
  const input = { workspaceId, entryId, revision, format };
  const queryKey = ["studio-background-render", workspaceId, entryId, revision, format];
  const label = format === "reel" ? "Reel" : "Carousel";
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string>();
  const status = useQuery({
    queryKey,
    queryFn: () => getStudioCarouselJob({ data: input }),
    retry: false,
    refetchInterval: (query) =>
      ["queued", "rendering"].includes(query.state.data?.job?.status || "") ? 5_000 : false,
  });
  const submit = useMutation({
    mutationFn: () => startStudioCarouselJob({ data: input }),
    onSuccess: (job) =>
      queryClient.setQueryData(queryKey, { ...status.data, available: true, job }),
  });
  if (!status.data?.available || (requiresPhoto && !status.data.photosAvailable)) return null;
  const job = status.data.job;
  const cost = status.data.costMicrousd;
  async function open() {
    if (job?.status !== "ready" || opening) return;
    setOpening(true);
    setOpenError(undefined);
    try {
      const { postId } = await openStudioSchedulerDraft({
        data: { workspaceId, requestId: job.id, mediaIds: job.media_ids, title },
      });
      void queryClient.invalidateQueries({ queryKey: ["social-scheduler"] });
      await navigate({ to: "/post-scheduler", search: { postId } });
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : "The Scheduler draft could not open.");
    } finally {
      setOpening(false);
    }
  }
  return (
    <div className="studio-actions" aria-label={`Background ${format} export`}>
      {(!job || job.status === "queued") && (
        <>
          <button
            type="button"
            className="content-action"
            disabled={submit.isPending}
            onClick={() => submit.mutate()}
          >
            {job ? "Resume queued export" : "Render in background and save to Media"}
          </button>
          {cost && !job && (
            <p className="studio-muted">
              Uses{" "}
              {new Intl.NumberFormat("en-US", {
                style: "currency",
                currency: "USD",
                maximumFractionDigits: 6,
              }).format(cost / 1_000_000)}{" "}
              of your Fully Managed allowance per attempt.
            </p>
          )}
        </>
      )}
      {job?.status === "queued" && (
        <p role="status" className="studio-muted">
          {label} export queued.
        </p>
      )}
      {job?.status === "rendering" && (
        <p role="status" className="studio-muted">
          Rendering your {label} in the background.
        </p>
      )}
      {job?.status === "failed" && (
        <p role="status" className="studio-muted">
          The background render stopped. Try rendering in this browser, or save a new revision.
        </p>
      )}
      {job?.status === "ready" && (
        <>
          <p role="status" className="studio-muted">
            {label} saved to Media.
          </p>
          <button
            type="button"
            className="content-action"
            disabled={opening}
            onClick={() => void open()}
          >
            Open background export in Scheduler
          </button>
        </>
      )}
      {(openError || submit.error) && (
        <p role="alert" className="studio-muted">
          {openError || submit.error?.message}
        </p>
      )}
    </div>
  );
}
