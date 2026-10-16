export const LINKEDIN_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const LINKEDIN_VIDEO_MAX_BYTES = 5 * 1024 * 1024 * 1024;
export const LINKEDIN_DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;
export const LINKEDIN_VIDEO_PART_BYTES = 4_194_304;

export const X_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const X_GIF_MAX_BYTES = 15 * 1024 * 1024;
// Post videos use the authenticated user's limit, not the smaller DM limit.
// https://docs.x.com/x-api/media/quickstart/best-practices
export const X_VIDEO_MAX_BYTES = 8 * 1024 * 1024 * 1024;
export const X_MEDIA_CHUNK_BYTES = 4 * 1024 * 1024;
export const SOCIAL_IMAGE_OPTIMIZATION_MAX_BYTES = 20 * 1024 * 1024;

export class ProviderMediaDownloadError extends Error {
  constructor(
    message: string,
    readonly code:
      "unavailable" | "empty" | "too_large" | "invalid_type" | "optimization_unavailable",
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderMediaDownloadError";
  }
}

type ProviderMediaDownloadOptions = {
  maxBytes: number;
  allowedMimeTypes: readonly string[];
  timeoutMs?: number;
  fetcher?: typeof fetch;
  /** Opt in only for still images. GIFs must retain all animation frames. */
  optimizeImage?: {
    images?: ImagesBinding;
    mimeType: string;
    beforeTransform?: () => Promise<void>;
  };
};

export async function downloadProviderMedia(
  url: string,
  {
    maxBytes,
    allowedMimeTypes,
    timeoutMs = 60_000,
    fetcher = fetch,
    optimizeImage,
  }: ProviderMediaDownloadOptions,
) {
  const imageInputTypes = ["image/jpeg", "image/png", "image/webp"];
  let canOptimize = Boolean(optimizeImage && imageInputTypes.includes(optimizeImage.mimeType));
  const downloadLimit = canOptimize
    ? Math.max(maxBytes, SOCIAL_IMAGE_OPTIMIZATION_MAX_BYTES)
    : maxBytes;
  let response: Response;
  try {
    response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ProviderMediaDownloadError(
      "The scheduled media could not be downloaded.",
      "unavailable",
      true,
    );
  }

  if (!response.ok) {
    throw new ProviderMediaDownloadError(
      "The scheduled media is unavailable.",
      "unavailable",
      response.status === 429 || response.status >= 500,
    );
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > downloadLimit) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderMediaDownloadError(
      "The scheduled media is too large for this destination.",
      "too_large",
      false,
    );
  }

  const responseMimeType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (responseMimeType && !imageInputTypes.includes(responseMimeType)) canOptimize = false;
  if (
    responseMimeType &&
    !allowedMimeTypes.includes(responseMimeType) &&
    !(canOptimize && imageInputTypes.includes(responseMimeType))
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderMediaDownloadError(
      "This media format is not supported by the destination.",
      "invalid_type",
      false,
    );
  }

  const bytes = await readProviderMediaBytes(response, downloadLimit);

  if (
    canOptimize &&
    (bytes.byteLength > maxBytes ||
      !allowedMimeTypes.includes(responseMimeType || optimizeImage!.mimeType))
  ) {
    return optimizeProviderImage(
      bytes,
      responseMimeType || optimizeImage!.mimeType,
      maxBytes,
      allowedMimeTypes,
      optimizeImage!.images,
      optimizeImage!.beforeTransform,
    );
  }
  if (bytes.byteLength > maxBytes) {
    throw new ProviderMediaDownloadError(
      "The scheduled media is too large for this destination.",
      "too_large",
      false,
    );
  }

  return { bytes, mimeType: responseMimeType };
}

