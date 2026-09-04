import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { durableSocialAvatarUrl } from "./social-avatar.server";

const bucket = {
  put: vi.fn().mockResolvedValue({}),
};

describe("social connection avatars", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_APP_URL", "https://app.test.bento.surf");
    bucket.put.mockClear();
    globalThis.__env__ = { MEDIA_BUCKET: bucket } as unknown as Env;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    globalThis.__env__ = undefined;
  });

  it("copies a provider avatar during connection and returns the staging CDN URL", async () => {
    const value = await durableSocialAvatarUrl({
      userId: "22222222-2222-4222-8222-222222222222",
      provider: "facebook",
      providerUserId: "page-1",
      value: "https://scontent.example.fbcdn.net/avatar.jpg",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://scontent.example.fbcdn.net/avatar.jpg",
      expect.objectContaining({ redirect: "manual", signal: expect.anything() }),
    );
    expect(bucket.put).toHaveBeenCalledWith(
      expect.stringMatching(
        /^users\/22222222-2222-4222-8222-222222222222\/social-avatars\/facebook-[a-f0-9]{16}-[a-f0-9]{16}$/,
      ),
      expect.any(Uint8Array),
      expect.objectContaining({
        httpMetadata: expect.objectContaining({ contentType: "image/jpeg" }),
      }),
    );
    expect(value).toMatch(
      /^https:\/\/app\.test\.bento\.surf\/cdn\/users\/22222222-2222-4222-8222-222222222222\/social-avatars\/facebook-[a-f0-9]{16}-[a-f0-9]{16}$/,
    );
  });

  it("does not fetch a first-party staging avatar again", async () => {
    const value = "https://app.test.bento.surf/cdn/users/user-1/social-avatars/facebook-abc";

    await expect(
      durableSocialAvatarUrl({
        userId: "user-1",
        provider: "facebook",
        providerUserId: "page-1",
        value,
      }),
    ).resolves.toBe(value);
    expect(fetch).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it("keeps the provider URL when copying fails", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("timeout"));
    const value = "https://pbs.twimg.com/profile_images/123/avatar.jpg";

    await expect(
      durableSocialAvatarUrl({
        userId: "user-1",
        provider: "twitter",
        providerUserId: "x-1",
        value,
      }),
    ).resolves.toBe(value);
  });

  it("does not buffer or store an oversized chunked avatar", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024 + 1));
            controller.enqueue(new Uint8Array(1024 * 1024));
            controller.close();
          },
        }),
        { headers: { "content-type": "image/jpeg" } },
      ),
    );
    const value = "https://pbs.twimg.com/profile_images/123/avatar.jpg";

    await expect(
      durableSocialAvatarUrl({
        userId: "user-1",
        provider: "twitter",
        providerUserId: "x-1",
        value,
      }),
    ).resolves.toBe(value);
    expect(bucket.put).not.toHaveBeenCalled();
  });
});
