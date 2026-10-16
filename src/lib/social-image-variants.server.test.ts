import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareSocialImageUrl } from "./social-image-variants.server";

const priorEnv = globalThis.__env__;
afterEach(() => {
  globalThis.__env__ = priorEnv;
  vi.restoreAllMocks();
});
describe("destination image variants", () => {
  it("keeps the original and reuses the derivative on retry", async () => {
    const item = {
      key: "users/creator/image/photo.png",
      url: "https://bento.surf/cdn/users/creator/image/photo.png",
      name: "photo.png",
      mimeType: "image/png",
      size: 1,
    };
    let variantKey: string | undefined;
    const head = vi.fn(async (key: string) =>
      key === item.key
        ? { size: 12, etag: "original-version", httpMetadata: { contentType: "image/png" } }
        : key === variantKey
          ? { size: 6, httpMetadata: { contentType: "image/jpeg" } }
          : null,
    );
    const get = vi.fn(async () => ({ body: new Response(new Uint8Array(12)).body!, size: 12 }));
    const put = vi.fn(async (key: string) => {
      variantKey = key;
    });
    const output = vi.fn(async () => ({
      response: () =>
        new Response(new Uint8Array([0xff, 0xd8, 0, 0, 0, 0]), {
          headers: { "content-type": "image/jpeg" },
        }),
    }));
    globalThis.__env__ = {
      MEDIA_BUCKET: { head, get, put },
      IMAGES: { input: () => ({ output }) },
    } as unknown as Env;
    const optimized = await prepareSocialImageUrl(item, 8, ["image/jpeg"]);
    expect(optimized.key).toMatch(/^users\/creator\/social-variants\/[a-f0-9]+\.jpg$/);
    expect(optimized.size).toBe(6);
    expect(item.key).toBe("users/creator/image/photo.png");
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0][0]).not.toBe(item.key);
    await expect(prepareSocialImageUrl(item, 8, ["image/jpeg"])).resolves.toEqual(optimized);
    expect(output).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
  });
});
