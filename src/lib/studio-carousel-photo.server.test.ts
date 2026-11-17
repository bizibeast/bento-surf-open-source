import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { loadStudioCarouselPhoto } from "./studio-carousel-photo.server";

const workspace = "00000000-0000-4000-8000-000000000011";
const photo = `users/${workspace}/image/portrait.png`;
const base64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKn0AAAAASUVORK5CYII=";

function bucketFor(bytes: Uint8Array<ArrayBuffer>, contentType = "image/png", size = bytes.length) {
  const arrayBuffer = vi.fn(async () => bytes.buffer);
  const get = vi.fn(async () => ({
    size,
    httpMetadata: { contentType },
    arrayBuffer,
    body: new ReadableStream(),
  }));
  return { get, arrayBuffer, bucket: { get } as unknown as R2Bucket };
}

describe("Studio background photo input", () => {
  it("loads supported owned bytes from R2", async () => {
    const { bucket, get } = bucketFor(Uint8Array.from(Buffer.from(base64, "base64")));
    await expect(loadStudioCarouselPhoto(bucket, workspace, photo)).resolves.toEqual({
      mime: "image/png",
      base64,
    });
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(photo);
  });

  it("rejects a foreign photo key before reading storage", async () => {
    const { bucket, get } = bucketFor(new Uint8Array());
    await expect(loadStudioCarouselPhoto(bucket, "other-workspace", photo)).rejects.toThrow(
      "unavailable",
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects excessive files, invalid formats and oversized image dimensions", async () => {
    const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
    const tooLarge = bucketFor(bytes, "image/png", 4 * 1024 * 1024 + 1);
    await expect(loadStudioCarouselPhoto(tooLarge.bucket, workspace, photo)).rejects.toThrow(
      "4 MB",
    );
    expect(tooLarge.arrayBuffer).not.toHaveBeenCalled();

    await expect(
      loadStudioCarouselPhoto(bucketFor(bytes, "image/jpeg").bucket, workspace, photo),
    ).rejects.toThrow("unsupported");
    new DataView(bytes.buffer).setUint32(16, 9000);
    await expect(
      loadStudioCarouselPhoto(bucketFor(bytes).bucket, workspace, photo),
    ).rejects.toThrow("unsupported");
  });
});
