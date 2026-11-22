export type PublicSocialPlatform = "twitter" | "pinterest" | "linkedin";

export function isPublicSocialPlatform(value: unknown): value is PublicSocialPlatform {
  return value === "twitter" || value === "pinterest" || value === "linkedin";
}

export function publicSocialHttpsUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url : null;
  } catch {
    return null;
  }
}

function decodedPostSlug(raw: string) {
  try {
    const slug = decodeURIComponent(raw);
    return /^[\p{L}\p{M}\p{N}_-]{1,350}$/u.test(slug) ? slug : null;
  } catch {
    return null;
  }
}

export function pinterestPinId(url: URL) {
  if (!/^(?:www\.|[a-z]{2}\.)?pinterest\.com$/u.test(url.hostname)) return null;
  const match = /^\/pin\/(?:([^/]+)-)?(\d{6,24})(?:\/sent)?\/?$/u.exec(url.pathname);
  return match && (!match[1] || decodedPostSlug(match[1])) ? match[2] : null;
}

export function pinterestShortUrl(url: URL) {
  return url.hostname === "pin.it" && /^\/[\w-]{3,64}\/?$/u.test(url.pathname);
}

export function linkedInPostHost(url: URL) {
  return /^(?:www\.|[a-z]{2}\.)?linkedin\.com$/u.test(url.hostname);
}

export function normalizePublicSocialPost(platform: PublicSocialPlatform, value: unknown) {
  const url = publicSocialHttpsUrl(value);
  if (!url) return null;
  if (platform === "twitter") {
    const allowed = /^(?:www\.)?(?:x|twitter)\.com$|^mobile\.twitter\.com$/u.test(url.hostname);
    const id = allowed
      ? /^\/(?:[\w]+|i\/web)\/status(?:es)?\/(\d{1,24})(?:\/(?:photo|video)\/\d+)?\/?$/iu.exec(
          url.pathname,
        )?.[1]
      : url.hostname === "platform.twitter.com" && url.pathname === "/embed/Tweet.html"
        ? url.searchParams.get("id")
        : null;
    return id && /^\d{1,24}$/u.test(id) ? `https://x.com/i/status/${id}` : null;
  }
  if (platform === "pinterest") {
    if (pinterestShortUrl(url)) return `https://pin.it${url.pathname.replace(/\/$/u, "")}`;
    const id = pinterestPinId(url);
    return id ? `https://www.pinterest.com/pin/${id}/` : null;
  }
  if (!linkedInPostHost(url)) return null;
  const segment = /^\/posts\/([^/]+)\/?$/u.exec(url.pathname)?.[1];
  const post = segment && decodedPostSlug(segment);
  if (post && /(?:^|[_-])activity-\d{15,24}(?:-|$)/u.test(post)) {
    return `https://www.linkedin.com/posts/${encodeURIComponent(post)}/`;
  }
  const activity =
    /^\/feed\/update\/urn(?::|%3a)li(?::|%3a)activity(?::|%3a)(\d{15,24})\/?$/iu.exec(
      url.pathname,
    )?.[1];
  return activity ? `https://www.linkedin.com/feed/update/urn:li:activity:${activity}/` : null;
}
