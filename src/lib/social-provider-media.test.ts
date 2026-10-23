import { describe, expect, it, vi } from "vitest";
import {
  downloadProviderMedia,
  openProviderMedia,
  providerMediaChunks,
  ProviderMediaDownloadError,
} from "./social-provider-media";

const options = {
  maxBytes: 4,
  allowedMimeTypes: ["image/jpeg", "image/png"],
};

describe("downloadProviderMedia", () => {
  it("uses the downloaded bytes and response type", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png; charset=binary" },
        }),
    );

    const result = await downloadProviderMedia("https://cdn.example/image", {
      ...options,
      fetcher,
    });

    expect([...result.bytes]).toEqual([1, 2, 3]);
    expect(result.mimeType).toBe("image/png");
  });

  it("rejects an oversized declared response before reading it", async () => {
    const arrayBuffer = vi.fn();
    const fetcher = vi.fn(async () => {
      const response = new Response(null, { headers: { "content-length": "5" } });
      Object.defineProperty(response, "arrayBuffer", { value: arrayBuffer });
      return response;
    });

    await expect(
      downloadProviderMedia("https://cdn.example/image", { ...options, fetcher }),
    ).rejects.toMatchObject({ code: "too_large" } satisfies Partial<ProviderMediaDownloadError>);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects oversized actual bytes, empty files, and unsupported formats", async () => {
    const cases = [
      {
        response: new Response(new Uint8Array([1, 2, 3, 4, 5])),
        code: "too_large",
      },
      { response: new Response(new Uint8Array()), code: "empty" },
      {
        response: new Response(new Uint8Array([1]), {
          headers: { "content-type": "image/webp" },
        }),
        code: "invalid_type",
      },
    ];

    for (const testCase of cases) {
      await expect(
        downloadProviderMedia("https://cdn.example/image", {
          ...options,
          fetcher: vi.fn(async () => testCase.response),
        }),
      ).rejects.toMatchObject({ code: testCase.code });
    }
  });

  it("marks transient download failures as retryable", async () => {
    await expect(
      downloadProviderMedia("https://cdn.example/image", {
        ...options,
        fetcher: vi.fn(async () => new Response(null, { status: 503 })),
      }),
    ).rejects.toMatchObject({ code: "unavailable", retryable: true });
  });
});

describe("bounded video streaming", () => {
  it("reassembles irregular network chunks without altering a byte", async () => {
    const source = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(source.slice(0, 2));
        controller.enqueue(source.slice(2, 8));
        controller.enqueue(source.slice(8));
        controller.close();
      },
    });
    const parts: Uint8Array[] = [];
    for await (const chunk of providerMediaChunks(body, source.byteLength, 4)) parts.push(chunk);
    expect(parts.map((part) => part.byteLength)).toEqual([4, 4, 1]);
    expect(parts.flatMap((part) => Array.from(part))).toEqual(Array.from(source));
  });

  it("honors destination-defined variable part sizes", async () => {
    const body = new Response(new Uint8Array([0, 1, 2, 3, 4, 5, 6])).body!;
    const parts: number[][] = [];
    for await (const chunk of providerMediaChunks(body, 7, [2, 4, 1]))
      parts.push(Array.from(chunk));
    expect(parts).toEqual([[0, 1], [2, 3, 4, 5], [6]]);
  });

  it.each([3, 7])("rejects actual data that disagrees with declared size %i", async (size) => {
    const consume = async () => {
      for await (const chunk of providerMediaChunks(new Response(new Uint8Array(5)).body!, size, 2))
        void chunk;
    };
    await expect(consume()).rejects.toMatchObject({ code: "unavailable", retryable: true });
  });

  it("cancels the source when a destination stops accepting chunks", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4));
      },
      cancel,
    });
    for await (const chunk of providerMediaChunks(body, 8, 4)) {
      expect(chunk.length).toBe(4);
      break;
    }
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects unsupported, oversized, or unverifiable sources before initializing an upload", async () => {
    for (const headers of [
      { "content-type": "video/mp4", "content-length": "10" },
      { "content-type": "text/html", "content-length": "3" },
      { "content-type": "video/mp4" },
    ] as Record<string, string>[]) {
      await expect(
        openProviderMedia("https://cdn.example/video", {
          maxBytes: 9,
          allowedMimeTypes: ["video/mp4"],
          fetcher: async () => new Response(new Uint8Array(3), { headers }),
        }),
      ).rejects.toBeInstanceOf(ProviderMediaDownloadError);
    }
  });
});

