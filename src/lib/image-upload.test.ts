import { afterEach, describe, expect, it, vi } from "vitest";
import { optimizeImageUpload, prepareSchedulerImageUpload } from "./image-upload";

describe("optimizeImageUpload", () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;

  afterEach(() => {
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: originalCreateImageBitmap,
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
