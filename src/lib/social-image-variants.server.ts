import { reserveProviderUsage } from "./provider-budget.server";
import { downloadProviderMedia, ProviderMediaDownloadError } from "./social-provider-media";
import { mediaObjectUrl, validateMediaObjectKey } from "./r2-storage.server";
import type { SchedulerMedia } from "./social-scheduler";

/** Keep the original immutable and cache a separate destination-sized image. */
export async function prepareSocialImageUrl(
  item: SchedulerMedia,
  maxBytes: number,
  allowedMimeTypes: readonly string[],
): Promise<SchedulerMedia> {
  if (!item.mimeType.startsWith("image/") || item.mimeType === "image/gif") return item;
  const key = validateMediaObjectKey(item.key);
  if (!key || !/^users\/[^/]+\//.test(key))
    throw new ProviderMediaDownloadError(
      "Upload this image through Bento before publishing.",
      "invalid_type",
      false,
    );
  const bucket = globalThis.__env__?.MEDIA_BUCKET;
  if (!bucket)
    throw new ProviderMediaDownloadError(
      "Image preparation is temporarily unavailable.",
      "optimization_unavailable",
      true,
    );
  const original = await bucket.head(key);
  if (!original)
    throw new ProviderMediaDownloadError(
      "This image is unavailable. Upload it again.",
      "unavailable",
      false,
    );
  const mimeType = original.httpMetadata?.contentType || item.mimeType;
  if (original.size <= maxBytes && allowedMimeTypes.includes(mimeType))
    return { ...item, size: original.size, mimeType };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify(["social-image-v1", key, original.etag, maxBytes, allowedMimeTypes]),
    ),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  // URL-pull destinations use JPEG. Cache by original version and destination budget.
  const variantKey = `${key.split("/").slice(0, 2).join("/")}/social-variants/${hash}.jpg`;
  const cached = await bucket.head(variantKey);
  if (
    cached &&
    cached.size > 0 &&
    cached.size <= maxBytes &&
    cached.httpMetadata?.contentType === "image/jpeg"
  )
    return {
      ...item,
      key: variantKey,
      url: mediaObjectUrl(variantKey),
      size: cached.size,
      mimeType: "image/jpeg",
      name: item.name.replace(/\.[^.]+$/, "") + ".jpg",
    };
  const object = await bucket.get(key);
  if (!object)
    throw new ProviderMediaDownloadError(
      "This image is unavailable. Upload it again.",
      "unavailable",
      false,
    );
  const prepared = await downloadProviderMedia(item.url, {
    maxBytes,
    allowedMimeTypes,
    optimizeImage: {
      beforeTransform: () => reserveProviderUsage("image_transformations"),
      images: globalThis.__env__?.IMAGES,
      mimeType,
    },
    fetcher: async () =>
      new Response(object.body, {
        headers: { "content-type": mimeType, "content-length": String(object.size) },
      }),
  });
  if (prepared.mimeType !== "image/jpeg")
    throw new ProviderMediaDownloadError(
      "The optimized image format is invalid.",
      "invalid_type",
      false,
    );
  await bucket.put(variantKey, prepared.bytes, {
    httpMetadata: {
      contentType: "image/jpeg",
      cacheControl: "public, max-age=31536000, immutable",
    },
  });
  return {
    ...item,
    key: variantKey,
    url: mediaObjectUrl(variantKey),
    size: prepared.bytes.byteLength,
    mimeType: "image/jpeg",
    name: item.name.replace(/\.[^.]+$/, "") + ".jpg",
  };
}
