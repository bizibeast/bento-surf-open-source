import { readBoundedBytes } from "./media-stream";

export class TikTokPublicError extends Error {
  constructor(readonly reason: "unavailable" | "restricted" | "identity") {
    super(reason);
  }
}

export function tiktokPublicPost(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !["www.tiktok.com", "tiktok.com", "m.tiktok.com"].includes(url.hostname)
    )
      return null;
    const match = /^\/@([A-Za-z0-9._-]{1,64})\/(photo|video)\/(\d{8,24})\/?$/u.exec(url.pathname);
    return match
      ? {
          id: match[3],
          photo: match[2] === "photo",
          url: `https://www.tiktok.com/@${match[1]}/video/${match[3]}`,
        }
      : null;
  } catch {
    return null;
  }
}

export function tiktokImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash)
      return null;
    return [
      "tiktokcdn.com",
      "tiktokcdn-us.com",
      "tiktokcdn-eu.com",
      "ibyteimg.com",
      "ibytedtos.com",
      "byteoversea.com",
      "muscdn.com",
    ].some((host) => url.hostname === host || url.hostname.endsWith("." + host))
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function parseTikTokPublicPost(html: string, expected: string) {
  const match =
    /<script\b[^>]*\bid=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/u.exec(
      html,
    );
  if (!match) throw new TikTokPublicError("unavailable");
  let root;
  try {
    root = JSON.parse(match[1]);
  } catch {
    throw new TikTokPublicError("unavailable");
  }
  const detail = root?.__DEFAULT_SCOPE__?.["webapp.video-detail"];
  const post = detail?.itemInfo?.itemStruct;
  if (detail?.statusCode !== 0 || !post) throw new TikTokPublicError("unavailable");
  if (String(post.id) !== expected) throw new TikTokPublicError("identity");
  if (post.privateItem || post.isSecret || post.author?.privateAccount)
    throw new TikTokPublicError("restricted");
  const nodes = post.imagePost?.images;
  if (nodes !== undefined && (!Array.isArray(nodes) || !nodes.length || nodes.length > 20))
    throw new TikTokPublicError("unavailable");
  const images: string[] = (nodes || []).map((image: { imageURL?: { urlList?: unknown[] } }) => {
    const selected = image?.imageURL?.urlList?.map(tiktokImageUrl).find(Boolean);
    if (!selected) throw new TikTokPublicError("unavailable");
    return selected;
  });
  return {
    id: expected,
    images,
    cover:
      tiktokImageUrl(post.video?.cover) ||
      tiktokImageUrl(post.video?.originCover) ||
      images[0] ||
      null,
  };
}

/** The logged-out page is data only: never evaluates scripts or follows redirects. */
export async function fetchTikTokPublicPost(value: string, signal: AbortSignal) {
  const source = tiktokPublicPost(value);
  if (!source) throw new TikTokPublicError("identity");
  const response = await fetch(source.url, {
    headers: {
      accept: "text/html",
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
    },
    credentials: "omit",
    redirect: "manual",
    signal: AbortSignal.any([signal, AbortSignal.timeout(9000)]),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new TikTokPublicError("unavailable");
  }
  return parseTikTokPublicPost(
    new TextDecoder().decode(await readBoundedBytes(response, 2 * 1024 * 1024)),
    source.id,
  );
}
