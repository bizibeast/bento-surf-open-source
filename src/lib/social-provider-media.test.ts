import { describe, expect, it, vi } from "vitest";
import { downloadProviderMedia, ProviderMediaDownloadError } from "./social-provider-media";

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
