import { readResponseBytes } from "./request-security.server";
import { getMediaBucket, mediaObjectUrl } from "./r2-storage.server";
import { allowedSocialAssetUrl } from "./social-avatar.server";
import type { SocialProvider } from "./social-scheduler";

const MAX_THUMBNAIL_BYTES = 3 * 1024 * 1024;

function imageExtension(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "png";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  )
    return "webp";
  return null;
}

export function isStoredSocialInsightThumbnailUrl(url: string) {
  try {
    const parsed = new URL(url);
    return [process.env.VITE_APP_URL, process.env.VITE_PUBLIC_URL, "http://localhost:8080"]
      .filter(Boolean)
      .some(
        (origin) =>
          parsed.origin === new URL(origin!).origin &&
          parsed.pathname.startsWith("/cdn/social-insights/"),
      );
  } catch {
    return false;
  }
}

export async function durableSocialInsightThumbnailUrl(input: {
  userId: string;
  connectionId: string;
  provider: SocialProvider;
  remotePostId: string;
  url: string | null;
}) {
  const original = input.url;
  if (!original || isStoredSocialInsightThumbnailUrl(original)) return original;
  let source = allowedSocialAssetUrl(input.provider, original);
  if (!source) return original;
  try {
    let response: Response | null = null;
    for (let redirect = 0; source && redirect <= 2; redirect += 1) {
      response = await fetch(source, {
        redirect: "manual",
        signal: AbortSignal.timeout(8_000),
        headers: { Accept: "image/avif,image/webp,image/png,image/jpeg" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        source = location
          ? allowedSocialAssetUrl(input.provider, new URL(location, source).toString())
          : null;
        response = null;
        continue;
      }
      break;
    }
    if (!response?.ok) return original;
    const bytes = await readResponseBytes(response, MAX_THUMBNAIL_BYTES);
    const extension = imageExtension(bytes);
    if (!extension) return original;
    const contentType = extension === "jpg" ? "image/jpeg" : `image/${extension}`;
    const [identityHash, contentHash] = await Promise.all([
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.remotePostId)),
      crypto.subtle.digest("SHA-256", bytes),
    ]);
    const hex = (digest: ArrayBuffer) =>
      [...new Uint8Array(digest).slice(0, 12)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    const key = `social-insights/${input.userId}/${input.connectionId}/${hex(identityHash)}-${hex(contentHash)}.${extension}`;
    await getMediaBucket().put(key, bytes, {
      httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
    });
    return mediaObjectUrl(key, process.env.VITE_APP_URL);
  } catch (error) {
    console.warn("Social insight thumbnail copy failed", {
      provider: input.provider,
      message: error instanceof Error ? error.message : "unknown",
    });
    return original;
  }
}
