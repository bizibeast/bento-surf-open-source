export type OptimizableImageKind = "avatar" | "image" | "cover";

type ImageUploadPreset = {
  maxDimension: number;
  quality: number;
  transcodeAboveBytes: number;
};

const IMAGE_UPLOAD_PRESETS: Record<OptimizableImageKind, ImageUploadPreset> = {
  // Avatars are never rendered above 160 CSS pixels. 640px keeps them sharp
  // on high-density displays without making every profile download a camera
  // original.
  avatar: { maxDimension: 640, quality: 0.88, transcodeAboveBytes: 96 * 1024 },
  // Bento image blocks can span the full desktop grid. 2400px leaves enough
  // resolution for retina screens while keeping first visits lightweight.
  image: { maxDimension: 2_400, quality: 0.9, transcodeAboveBytes: 384 * 1024 },
  cover: { maxDimension: 2_000, quality: 0.88, transcodeAboveBytes: 320 * 1024 },
};

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
export async function prepareSchedulerImageUpload(file: File) {
  if (!file.type.startsWith("image/")) return file;
  // Keep animated GIFs intact so X can publish them as tweet_gif.
  if (file.type === "image/gif") return file;
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") {
    if (file.type === "image/jpeg") return file;
    throw new Error(
      "This browser cannot convert images for social publishing. Try Chrome or Safari, or upload a JPG.",
    );
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const maxDimension = 1_440;
    const longestSide = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, maxDimension / Math.max(1, longestSide));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      if (file.type === "image/jpeg") return file;
      throw new Error("Could not prepare this image for social publishing.");
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await canvasBlob(canvas, "image/jpeg", 0.92);
    if (!blob) {
      if (file.type === "image/jpeg") return file;
      throw new Error("Could not convert this image to JPEG for social publishing.");
    }

    return new File([blob], imageFilename(file.name, "jpg"), {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("social publishing")) throw error;
    if (file.type === "image/jpeg") return file;
    throw new Error("Could not prepare this image for social publishing.");
  } finally {
    bitmap?.close();
  }
}

/**
 * Resize and strip metadata from user-uploaded display images before they ever
 * cross the network. Animated GIFs stay untouched and every failure safely
 * falls back to the original file.
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
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const preset = IMAGE_UPLOAD_PRESETS[kind];
    const longestSide = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, preset.maxDimension / Math.max(1, longestSide));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const needsResize = scale < 1;
    const needsTranscode = file.type !== "image/webp" && file.size > preset.transcodeAboveBytes;

    if (!needsResize && !needsTranscode) return file;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await canvasBlob(canvas, "image/webp", preset.quality);
    if (!blob) return file;
    // Never replace an already correctly sized image with a larger encoding.
    if (!needsResize && blob.size >= file.size) return file;

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
