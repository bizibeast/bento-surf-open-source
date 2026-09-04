export const LINKEDIN_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const LINKEDIN_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const LINKEDIN_DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;
export const LINKEDIN_VIDEO_PART_BYTES = 4_194_304;

export const X_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const X_GIF_MAX_BYTES = 15 * 1024 * 1024;
export const X_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const X_MEDIA_CHUNK_BYTES = 4 * 1024 * 1024;

export class ProviderMediaDownloadError extends Error {
  constructor(
    message: string,
    readonly code: "unavailable" | "empty" | "too_large" | "invalid_type",
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
};

export async function downloadProviderMedia(
  url: string,
  { maxBytes, allowedMimeTypes, timeoutMs = 60_000, fetcher = fetch }: ProviderMediaDownloadOptions,
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

  if (!response.ok) {
    throw new ProviderMediaDownloadError(
      "The scheduled media is unavailable.",
      "unavailable",
      response.status === 429 || response.status >= 500,
    );
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ProviderMediaDownloadError(
      "The scheduled media is too large for this destination.",
      "too_large",
      false,
    );
  }

  const responseMimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (responseMimeType && !allowedMimeTypes.includes(responseMimeType)) {
    throw new ProviderMediaDownloadError(
      "This media format is not supported by the destination.",
      "invalid_type",
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
  if (bytes.byteLength > maxBytes) {
    throw new ProviderMediaDownloadError(
      "The scheduled media is too large for this destination.",
      "too_large",
      false,
    );
  }

  return { bytes, mimeType: responseMimeType };
}
