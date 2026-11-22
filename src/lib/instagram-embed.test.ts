import { afterEach, describe, expect, it, vi } from "vitest";
import mediaResolver, { type MediaResolverEnv } from "./media-resolver.worker-core";
import { handleFreeToolMediaRequest } from "./media-tools.server";
import { MEDIA_TOOLS_API_PATH } from "./media-tools";
import deployedResolver from "../media-resolver.worker";
import { fetchInstagramMedia } from "./instagram-embed";

const origin = "https://media.bento.surf";
const shortcode = "CxsaqgOPVJe";
const source = `https://www.instagram.com/p/${shortcode}/`;
const embed = `${source}embed/captioned/`;
const photo = "https://scontent-ord5-1.cdninstagram.com/v/photo.jpg?token=one&size=1080";
const video = "https://video-ord5-1.fbcdn.net/v/video.mp4?token=two";
it("retries one transient CDN read without retrying a permission denial", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response("image", { headers: { "content-type": "image/jpeg" } }));
  vi.stubGlobal("fetch", fetcher);
  expect(
    (await fetchInstagramMedia(new URL(photo), "image/jpeg", "GET", new AbortController().signal))
      .status,
  ).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockClear().mockResolvedValue(new Response(null, { status: 403 }));
  expect(
    (await fetchInstagramMedia(new URL(photo), "image/jpeg", "GET", new AbortController().signal))
      .status,
  ).toBe(403);
  expect(fetcher).toHaveBeenCalledOnce();
});
const secret = "a-long-instagram-resolver-secret-used-only-by-tests";
const upstream = "https://cobalt.invalid/";
const upstreamKey = "00000000-0000-4000-8000-000000000000";
const fullCaption = 'A "quoted" caption with \\ and a newline\n🌊';

const videoNode = {
  __typename: "GraphVideo",
  is_video: true,
  video_url: video,
  display_url: photo,
  video_duration: 12.5,
  video_view_count: 0,
};

function htmlResponse(html: string) {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function embedResponse(media: Record<string, unknown>) {
  const context = JSON.stringify({ gql_data: { shortcode_media: media } });
  return htmlResponse(
    `<html><script>register({"contextJSON" : ${JSON.stringify(context)}});</script></html>`,
  );
}

function resolverEnv(fetcher: ReturnType<typeof vi.fn>, options: MediaResolverEnv = {}) {
  vi.stubGlobal("fetch", fetcher);
  return {
    RESOLVER_SHARED_SECRET: secret,
    COBALT_UPSTREAM_API_KEY: upstreamKey,
    COBALT_UPSTREAM_URL: upstream,
    TUNNEL_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    ...options,
  };
}

function resolveRequest(path = "/instagram-reference", url = source, downloadMode?: string) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      authorization: `Api-Key ${secret}`,
      "content-type": "application/json",
      cookie: "incoming-private-cookie=never-forward",
    },
    body: JSON.stringify({ url, ...(downloadMode ? { downloadMode } : {}) }),
  });
}

async function signedVideo(env: MediaResolverEnv) {
  const response = await mediaResolver.fetch(resolveRequest(), env);
  expect(response.status).toBe(200);
  const result = (await response.json()) as { items: Array<{ url: string }> };
  return new URL(result.items[0].url);
}

