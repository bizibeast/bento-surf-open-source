import { useEffect, useRef, useState } from "react";
import { Images, Search, Sparkles, Upload, X, LoaderCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Link } from "@tanstack/react-router";
import {
  getSchedulerPhotoLibrary,
  findSchedulerStockPhotos,
  addSchedulerStockPhoto,
  getSchedulerImageSettings,
  generateSchedulerImage,
  getSchedulerImageJob,
} from "@/lib/scheduler-assist.functions";
import { uploadFileResult } from "@/lib/upload";
import type { SchedulerMedia } from "@/lib/social-scheduler";
import type { StockPhoto, StockProvider } from "@/lib/scheduler-stock.server";

const stockSources: Record<StockProvider, { name: string; url: string }> = {
  pixabay: { name: "Pixabay", url: "https://pixabay.com" },
  pexels: { name: "Pexels", url: "https://www.pexels.com" },
  commons: {
    name: "Wikimedia Commons (public domain / CC0)",
    url: "https://commons.wikimedia.org",
  },
};

type Source = "upload" | "library" | "stock" | "ai";
const sources = [
  { id: "upload", title: "Upload", detail: "From your device", Icon: Upload },
  { id: "library", title: "Your photos", detail: "Reuse your saved images", Icon: Images },
  { id: "stock", title: "Stock photos", detail: "Free photos for your posts", Icon: Search },
  {
    id: "ai",
    title: "Generate with AI",
    detail: "Use your monthly image allowance",
    Icon: Sparkles,
  },
] as const;

