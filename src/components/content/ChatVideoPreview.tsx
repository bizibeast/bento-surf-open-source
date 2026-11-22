import { useRef, useState } from "react";
import { Play, RefreshCw } from "lucide-react";
import { micro } from "@/lib/micro-app-ui";

export function ChatVideoPreview({
  src,
  reloading,
  onReload,
  onPlaybackError,
}: {
  src: string;
  reloading: boolean;
  onReload: () => void;
  onPlaybackError: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const fail = () => {
    setFailed(true);
    onPlaybackError();
  };
  return (
    <div className="relative mx-auto aspect-[9/16] w-full max-w-[320px] overflow-hidden rounded-xl bg-black shadow-sm">
      <video
        ref={video}
        controls
        playsInline
        preload="metadata"
        src={src}
        aria-label="Finished video preview"
        className="h-full w-full object-contain"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={fail}
      />
      {!playing && !failed && (
        <button
          type="button"
          aria-label="Play video preview"
          className="absolute left-1/2 top-1/2 grid size-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/30 bg-black/45 text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-black/65 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
          onClick={() => {
            const attempt = video.current?.play();
            void attempt?.catch((error: unknown) => {
              if (!(error instanceof DOMException && error.name === "AbortError")) fail();
            });
          }}
        >
          <Play className="ml-1 size-6 fill-current" aria-hidden="true" />
        </button>
      )}
      {failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-muted px-6 text-center text-foreground">
          <p role="alert" className="text-sm leading-6">
            This preview couldn’t play. Reload it to get a fresh video link.
          </p>
          <button type="button" className={micro.btnSoft} disabled={reloading} onClick={onReload}>
            <RefreshCw className="size-4" aria-hidden="true" />
            {reloading ? "Reloading…" : "Reload video preview"}
          </button>
        </div>
      )}
    </div>
  );
}