function publicHeaders(init: RequestInit) {
  const headers = new Headers(init.headers);
  expect(init.redirect).toBe("manual");
  expect(init.credentials).toBe("omit");
  expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(headers.has("authorization")).toBe(false);
  expect(headers.has("cookie")).toBe(false);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Instagram embed resolver", () => {
  it("decodes escaped JSON and signs ordered carousel items with metadata", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      embedResponse({
        __typename: "GraphSidecar",
        shortcode,
        owner: { username: "surf.creator" },
        edge_media_to_caption: { edges: [{ node: { text: fullCaption } }] },
        edge_liked_by: { count: 25 },
        edge_media_to_comment: { count: 0 },
        taken_at_timestamp: 1_700_000_000,
        edge_sidecar_to_children: {
          edges: [
            {
              node: {
                display_resources: [
                  { src: photo, config_width: 1080 },
                  { src: "https://cdninstagram.com/small.jpg", config_width: 320 },
                ],
              },
            },
            { node: videoNode },
            { node: { display_url: "https://cdninstagram.com/last.png" } },
          ],
        },
      }),
    );
    const response = await mediaResolver.fetch(
      resolveRequest(
        "/instagram-reference",
        `https://instagram.com/p/${shortcode}/?img_index=2#fragment`,
      ),
      resolverEnv(fetcher),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const result = (await response.json()) as {
      source: unknown;
      expiresInSeconds: number;
      items: Array<{ kind: string; url: string; filename: string }>;
    };
    expect(result.source).toMatchObject({
      shortcode,
      url: source,
      owner: "surf.creator",
      caption: fullCaption,
      likes: 25,
      comments: 0,
      takenAt: 1_700_000_000,
    });
    expect(result.expiresInSeconds).toBe(90);
    expect(result.items.map((item) => item.kind)).toEqual(["image", "video", "image"]);
    expect(result.items.map((item) => new URL(item.url).searchParams.get("src"))).toEqual([
      photo,
      video,
      "https://cdninstagram.com/last.png",
    ]);
    for (const item of result.items) {
      const url = new URL(item.url);
      expect(url.origin).toBe(origin);
      expect(url.pathname).toBe("/instagram-media");
      expect(url.searchParams.get("bento_filename")).toBe(item.filename);
      expect(url.searchParams.get("signature")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe(embed);
    publicHeaders(fetcher.mock.calls[0][1]);
  });

  it("retains a zero view count and finite duration for a reel", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(embedResponse({ ...videoNode, edge_sidecar_to_children: { edges: [] } }));
    const response = await mediaResolver.fetch(
      resolveRequest("/instagram-reference", `https://m.instagram.com/reels/${shortcode}`),
      resolverEnv(fetcher),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source: { url: source, shortcode, durationSeconds: 12.5, views: 0 },
    });
  });

  it("parses a long valid context within the HTML cap and bounds text metadata", async () => {
    const caption = "x".repeat(1_200_000);
    const fetcher = vi.fn().mockResolvedValue(
      embedResponse({
        ...videoNode,
        owner: { username: "y".repeat(120) },
        edge_media_to_caption: { edges: [{ node: { text: caption } }] },
      }),
    );
    const response = await mediaResolver.fetch(resolveRequest(), resolverEnv(fetcher));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source: { owner: "y".repeat(100), caption: "x".repeat(2_200) },
    });
  });

  it.each([
    ["missing context", () => htmlResponse("<html>Please log in</html>")],
    ["malformed context", () => htmlResponse('<script>register({"contextJSON":"{bad"});</script>')],
    ["private post", () => embedResponse({ ...videoNode, owner: { is_private: true } })],
    ["mismatched shortcode", () => embedResponse({ ...videoNode, shortcode: "AnotherPost" })],
  ])("fails when the embed has %s", async (_label, responseFromEmbed) => {
    const fetcher = vi.fn().mockResolvedValue(responseFromEmbed());
    const response = await mediaResolver.fetch(resolveRequest(), resolverEnv(fetcher));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Instagram embed unavailable" });
  });

  it.each([
    [
      "a reel with only a cover",
      `https://instagram.com/reel/${shortcode}/`,
      { display_url: photo },
    ],
    ["a video post with only a cover", source, { __typename: "GraphVideo", display_url: photo }],
    [
      "a video child with only a cover",
      source,
      { edge_sidecar_to_children: { edges: [{ node: { is_video: true, display_url: photo } }] } },
    ],
  ])("does not substitute an image for %s", async (_label, url, media) => {
    const fetcher = vi.fn().mockResolvedValue(embedResponse(media));
    const response = await mediaResolver.fetch(
      resolveRequest("/instagram-reference", url),
      resolverEnv(fetcher),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Instagram video unavailable" });
  });

  it("returns at most 20 carousel children in source order", async () => {
    const edges = Array.from({ length: 25 }, (_, index) => ({
      node: { display_url: `https://cdninstagram.com/${index}.jpg` },
    }));
    const fetcher = vi
      .fn()
      .mockResolvedValue(embedResponse({ edge_sidecar_to_children: { edges } }));
    const response = await mediaResolver.fetch(resolveRequest(), resolverEnv(fetcher));
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as { items: Array<{ url: string }> };
    expect(items).toHaveLength(20);
    expect(new URL(items[19].url).searchParams.get("src")).toBe("https://cdninstagram.com/19.jpg");
  });

  it("requires resolver authorization before fetching an embed", async () => {
    const fetcher = vi.fn();
    const request = resolveRequest();
    request.headers.delete("authorization");
    const response = await mediaResolver.fetch(request, resolverEnv(fetcher));
    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    `https://instagram.com.invalid/p/${shortcode}/`,
    `https://instagram.com:8443/p/${shortcode}/`,
    `http://instagram.com/p/${shortcode}/`,
    `https://user:pass@instagram.com/p/${shortcode}/`,
    "https://instagram.com/p/invalid!shortcode/",
    `https://instagram.com/p/${shortcode}/embed/`,
  ])("rejects invalid post URL %s before fetching", async (url) => {
    const fetcher = vi.fn();
    const response = await mediaResolver.fetch(
      resolveRequest("/instagram-reference", url),
      resolverEnv(fetcher),
    );
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "https://cdninstagram.com.invalid/video.mp4",
    "https://spoofcdninstagram.com/video.mp4",
    "https://fbcdn.net:8443/video.mp4",
    "https://user:pass@fbcdn.net/video.mp4",
    "http://cdninstagram.com/video.mp4",
  ])("refuses to sign invalid CDN source %s", async (video_url) => {
    const fetcher = vi.fn().mockResolvedValue(embedResponse({ ...videoNode, video_url }));
    const response = await mediaResolver.fetch(resolveRequest(), resolverEnv(fetcher));
    expect(response.status).toBe(502);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    `https://instagram.com.invalid/p/${shortcode}/embed/captioned/`,
    `https://instagram.com:8443/p/${shortcode}/embed/captioned/`,
    "/accounts/login/",
    "/p/OtherPost/embed/captioned/",
  ])("rejects embed redirect %s before fetching it", async (location) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    const response = await mediaResolver.fetch(resolveRequest(), resolverEnv(fetcher));
    expect(response.status).toBe(502);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("caps otherwise valid embed redirects", async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.redirect(embed));
    const response = await mediaResolver.fetch(resolveRequest(), resolverEnv(fetcher));
    expect(response.status).toBe(502);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each(["content-length", "stream"])("caps embed HTML from the %s", async (mode) => {
    const content = `<script>${" ".repeat(2 * 1024 * 1024)}</script>`;
    const responseFromEmbed =
      mode === "stream"
        ? htmlResponse(content)
        : new Response(null, {
            headers: { "content-type": "text/html", "content-length": String(content.length) },
          });
    const response = await mediaResolver.fetch(
      resolveRequest(),
      resolverEnv(vi.fn().mockResolvedValue(responseFromEmbed)),
    );
    expect(response.status).toBe(502);
  });

  it("preserves a working Instagram Cobalt tunnel without fetching the embed", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json({ status: "tunnel", url: `${upstream}tunnel/ok`, filename: "cobalt.mp4" }),
      );
    const response = await mediaResolver.fetch(resolveRequest("/resolve"), resolverEnv(fetcher));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "tunnel",
      url: `${origin}/tunnel/ok`,
      filename: "cobalt.mp4",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe(upstream);
  });

  it.each([
    ["instagram-video-downloader", "reel", true],
    ["social-media-downloader", "reels", true],
    ["social-media-downloader", "tv", false],
    ["instagram-video-downloader", "reel", false],
  ] as const)(
    "resolves %s /%s when the embed contains video: %s",
    async (toolSlug, path, hasVideo) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            status: "picker",
            picker: [{ type: "photo", url: upstream + "tunnel/poster", filename: "cover.jpg" }],
          }),
        )
        .mockResolvedValueOnce(embedResponse(hasVideo ? videoNode : { display_url: photo }));
      const env = resolverEnv(fetcher);
      const response = await handleFreeToolMediaRequest(
        new Request("https://bento.surf" + MEDIA_TOOLS_API_PATH, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://bento.surf" },
          body: JSON.stringify({ toolSlug, url: `https://instagram.com/${path}/${shortcode}/` }),
        }),
        { APP_ENV: "development", COBALT_API_URL: origin, COBALT_API_KEY: secret },
        {
          fetcher: async (input, init) => mediaResolver.fetch(new Request(input, init), env),
        },
      );
      expect(response?.status).toBe(hasVideo ? 200 : 422);
      if (hasVideo) {
        const { items } = (await response!.json()) as {
          items: { url: string; mediaType: string }[];
        };
        expect(items).toHaveLength(1);
        expect(items[0].mediaType).toBe("video");
        const link = new URL(items[0].url);
        expect(link.pathname).toBe("/instagram-media");
        expect(link.searchParams.get("src")).toBe(video);
        expect(link.searchParams.get("signature")).toBeTruthy();
      } else {
        expect(await response?.json()).toEqual({
          error: "Instagram did not provide a downloadable video for that link",
        });
      }
      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([upstream, embed]);
      publicHeaders(fetcher.mock.calls[1][1]);
    },
  );
  it.each(["tunnel", "picker"])(
    "checks the actual video MIME on a Cobalt Reel %s",
    async (status) => {
      const tunnel = upstream + "tunnel/clip";
      const candidate =
        status === "tunnel"
          ? { status, url: tunnel, filename: "clip.mp4" }
          : { status, picker: [{ type: "video", url: tunnel, filename: "clip.mp4" }] };
      for (const mime of ["video/mp4", "image/jpeg"]) {
        const fetcher = vi
          .fn()
          .mockResolvedValueOnce(Response.json(candidate))
          .mockResolvedValueOnce(new Response("bytes", { headers: { "content-type": mime } }))
          .mockResolvedValueOnce(embedResponse({ display_url: photo }));
        const response = await mediaResolver.fetch(
          resolveRequest("/resolve", `https://instagram.com/tv/${shortcode}/`, "auto"),
          resolverEnv(fetcher),
        );
        const result = await response.json();
        if (mime === "video/mp4") {
          expect(result).toMatchObject({ status });
          expect(fetcher).toHaveBeenCalledTimes(2);
        } else
          expect(result).toMatchObject({
            status: "error",
            error: { code: "error.api.instagram.video_unavailable" },
          });
        expect(String(fetcher.mock.calls[1][0])).toBe(tunnel);
        expect(fetcher.mock.calls[1][1].redirect).toBe("manual");
        expect(new Headers(fetcher.mock.calls[1][1].headers).get("range")).toBe("bytes=0-1023");
      }
    },
  );
  it.each(["private", "deleted"])(
    "preserves a terminal Cobalt %s Reel response",
    async (reason) => {
      const terminal = { status: "error", error: { code: "error.api.content." + reason } };
      const fetcher = vi.fn().mockResolvedValueOnce(Response.json(terminal));
      const response = await mediaResolver.fetch(
        resolveRequest("/resolve", `https://instagram.com/reel/${shortcode}/`),
        resolverEnv(fetcher),
      );
      expect(await response.json()).toEqual(terminal);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("returns a compatible Instagram picker after Cobalt cannot resolve", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { status: "error", error: { code: "error.api.content.post.unavailable" } },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        embedResponse({
          edge_sidecar_to_children: {
            edges: [{ node: { display_url: photo } }, { node: videoNode }],
          },
        }),
      );
    const response = await mediaResolver.fetch(resolveRequest("/resolve"), resolverEnv(fetcher));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "picker",
      picker: [
        {
          type: "photo",
          url: expect.stringContaining(`${origin}/instagram-media?`),
          filename: expect.stringMatching(/\.jpg$/u),
        },
        {
          type: "video",
          url: expect.stringContaining(`${origin}/instagram-media?`),
          filename: expect.stringMatching(/\.mp4$/u),
        },
      ],
    });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([upstream, embed]);
    publicHeaders(fetcher.mock.calls[1][1]);
  });

  it("selects video after a Cobalt audio failure for the transcript parser", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("Cobalt unavailable"))
      .mockResolvedValueOnce(
        embedResponse({
          edge_sidecar_to_children: {
            edges: [{ node: { display_url: photo } }, { node: videoNode }],
          },
        }),
      );
    const response = await mediaResolver.fetch(
      resolveRequest("/resolve", source, "audio"),
      resolverEnv(fetcher),
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as { status: string; url: string; filename: string };
    expect(result.status).toBe("tunnel");
    expect(result.filename).toMatch(/\.mp4$/u);
    expect(new URL(result.url).searchParams.get("src")).toBe(video);
  });

  it.each([undefined, "https://cdninstagram.com/unsigned.mp3"])(
    "selects the first embed video when the Cobalt picker audio is %s",
    async (audio) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            status: "picker",
            audio,
            picker: [{ type: "video", url: `${upstream}tunnel/video` }],
          }),
        )
        .mockResolvedValueOnce(
          embedResponse({
            edge_sidecar_to_children: {
              edges: [
                { node: { display_url: photo } },
                { node: videoNode },
                { node: { ...videoNode, video_url: "https://fbcdn.net/second.mp4" } },
              ],
            },
          }),
        );
      const response = await mediaResolver.fetch(
        resolveRequest("/resolve", source, "audio"),
        resolverEnv(fetcher),
      );
      expect(response.status).toBe(200);
      const result = (await response.json()) as { status: string; url: string; filename: string };
      expect(result.status).toBe("tunnel");
      expect(new URL(result.url).searchParams.get("src")).toBe(video);
      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([upstream, embed]);
    },
  );

  it("uses a valid Cobalt audio tunnel from the next configured candidate", async () => {
    const proxy = `${upstream}webshare/`;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          status: "picker",
          picker: [{ type: "video", url: `${upstream}tunnel/video` }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          status: "picker",
          audio: `${proxy}tunnel/audio`,
          audioFilename: "cobalt.mp3",
          picker: [],
        }),
      );
    const response = await mediaResolver.fetch(
      resolveRequest("/resolve", source, "audio"),
      resolverEnv(fetcher, { COBALT_PROXY_URL: proxy }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "picker",
      audio: `${origin}/webshare/tunnel/audio`,
      audioFilename: "cobalt.mp3",
    });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([upstream, proxy]);
  });
});