export function SchedulerMediaPicker({
  open,
  onOpenChange,
  onUpload,
  onSelect,
  initialPrompt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpload: () => void;
  onSelect: (media: SchedulerMedia) => boolean | void;
  initialPrompt: string;
}) {
  const [source, setSource] = useState<Source>("library");
  const [photos, setPhotos] = useState<SchedulerMedia[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [stockProvider, setStockProvider] = useState<StockProvider>("commons");
  const [stockProviders, setStockProviders] = useState<StockProvider[]>(["commons"]);
  const [stockPage, setStockPage] = useState(1);
  const [stockAvailable, setStockAvailable] = useState<boolean | null>(null);
  const [stockQuery, setStockQuery] = useState("");
  const [stock, setStock] = useState<StockPhoto[] | null>(null);
  const [prompt, setPrompt] = useState("");
  const [references, setReferences] = useState<SchedulerMedia[]>([]);
  const [selectReferences, setSelectReferences] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof getSchedulerImageSettings>>>();
  const [job, setJob] = useState<Awaited<ReturnType<typeof getSchedulerImageJob>> | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const requestKey = useRef<string | null>(null);
  const referenceUpload = useRef<HTMLInputElement>(null);
  const inputClass =
    "w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30";
  const buttonClass =
    "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-border bg-white px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50";
  async function act(work: () => Promise<unknown>) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setPending(false);
    }
  }
  async function loadPhotos(next?: string) {
    const result = await getSchedulerPhotoLibrary({ data: { cursor: next } });
    setPhotos((old) => (next ? [...old, ...result.photos] : result.photos));
    setCursor(result.cursor);
    setStockAvailable(result.stockAvailable);
    setStockProviders(result.stockProviders);
    if (stockAvailable === null || !result.stockProviders.includes(stockProvider)) {
      setStockProvider(result.stockProvider);
      setStock(null);
      setStockPage(1);
    }
    setLoaded(true);
  }
  useEffect(() => {
    if (!open) return;
    if (!loaded) void act(() => loadPhotos());
    // Library is loaded on demand and paginated; opening the composer does no crawl.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open || source !== "ai") return;
    let stale = false;
    getSchedulerImageSettings()
      .then((result) => {
        if (!stale) setSettings(result);
      })
      .catch((e) => {
        if (!stale) setError(e.message);
      });
    setPrompt((old) => old || initialPrompt.slice(0, 2000));
    return () => {
      stale = true;
    };
  }, [open, source, initialPrompt]);
  useEffect(() => {
    if (!open || !jobId) return;
    let stale = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    async function poll() {
      try {
        const result = await getSchedulerImageJob({ data: { id: jobId! } });
        if (stale) return;
        setJob(result);
        if (["ready", "failed", "ambiguous"].includes(result.status)) {
          const next = await getSchedulerImageSettings();
          if (!stale) setSettings(next);
          return;
        }
        if (++attempts < 30) timer = setTimeout(poll, 10000);
        else
          setError(
            "Your image is still processing. Reopen this panel to check its progress; do not generate a replacement.",
          );
      } catch (e) {
        if (!stale) setError(e instanceof Error ? e.message : "Image status unavailable.");
      }
    }
    void poll();
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [open, jobId]);
  function toggleReference(photo: SchedulerMedia) {
    setReferences((old) =>
      old.some((p) => p.key === photo.key)
        ? old.filter((p) => p.key !== photo.key)
        : [...old, photo].slice(0, 4),
    );
    setConfirmed(false);
  }
  const imageRunning = Boolean(jobId && (!job || !["ready", "failed"].includes(job.status)));
  const quotaRemaining = settings
    ? Math.max(0, settings.quota.limit - settings.quota.successful - settings.quota.pending)
    : 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] w-[calc(100vw-1rem)] max-w-3xl flex-col gap-4 overflow-hidden rounded-3xl bg-[#f7f8fc] p-5 sm:p-6">
        <DialogHeader>
          <DialogTitle className="font-ui-display text-2xl">Pictures for your post</DialogTitle>
          <DialogDescription>
            Choose your own, find a free stock photo, or create something new.
          </DialogDescription>
        </DialogHeader>
        <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Media sources">
          {sources.map(({ id, title, detail, Icon }) => (
            <button
              key={id}
              type="button"
              aria-pressed={source === id}
              title={detail}
              data-hover-guide={detail}
              className={`rounded-2xl border p-3 text-left transition ${source === id ? "border-primary/40 bg-primary/10" : "border-border bg-white hover:bg-accent"}`}
              onClick={() => {
                setSource(id);
                setError("");
                setSelectReferences(false);
                if (id === "upload") {
                  onUpload();
                  onOpenChange(false);
                }
              }}
            >
              <Icon className="mb-2 size-4" />
              <span className="block text-xs font-semibold">{title}</span>
              <span className="mt-1 hidden text-[11px] leading-4 text-muted-foreground sm:block">
                {detail}
              </span>
            </button>
          ))}
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain pr-1">
          {(source === "library" || selectReferences) && (
            <section
              className="space-y-3"
              aria-label={selectReferences ? "Choose reference photos" : "Saved photos"}
            >
              {selectReferences && (
                <p className="text-sm font-medium">
                  Choose up to four reference images.{" "}
                  <button
                    type="button"
                    className="ml-2 text-primary underline"
                    onClick={() => setSelectReferences(false)}
                  >
                    Done
                  </button>
                </p>
              )}
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {photos.map((photo) => (
                  <button
                    key={photo.key}
                    type="button"
                    disabled={
                      pending ||
                      (selectReferences &&
                        references.length === 4 &&
                        !references.some((p) => p.key === photo.key))
                    }
                    className={`overflow-hidden rounded-xl border-2 ${references.some((p) => p.key === photo.key) && selectReferences ? "border-primary" : "border-transparent"}`}
                    title={
                      selectReferences ? "Use as an AI reference" : "Add this photo to the post"
                    }
                    aria-label={`${selectReferences ? "Reference" : "Add"} ${photo.name}`}
                    aria-pressed={
                      selectReferences ? references.some((p) => p.key === photo.key) : undefined
                    }
                    onClick={() => {
                      if (selectReferences) toggleReference(photo);
                      else {
                        if (onSelect(photo) !== false) onOpenChange(false);
                      }
                    }}
                  >
                    <img
                      loading="lazy"
                      src={photo.url}
                      alt={photo.name}
                      className="aspect-square w-full object-cover"
                    />
                  </button>
                ))}
              </div>
              {loaded && !photos.length && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No photos on this page yet. Upload an image
                  {cursor ? " or load the next page" : " to get started"}.
                </p>
              )}
              {cursor && (
                <button
                  type="button"
                  disabled={pending}
                  className={buttonClass}
                  onClick={() => void act(() => loadPhotos(cursor))}
                >
                  Load more photos
                </button>
              )}
            </section>
          )}
          {source === "stock" && (
            <section className="space-y-4">
              {stockProviders.length > 1 && (
                <label className="block space-y-1 text-sm font-medium">
                  <span>Photo source</span>
                  <select
                    className={inputClass}
                    value={stockProvider}
                    disabled={pending}
                    title="Choose where to search for stock photos"
                    onChange={(e) => {
                      setStockProvider(e.target.value as StockProvider);
                      setStock(null);
                      setStockPage(1);
                      setError("");
                    }}
                  >
                    {stockProviders.map((provider) => (
                      <option key={provider} value={provider}>
                        {stockSources[provider].name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    setStockPage(1);
                    setStock(
                      await findSchedulerStockPhotos({
                        data: { query: stockQuery, page: 1, provider: stockProvider },
                      }),
                    );
                  });
                }}
              >
                <input
                  aria-label="Search stock photos"
                  placeholder="Search photos, e.g. home office"
                  minLength={3}
                  maxLength={100}
                  value={stockQuery}
                  disabled={pending}
                  onChange={(e) => {
                    setStockQuery(e.target.value);
                    setStock(null);
                    setStockPage(1);
                  }}
                  className={inputClass}
                />
                <button
                  type="submit"
                  disabled={pending || stockQuery.trim().length < 3 || stockAvailable === false}
                  className={buttonClass}
                >
                  Search
                </button>
              </form>
              {stockAvailable === false && (
                <p className="text-sm text-muted-foreground">
                  Stock search is awaiting setup. Your uploaded photos and library are available
                  now.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Free photos via{" "}
                <a
                  href={stockSources[stockProvider].url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  {stockSources[stockProvider].name}
                </a>
                . Check the linked source for usage details.
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {stock?.map((photo) => (
                  <div key={`${photo.provider}:${photo.id}`}>
                    <button
                      type="button"
                      disabled={pending}
                      title="Add this stock photo to your post and library"
                      className="w-full overflow-hidden rounded-xl"
                      onClick={() =>
                        void act(async () => {
                          const result = await addSchedulerStockPhoto({
                            data: { id: photo.id, provider: photo.provider },
                          });
                          setLoaded(false);
                          if (onSelect(result.media) !== false) onOpenChange(false);
                        })
                      }
                    >
                      <img
                        src={photo.previewUrl}
                        alt={photo.description}
                        loading="lazy"
                        className="aspect-square w-full object-cover"
                      />
                    </button>
                    <a
                      href={photo.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 block truncate text-[11px] text-muted-foreground underline"
                    >
                      Photo by {photo.photographer} · {stockSources[photo.provider].name}
                    </a>
                  </div>
                ))}
              </div>
              {!!stock?.length && stockPage < 5 && (
                <button
                  type="button"
                  disabled={pending}
                  className={buttonClass}
                  onClick={() =>
                    void act(async () => {
                      const next = stockPage + 1;
                      setStock(
                        await findSchedulerStockPhotos({
                          data: { query: stockQuery, page: next, provider: stockProvider },
                        }),
                      );
                      setStockPage(next);
                    })
                  }
                >
                  More results
                </button>
              )}
              {stock?.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No photos found. Try a different search.
                </p>
              )}
            </section>
          )}
          {source === "ai" && !selectReferences && (
            <section className="space-y-4">
              <label className="block text-sm font-medium">
                Describe your image
                <textarea
                  aria-label="Image description"
                  value={prompt}
                  maxLength={2000}
                  onChange={(e) => {
                    setPrompt(e.target.value);
                    requestKey.current = null;
                  }}
                  rows={3}
                  className={`${inputClass} mt-2 resize-y`}
                />
              </label>
              <div>
                <p className="text-sm font-medium">
                  Reference images{" "}
                  <span className="font-normal text-muted-foreground">(optional, up to 4)</span>
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {references.map((photo) => (
                    <div key={photo.key} className="relative">
                      <img
                        src={photo.url}
                        alt="Selected reference"
                        className="size-16 rounded-xl object-cover"
                      />
                      <button
                        type="button"
                        aria-label="Remove reference"
                        title="Remove reference image"
                        onClick={() => toggleReference(photo)}
                        className="absolute -right-1 -top-1 rounded-full bg-white p-1 shadow"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={pending || references.length >= 4}
                    className={buttonClass}
                    onClick={() => referenceUpload.current?.click()}
                  >
                    <Upload className="size-4" />
                    Upload reference
                  </button>
                  <button
                    type="button"
                    disabled={references.length >= 4}
                    className={buttonClass}
                    onClick={() => setSelectReferences(true)}
                  >
                    <Images className="size-4" />
                    Choose from your photos
                  </button>
                </div>
                <input
                  ref={referenceUpload}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    void act(async () => {
                      if (file.size > 8 * 1024 * 1024)
                        throw new Error("Choose a reference under 8 MB.");
                      const uploaded = await uploadFileResult(file, "image");
                      toggleReference({
                        key: uploaded.key,
                        url: uploaded.publicUrl!,
                        name: file.name,
                        mimeType: uploaded.mimeType,
                        size: uploaded.size,
                      });
                      setLoaded(false);
                    });
                  }}
                />
              </div>
              {references.length > 0 && (
                <label className="flex items-start gap-2 text-xs leading-5">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    className="mt-1"
                  />
                  I have permission to use these images and send them to the AI image provider for
                  this request.
                </label>
              )}
              {settings && (
                <p className="text-xs text-muted-foreground">
                  {quotaRemaining} of {settings.quota.limit} images remaining this month, shared
                  with your Agent. Pending requests reserve an image. References do not add an image
                  charge.
                </p>
              )}
              {settings && !settings.enabled && (
                <p className="text-sm">
                  <Link
                    to="/content"
                    search={{ tab: "agent" }}
                    className="text-primary underline"
                    onClick={() => onOpenChange(false)}
                  >
                    Enable AI images in Agent settings
                  </Link>{" "}
                  before generating.
                </p>
              )}
              {settings && !settings.available && (
                <p className="text-sm text-muted-foreground">
                  AI image generation is temporarily unavailable. Use a library or stock photo.
                </p>
              )}
              <button
                type="button"
                className={`${buttonClass} !border-primary !bg-primary !text-white`}
                disabled={
                  pending ||
                  imageRunning ||
                  !settings?.available ||
                  !settings.enabled ||
                  !quotaRemaining ||
                  prompt.trim().length < 8 ||
                  (references.length > 0 && !confirmed)
                }
                onClick={() =>
                  void act(async () => {
                    requestKey.current ||= crypto.randomUUID();
                    const next = await generateSchedulerImage({
                      data: {
                        prompt,
                        referenceKeys: references.map((p) => p.key),
                        referencesConfirmed: confirmed,
                        requestKey: requestKey.current,
                      },
                    });
                    setJob(null);
                    setJobId(next.id);
                    requestKey.current = null;
                  })
                }
              >
                <Sparkles className="size-4" />
                Generate image · 1 credit
              </button>
              {jobId && (
                <p role="status" className="text-sm">
                  {job?.detail || "Preparing your image…"}
                </p>
              )}
              {job?.media && (
                <div className="space-y-2">
                  <img
                    src={job.media.url}
                    alt="Generated image preview"
                    className="max-h-72 max-w-full rounded-2xl object-contain"
                  />
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => {
                      if (onSelect(job.media!) !== false) onOpenChange(false);
                    }}
                  >
                    Use this image
                  </button>
                </div>
              )}
            </section>
          )}
          {pending && (
            <p role="status" className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              Working…
            </p>
          )}
          {error && (
            <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">
              {error}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
