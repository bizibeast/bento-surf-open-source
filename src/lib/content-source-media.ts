import { parsePublicHttpUrl } from "./safe-url";
import { socialEmbedUrl, youtubeVideoIdFromUrl } from "./social-embeds";

export type ContentSourceMedia = {
  type: "image" | "video";
  url: string;
  thumbnailUrl?: string | null;
  width?: number | null;
  height?: number | null;
};
export type ContentSourcePresentation = {
  authorUrl?: string | null;
  authorAvatarUrl?: string | null;
  mediaType?: "text" | "image" | "video" | "carousel" | "article" | null;
  media?: ContentSourceMedia[];
};

export type DiscoverCreator = {
  author: string | null;
  authorUrl: string | null;
  authorAvatarUrl: string | null;
};

export function discoverAvatarProvider(source: string | null) {
  const url = source && publicSourceUrl(source);
  if (!url) return null;
  const host = new URL(url).hostname.replace(/^www\./, "");
  const providers = {
    "instagram.com": "instagram",
    "facebook.com": "facebook",
    "linkedin.com": "linkedin",
    "youtube.com": "youtube",
    "youtu.be": "youtube",
    "tiktok.com": "tiktok",
    "x.com": "twitter",
    "twitter.com": "twitter",
    "threads.net": "threads",
    "threads.com": "threads",
    "reddit.com": "reddit",
  } as const;
  return providers[host as keyof typeof providers] || null;
}

export function publicSourceUrl(value: unknown) {
  return (
    parsePublicHttpUrl(value, { requireHttps: true, allowNonStandardPort: false })?.toString() ??
    null
  );
}

export function sourcePresentation(value: ContentSourcePresentation): ContentSourcePresentation {
  return {
    authorUrl: publicSourceUrl(value.authorUrl),
    authorAvatarUrl: publicSourceUrl(value.authorAvatarUrl),
    mediaType: ["text", "image", "video", "carousel", "article"].includes(value.mediaType || "")
      ? value.mediaType
      : null,
    media: (Array.isArray(value.media) ? value.media : []).slice(0, 20).flatMap((asset) => {
      const url = publicSourceUrl(asset?.url);
      if (!url || !["image", "video"].includes(asset.type)) return [];
      const dimension = (v: unknown) =>
        typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
      return [
        {
          type: asset.type,
          url,
          thumbnailUrl: publicSourceUrl(asset.thumbnailUrl),
          width: dimension(asset.width),
          height: dimension(asset.height),
        },
      ];
    }),
  };
}

export function sourcePostEmbed(
  source: string | null,
  dark = false,
): { url: string; vertical: boolean; label: string } | null {
  const safe = publicSourceUrl(source);
  if (!safe) return null;
  const url = new URL(safe);
  const host = url.hostname.replace(/^www\./, "");
  for (const [provider, label] of [
    ["youtube", "Video"],
    ["instagram", "Post"],
    ["tiktok", "Video"],
    ["twitter", "Post"],
  ] as const) {
    const embed = socialEmbedUrl(provider, safe, { twitterTheme: dark ? "dark" : "light" });
    if (embed)
      return {
        url: embed,
        label: provider === "instagram" && /\/reels?\//.test(url.pathname) ? "Reel" : label,
        vertical:
          provider === "instagram" ||
          provider === "tiktok" ||
          (provider === "youtube" && url.pathname.startsWith("/shorts/")),
      };
  }
  if (
    ["threads.net", "threads.com"].includes(host) &&
    /^\/@[\w.]+\/post\/[\w-]+\/?$/.test(url.pathname)
  )
    return {
      url: `${url.origin}${url.pathname.replace(/\/$/, "")}/embed`,
      vertical: true,
      label: "Post",
    };
  if (
    ["facebook.com", "m.facebook.com"].includes(host) &&
    /\/(posts|reel|videos)\//.test(url.pathname)
  ) {
    const video = /\/(reel|videos)\//.test(url.pathname);
    return {
      url: `https://www.facebook.com/plugins/${video ? "video" : "post"}.php?href=${encodeURIComponent(safe)}&show_text=true&width=500`,
      vertical: true,
      label: video ? "Video" : "Post",
    };
  }
  if (host === "linkedin.com") {
    const id =
      url.pathname.match(/urn:li:(?:activity|share|ugcPost):\d+/)?.[0] ||
      (url.pathname.match(/-activity-(\d+)-/)?.[1]
        ? `urn:li:activity:${url.pathname.match(/-activity-(\d+)-/)![1]}`
        : null);
    if (id)
      return {
        url: `https://www.linkedin.com/embed/feed/update/${id}`,
        vertical: true,
        label: "Post",
      };
  }
  return null;
}

export function sourceThumbnail(item: {
  sourceUrl?: string | null;
  canonicalUrl?: string;
  thumbnailUrl?: string | null;
  media?: ContentSourceMedia[];
}) {
  const image =
    publicSourceUrl(item.thumbnailUrl) ||
    item.media
      ?.map(
        (media) =>
          publicSourceUrl(media.thumbnailUrl) ||
          (media.type === "image" ? publicSourceUrl(media.url) : null),
      )
      .find(Boolean);
  if (image) return image;
  const url = item.sourceUrl || item.canonicalUrl;
  const id = url && publicSourceUrl(url) && youtubeVideoIdFromUrl(url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

export function sourceCreator(source: string | null) {
  const url = source && publicSourceUrl(source);
  if (!url) return null;
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./, "");
  if (["facebook.com", "m.facebook.com"].includes(host)) {
    const account = parsed.pathname.match(/^\/([\w.]+)\/posts\//)?.[1];
    if (account) return { name: account, url: `https://www.facebook.com/${account}/` };
  }
  const handle = parsed.pathname.match(/^\/@?([\w.]+)\/(?:status|post|video|photo)\//)?.[1];
  if (!handle || ["i", "share", "reel", "reels"].includes(handle)) return null;
  if (["x.com", "twitter.com", "threads.net", "threads.com", "tiktok.com"].includes(host))
    return {
      name: `@${handle}`,
      url: `https://${host}/${["x.com", "twitter.com"].includes(host) ? "" : "@"}${handle}`,
    };
  return null;
}
