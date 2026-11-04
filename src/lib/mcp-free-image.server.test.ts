import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reserveProviderUsage = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./provider-budget.server", async () => ({
  ...(await vi.importActual<typeof import("./provider-budget.server")>("./provider-budget.server")),
  reserveProviderUsage,
}));

import { runMcpFreeImageTool } from "./mcp-free-image.server";
import { readMcpFreeFile } from "./mcp-free-files.server";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const inlineImage = {
  fileName: "example.png",
  mimeType: "image/png",
  base64: Buffer.from([1, 2, 3, 4]).toString("base64"),
};

function imageEnv() {
  const response = vi.fn(
    () =>
      new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "image/png" },
      }),
  );
  const output = vi.fn(async () => ({ response }));
  const transform = vi.fn((_options: { gravity?: { x: number } }) => ({ output }));
  const input = vi.fn(() => ({ transform, output }));
  const info = vi.fn(async () => ({ format: "image/png", fileSize: 4, width: 300, height: 100 }));
  const limit = vi.fn(async () => ({ success: true }));
  return {
    env: {
      APP_ENV: "production",
      IMAGES: { info, input } as unknown as ImagesBinding,
      FREE_TOOLS_MEDIA_RATE_LIMITER: { limit },
    },
    input,
    transform,
    output,
    limit,
  };
}

beforeEach(() => reserveProviderUsage.mockClear());

describe("MCP image tools", () => {
  it("reserves all split tiles before image execution and returns three images", async () => {
    const fixture = imageEnv();
    const result = await runMcpFreeImageTool(
      workspaceId,
      { ...inlineImage, toolSlug: "image-splitter", parts: 3 },
      fixture.env,
    );
    expect(reserveProviderUsage).toHaveBeenCalledExactlyOnceWith("image_transformations", 3, {
      workspaceId,
    });
    expect(fixture.limit).toHaveBeenCalledWith({ key: `free-tool-image:mcp:${workspaceId}` });
    expect(fixture.input).toHaveBeenCalledTimes(3);
    expect(fixture.transform).toHaveBeenCalledTimes(3);
    expect(fixture.transform.mock.calls.map(([options]) => options.gravity?.x)).toEqual([
      1 / 6,
      1 / 2,
      5 / 6,
    ]);
    expect(result.images).toHaveLength(3);
    expect(result.images.map((image) => image.name)).toEqual([
      "example-1-of-3.png",
      "example-2-of-3.png",
      "example-3-of-3.png",
    ]);
  });

  it("uses the existing background-removal reservation and scoped rate limit", async () => {
    const fixture = imageEnv();
    const result = await runMcpFreeImageTool(
      workspaceId,
      { ...inlineImage, toolSlug: "background-remover" },
      fixture.env,
    );
    expect(reserveProviderUsage).toHaveBeenCalledWith("public_background_removals");
    expect(reserveProviderUsage).toHaveBeenCalledWith("image_transformations");
    expect(fixture.limit).toHaveBeenCalledWith({
      key: `free-tool-background:mcp:${workspaceId}`,
    });
    expect(result.images[0]).toMatchObject({ mimeType: "image/png", width: 300, height: 100 });
  });

  it("refuses a foreign media key and fails closed without the production limiter", async () => {
    await expect(
      readMcpFreeFile(
        workspaceId,
        { mediaKey: "users/00000000-0000-4000-8000-000000000002/image/a.png", fileName: "a.png" },
        1024,
      ),
    ).rejects.toThrow("another workspace");
    await expect(
      runMcpFreeImageTool(
        workspaceId,
        { ...inlineImage, toolSlug: "image-flipper" },
        { APP_ENV: "production", IMAGES: imageEnv().env.IMAGES },
      ),
    ).rejects.toThrow("temporarily unavailable");
    expect(reserveProviderUsage).not.toHaveBeenCalled();
  });
});