async function readProviderMediaBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderMediaDownloadError(
      "The scheduled media is too large for this destination.",
      "too_large",
      false,
    );
  }
  let bytes: Uint8Array;
  try {
    const reader = response.body?.getReader();
    if (!reader) {
      bytes = new Uint8Array(await response.arrayBuffer());
    } else {
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;

        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel("Provider media exceeded the destination size limit");
          throw new ProviderMediaDownloadError(
            "The scheduled media is too large for this destination.",
            "too_large",
            false,
          );
        }
        chunks.push(value);
      }

      bytes = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
  } catch (error) {
    if (error instanceof ProviderMediaDownloadError) throw error;
    throw new ProviderMediaDownloadError(
      "The scheduled media could not be downloaded.",
      "unavailable",
      true,
    );
  }

  if (!bytes.byteLength) {
    throw new ProviderMediaDownloadError("The scheduled media file is empty.", "empty", false);
  }
  if (bytes.byteLength > maxBytes)
    throw new ProviderMediaDownloadError(
      "The scheduled media is too large for this destination.",
      "too_large",
      false,
    );
  return bytes;
}

async function optimizeProviderImage(
  source: Uint8Array,
  mimeType: string,
  maxBytes: number,
  allowedMimeTypes: readonly string[],
  images?: ImagesBinding,
  beforeTransform?: () => Promise<void>,
) {
  if (source.byteLength > SOCIAL_IMAGE_OPTIMIZATION_MAX_BYTES) {
    throw new ProviderMediaDownloadError(
      "This image is too large to optimize safely. Upload a smaller original.",
      "too_large",
      false,
    );
  }
  if (!images) {
    throw new ProviderMediaDownloadError(
      "Image optimization is temporarily unavailable. Bento will retry automatically.",
      "optimization_unavailable",
      true,
    );
  }
  // Keep PNG transparency and try a lossless re-encode at the original resolution.
  // JPEG attempts begin at full resolution; resize only when that does not fit.
  const png = mimeType === "image/png" && allowedMimeTypes.includes("image/png");
  const format = png ? "image/png" : "image/jpeg";
  if (!allowedMimeTypes.includes(format)) {
    throw new ProviderMediaDownloadError(
      "This image format cannot be optimized for the destination.",
      "invalid_type",
      false,
    );
  }
  const attempts = png
    ? [{}, ...[4096, 2560, 2048, 1600, 1280].map((dimension) => ({ dimension }))]
    : [
        { quality: 95 },
        { quality: 92 },
        { quality: 90 },
        ...[2560, 2048, 1600, 1280].map((dimension) => ({ dimension, quality: 92 })),
      ];
  for (const attempt of attempts as { dimension?: number; quality?: number }[]) {
    await beforeTransform?.();
    try {
      let transformer = images.input(new Response(source as BodyInit).body!);
      if (attempt.dimension)
        transformer = transformer.transform({
          width: attempt.dimension,
          height: attempt.dimension,
          fit: "scale-down",
        });
      const result = await transformer.output({ format, quality: attempt.quality });
      const response = result.response();
      if (!response.ok) throw new Error("Image transformation failed");
      // Bound the output as well as the input, including chunked responses.
      const bytes = await readProviderMediaBytes(response, maxBytes);
      const outputMimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      const valid =
        format === "image/png"
          ? bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
          : bytes[0] === 0xff && bytes[1] === 0xd8;
      if (!valid || outputMimeType !== format)
        throw new Error("Image transformation returned invalid media");
      return { bytes, mimeType: format };
    } catch (error) {
      if (error instanceof ProviderMediaDownloadError && error.code === "too_large") continue;
      throw new ProviderMediaDownloadError(
        "Image optimization is temporarily unavailable. Bento will retry automatically.",
        "optimization_unavailable",
        true,
      );
    }
  }
  throw new ProviderMediaDownloadError(
    "This image could not fit the destination's limit at high quality. Choose a smaller image.",
    "too_large",
    false,
  );
}

