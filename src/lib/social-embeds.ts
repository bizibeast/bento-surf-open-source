export type SocialEmbedProvider = "youtube" | "instagram" | "tiktok" | "twitter";
export type TwitterEmbedTheme = "light" | "dark";

const PROVIDERS = new Set<SocialEmbedProvider>(["youtube", "instagram", "tiktok", "twitter"]);

function parsePublicUrl(input: string) {
  const value = input.trim();
  if (!value) return null;
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
}

function isHost(hostname: string, allowed: string[]) {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return allowed.includes(host);
}

function validYoutubeId(value: string | null | undefined) {
  const id = value?.trim() ?? "";
  return /^[A-Za-z0-9_-]{6,15}$/.test(id) ? id : null;
}

function youtubeVideoId(url: URL) {
  if (isHost(url.hostname, ["youtu.be"])) {
    return validYoutubeId(url.pathname.split("/").filter(Boolean)[0]);
  }
  if (!isHost(url.hostname, ["youtube.com", "m.youtube.com", "music.youtube.com"])) return null;
  if (url.pathname === "/watch") return validYoutubeId(url.searchParams.get("v"));
  const match = url.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/i);
  return validYoutubeId(match?.[1]);
}

export function youtubeVideoIdFromUrl(input: string) {
  const url = parsePublicUrl(input);
  return url?.protocol === "https:" ? youtubeVideoId(url) : null;
}

function instagramPost(url: URL) {
  if (!isHost(url.hostname, ["instagram.com"])) return null;
  const match = url.pathname.match(/^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,64})(?:\/|$)/i);
  if (!match) return null;
  return {
    kind: match[1].toLowerCase() === "reels" ? "reel" : match[1].toLowerCase(),
    id: match[2],
  };
}

function tiktokVideoId(url: URL) {
  if (!isHost(url.hostname, ["tiktok.com", "m.tiktok.com"])) return null;
  return url.pathname.match(/\/(?:video|player\/v1)\/(\d{8,24})(?:\/|$)/i)?.[1] ?? null;
}

export function tiktokPhotoSourceUrl(input: string) {
  const url = parsePublicUrl(input);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !isHost(url.hostname, ["tiktok.com", "m.tiktok.com"]) ||
    !/^\/@[A-Za-z0-9._-]{1,64}\/photo\/\d{8,24}\/?$/iu.test(url.pathname)
  ) {
    return null;
  }
  url.hash = "";
  return url.toString();
}

function validTweetId(value: string | null | undefined) {
  const id = value?.trim() ?? "";
  return /^\d{1,24}$/.test(id) ? id : null;
}

function tweetId(url: URL) {
  if (isHost(url.hostname, ["x.com", "twitter.com", "mobile.twitter.com"])) {
    return validTweetId(url.pathname.match(/\/status\/(\d{1,24})(?:\/|$)/i)?.[1]);
  }
  if (isHost(url.hostname, ["platform.twitter.com"]) && url.pathname === "/embed/Tweet.html") {
    return validTweetId(url.searchParams.get("id"));
  }
  return null;
}

export function isSocialEmbedProvider(value: unknown): value is SocialEmbedProvider {
  return typeof value === "string" && PROVIDERS.has(value as SocialEmbedProvider);
}

/**
 * Resolves the provider stored on a video block. YouTube video blocks created
 * before `embedProvider` was persisted only contain an embed/source URL, so
 * recognize those blocks by their URL and let them self-heal on the next edit.
 */
export function socialEmbedProviderFromContent(content: Record<string, unknown>) {
  if (isSocialEmbedProvider(content.embedProvider)) return content.embedProvider;
  const source = String(content.originalUrl || content.url || "").trim();
  return source && socialEmbedUrl("youtube", source) ? "youtube" : null;
}

/**
 * Converts a public post URL into the provider's official iframe player URL.
 * Returning null keeps arbitrary websites and profile URLs out of video iframes.
 */
export function socialEmbedUrl(
  provider: SocialEmbedProvider,
  input: string,
  options?: { twitterTheme?: TwitterEmbedTheme },
): string | null {
  const url = parsePublicUrl(input);
  if (!url || url.protocol !== "https:") return null;

  if (provider === "youtube") {
    const id = youtubeVideoId(url);
    return id ? `https://www.youtube.com/embed/${id}?playsinline=1&rel=0` : null;
  }

  if (provider === "instagram") {
    const post = instagramPost(url);
    return post ? `https://www.instagram.com/${post.kind}/${post.id}/embed/` : null;
  }

  if (provider === "tiktok") {
    const id = tiktokVideoId(url);
    return id ? `https://www.tiktok.com/player/v1/${id}?autoplay=0` : null;
  }

  const id = tweetId(url);
  const theme = options?.twitterTheme === "dark" ? "dark" : "light";
  return id
    ? `https://platform.twitter.com/embed/Tweet.html?id=${id}&dnt=true&theme=${theme}`
    : null;
}

/**
 * Returns the creator-facing source URL shown in the editor. Older X blocks
 * accidentally stored Twitter's iframe URL as their original source; convert
 * those back to a public post URL so they remain editable and self-heal when
 * saved again.
 */
export function socialEmbedSourceUrl(provider: SocialEmbedProvider, input: string): string | null {
  const url = parsePublicUrl(input);
  if (!url || url.protocol !== "https:") return null;
  if (provider === "twitter") {
    const id = tweetId(url);
    return id ? `https://x.com/i/status/${id}` : null;
  }
  return socialEmbedUrl(provider, input) ? url.toString() : null;
}

export function normalizeSocialEmbedContent<T extends Record<string, unknown>>(
  provider: SocialEmbedProvider,
  content: T,
) {
  const rawSource = String(content.originalUrl || content.url || "").trim();
  const originalUrl = socialEmbedSourceUrl(provider, rawSource) ?? rawSource;
  const twitterTheme: TwitterEmbedTheme = content.twitterTheme === "dark" ? "dark" : "light";
  return {
    ...content,
    embedProvider: provider,
    originalUrl,
    url:
      socialEmbedUrl(provider, originalUrl, {
        twitterTheme,
      }) ?? "",
  };
}

export function socialEmbedHelp(provider: SocialEmbedProvider) {
  switch (provider) {
    case "youtube":
      return "Paste a YouTube video, Short, or youtu.be link.";
    case "instagram":
      return "Paste a public Instagram post, Reel, or video link.";
    case "tiktok":
      return "Paste the full public TikTok video link (not a shortened vm.tiktok.com link).";
    case "twitter":
      return "Paste a public post link from x.com or twitter.com.";
  }
}

export function socialEmbedLabel(provider: SocialEmbedProvider) {
  switch (provider) {
    case "youtube":
      return "YouTube video";
    case "instagram":
      return "Instagram video";
    case "tiktok":
      return "TikTok video";
    case "twitter":
      return "X post / Tweet";
  }
}
