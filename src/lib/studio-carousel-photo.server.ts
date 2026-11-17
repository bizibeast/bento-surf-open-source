import { Buffer } from "node:buffer";
import { imageSize } from "image-size";
import { isAnimatedImage } from "./image-upload";
import { validateMediaObjectKey } from "./r2-storage.server";

const maximumPhotoBytes = 4 * 1024 * 1024;
const maximumPhotoPixels = 4_000_000;
const supportedPhotoTypes = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

export async function loadStudioCarouselPhoto(
  bucket: R2Bucket,
  workspaceId: string,
  source: string,
) {
  const key = validateMediaObjectKey(source);
  if (!key?.startsWith(`users/${workspaceId}/`))
    throw new Error("The slide photo is unavailable in this workspace.");
  const object = await bucket.get(key);
  const mime = object?.httpMetadata?.contentType;
  if (
    !object ||
    !mime ||
    !Object.hasOwn(supportedPhotoTypes, mime) ||
    object.size < 1 ||
    object.size > maximumPhotoBytes
  ) {
    await object?.body.cancel().catch(() => undefined);
    throw new Error("Choose a still photo up to 4 MB for background exports.");
  }
  const buffer = await object.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let dimension: ReturnType<typeof imageSize>;
  try {
    dimension = imageSize(bytes);
  } catch {
    throw new Error("The slide photo could not be read.");
  }
  if (
    dimension.type !== supportedPhotoTypes[mime as keyof typeof supportedPhotoTypes] ||
    !dimension.width ||
    !dimension.height ||
    dimension.width > 4096 ||
    dimension.height > 4096 ||
    dimension.width * dimension.height > maximumPhotoPixels ||
    isAnimatedImage(bytes, mime)
  ) {
    throw new Error("The slide photo is unsupported for background exports.");
  }
  // The bundled SVG rasterizer can embed PNG/JPEG but cannot decode WebP.
  if (mime === "image/webp") {
    const { studioWebpToPng } = await import("./studio-carousel-webp.server");
    const png = await studioWebpToPng(buffer);
    return { mime: "image/png", base64: png.toString("base64") };
  }
  return { mime, base64: Buffer.from(buffer).toString("base64") };
}