/** Open a bounded stream; never buffer an entire video in a 128 MB Worker. */
export async function openProviderMedia(
  url: string,
  {
    maxBytes,
    allowedMimeTypes,
    timeoutMs = 180_000,
    fetcher = fetch,
  }: ProviderMediaDownloadOptions,
) {
  let response: Response;
  try {
    response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ProviderMediaDownloadError(
      "The scheduled media could not be downloaded.",
      "unavailable",
      true,
    );
  }
  const cancel = () => response.body?.cancel().catch(() => undefined);
  if (!response.ok) {
    await cancel();
    throw new ProviderMediaDownloadError(
      "The scheduled media is unavailable.",
      "unavailable",
      response.status === 429 || response.status >= 500,
    );
  }
  const totalBytes = Number(response.headers.get("content-length"));
  if (totalBytes > maxBytes) {
    await cancel();
    throw new ProviderMediaDownloadError(
      "The scheduled media exceeds the destination's size limit.",
      "too_large",
      false,
    );
  }
  const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mimeType || !allowedMimeTypes.includes(mimeType)) {
    await cancel();
    throw new ProviderMediaDownloadError(
      "This media format is not supported by the destination.",
      "invalid_type",
      false,
    );
  }
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || !response.body) {
    await cancel();
    throw new ProviderMediaDownloadError(
      "The media's size could not be verified. Please upload it through Bento again.",
      "unavailable",
      false,
    );
  }
  return { totalBytes, mimeType, body: response.body, cancel };
}

export async function* providerMediaChunks(
  body: ReadableStream<Uint8Array>,
  totalBytes: number,
  chunkBytes: number | readonly number[],
  startByte = 0,
) {
  if (!Number.isSafeInteger(startByte) || startByte < 0 || startByte >= totalBytes)
    throw new ProviderMediaDownloadError("The upload offset is invalid.", "unavailable", false);
  const sizes = typeof chunkBytes === "number" ? null : chunkBytes;
  let index = 0;
  const nextSize = () => (sizes ? (sizes[index++] ?? 0) : (chunkBytes as number));
  const firstSize = nextSize();
  if (!Number.isSafeInteger(firstSize) || firstSize <= 0)
    throw new ProviderMediaDownloadError("The upload chunk size is invalid.", "unavailable", false);
  const reader = body.getReader();
  let received = 0;
  let used = 0;
  let chunk = new Uint8Array(Math.min(firstSize, totalBytes - startByte));
  let finalChunk: Uint8Array<ArrayBuffer> | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > totalBytes)
        throw new ProviderMediaDownloadError(
          "The media size changed while uploading. Please upload it again.",
          "unavailable",
          true,
        );
      for (
        let offset = Math.min(
          value.byteLength,
          Math.max(0, startByte - (received - value.byteLength)),
        );
        offset < value.byteLength;
      ) {
        const count = Math.min(chunk.byteLength - used, value.byteLength - offset);
        chunk.set(value.subarray(offset, offset + count), used);
        used += count;
        offset += count;
        if (used === chunk.byteLength) {
          const remaining = totalBytes - (received - value.byteLength + offset);
          // Validate EOF before giving a destination its final upload segment.
          // A truncated or overlong source must never complete a public post.
          if (remaining) yield chunk;
          else finalChunk = chunk;
          const size = remaining ? nextSize() : 0;
          if (remaining && (!Number.isSafeInteger(size) || size <= 0))
            throw new ProviderMediaDownloadError(
              "The upload plan is incomplete.",
              "unavailable",
              false,
            );
          chunk = new Uint8Array(Math.min(size, remaining));
          used = 0;
        }
      }
    }
    if (received !== totalBytes)
      throw new ProviderMediaDownloadError(
        "The media download was interrupted. Bento will retry automatically.",
        "unavailable",
        true,
      );
    if (finalChunk) yield finalChunk;
  } catch (error) {
    if (error instanceof ProviderMediaDownloadError) throw error;
    throw new ProviderMediaDownloadError(
      "The media download was interrupted. Bento will retry automatically.",
      "unavailable",
      true,
    );
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
