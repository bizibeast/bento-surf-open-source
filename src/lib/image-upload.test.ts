import { afterEach, describe, expect, it, vi } from "vitest";
import { isAnimatedImage, optimizeImageUpload, prepareSchedulerImageUpload } from "./image-upload";

function mockEncoder(blob: Blob | null) {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: vi.fn() }),
    toBlob: (callback: (value: Blob | null) => void) => callback(blob),
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => canvas },
  });
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: vi.fn(async () => ({ width: 100, height: 80, close: vi.fn() })),
  });
  return canvas;
}

describe("optimizeImageUpload", () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalDocument = globalThis.document;

  afterEach(() => {
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: originalCreateImageBitmap,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
    vi.restoreAllMocks();
  });

  it("keeps the original when browser image decoding is unavailable", async () => {
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: undefined,
    });
    const file = new File([new Uint8Array(200_000)], "avatar.jpg", { type: "image/jpeg" });

    await expect(optimizeImageUpload(file, "avatar")).resolves.toBe(file);
  });

  it("never flattens an animated GIF", async () => {
    const decoder = vi.fn();
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: decoder,
    });
    const file = new File([new Uint8Array(200_000)], "animation.gif", { type: "image/gif" });

    await expect(optimizeImageUpload(file, "image")).resolves.toBe(file);
    expect(decoder).not.toHaveBeenCalled();
  });

  it("encodes a still image as WebP and scales it to the kind maximum", async () => {
    const canvas = mockEncoder(new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }));
    vi.mocked(createImageBitmap).mockResolvedValue({
      width: 4_000,
      height: 2_000,
      close: vi.fn(),
    } as ImageBitmap);
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], "photo.jpg", {
      type: "image/jpeg",
    });

    const avatar = await optimizeImageUpload(file, "avatar");
    expect(avatar.type).toBe("image/webp");
    expect(avatar.name).toBe("photo.webp");
    expect(canvas.width).toBe(512);
    expect(canvas.height).toBe(256);

    const block = await optimizeImageUpload(file, "image");
    expect(canvas.width).toBe(2_000);
    expect(canvas.height).toBe(1_000);
    expect(block).not.toBe(file);
  });

  it("returns the original file when WebP encoding is unavailable", async () => {
    mockEncoder(null);
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], "photo.jpg", {
      type: "image/jpeg",
    });
    await expect(optimizeImageUpload(file, "image")).resolves.toBe(file);
  });

  it("leaves animated WebP untouched", async () => {
    const decoder = vi.fn();
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: decoder,
    });
    const bytes = new Uint8Array(16);
    bytes.set(new TextEncoder().encode("RIFF"), 0);
    bytes.set(new TextEncoder().encode("WEBP"), 8);
    bytes.set(new TextEncoder().encode("ANIM"), 12);
    const file = new File([bytes], "anim.webp", { type: "image/webp" });

    await expect(optimizeImageUpload(file, "image")).resolves.toBe(file);
    expect(decoder).not.toHaveBeenCalled();
    expect(isAnimatedImage(bytes, "image/webp")).toBe(true);
    expect(
      isAnimatedImage(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new TextEncoder().encode("acTL")]),
        "image/png",
      ),
    ).toBe(true);
  });
});

describe("prepareSchedulerImageUpload", () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalDocument = globalThis.document;

  afterEach(() => {
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: originalCreateImageBitmap,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
    vi.restoreAllMocks();
  });

  it("keeps JPEG when canvas conversion is unavailable", async () => {
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: undefined,
    });
    const file = new File([new Uint8Array(12_000)], "photo.jpg", { type: "image/jpeg" });
    await expect(prepareSchedulerImageUpload(file)).resolves.toBe(file);
  });

  it("rejects non-JPEG when conversion is unavailable", async () => {
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: undefined,
    });
    const file = new File([new Uint8Array(12_000)], "photo.webp", { type: "image/webp" });
    await expect(prepareSchedulerImageUpload(file)).rejects.toThrow(/convert images/i);
  });

  it("converts webp to jpeg when canvas is available", async () => {
    const close = vi.fn();
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: vi.fn(async () => ({ width: 100, height: 80, close })),
    });
    const toBlob = vi.fn((cb: (blob: Blob | null) => void) => {
      cb(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }));
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        createElement: () => ({
          width: 0,
          height: 0,
          getContext: () => ({
            fillStyle: "",
            fillRect: vi.fn(),
            drawImage: vi.fn(),
          }),
          toBlob,
        }),
      },
    });

    const file = new File([new Uint8Array(12_000)], "ChatGPT.webp", { type: "image/webp" });
    const prepared = await prepareSchedulerImageUpload(file);
    expect(prepared.type).toBe("image/jpeg");
    expect(prepared.name).toBe("ChatGPT.jpg");
    expect(close).toHaveBeenCalled();
  });
});
