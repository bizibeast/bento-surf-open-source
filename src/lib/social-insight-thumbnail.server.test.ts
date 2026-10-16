import { afterEach, expect, it, vi } from "vitest";
import { durableSocialInsightThumbnailUrl } from "./social-insight-thumbnail.server";

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as typeof globalThis & { __env__?: Env }).__env__;
});

it("copies a Meta thumbnail into durable public storage", async () => {
  const put = vi.fn().mockResolvedValue(undefined);
  (globalThis as typeof globalThis & { __env__?: Env }).__env__ = {
    MEDIA_BUCKET: { put },
  } as unknown as Env;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        headers: { "content-type": "image/jpeg" },
      }),
    ),
  );

  const result = await durableSocialInsightThumbnailUrl({
    userId: "user-id",
    connectionId: "connection-id",
    provider: "instagram",
    remotePostId: "post-id",
    url: "https://scontent.cdninstagram.com/cover.jpg",
  });

  expect(result).toMatch(/\/cdn\/social-insights\/user-id\/connection-id\/.*\.jpg$/);
  expect(put).toHaveBeenCalledWith(
    expect.stringMatching(/^social-insights\/user-id\/connection-id\//),
    expect.any(Uint8Array),
    expect.objectContaining({
      httpMetadata: {
        contentType: "image/jpeg",
        cacheControl: "public, max-age=31536000, immutable",
      },
    }),
  );
});

it("rejects a non-provider thumbnail host without fetching it", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const url = "https://example.com/cover.jpg";
  expect(
    await durableSocialInsightThumbnailUrl({
      userId: "user-id",
      connectionId: "connection-id",
      provider: "instagram",
      remotePostId: "post-id",
      url,
    }),
  ).toBe(url);
  expect(fetcher).not.toHaveBeenCalled();
});
