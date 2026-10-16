import { discoverMediaLabel } from "./discover-utils";
import { useState } from "react";
import { useTheme } from "next-themes";
import { ChevronLeft, ChevronRight, ExternalLink, ImageOff, Play } from "lucide-react";
import { DecodedImage } from "@/components/DecodedImage";
import type { DiscoverRecommendation } from "@/lib/content-discovery.functions";
import {
  publicSourceUrl,
  sourcePostEmbed,
  sourcePresentation,
  sourceThumbnail,
} from "@/lib/content-source-media";

export function DiscoverMedia({
  item,
  detail = false,
}: {
  item: DiscoverRecommendation;
  detail?: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const [failedVideo, setFailedVideo] = useState(false);
  const [index, setIndex] = useState(0);
  const [embedReady, setEmbedReady] = useState(false);
  const embed = sourcePostEmbed(item.sourceUrl, resolvedTheme === "dark");
  const media = sourcePresentation(item).media || [];
  const asset = media[Math.min(index, Math.max(0, media.length - 1))];
  const poster = sourceThumbnail(item);
  const image = asset?.type === "image" ? asset.url : poster;
  const video = detail && asset?.type === "video" && !failedVideo ? asset.url : null;
  const useEmbed =
    embed && (detail ? !video && asset?.type !== "image" : !image || failedImage === image);
  const isVideo = item.mediaType === "video" || embed?.label === "Video" || embed?.label === "Reel";
  const vertical = embed?.vertical && (detail || isVideo);
  if (!image && !video && !embed) return null;
  return (
    <div
      className={`discover-media ${detail ? "discover-media-detail" : "discover-media-feed"} ${vertical ? "discover-media-vertical" : ""}`}
    >
      {video ? (
        <video
          key={video}
          src={video}
          poster={poster || undefined}
          controls
          playsInline
          preload="metadata"
          aria-label={`Play ${item.title}`}
          onError={() => setFailedVideo(true)}
        />
      ) : useEmbed ? (
        <iframe
          title={`${detail ? "Original post" : "Post preview"}: ${item.title}`}
          src={embed.url}
          loading="lazy"
          tabIndex={detail ? 0 : -1}
          aria-hidden={detail ? undefined : true}
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          onLoad={() => setEmbedReady(true)}
        />
      ) : image && failedImage !== image ? (
        <DecodedImage
          key={image}
          src={image}
          alt={detail ? item.title : ""}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedImage(image)}
        />
      ) : (
        <div className="discover-media-unavailable">
          <ImageOff aria-hidden="true" />
          <span>Preview unavailable</span>
          {detail && publicSourceUrl(item.sourceUrl) && (
            <a href={item.sourceUrl!} target="_blank" rel="noreferrer noopener">
              View original post <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      )}
      {!detail && (
        <>
          <span className="discover-media-badge">
            {discoverMediaLabel(item)}
            {media.length > 1 && ` · ${media.length}`}
          </span>
          {isVideo && image && (
            <span className="discover-play" aria-hidden="true">
              <Play fill="currentColor" />
            </span>
          )}
        </>
      )}
      {detail && useEmbed && !embedReady && (
        <div className="discover-embed-loading" aria-label="Loading original post">
          {poster && <DecodedImage src={poster} alt="" />}
          <span role="status">Loading original post…</span>
        </div>
      )}
      {detail && media.length > 1 && (
        <div className="discover-gallery-controls">
          <button
            type="button"
            aria-label="Previous media"
            disabled={index === 0}
            onClick={() => {
              setIndex(index - 1);
              setFailedVideo(false);
            }}
          >
            <ChevronLeft />
          </button>
          <span role="status">
            {index + 1} / {media.length}
          </span>
          <button
            type="button"
            aria-label="Next media"
            disabled={index === media.length - 1}
            onClick={() => {
              setIndex(index + 1);
              setFailedVideo(false);
            }}
          >
            <ChevronRight />
          </button>
        </div>
      )}
    </div>
  );
}
