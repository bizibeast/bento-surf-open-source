export type OptimizableImageKind = "avatar" | "image" | "cover";

const IMAGE_UPLOAD_QUALITY: Record<OptimizableImageKind, number> = {
  avatar: 0.88,
  image: 0.9,
  cover: 0.88,
};

/** Avatars render at 160 CSS pixels. Other display images stay sharp on a full desktop grid. */
export function imageUploadMaxDimension(kind: string) {
  return kind === "avatar" ? 512 : 2_000;
}

function asciiAt(bytes: Uint8Array, needle: string, offset: number) {
  if (offset < 0 || offset + needle.length > bytes.length) return false;
  for (let index = 0; index < needle.length; index += 1) {
    if (bytes[offset + index] !== needle.charCodeAt(index)) return false;
  }
  return true;
}

function findAscii(bytes: Uint8Array, needle: string) {
  const limit = bytes.length - needle.length;
  for (let offset = 0; offset <= limit; offset += 1) {
    if (asciiAt(bytes, needle, offset)) return true;
  }
  return false;
}

/**
 * GIF, animated WebP, APNG, and animated AVIF must not be flattened.
 * ponytail: callers pass either the whole upload or a prefix. An animation
 * marker past that prefix is treated as a still image.
 */
export function isAnimatedImage(bytes: Uint8Array, contentType = "") {
  const type = contentType.split(";", 1)[0].trim().toLowerCase();
  if (type === "image/gif" || asciiAt(bytes, "GIF87a", 0) || asciiAt(bytes, "GIF89a", 0)) {
    return true;
  }
  const webp = type === "image/webp" || (asciiAt(bytes, "RIFF", 0) && asciiAt(bytes, "WEBP", 8));
  if (webp && (findAscii(bytes, "ANIM") || findAscii(bytes, "ANMF"))) return true;
  const png = type === "image/png" || (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e);
  if (png && findAscii(bytes, "acTL")) return true;
  return type === "image/avif" && asciiAt(bytes, "avis", 8);
}

function imageFilename(name: string, extension: "webp" | "jpg") {
  const base = name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "-") || "image";
  return `${base}.${extension}`;
}

function canvasBlob(
  canvas: HTMLCanvasElement,
  mimeType: "image/webp" | "image/jpeg",
  quality: number,
) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality));
}

/**
 * Social networks (Instagram JPEG-only, LinkedIn JPEG/PNG/GIF) reject Bento's
 * default WebP page-media encoding. Convert scheduler uploads to JPEG before
 * they hit R2 so every image destination can publish the same object.
 */
export async function prepareSchedulerImageUpload(
  file: File,
  { maxBytes = 5 * 1024 * 1024 }: { maxBytes?: number } = {},
) {
  if (!file.type.startsWith("image/")) return file;
  // Keep animated GIFs intact so X can publish them as tweet_gif.
  if (file.type === "image/gif") return file;
  // A compatible image that already fits needs no generation loss or resizing.
  if (file.type === "image/jpeg" && file.size <= maxBytes) return file;
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") {
    if (file.type === "image/jpeg") return file;
    throw new Error(
      "This browser cannot convert images for social publishing. Try Chrome or Safari, or upload a JPG.",
    );
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const longestSide = Math.max(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      if (file.type === "image/jpeg") return file;
      throw new Error("Could not prepare this image for social publishing.");
    }
    for (const { dimension, quality } of [
      { dimension: longestSide, quality: 0.95 },
      { dimension: longestSide, quality: 0.92 },
      { dimension: longestSide, quality: 0.9 },
      ...[2560, 2048, 1600, 1280].map((dimension) => ({ dimension, quality: 0.92 })),
    ]) {
      const scale = Math.min(1, dimension / Math.max(1, longestSide));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.width = width;
      canvas.height = height;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvasBlob(canvas, "image/jpeg", quality);
      if (!blob) break;
      if (blob.type !== "image/jpeg") break;
      if (blob.size <= maxBytes)
        return new File([blob], imageFilename(file.name, "jpg"), {
          type: "image/jpeg",
          lastModified: file.lastModified,
        });
    }
    throw new Error(
      "This image could not fit the size limit at high quality for social publishing. Choose a smaller image.",
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("social publishing")) throw error;
    if (file.type === "image/jpeg") return file;
    throw new Error("Could not prepare this image for social publishing.");
  } finally {
    bitmap?.close();
  }
}

/**
 * Resize every still display image to its max dimension, encode WebP, and
 * strip metadata by redrawing. GIF and animated images stay untouched. Any
 * failure returns the original file.
 */
export async function optimizeImageUpload(file: File, kind: OptimizableImageKind) {
  if (
    !file.type.startsWith("image/") ||
    file.type === "image/gif" ||
    typeof document === "undefined" ||
    typeof createImageBitmap !== "function"
  ) {
    return file;
  }

  let bitmap: ImageBitmap | null = null;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (isAnimatedImage(bytes, file.type)) return file;

    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const maxDimension = imageUploadMaxDimension(kind);
    const longestSide = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, maxDimension / Math.max(1, longestSide));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await canvasBlob(canvas, "image/webp", IMAGE_UPLOAD_QUALITY[kind]);
    if (!blob || blob.type !== "image/webp") return file;
    if (file.type === "image/webp" && scale === 1 && blob.size >= file.size) return file;

    return new File([blob], imageFilename(file.name, "webp"), {
      type: "image/webp",
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}