describe("signed Instagram media", () => {
  it("allows a valid CDN redirect while keeping request credentials private", async () => {
    const redirected = "https://scontent.cdninstagram.com/redirected.mp4";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(embedResponse(videoNode))
      .mockResolvedValueOnce(Response.redirect(redirected))
      .mockResolvedValueOnce(
        new Response("video bytes", {
          headers: {
            "content-type": "video/mp4",
            "content-length": "11",
            "set-cookie": "upstream=private",
          },
        }),
      );
    const env = resolverEnv(fetcher);
    const signed = await signedVideo(env);
    const response = await mediaResolver.fetch(
      new Request(signed, {
        headers: {
          authorization: "Bearer incoming",
          cookie: "incoming=private",
          "cf-connecting-ip": "203.0.113.9",
        },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${signed.searchParams.get("bento_filename")}"`,
    );
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await response.text()).toBe("video bytes");
    expect(fetcher.mock.calls.slice(1).map(([url]) => String(url))).toEqual([video, redirected]);
    for (const [, init] of fetcher.mock.calls.slice(1)) publicHeaders(init);
    expect(env.TUNNEL_RATE_LIMITER?.limit).toHaveBeenCalledWith({
      key: "media-tunnel:203.0.113.9",
    });
  });

  it.each([
    ["src", "https://fbcdn.net/other.mp4"],
    ["kind", "image"],
    ["bento_filename", "renamed.mp4"],
    ["signature", "A".repeat(43)],
  ])("rejects tampering with signed %s before fetching", async (field, value) => {
    const fetcher = vi.fn().mockResolvedValueOnce(embedResponse(videoNode));
    const env = resolverEnv(fetcher);
    const signed = await signedVideo(env);
    signed.searchParams.set(field, value);
    const response = await mediaResolver.fetch(new Request(signed), env);
    expect(response.status).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects expired links before fetching", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T00:00:00Z"));
    const fetcher = vi.fn().mockResolvedValueOnce(embedResponse(videoNode));
    const env = resolverEnv(fetcher);
    const signed = await signedVideo(env);
    const tampered = new URL(signed);
    tampered.searchParams.set("expires", String(Number(signed.searchParams.get("expires")) - 1));
    expect((await mediaResolver.fetch(new Request(tampered), env)).status).toBe(404);
    vi.setSystemTime(new Date("2026-11-19T00:01:31Z"));
    const response = await mediaResolver.fetch(new Request(signed), env);
    expect(response.status).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("enforces the existing public tunnel rate limit before downloading", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(embedResponse(videoNode));
    const env = resolverEnv(fetcher, {
      TUNNEL_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: false }) },
    });
    const response = await mediaResolver.fetch(new Request(await signedVideo(env)), env);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://fbcdn.net.invalid/other.mp4",
    "https://fbcdn.net:8443/other.mp4",
    "http://cdninstagram.com/other.mp4",
  ])("refuses CDN redirect %s before fetching it", async (target) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(embedResponse(videoNode))
      .mockResolvedValueOnce(Response.redirect(target));
    const env = resolverEnv(fetcher);
    const response = await mediaResolver.fetch(new Request(await signedVideo(env)), env);
    expect(response.status).toBe(502);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["wrong media kind", { "content-type": "image/jpeg" }, 502],
    ["unsupported type", { "content-type": "text/html" }, 502],
    [
      "oversized declared length",
      { "content-type": "video/mp4", "content-length": "5368709121" },
      413,
    ],
    ["invalid declared length", { "content-type": "video/mp4", "content-length": "4, 10" }, 413],
  ])("rejects %s in a CDN response", async (_label, headers, status) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(embedResponse(videoNode))
      .mockResolvedValueOnce(
        new Response("untrusted bytes", { headers: new Headers(Object.entries(headers)) }),
      );
    const env = resolverEnv(fetcher);
    const response = await mediaResolver.fetch(new Request(await signedVideo(env)), env);
    expect(response.status).toBe(status);
  });

  it("stops an image stream that exceeds its byte limit without a declared length", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(embedResponse({ display_url: photo }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array(20 * 1_024 * 1_024 + 1), {
          headers: { "content-type": "image/jpeg" },
        }),
      );
    const env = resolverEnv(fetcher);
    const response = await mediaResolver.fetch(new Request(await signedVideo(env)), env);
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow("media-too-large");
  });

  it("rejects a redirected image whose MIME type differs from its signed extension", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(embedResponse({ display_url: photo }))
      .mockResolvedValueOnce(Response.redirect("https://cdninstagram.com/other.webp"))
      .mockResolvedValueOnce(
        new Response("image bytes", { headers: { "content-type": "image/webp" } }),
      );
    const env = resolverEnv(fetcher);
    const signed = await signedVideo(env);
    expect(signed.searchParams.get("bento_filename")).toMatch(/\.jpg$/u);
    const response = await mediaResolver.fetch(new Request(signed), env);
    expect(response.status).toBe(502);
  });

  it("serves image previews inline and downloads the same signed link when requested", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(embedResponse({ display_url: photo }))
      .mockImplementation(
        async () =>
          new Response(null, { headers: { "content-type": "image/jpeg", "content-length": "10" } }),
      );
    const env = resolverEnv(fetcher);
    const signed = await signedVideo(env);
    const preview = await mediaResolver.fetch(new Request(signed, { method: "HEAD" }), env);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-disposition")).toMatch(/^inline;/u);
    expect(preview.body).toBe(null);
    signed.searchParams.set("bento_download", "1");
    const download = await mediaResolver.fetch(new Request(signed, { method: "HEAD" }), env);
    expect(download.headers.get("content-disposition")).toMatch(/^attachment;/u);
    expect(fetcher.mock.calls[2][1].method).toBe("HEAD");
  });

  it("aborts an in-flight download body when the client disconnects", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(embedResponse(videoNode))
      .mockResolvedValueOnce(
        new Response(new ReadableStream<Uint8Array>(), {
          headers: { "content-type": "video/mp4" },
        }),
      );
    const env = resolverEnv(fetcher);
    const controller = new AbortController();
    const response = await mediaResolver.fetch(
      new Request(await signedVideo(env), { signal: controller.signal }),
      env,
    );
    const reader = response.body!.getReader();
    const pending = reader.read();
    await Promise.resolve();
    controller.abort(new Error("download disconnected"));
    await expect(pending).rejects.toThrow("download disconnected");
  });

  it("shares the deployed worker's four-stream limit", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(embedResponse(videoNode))
      .mockImplementation(
        async () =>
          new Response(new ReadableStream<Uint8Array>(), {
            headers: { "content-type": "video/mp4" },
          }),
      );
    const env = resolverEnv(fetcher);
    const signed = await signedVideo(env);
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => deployedResolver.fetch(new Request(signed), env)),
    );
    try {
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 429]);
    } finally {
      await Promise.all(responses.map((response) => response.body?.cancel()));
    }
  });
});
