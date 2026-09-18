import { describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_REMOVAL_API_PATH,
  handleBackgroundRemovalRequest,
} from "./background-removal-tool.server";

function imageRequest(overrides: RequestInit = {}) {
  return new Request(`http://localhost:8080${BACKGROUND_REMOVAL_API_PATH}`, {
    method: "POST",
    headers: {
      origin: "http://localhost:8080",
      "content-type": "image/png",
      "x-bento-file-size": "4",
    },
    body: new Uint8Array([1, 2, 3, 4]),
    ...overrides,
  });
}

describe("background removal endpoint", () => {
  it("removes the background through the protected Images binding", async () => {
    const response = vi.fn(() => new Response(new Uint8Array([9]), { status: 200 }));
    const output = vi.fn(async () => ({ response }));
    const transform = vi.fn(() => ({ output }));
    const input = vi.fn(() => ({ transform }));
    const limiter = vi.fn().mockResolvedValue({ success: true });

    const result = await handleBackgroundRemovalRequest(imageRequest(), {
      APP_ENV: "development",
      FREE_TOOLS_MEDIA_RATE_LIMITER: { limit: limiter },
      IMAGES: { input } as unknown as ImagesBinding,
    });

    expect(result?.status).toBe(200);
    expect(result?.headers.get("content-type")).toBe("image/png");
    expect(result?.headers.get("cache-control")).toBe("private, no-store");
    expect(input).toHaveBeenCalledOnce();
    expect(transform).toHaveBeenCalledWith({ segment: "foreground" });
    expect(output).toHaveBeenCalledWith({ format: "image/png" });
    expect(limiter).toHaveBeenCalledWith({ key: "free-tool-background:missing-cloudflare-ip" });
  });

  it.each([
    [new Request(`http://localhost:8080${BACKGROUND_REMOVAL_API_PATH}`), 405],
    [imageRequest({ headers: { origin: "https://evil.example" } }), 403],
    [
      imageRequest({ headers: { origin: "http://localhost:8080", "content-type": "text/plain" } }),
      415,
    ],
  ])("rejects invalid requests", async (request, status) => {
    expect(
      (await handleBackgroundRemovalRequest(request, { APP_ENV: "development" }))?.status,
    ).toBe(status);
  });
});
