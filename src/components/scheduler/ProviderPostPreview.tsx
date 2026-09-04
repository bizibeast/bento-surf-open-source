import { useState, type ComponentType } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  Heart,
  MessageCircle,
  MoreHorizontal,
  Repeat2,
  Send,
  Share2,
  ThumbsUp,
} from "lucide-react";
import { FaLinkedinIn } from "react-icons/fa";
import {
  SiFacebook,
  SiInstagram,
  SiReddit,
  SiTiktok,
  SiThreads,
  SiX as SiXLogo,
  SiYoutube,
} from "react-icons/si";
import { DecodedImage } from "@/components/DecodedImage";
import {
  SOCIAL_PROVIDER_DEFINITIONS,
  type SchedulerConnection,
  type SchedulerMedia,
  type SocialProvider,
  type YouTubePostFormat,
} from "@/lib/social-scheduler";

const PROVIDER_ICONS: Record<SocialProvider, ComponentType<{ className?: string }>> = {
  instagram: SiInstagram,
  facebook: SiFacebook,
  threads: SiThreads,
  tiktok: SiTiktok,
  linkedin: FaLinkedinIn,
  twitter: SiXLogo,
  youtube: SiYoutube,
  reddit: SiReddit,
};

export function ProviderPostPreview({
  connection,
  body,
  title,
  media,
  youtubeThumbnail,
  youtubeFormat,
  instagramCover,
  tiktokPrivacy,
  youtubePrivacy,
  redditCommunity,
  redditKind,
  redditUrl,
  onAvatarError,
}: {
  connection: SchedulerConnection;
  body: string;
  title: string;
  media: SchedulerMedia[];
  youtubeThumbnail: SchedulerMedia | null;
  youtubeFormat: YouTubePostFormat | null;
  instagramCover: SchedulerMedia | null;
  tiktokPrivacy: string;
  youtubePrivacy: string;
  redditCommunity: string;
  redditKind: "self" | "link";
  redditUrl: string;
  onAvatarError?: () => void;
}) {
  const provider = connection.provider;
  const copy = body.trim() || "Your post copy will appear here.";
  const postTitle = title.trim() || "Your post title will appear here";
  const handle = connection.handle.replace(/^@/, "");
  const placeholderClass = body.trim() ? "" : "text-muted-foreground";

  if (provider === "instagram") {
    return (
      <div className="mx-auto max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-center gap-3 p-3">
          <PreviewAvatar connection={connection} onError={onAvatarError} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{handle}</p>
            <p className="text-[11px] text-muted-foreground">Original audio</p>
          </div>
          <MoreHorizontal className="size-5" aria-hidden="true" />
        </div>
        <PreviewMedia
          media={
            instagramCover && media.some((item) => item.mimeType.startsWith("video/"))
              ? [instagramCover]
              : media
          }
          className="aspect-square"
          emptyLabel="Photo or video"
        />
        <div className="flex items-center gap-4 px-3 pt-3">
          <Heart className="size-6" aria-hidden="true" />
          <MessageCircle className="size-6" aria-hidden="true" />
          <Send className="size-6" aria-hidden="true" />
          <span className="ml-auto text-xl" aria-hidden="true">
            ♧
          </span>
        </div>
        <p className={`whitespace-pre-wrap break-words px-3 pb-4 pt-3 text-sm ${placeholderClass}`}>
          <span className="font-semibold text-foreground">{handle}</span> {copy}
        </p>
      </div>
    );
  }

  if (provider === "facebook") {
    return (
      <div className="mx-auto max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-center gap-3 p-4">
          <PreviewAvatar connection={connection} onError={onAvatarError} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{connection.displayName}</p>
            <p className="text-xs text-muted-foreground">Just now · Public</p>
          </div>
          <MoreHorizontal className="size-5 text-muted-foreground" aria-hidden="true" />
        </div>
        <p className={`whitespace-pre-wrap break-words px-4 pb-4 text-sm ${placeholderClass}`}>
          {copy}
        </p>
        {media.length > 0 && <PreviewMedia media={media} className="aspect-[4/3]" />}
        <div className="mx-4 flex items-center justify-between border-b border-border py-2 text-xs text-muted-foreground">
          <span>👍 ❤️</span>
          <span>0 comments · 0 shares</span>
        </div>
        <div className="grid grid-cols-3 px-3 py-1 text-xs font-semibold text-muted-foreground">
          <span className="flex items-center justify-center gap-1.5 py-2">
            <ThumbsUp className="size-4" /> Like
          </span>
          <span className="flex items-center justify-center gap-1.5 py-2">
            <MessageCircle className="size-4" /> Comment
          </span>
          <span className="flex items-center justify-center gap-1.5 py-2">
            <Share2 className="size-4" /> Share
          </span>
        </div>
      </div>
    );
  }

  if (provider === "threads") {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="flex gap-3">
          <div className="flex flex-col items-center">
            <PreviewAvatar connection={connection} onError={onAvatarError} />
            <span className="mt-2 w-px flex-1 bg-border" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-semibold">{handle}</p>
              <span className="text-xs text-muted-foreground">now</span>
              <MoreHorizontal className="ml-auto size-4" aria-hidden="true" />
            </div>
            <p className={`mt-1 whitespace-pre-wrap break-words text-sm ${placeholderClass}`}>
              {copy}
            </p>
            {media.length > 0 && (
              <PreviewMedia media={media} className="mt-3 aspect-[4/3] rounded-xl" />
            )}
            <div className="mt-3 flex gap-5 text-muted-foreground">
              <Heart className="size-5" />
              <MessageCircle className="size-5" />
              <Repeat2 className="size-5" />
              <Send className="size-5" />
            </div>
          </div>
        </div>
        <p className="ml-14 mt-3 text-xs text-muted-foreground">Be the first to reply</p>
      </div>
    );
  }

  if (provider === "tiktok") {
    const privacy =
      tiktokPrivacy === "PUBLIC_TO_EVERYONE"
        ? "Everyone"
        : tiktokPrivacy === "MUTUAL_FOLLOW_FRIENDS"
          ? "Friends"
          : "Only you";
    return (
      <div className="relative mx-auto aspect-[9/16] max-h-[620px] w-full max-w-[320px] overflow-hidden rounded-[28px] bg-black text-white shadow-xl">
        <PreviewMedia
          media={media}
          className="absolute inset-0 size-full"
          emptyLabel="TikTok video"
          controls={false}
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/20" />
        <div className="absolute left-4 top-4 rounded-full bg-black/35 px-2.5 py-1 text-[10px]">
          {privacy}
        </div>
        <div className="absolute bottom-5 left-4 right-14">
          <p className="text-sm font-semibold">@{handle}</p>
          <p
            className={`mt-2 whitespace-pre-wrap break-words text-xs leading-5 ${body.trim() ? "" : "text-white/65"}`}
          >
            {copy}
          </p>
          <p className="mt-2 text-xs">♫ original sound - {handle}</p>
        </div>
        <div className="absolute bottom-6 right-3 flex flex-col items-center gap-5 text-[10px]">
          <PreviewAvatar
            connection={connection}
            onError={onAvatarError}
            className="ring-1 ring-white"
          />
          <span className="flex flex-col items-center">
            <Heart className="size-6" />0
          </span>
          <span className="flex flex-col items-center">
            <MessageCircle className="size-6" />0
          </span>
          <span className="flex flex-col items-center">
            <Share2 className="size-6" />
            Share
          </span>
        </div>
      </div>
    );
  }

  if (provider === "linkedin") {
    return (
      <div className="mx-auto max-w-lg overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <div className="flex items-center gap-3 p-4">
          <PreviewAvatar connection={connection} onError={onAvatarError} className="rounded-md" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{connection.displayName}</p>
            <p className="truncate text-[11px] text-muted-foreground">@{handle}</p>
            <p className="text-[11px] text-muted-foreground">Now · Public</p>
          </div>
          <MoreHorizontal className="size-5 text-muted-foreground" aria-hidden="true" />
        </div>
        <p className={`whitespace-pre-wrap break-words px-4 pb-4 text-sm ${placeholderClass}`}>
          {copy}
        </p>
        {media.length > 0 && (
          <PreviewMedia
            media={media}
            className="aspect-[4/3]"
            layout={
              media.every((item) => item.mimeType.startsWith("image/")) && media.length > 1
                ? "grid"
                : "carousel"
            }
          />
        )}
        <div className="mx-4 flex items-center justify-between border-b border-border py-2 text-xs text-muted-foreground">
          <span>👍 💡 ❤️</span>
          <span>0 comments</span>
        </div>
        <div className="grid grid-cols-4 px-2 py-1 text-[11px] font-semibold text-muted-foreground">
          {[
            [ThumbsUp, "Like"],
            [MessageCircle, "Comment"],
            [Repeat2, "Repost"],
            [Send, "Send"],
          ].map(([ActionIcon, label]) => (
            <span key={String(label)} className="flex items-center justify-center gap-1 py-2">
              <ActionIcon className="size-4" /> {String(label)}
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (provider === "twitter") {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="flex gap-3">
          <PreviewAvatar connection={connection} onError={onAvatarError} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1 text-sm">
              <span className="truncate font-semibold">{connection.displayName}</span>
              <span className="truncate text-muted-foreground">@{handle} · now</span>
              <MoreHorizontal className="ml-auto size-4 shrink-0" aria-hidden="true" />
            </div>
            <p className={`mt-1 whitespace-pre-wrap break-words text-sm ${placeholderClass}`}>
              {copy}
            </p>
            {media.length > 0 && (
              <PreviewMedia media={media} className="mt-3 aspect-video rounded-2xl" />
            )}
            <div className="mt-4 flex justify-between pr-8 text-muted-foreground">
              <MessageCircle className="size-4" />
              <Repeat2 className="size-4" />
              <Heart className="size-4" />
              <Eye className="size-4" />
              <Share2 className="size-4" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (provider === "youtube") {
    if (youtubeFormat === "short") {
      return (
        <div className="relative mx-auto aspect-[9/16] max-h-[620px] w-full max-w-[320px] overflow-hidden rounded-[28px] bg-black text-white shadow-xl">
          <PreviewMedia
            media={youtubeThumbnail ? [youtubeThumbnail] : media}
            className="absolute inset-0 size-full"
            emptyLabel="Short thumbnail"
            controls={false}
          />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/20" />
          <div className="absolute left-4 top-4 rounded-full bg-black/35 px-2.5 py-1 text-[10px]">
            Short · {youtubePrivacy}
          </div>
          <div className="absolute bottom-5 left-4 right-14">
            <p className="text-sm font-semibold">{connection.displayName}</p>
            <p className="mt-2 line-clamp-2 text-xs leading-5">{postTitle}</p>
          </div>
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-xl">
        <PreviewMedia
          media={youtubeThumbnail ? [youtubeThumbnail] : media}
          className="aspect-video rounded-xl"
          emptyLabel="Video thumbnail"
          controls={!youtubeThumbnail}
        />
        <div className="mt-3 flex gap-3">
          <PreviewAvatar connection={connection} onError={onAvatarError} />
          <div className="min-w-0 flex-1">
            <h4 className="line-clamp-2 text-sm font-semibold leading-5">{postTitle}</h4>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {connection.displayName} · No views · now
            </p>
            <p className="mt-1 text-[11px] capitalize text-muted-foreground">
              Visibility: {youtubePrivacy}
            </p>
          </div>
          <MoreHorizontal className="size-5 shrink-0" aria-hidden="true" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex gap-3 p-3">
        <div className="flex w-7 shrink-0 flex-col items-center text-muted-foreground">
          <span className="text-lg">▲</span>
          <span className="text-xs font-semibold">1</span>
          <span className="text-lg">▼</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-muted-foreground">
            r/{redditCommunity || "community"} · Posted by u/{handle} · now
          </p>
          <h4 className="mt-1 text-base font-semibold leading-5">{postTitle}</h4>
          {redditKind === "link" ? (
            <p className="mt-2 break-all text-xs text-primary">
              {redditUrl || "https://example.com"}
            </p>
          ) : (
            <p className={`mt-2 whitespace-pre-wrap break-words text-sm ${placeholderClass}`}>
              {copy}
            </p>
          )}
          {media.length > 0 && (
            <PreviewMedia media={media} className="mt-3 aspect-video rounded-lg" />
          )}
          <div className="mt-3 flex gap-5 text-xs font-semibold text-muted-foreground">
            <span className="flex items-center gap-1">
              <MessageCircle className="size-4" /> 0 Comments
            </span>
            <span className="flex items-center gap-1">
              <Share2 className="size-4" /> Share
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PreviewAvatar({
  connection,
  className = "",
  onError,
}: {
  connection: SchedulerConnection;
  className?: string;
  onError?: () => void;
}) {
  const Icon = PROVIDER_ICONS[connection.provider];
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const avatarUrl = connection.avatarUrl === failedSrc ? null : connection.avatarUrl;
  return avatarUrl ? (
    <DecodedImage
      src={avatarUrl}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => {
        setFailedSrc(avatarUrl);
        onError?.();
      }}
      className={`size-10 shrink-0 rounded-full object-cover ${className}`}
    />
  ) : (
    <span
      className={`flex size-10 shrink-0 items-center justify-center rounded-full bg-accent ${className}`}
      style={{ color: SOCIAL_PROVIDER_DEFINITIONS[connection.provider].color }}
    >
      <Icon className="size-4" />
    </span>
  );
}

function isSchedulerDocument(mimeType: string) {
  return (
    mimeType === "application/pdf" ||
    mimeType === "application/msword" ||
    mimeType === "application/vnd.ms-powerpoint" ||
    mimeType.includes("wordprocessingml") ||
    mimeType.includes("presentationml")
  );
}

function PreviewMediaItem({
  item,
  controls = true,
  className = "size-full object-contain",
}: {
  item: SchedulerMedia;
  controls?: boolean;
  className?: string;
}) {
  if (item.mimeType.startsWith("video/")) {
    return (
      <video
        src={item.url}
        controls={controls}
        muted
        playsInline
        preload="metadata"
        className={className}
      />
    );
  }
  if (isSchedulerDocument(item.mimeType)) {
    return (
      <div className="flex size-full flex-col items-center justify-center gap-2 bg-zinc-900 px-4 text-center text-xs text-white/80">
        <span className="rounded-full border border-white/20 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-white/60">
          Document
        </span>
        <span className="line-clamp-3">{item.name}</span>
      </div>
    );
  }
  return <DecodedImage src={item.url} alt={item.name || "Post preview"} className={className} />;
}

function LinkedInMultiImageGrid({ media }: { media: SchedulerMedia[] }) {
  const visible = media.slice(0, 4);
  const overflow = Math.max(0, media.length - 4);

  if (visible.length === 1) {
    return <PreviewMediaItem item={visible[0]} className="size-full object-cover" />;
  }

  if (visible.length === 2) {
    return (
      <div className="grid size-full grid-cols-2 gap-0.5 bg-black">
        {visible.map((item) => (
          <PreviewMediaItem key={item.key} item={item} className="size-full object-cover" />
        ))}
      </div>
    );
  }

  if (visible.length === 3) {
    return (
      <div className="grid size-full grid-cols-2 grid-rows-2 gap-0.5 bg-black">
        <div className="row-span-2">
          <PreviewMediaItem item={visible[0]} className="size-full object-cover" />
        </div>
        <PreviewMediaItem item={visible[1]} className="size-full object-cover" />
        <PreviewMediaItem item={visible[2]} className="size-full object-cover" />
      </div>
    );
  }

  return (
    <div className="grid size-full grid-cols-2 grid-rows-2 gap-0.5 bg-black">
      {visible.map((item, index) => (
        <div key={item.key} className="relative size-full">
          <PreviewMediaItem item={item} className="size-full object-cover" />
          {index === 3 && overflow > 0 && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/55 text-2xl font-semibold text-white">
              +{overflow}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function PreviewMedia({
  media,
  className = "",
  emptyLabel = "Media",
  controls = true,
  layout = "auto",
}: {
  media: SchedulerMedia[];
  className?: string;
  emptyLabel?: string;
  controls?: boolean;
  layout?: "auto" | "carousel" | "grid";
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const item = media[Math.min(activeIndex, Math.max(media.length - 1, 0))];
  const allImages = media.length > 1 && media.every((entry) => entry.mimeType.startsWith("image/"));
  const resolvedLayout = layout === "auto" ? "carousel" : layout;

  if (!media.length) {
    return (
      <div className={`relative overflow-hidden bg-black ${className}`}>
        <div className="flex size-full items-center justify-center bg-zinc-900 px-4 text-center text-xs text-white/55">
          {emptyLabel} appears here
        </div>
      </div>
    );
  }

  if (resolvedLayout === "grid" && allImages) {
    return (
      <div className={`relative overflow-hidden bg-black ${className}`}>
        <LinkedInMultiImageGrid media={media} />
        {media.length > 1 && (
          <div className="absolute bottom-3 right-3 rounded-full bg-black/65 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
            {media.length} photos
          </div>
        )}
      </div>
    );
  }

  const canPage = media.length > 1;
  const go = (direction: -1 | 1) => {
    setActiveIndex((current) => {
      const next = current + direction;
      if (next < 0) return media.length - 1;
      if (next >= media.length) return 0;
      return next;
    });
  };

  return (
    <div className={`relative overflow-hidden bg-black ${className}`}>
      {item ? (
        <PreviewMediaItem item={item} controls={controls} />
      ) : (
        <div className="flex size-full items-center justify-center bg-zinc-900 px-4 text-center text-xs text-white/55">
          {emptyLabel} appears here
        </div>
      )}

      {canPage && (
        <>
          <button
            type="button"
            aria-label="Previous media"
            onClick={() => go(-1)}
            className="absolute left-2 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur hover:bg-black/70"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Next media"
            onClick={() => go(1)}
            className="absolute right-2 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur hover:bg-black/70"
          >
            <ChevronRight className="size-4" />
          </button>
          <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/45 px-2 py-1 backdrop-blur">
            {media.map((entry, index) => (
              <button
                key={entry.key}
                type="button"
                aria-label={`Show media ${index + 1}`}
                onClick={() => setActiveIndex(index)}
                className={`size-1.5 rounded-full ${
                  index === activeIndex ? "bg-white" : "bg-white/40"
                }`}
              />
            ))}
          </div>
          <div className="absolute right-3 top-3 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur">
            {activeIndex + 1}/{media.length}
          </div>
        </>
      )}
    </div>
  );
}
