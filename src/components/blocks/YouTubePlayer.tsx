import { useState } from "react";
import { Play } from "lucide-react";
import { DecodedImage } from "@/components/DecodedImage";

type YouTubePlayerProps = {
  videoId: string;
  title: string;
  testId?: string;
  posterFit?: "cover" | "contain";
};

export function YouTubePlayer({
  videoId,
  title,
  testId = "youtube-embed",
  posterFit = "cover",
}: YouTubePlayerProps) {
  const [playing, setPlaying] = useState(false);
  const safeVideoId = encodeURIComponent(videoId);

  if (playing) {
    return (
      <iframe
        data-testid={testId}
        title={title}
        src={`https://www.youtube.com/embed/${safeVideoId}?autoplay=1&playsinline=1&rel=0&modestbranding=1`}
        className="size-full border-0"
        allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture; web-share"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
      />
    );
  }

  return (
    <button
      type="button"
      data-testid={`${testId}-poster`}
      aria-label={`Play ${title}`}
      className="group relative size-full cursor-pointer overflow-hidden bg-black"
      onClick={() => setPlaying(true)}
    >
      <DecodedImage
        src={`https://i.ytimg.com/vi/${safeVideoId}/hqdefault.jpg`}
        alt=""
        className={`size-full ${posterFit === "contain" ? "object-contain" : "object-cover"}`}
        loading="lazy"
      />
      <span className="absolute inset-0 bg-black/5 transition-colors group-hover:bg-black/10" />
      <span className="absolute left-1/2 top-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/80 text-white shadow-sm transition-transform group-hover:scale-105 @[260px]:size-10">
        <Play className="ml-0.5 size-4 fill-current @[260px]:size-[18px]" aria-hidden="true" />
      </span>
    </button>
  );
}
