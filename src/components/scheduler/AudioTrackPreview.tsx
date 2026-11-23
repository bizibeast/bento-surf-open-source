import { useEffect, useId, useRef, useState } from "react";
import { micro } from "@/lib/micro-app-ui";

/** A listening preview; only the uploaded-track editor uses its position for rendering. */
export function AudioTrackPreview({
  src,
  volume,
  startSeconds,
  onStartChange,
  disabled = false,
  startLabel = "Preview starts at (seconds)",
}: {
  src: string;
  volume: number;
  startSeconds?: number;
  onStartChange?: (seconds: number) => void;
  disabled?: boolean;
  startLabel?: string;
}) {
  const id = useId();
  const audio = useRef<HTMLAudioElement>(null);
  const [localStart, setLocalStart] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const start = startSeconds ?? localStart;
  const invalid = duration !== null && start >= duration;
  function update(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    if (onStartChange) onStartChange(seconds);
    else setLocalStart(seconds);
  }
  function seek() {
    if (!audio.current || invalid) return;
    try {
      audio.current.currentTime = start;
    } catch {
      /* Some previews become seekable only after loading. */
    }
  }
  useEffect(() => {
    if (audio.current) audio.current.volume = Math.min(1, Math.max(0, volume / 100));
  }, [volume, src]);
  useEffect(() => {
    if (!audio.current || !Number.isFinite(start) || start < 0) return;
    try {
      audio.current.currentTime = start;
    } catch {
      /* Retry when metadata is ready. */
    }
  }, [start, src]);
  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-3">
      <audio
        ref={audio}
        src={src}
        controls
        preload="metadata"
        className="w-full"
        aria-label="Track preview"
        onLoadedMetadata={() => {
          const value = audio.current?.duration;
          setDuration(value !== undefined && Number.isFinite(value) && value > 0 ? value : null);
          setFailed(false);
          seek();
        }}
        onPlay={() => {
          if (audio.current && audio.current.currentTime < start) seek();
        }}
        onError={() => setFailed(true)}
      />
      <div className="flex flex-wrap items-end gap-2">
        <label htmlFor={id} className="min-w-36 flex-1 text-xs font-medium">
          {startLabel}
          <input
            id={id}
            type="number"
            min={0}
            max={duration === null ? undefined : Math.max(0, duration - 0.001)}
            step="0.1"
            className={`${micro.input} mt-1`}
            value={start}
            disabled={disabled}
            aria-invalid={invalid}
            onChange={(event) => update(event.currentTarget.valueAsNumber)}
          />
        </label>
        <button
          type="button"
          className={micro.btnSoft}
          disabled={disabled || failed}
          onClick={() => {
            if (audio.current) update(audio.current.currentTime);
          }}
        >
          Use current position
        </button>
      </div>
      {invalid && (
        <p role="alert" className="text-xs text-destructive">
          Choose a start before the end of the track.
        </p>
      )}
      {failed && (
        <p role="status" className="text-xs text-muted-foreground">
          This audio preview could not load. Refresh the track and try again.
        </p>
      )}
    </div>
  );
}
