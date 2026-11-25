import { afterEach, expect, it, vi } from "vitest";
import mediaResolver from "../media-resolver.worker";
import {
  fetchTikTokPublicPost,
  parseTikTokPublicPost,
  tiktokImageUrl,
  tiktokPublicPost,
} from "./tiktok-public";
afterEach(() => vi.unstubAllGlobals());
const id = "7557376330036153622";
const photo = "https://p16-sign.tiktokcdn.com/public/photo.jpg?token=public-media";
const html = (post: object, code = 0) =>
  `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.video-detail": { statusCode: code, itemInfo: { itemStruct: post } } } })}</script>`;
const post = {
  id,
  privateItem: false,
  author: { privateAccount: false },
  imagePost: { images: [{ imageURL: { urlList: [photo] } }] },
  video: { cover: photo },
};
it("normalizes a public photo to its first-party logged-out video detail page", () => {
  expect(tiktokPublicPost(`https://www.tiktok.com/@hullcity/photo/${id}?share=1`)).toEqual({
    id,
    photo: true,
    url: `https://www.tiktok.com/@hullcity/video/${id}`,
  });
  for (const url of [
    "http://tiktok.com/@a/video/12345678",
    "https://tiktok.com.evil/@a/video/12345678",
    "https://user@tiktok.com/@a/video/12345678",
    "https://tiktok.com:8443/@a/video/12345678",
  ])
    expect(tiktokPublicPost(url)).toBeNull();
});

it.each(["photo", "cover"])("returns a signed %s through the real gateway", async (kind) => {
  const secret = "a-staging-test-secret-with-more-than-thirty-two-characters";
  const fetcher = vi.fn(async (input: string | URL) => {
    const target = new URL(input);
    if (target.pathname === "/oembed") return new Response(null, { status: 404 });
    if (target.hostname === "www.tiktok.com")
      return new Response(html(post), { headers: { "content-type": "text/html" } });
    if (target.href === photo)
      return new Response(
        Uint8Array.of(255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1),
        { headers: { "content-type": "image/jpeg" } },
      );
    throw new Error("Unexpected source");
  });
  vi.stubGlobal("fetch", fetcher);
  const env = {
    RESOLVER_SHARED_SECRET: secret,
    TUNNEL_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
  const path = kind === "photo" ? "/resolve" : "/cover";
  const body =
    kind === "photo"
      ? { url: `https://www.tiktok.com/@hullcity/photo/${id}`, downloadMode: "auto" }
      : { url: `https://www.tiktok.com/@hullcity/video/${id}`, platform: "tiktok" };
  const response = await mediaResolver.fetch(
    new Request("https://media.test.bento.surf" + path, {
      method: "POST",
      headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
  const data = (await response.json()) as {
    status: string;
    picker: { url: string; filename: string }[];
  };
  expect(data.status).toBe("picker");
  expect(data.picker).toHaveLength(1);
  const signed = new URL(data.picker[0].url);
  expect(signed.pathname).toBe("/image");
  const download = await mediaResolver.fetch(new Request(signed), env);
  expect(download.status).toBe(200);
  expect((await download.arrayBuffer()).byteLength).toBe(16);
  signed.searchParams.set("bento_filename", "different.jpg");
  expect((await mediaResolver.fetch(new Request(signed), env)).status).toBe(404);
});
it("extracts all ordered images without replacing them with the cover", () => {
  expect(parseTikTokPublicPost(html(post), id)).toMatchObject({
    id,
    images: [photo],
    cover: photo,
  });
  expect(parseTikTokPublicPost(html({ id, video: { cover: photo } }), id).images).toEqual([]);
});
it.each([
  { id: "999999999" },
  { privateItem: true },
  { author: { privateAccount: true } },
  { isSecret: true },
])("rejects private or unrelated post data %j", (change) => {
  expect(() => parseTikTokPublicPost(html({ ...post, ...change }), id)).toThrow();
});
it("rejects non-provider assets and partial oversized carousels", () => {
  for (const url of [
    "https://127.0.0.1/x.jpg",
    "https://tiktokcdn.com.evil/x.jpg",
    "http://p16.tiktokcdn.com/x.jpg",
    "https://p16.tiktokcdn.com:444/x.jpg",
  ])
    expect(tiktokImageUrl(url)).toBeNull();
  expect(() =>
    parseTikTokPublicPost(
      html({ ...post, imagePost: { images: Array(21).fill(post.imagePost.images[0]) } }),
      id,
    ),
  ).toThrow();
  expect(() =>
    parseTikTokPublicPost(
      html({
        ...post,
        imagePost: { images: [{ imageURL: { urlList: ["https://127.0.0.1/x.jpg"] } }] },
      }),
      id,
    ),
  ).toThrow();
});
it("uses manual redirects and never follows an authwall or unknown redirect", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://127.0.0.1/" } }),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    fetchTikTokPublicPost(
      `https://www.tiktok.com/@hullcity/photo/${id}`,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "manual", credentials: "omit" });
});

it("retains exact public counters from the same photo-download metadata", () => {
  expect(
    parseTikTokPublicPost(
      html({
        ...post,
        statsV2: {
          playCount: "100",
          diggCount: "2",
          commentCount: "3",
          shareCount: "4",
          collectCount: "0",
        },
      }),
      id,
    ).counts,
  ).toEqual({ views: 100, likes: 2, comments: 3, shares: 4, saves: 0 });
});
