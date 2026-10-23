import { useEffect, useRef, useState } from "react";
import {
  attachAgentDraftImage,
  clearAgentDraftBackgrounds,
  getAgentDraftImages,
  getContentImageSettings,
  getContentExistingPhotos,
  requestDraftImage,
} from "@/lib/content-agent-images.functions";
import type { ImageDraftRef } from "@/lib/content-agent-images.server";

type DraftImages = Awaited<ReturnType<typeof getAgentDraftImages>>;
export function ContentDraftImages({
  draftRef,
  showPreview = true,
  compact = false,
  slideCount,
  onChanged,
  onAssets,
  onReady,
}: {
  draftRef: ImageDraftRef;
  showPreview?: boolean;
  compact?: boolean;
  slideCount: number;
  onChanged?: () => void | Promise<unknown>;
  onAssets: (assets: Record<string, string>) => void;
  onReady?: (ready: boolean) => void;
}) {
  const [state, setState] = useState<DraftImages>();
  const [imageSettings, setImageSettings] =
    useState<Awaited<ReturnType<typeof getContentImageSettings>>>();
  const available = Boolean(imageSettings?.available);
  const [photos, setPhotos] = useState<Awaited<ReturnType<typeof getContentExistingPhotos>>>([]);
  const [selecting, setSelecting] = useState(false);
  const [slideIndex, setSlideIndex] = useState(0);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const requestKey = useRef<string | undefined>(undefined);
  const { messageId, cardId, revision } = draftRef;
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let previousReady = "";
    onReady?.(false);
    async function refresh() {
      try {
        const value = await getAgentDraftImages({ data: { messageId, cardId, revision } });
        if (cancelled) return;
        setState(value);
        onAssets(value.assets);
        onReady?.(!value.missingMediaIds?.length);
        const settings = await getContentImageSettings();
        if (!cancelled) setImageSettings(settings);
        const ready = value.jobs
          .filter((j) => j.status === "ready")
          .map((j) => j.id)
          .join();
        if (ready && ready !== previousReady) await onChanged?.();
        previousReady = ready;
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Image previews unavailable.");
          onReady?.(false);
          if (e instanceof Error && /Draft changed/.test(e.message)) await onChanged?.();
        }
      }
      if (!cancelled) timer = setTimeout(refresh, 15000);
    }
    void refresh();
    void getContentImageSettings()
      .then((v) => {
        if (!cancelled) setImageSettings(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Draft ownership/revision changes must refetch URLs before an export is enabled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId, cardId, revision]);
  async function act(work: () => Promise<unknown>) {
    setPending(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Image action failed.");
    } finally {
      setPending(false);
    }
  }
  return (
    <section aria-label="Draft images" className="my-3 space-y-3">
      {showPreview &&
        slideCount === 0 &&
        state &&
        Object.entries(state.assets).map(([id, url]) => (
          <img
            key={id}
            src={url}
            alt="Photo attached to this draft"
            className="max-h-80 max-w-full rounded-xl object-contain"
          />
        ))}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="content-action"
          disabled={pending || !available}
          title={
            !available
              ? "AI images are unavailable for this workspace"
              : "Generate an image using your image allowance"
          }
          onClick={() =>
            void act(async () => {
              requestKey.current ||= crypto.randomUUID();
              await requestDraftImage({
                data: { draftRef, requestKey: requestKey.current, slideIndex },
              });
              requestKey.current = undefined;
              setState(await getAgentDraftImages({ data: draftRef }));
              setImageSettings(await getContentImageSettings());
            })
          }
        >
          {state?.jobs.some((j) => j.mediaId) ? "Replace AI image" : "Generate AI image"}
        </button>
        <button
          type="button"
          className="content-action"
          disabled={pending}
          onClick={() =>
            void act(async () => {
              setPhotos(await getContentExistingPhotos());
              setSelecting(true);
            })
          }
        >
          Use existing photo
        </button>
        {slideCount > 1 && (
          <label className="text-xs">
            Image for slide{" "}
            <select
              aria-label="Image for slide"
              className="content-field"
              value={slideIndex}
              onChange={(e) => setSlideIndex(Number(e.target.value))}
            >
              {Array.from({ length: slideCount }, (_, i) => (
                <option key={i} value={i}>
                  {i + 1}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {state?.missingMediaIds?.length ? (
        <p role="alert" className="text-xs text-red-700">
          An attached photo is unavailable. Replace it, or remove all slide backgrounds if several
          need repair, before exporting.
        </p>
      ) : null}
      {slideCount > 1 &&
        state &&
        (Object.keys(state.assets).length > 0 || Boolean(state.missingMediaIds?.length)) && (
          <button
            type="button"
            className="content-action"
            disabled={pending}
            onClick={() =>
              void act(async () => {
                await clearAgentDraftBackgrounds({ data: draftRef });
                await onChanged?.();
              })
            }
          >
            Remove all slide backgrounds
          </button>
        )}
      {imageSettings && !compact && (
        <p className="text-xs">
          {imageSettings.quota.successful} / 100 successful · {imageSettings.quota.pending} pending.
          Resets{" "}
          {new Date(imageSettings.quota.resetAt).toLocaleDateString(undefined, { timeZone: "UTC" })}{" "}
          UTC. Each replacement uses one image credit.
        </p>
      )}
      {!available && !compact && (
        <p className="text-xs text-muted-foreground">
          AI images are unavailable for this workspace. Existing photos can still be used.
        </p>
      )}
      {state?.parentPending && (
        <p className="text-xs">
          This revision reuses its earlier visual when available. An image still generating on the
          earlier draft can be attached here after it finishes; replacing it uses another credit.
        </p>
      )}
      {selecting && (
        <div className="flex flex-wrap gap-2" aria-label="Choose an existing photo">
          {!photos.length && (
            <p className="text-xs">
              No ready indexed photos. Import a photo from a connected account first.
            </p>
          )}
          {photos.map((photo) => (
            <button
              key={photo.id}
              type="button"
              disabled={pending}
              className="content-action"
              onClick={() =>
                void act(async () => {
                  await attachAgentDraftImage({
                    data: { draftRef, mediaId: photo.id, slideIndex },
                  });
                  setSelecting(false);
                  await onChanged?.();
                })
              }
            >
              <img src={photo.url} alt="Owned photo" className="size-20 object-cover" />
              <span>Use this photo</span>
            </button>
          ))}
          <button type="button" className="content-action" onClick={() => setSelecting(false)}>
            Cancel
          </button>
        </div>
      )}
      {state?.jobs.map((job) => (
        <div key={job.id} className="space-y-2">
          <p role="status" className="text-xs">
            {job.status === "storage_pending"
              ? "Generated · saving image (counted this month)"
              : job.status === "ambiguous"
                ? "Awaiting provider reconciliation · quota reserved"
                : job.detail || job.status}
          </p>
          {job.detail && ["storage_pending", "ambiguous"].includes(job.status) && (
            <p className="text-xs">{job.detail}</p>
          )}
          {job.url && (
            <>
              <img
                src={job.url}
                alt="Generated draft image preview"
                className="max-h-64 rounded-lg"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  className="content-action"
                  disabled={pending}
                  onClick={() =>
                    void act(async () => {
                      const response = await fetch(job.url!);
                      if (!response.ok) throw new Error("Download unavailable.");
                      const blob = await response.blob();
                      const url = URL.createObjectURL(blob);
                      const link = document.createElement("a");
                      link.href = url;
                      link.download = "bento-image.jpg";
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(url), 10000);
                    })
                  }
                >
                  Download image
                </button>
                <button
                  type="button"
                  className="content-action"
                  disabled={pending}
                  onClick={() =>
                    void act(async () => {
                      await attachAgentDraftImage({
                        data: { draftRef, mediaId: job.mediaId, slideIndex },
                      });
                      await onChanged?.();
                    })
                  }
                >
                  Attach image
                </button>
              </div>
            </>
          )}
        </div>
      ))}
      {slideCount > 1 && (
        <p className="text-xs text-muted-foreground">
          Photos become slide backgrounds. Your agent prepares the finished carousel for review.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