describe("size-aware image optimization", () => {
  const jpeg = (size: number) => {
    const bytes = new Uint8Array(size);
    bytes.set([0xff, 0xd8]);
    return bytes;
  };
  const png = (size: number) => {
    const bytes = new Uint8Array(size);
    bytes.set([0x89, 0x50, 0x4e, 0x47]);
    return bytes;
  };
  function imagesWithOutputs(outputs: Uint8Array[], mimeType = "image/jpeg") {
    const transform = vi.fn();
    const output = vi.fn(async (options: Record<string, unknown>) => {
      void options;
      return {
        response: () =>
          new Response(outputs.shift()! as BodyInit, { headers: { "content-type": mimeType } }),
      };
    });
    const handle = { output, transform: transform.mockImplementation(() => handle) };
    return {
      images: { input: vi.fn(() => handle) } as unknown as ImagesBinding,
      output,
      transform,
    };
  }
  it("leaves a compatible image that already fits byte-for-byte intact", async () => {
    const source = jpeg(6);
    const { images, output } = imagesWithOutputs([]);
    const result = await downloadProviderMedia("https://cdn.example/image", {
      maxBytes: 8,
      allowedMimeTypes: ["image/jpeg"],
      optimizeImage: { images, mimeType: "image/jpeg" },
      fetcher: async () => new Response(source, { headers: { "content-type": "image/jpeg" } }),
    });
    expect(result.bytes).toEqual(source);
    expect(output).not.toHaveBeenCalled();
  });
  it("uses lossless PNG output before attempting any resizing", async () => {
    const { images, output, transform } = imagesWithOutputs([png(6)], "image/png");
    const result = await downloadProviderMedia("https://cdn.example/image", {
      maxBytes: 8,
      allowedMimeTypes: ["image/png", "image/jpeg"],
      optimizeImage: { images, mimeType: "image/png" },
      fetcher: async () =>
        new Response(png(12), { headers: { "content-type": "image/png", "content-length": "12" } }),
    });
    expect(result.mimeType).toBe("image/png");
    expect(output).toHaveBeenCalledWith({ format: "image/png", quality: undefined });
    expect(transform).not.toHaveBeenCalled();
  });
  it("tries high quality at full resolution before scaling down without cropping", async () => {
    const { images, output, transform } = imagesWithOutputs([
      jpeg(12),
      jpeg(11),
      jpeg(10),
      jpeg(7),
    ]);
    const result = await downloadProviderMedia("https://cdn.example/image", {
      maxBytes: 8,
      allowedMimeTypes: ["image/jpeg"],
      optimizeImage: { images, mimeType: "image/jpeg" },
      fetcher: async () => new Response(jpeg(14), { headers: { "content-type": "image/jpeg" } }),
    });
    expect(result.bytes.byteLength).toBe(7);
    expect(output.mock.calls.slice(0, 3).map((args) => args[0])).toEqual([
      { format: "image/jpeg", quality: 95 },
      { format: "image/jpeg", quality: 92 },
      { format: "image/jpeg", quality: 90 },
    ]);
    expect(transform).toHaveBeenCalledExactlyOnceWith({
      width: 2560,
      height: 2560,
      fit: "scale-down",
    });
  });
  it("treats optimizer outages as retryable and refuses invalid optimized bytes", async () => {
    const opts = {
      maxBytes: 8,
      allowedMimeTypes: ["image/jpeg"],
      fetcher: async () => new Response(jpeg(14), { headers: { "content-type": "image/jpeg" } }),
    };
    await expect(
      downloadProviderMedia("https://cdn.example/image", {
        ...opts,
        optimizeImage: { mimeType: "image/jpeg" },
      }),
    ).rejects.toMatchObject({ code: "optimization_unavailable", retryable: true });
    const { images } = imagesWithOutputs([new Uint8Array(6)]);
    await expect(
      downloadProviderMedia("https://cdn.example/image", {
        ...opts,
        optimizeImage: { images, mimeType: "image/jpeg" },
      }),
    ).rejects.toMatchObject({ code: "optimization_unavailable", retryable: true });
  });
  it("never sends an oversized result after exhausting safe quality settings", async () => {
    const { images } = imagesWithOutputs(Array.from({ length: 7 }, () => jpeg(12)));
    await expect(
      downloadProviderMedia("https://cdn.example/image", {
        maxBytes: 8,
        allowedMimeTypes: ["image/jpeg"],
        optimizeImage: { images, mimeType: "image/jpeg" },
        fetcher: async () => new Response(jpeg(14), { headers: { "content-type": "image/jpeg" } }),
      }),
    ).rejects.toMatchObject({ code: "too_large", retryable: false });
  });
});

describe("resumable media byte ranges", () => {
  it("uses the acknowledged byte range and verifies the original total size", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(new Uint8Array([3, 4, 5]), {
          status: 206,
          headers: {
            "content-type": "video/mp4",
            "content-length": "3",
            "content-range": "bytes 3-5/6",
          },
        }),
    );
    const media = await openProviderMedia("https://cdn.example/video", {
      maxBytes: 6,
      allowedMimeTypes: ["video/mp4"],
      startByte: 3,
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://cdn.example/video",
      expect.objectContaining({ headers: { Range: "bytes=3-" } }),
    );
    expect(media.totalBytes).toBe(6);
    const chunks: number[] = [];
    for await (const chunk of providerMediaChunks(
      media.body,
      media.totalBytes,
      2,
      3,
      media.bodyStartByte,
    ))
      chunks.push(...chunk);
    expect(chunks).toEqual([3, 4, 5]);
  });
  it.each(["bytes 0-2/6", "bytes 3-5/999", "invalid"])(
    "rejects mismatched Content-Range %s",
    async (range) => {
      await expect(
        openProviderMedia("https://cdn.example/video", {
          maxBytes: 6,
          allowedMimeTypes: ["video/mp4"],
          startByte: 3,
          fetcher: async () =>
            new Response(new Uint8Array([3, 4, 5]), {
              status: 206,
              headers: {
                "content-type": "video/mp4",
                "content-length": "3",
                "content-range": range,
              },
            }),
        }),
      ).rejects.toBeInstanceOf(ProviderMediaDownloadError);
    },
  );
});
