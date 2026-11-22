import { InstagramAudioCatalog } from "./InstagramAudioCatalog";
import { Music2, SlidersHorizontal, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { micro } from "@/lib/micro-app-ui";
import type {
  InstagramCatalogAudio,
  InstagramReelAudio,
  SchedulerMedia,
} from "@/lib/social-scheduler";

export function InstagramReelAudioEditor({
  video,
  saved,
  catalogAudio,
  catalogConnectionId,
  postId,
  onCatalogChange,
  busy,
  maxBytes,
  upload,
  onChange,
  onProcessing,
}: {
  video: SchedulerMedia;
  saved: InstagramReelAudio | null;
  catalogAudio: InstagramCatalogAudio | null;
  catalogConnectionId: string | null;
  postId: string | null;
  onCatalogChange: (audio: InstagramCatalogAudio | null) => void;
  busy: boolean;
  maxBytes: number;
  upload: (file: File, signal: AbortSignal) => Promise<SchedulerMedia>;
  onChange: (audio: InstagramReelAudio | null) => void;
  onProcessing: (processing: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"music" | "original_sound" | "upload">(saved ? "upload" : "music");
  const [track, setTrack] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [originalVolume, setOriginalVolume] = useState(saved?.originalVolume ?? 100);
  const [trackVolume, setTrackVolume] = useState(saved?.trackVolume ?? 40);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!track) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(track);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [track]);
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = trackVolume / 100;
  }, [trackVolume, preview, open]);
  useEffect(
    () => () => {
      if (controllerRef.current) {
        controllerRef.current.abort();
        onProcessing(false);
      }
    },
    [onProcessing],
  );

  async function apply() {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setError("");
    setProgress("Mixing Reel audio…");
    onProcessing(true);
    try {
      const { mixInstagramReelAudio } = await import("@/lib/instagram-reel-audio");
      const file = await mixInstagramReelAudio(video.url, {
        originalVolume,
        trackVolume,
        track,
        maxBytes,
        signal: controller.signal,
      });
      setProgress("Uploading mixed Reel…");
      const mixed = await upload(file, controller.signal);
      controller.signal.throwIfAborted();
      onChange({
        sourceKey: video.key,
        video: { ...mixed, mimeType: "video/mp4" },
        trackName: track?.name.slice(0, 255) || null,
        originalVolume,
        trackVolume: track ? trackVolume : 0,
      });
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "Bento could not mix the audio.");
    } finally {
      controllerRef.current = null;
      setProgress("");
      onProcessing(false);
    }
  }

  return (
    <div className="space-y-2 rounded-xl border border-border p-3">
      <button
        type="button"
        className="flex w-full items-center gap-3 text-left"
        onClick={() => setOpen(true)}
        disabled={busy}
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <Music2 className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">Reel audio</span>
          <span className="block truncate text-xs text-muted-foreground">
            {catalogAudio?.title ||
              saved?.trackName ||
              (saved ? "Original audio adjusted" : "Add a track or adjust original audio")}
          </span>
        </span>
        <SlidersHorizontal className="size-4 text-muted-foreground" />
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!progress) setOpen(next);
        }}
      >
        <DialogContent
          className="max-h-[85dvh] overflow-y-auto sm:max-w-md"
          onEscapeKeyDown={(event) => {
            if (progress) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Reel audio</DialogTitle>
            <DialogDescription>Choose audio for this Instagram Reel.</DialogDescription>
          </DialogHeader>
          <div className="flex gap-1 rounded-xl bg-muted p-1" aria-label="Audio source">
            {(
              [
                ["music", "Music"],
                ["original_sound", "Original sounds"],
                ["upload", "Upload"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={tab === id}
                disabled={Boolean(progress)}
                onClick={() => setTab(id)}
                className="flex-1 rounded-lg px-2 py-2 text-xs font-semibold text-muted-foreground aria-pressed:bg-background aria-pressed:text-foreground"
              >
                {label}
              </button>
            ))}
          </div>
          {tab !== "upload" && (
            <InstagramAudioCatalog
              key={tab}
              type={tab}
              video={video}
              connectionId={catalogConnectionId}
              postId={postId}
              selected={catalogAudio}
              onSelect={(audio) => {
                onCatalogChange(audio);
                setOpen(false);
              }}
            />
          )}
          {tab === "upload" && (
            <div className="space-y-4">
              <input
                ref={inputRef}
                className="hidden"
                type="file"
                accept="audio/mpeg,audio/mp4,audio/wav,.mp3,.m4a,.wav"
                onChange={(event) => {
                  setTrack(event.currentTarget.files?.[0] || null);
                  setTrackVolume((volume) => volume || 40);
                  event.currentTarget.value = "";
                }}
              />
              <div className="flex items-center gap-2 rounded-xl border border-dashed border-border p-3">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left text-sm font-semibold"
                  disabled={Boolean(progress)}
                  onClick={() => inputRef.current?.click()}
                >
                  <Upload className="size-4 shrink-0 text-primary" />
                  <span className="truncate">{track?.name || "Upload audio"}</span>
                </button>
                {track && (
                  <button
                    type="button"
                    aria-label="Remove selected track"
                    disabled={Boolean(progress)}
                    onClick={() => setTrack(null)}
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>
              {preview && (
                <audio
                  ref={audioRef}
                  src={preview}
                  controls
                  preload="metadata"
                  className="w-full"
                />
              )}
              <p className="text-xs text-muted-foreground">
                Upload a track you have rights to use, or adjust the Reel’s original audio.
              </p>
              {!track && saved?.trackName && (
                <p className="text-xs text-muted-foreground">
                  Upload the track again to change its mix, or play the saved Reel below.
                </p>
              )}
              <fieldset disabled={Boolean(progress)} className="space-y-4">
                <legend className="mb-3 text-sm font-semibold">Volume</legend>
                <label className="block text-sm">
                  <span className="flex justify-between">
                    Original audio <span>{originalVolume}%</span>
                  </span>
                  <input
                    aria-label="Original audio volume"
                    type="range"
                    min={0}
                    max={100}
                    value={originalVolume}
                    onChange={(event) => setOriginalVolume(event.currentTarget.valueAsNumber)}
                    className="w-full accent-primary"
                  />
                </label>
                {track && (
                  <label className="block text-sm">
                    <span className="flex justify-between">
                      Music <span>{trackVolume}%</span>
                    </span>
                    <input
                      aria-label="Music volume"
                      type="range"
                      min={0}
                      max={100}
                      value={trackVolume}
                      onChange={(event) => setTrackVolume(event.currentTarget.valueAsNumber)}
                      className="w-full accent-primary"
                    />
                  </label>
                )}
              </fieldset>
              {saved && (
                <video
                  src={saved.video.url}
                  controls
                  preload="metadata"
                  className="mx-auto max-h-52 w-full rounded-lg bg-black"
                  aria-label="Saved Reel audio preview"
                />
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <div className="flex items-center justify-end gap-2">
                {progress && (
                  <button
                    type="button"
                    className={micro.btnSoft}
                    onClick={() => controllerRef.current?.abort()}
                  >
                    Cancel
                  </button>
                )}
                {saved && (
                  <button
                    type="button"
                    className={micro.btnSoft}
                    disabled={Boolean(progress)}
                    onClick={() => {
                      onChange(null);
                      setOriginalVolume(100);
                      setTrackVolume(40);
                      setTrack(null);
                      setOpen(false);
                    }}
                  >
                    Remove mix
                  </button>
                )}
                <button
                  type="button"
                  className={micro.btnPrimary}
                  disabled={
                    Boolean(progress) ||
                    (!track && (originalVolume === 100 || Boolean(saved?.trackName)))
                  }
                  onClick={() => void apply()}
                >
                  {progress || "Apply to Reel"}
                </button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
