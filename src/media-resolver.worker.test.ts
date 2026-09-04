import { afterEach, describe, expect, it, vi } from "vitest";
import mediaResolver, {
  readBoundedBytes,
  releaseWhenStreamEnds,
  StreamConcurrencyGate,
  streamWithByteLimit,
} from "./lib/media-resolver.worker-core";

const SECRET = "a-long-random-shared-secret-used-only-by-tests";
const UPSTREAM_KEY = "00000000-0000-4000-8000-000000000000";
const UPSTREAM_URL = "https://media-resolver.invalid";

function envFor(
  fetcher: ReturnType<typeof vi.fn>,
  limit = vi.fn().mockResolvedValue({ success: true }),
) {
  vi.stubGlobal("fetch", fetcher);
  return {
    COBALT_UPSTREAM_API_KEY: UPSTREAM_KEY,
    COBALT_UPSTREAM_URL: UPSTREAM_URL,
    RESOLVER_SHARED_SECRET: SECRET,
    TUNNEL_RATE_LIMITER: { limit },
  };
}

describe("media resolver Worker", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the processing endpoint private and no-store", async () => {
    const fetcher = vi.fn();
    const response = await mediaResolver.fetch(
      new Request("https://media.bento.surf/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/video" }),
      }),
      envFor(fetcher) as never,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards authorized requests and rewrites only Cobalt tunnel URLs", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        status: "picker",
        audio: "https://media-resolver.invalid/tunnel?id=audio",
        picker: [
          {
            type: "video",
            url: "https://media-resolver.invalid/tunnel?id=video",
            thumb: "https://cdn.example/thumb.jpg",
          },
        ],
      }),
    );
    const response = await mediaResolver.fetch(
      new Request("https://media.bento.surf/resolve", {
        method: "POST",
        headers: {
          authorization: `Api-Key ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/video" }),
      }),
      envFor(fetcher) as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "picker",
      audio: "https://media.bento.surf/tunnel?id=audio",
      picker: [
        {
          type: "video",
          url: "https://media.bento.surf/tunnel?id=video",
          thumb: "https://cdn.example/thumb.jpg",
        },
      ],
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`${UPSTREAM_URL}/`);
    expect(fetcher.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: "POST", headers: expect.any(Headers) }),
    );
    expect((fetcher.mock.calls[0]?.[1]?.headers as Headers).get("authorization")).toBe(
      `Api-Key ${UPSTREAM_KEY}`,
    );
    expect((fetcher.mock.calls[0]?.[1]?.headers as Headers).get("user-agent")).toBe(
      "bento-media-gateway/1.0",
    );
  });

  it("rejects same-origin Cobalt URLs outside the tunnel route", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        status: "tunnel",
        url: `${UPSTREAM_URL}/admin`,
        filename: "video.mp4",
      }),
    );
    const response = await mediaResolver.fetch(
      new Request("https://media.bento.surf/resolve", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/video" }),
      }),
      envFor(fetcher) as never,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Media resolver is temporarily unavailable",
    });
  });

  it("rate limits public tunnel streams", async () => {
    const fetcher = vi.fn();
    const limit = vi.fn().mockResolvedValue({ success: false });
    const response = await mediaResolver.fetch(
      new Request("https://media.bento.surf/tunnel?id=video", {
        headers: { "cf-connecting-ip": "203.0.113.7" },
      }),
      envFor(fetcher, limit) as never,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(limit).toHaveBeenCalledWith({ key: "media-tunnel:203.0.113.7" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves structured Cobalt errors for the app gateway", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { status: "error", error: { code: "error.api.youtube.login" } },
          { status: 400 },
        ),
      );
    const response = await mediaResolver.fetch(
      new Request("https://media.bento.surf/", {
        method: "POST",
        headers: {
          authorization: `Api-Key ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://youtube.com/watch?v=test" }),
      }),
      envFor(fetcher) as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "error",
      error: { code: "error.api.youtube.login" },
    });
  });

  it("falls back from an unusable direct tunnel to the YouTube session route", async () => {
    const sessionUrl = `${UPSTREAM_URL}/youtube-session`;
    const proxyUrl = `${UPSTREAM_URL}/webshare`;
    const fetcher = vi.fn().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `${UPSTREAM_URL}/`) {
        return Response.json({
          status: "tunnel",
          url: `${UPSTREAM_URL}/tunnel?id=direct-video`,
          filename: "video.mp4",
        });
      }
      if (url === `${UPSTREAM_URL}/tunnel?id=direct-video`) {
        expect(init?.headers).toEqual(expect.any(Headers));
        return new Response("unavailable", { status: 502 });
      }
      if (url === `${sessionUrl}/`) {
        return Response.json({
          status: "tunnel",
          url: `${UPSTREAM_URL}/tunnel?id=session-video`,
          filename: "video.mp4",
        });
      }
      if (url === `${sessionUrl}/tunnel?id=session-video`) {
        expect(new Headers(init?.headers).get("range")).toBe("bytes=0-1023");
        return new Response(Uint8Array.from([1, 2, 3]), {
          status: 206,
          headers: { "content-type": "video/mp4", "content-range": "bytes 0-2/100" },
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    const response = await mediaResolver.fetch(
      new Request("https://media.bento.surf/resolve", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: "https://youtube.com/watch?v=dQw4w9WgXcQ",
          videoQuality: "max",
        }),
      }),
      {
        ...envFor(fetcher),
        COBALT_YOUTUBE_SESSION_URL: sessionUrl,
        COBALT_PROXY_URL: proxyUrl,
      } as never,
    );

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      `${UPSTREAM_URL}/`,
      `${UPSTREAM_URL}/tunnel?id=direct-video`,
      `${sessionUrl}/`,
      `${sessionUrl}/tunnel?id=session-video`,
    ]);
    await expect(response.json()).resolves.toMatchObject({
      status: "tunnel",
      url: "https://media.bento.surf/youtube-session/tunnel?id=session-video",
    });
  });

  it("returns the first usable direct YouTube tunnel without spending fallback routes", async () => {
    const sessionUrl = `${UPSTREAM_URL}/youtube-session`;
    const fetcher = vi.fn().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `${UPSTREAM_URL}/`) {
        return Response.json({
          status: "tunnel",
          url: `${UPSTREAM_URL}/tunnel?id=direct-audio`,
          filename: "audio.mp3",
        });
      }
      if (url === `${UPSTREAM_URL}/tunnel?id=direct-audio`) {
        expect(new Headers(init?.headers).get("range")).toBe("bytes=0-1023");
        expect(init?.redirect).toBe("manual");
        return new Response(Uint8Array.from([1, 2, 3]), {
          status: 206,
          headers: {
            "content-type": "audio/mpeg",
            "content-range": "bytes 0-2/100",
          },
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    const response = await mediaResolver.fetch(
      new Request("https://media.bento.surf/resolve", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: "https://youtube.com/watch?v=dQw4w9WgXcQ",
          downloadMode: "audio",
        }),
      }),
      {
        ...envFor(fetcher),
        COBALT_YOUTUBE_SESSION_URL: sessionUrl,
      } as never,
    );

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      `${UPSTREAM_URL}/`,
      `${UPSTREAM_URL}/tunnel?id=direct-audio`,
    ]);
    await expect(response.json()).resolves.toMatchObject({
      status: "tunnel",
      url: "https://media.bento.surf/tunnel?id=direct-audio",
    });
  });

  it("probes every YouTube picker item and rejects redirecting tunnels", async () => {
    const fetcher = vi.fn().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `${UPSTREAM_URL}/`) {
        return Response.json({
          status: "picker",
          picker: [
            { type: "video", url: `${UPSTREAM_URL}/tunnel?id=first-video` },
            { type: "video", url: `${UPSTREAM_URL}/tunnel?id=second-video` },
          ],
        });
      }
      expect(init?.redirect).toBe("manual");
      if (url === `${UPSTREAM_URL}/tunnel?id=first-video`) {
        return new Response(Uint8Array.from([1]), {
          status: 206,
          headers: { "content-type": "video/mp4", "content-range": "bytes 0-0/100" },
        });
      }
      if (url === `${UPSTREAM_URL}/tunnel?id=second-video`) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://untrusted.invalid/media" },
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    const response = await mediaResolver.fetch(
      new Request("https://media.bento.surf/resolve", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: "https://youtube.com/watch?v=dQw4w9WgXcQ",
          videoQuality: "1080",
        }),
      }),
      envFor(fetcher) as never,
    );

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      `${UPSTREAM_URL}/`,
      `${UPSTREAM_URL}/tunnel?id=first-video`,
      `${UPSTREAM_URL}/tunnel?id=second-video`,
    ]);
    expect(response.status).toBe(503);
  });

  it("rejects the complete YouTube picker when any declared media URL is untrusted", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        status: "picker",
        picker: [
          { type: "video", url: `${UPSTREAM_URL}/tunnel?id=valid-video` },
          { type: "video", url: "https://untrusted.invalid/media" },
        ],
      }),
    );
    const response = await mediaResolver.fetch(
      new Request("https://media.bento.surf/resolve", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: "https://youtube.com/watch?v=dQw4w9WgXcQ",
          videoQuality: "1080",
        }),
      }),
      envFor(fetcher) as never,
    );

    expect(fetcher).toHaveBeenCalledOnce();
    expect(response.status).toBe(503);
  });

  it("tries direct, qualifying YouTube session, then Webshare when tunnel probes fail", async () => {
    const sessionUrl = `${UPSTREAM_URL}/youtube-session`;
    const proxyUrl = `${UPSTREAM_URL}/webshare`;
    const attemptedUrls: string[] = [];
    const probeUrls: string[] = [];
    const attemptedBodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn().mockImplementation(async (input, init) => {
      const target = String(input);
      if (init?.method === "GET") {
        probeUrls.push(target);
        expect(new Headers(init.headers).get("range")).toBe("bytes=0-1023");
        return target === `${proxyUrl}/tunnel?id=proxy-audio`
          ? new Response(Uint8Array.from([1, 2, 3]), {
              status: 206,
              headers: {
                "content-type": "audio/mpeg",
                "content-range": "bytes 0-2/100",
              },
            })
          : new Response("unavailable", { status: 502 });
      }
      expect(init?.redirect).toBe("manual");
      attemptedUrls.push(target);
      attemptedBodies.push(
        JSON.parse(new TextDecoder().decode(new Uint8Array(init?.body as ArrayBuffer))) as Record<
          string,
          unknown
        >,
      );
      const id =
        target === `${UPSTREAM_URL}/`
          ? "direct-audio"
          : target === `${sessionUrl}/`
            ? "session-audio"
            : "proxy-audio";
      return Response.json({
        status: "tunnel",
        url: `${UPSTREAM_URL}/tunnel?id=${id}`,
        filename: "audio.mp3",
      });
    });
    const response = await mediaResolver.fetch(
      new Request("https://media.bento.surf/resolve", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: "https://youtube.com/watch?v=dQw4w9WgXcQ",
          downloadMode: "audio",
          audioFormat: "mp3",
        }),
      }),
      {
        ...envFor(fetcher),
        COBALT_YOUTUBE_SESSION_URL: sessionUrl,
        COBALT_PROXY_URL: proxyUrl,
      } as never,
    );

    expect(attemptedUrls).toEqual([`${UPSTREAM_URL}/`, `${sessionUrl}/`, `${proxyUrl}/`]);
    expect(probeUrls).toEqual([
      `${UPSTREAM_URL}/tunnel?id=direct-audio`,
      `${sessionUrl}/tunnel?id=session-audio`,
      `${proxyUrl}/tunnel?id=proxy-audio`,
    ]);
    expect(attemptedBodies[0]).not.toHaveProperty("videoQuality");
    expect(attemptedBodies[1]).toMatchObject({
      downloadMode: "audio",
      videoQuality: "max",
    });
    expect(attemptedBodies[2]).not.toHaveProperty("videoQuality");
    await expect(response.json()).resolves.toMatchObject({
      status: "tunnel",
      url: "https://media.bento.surf/webshare/tunnel?id=proxy-audio",
    });
  });

  it("skips the YouTube session route for explicit 1080p video", async () => {
    const proxyUrl = `${UPSTREAM_URL}/webshare`;
    const fetcher = vi.fn().mockImplementation(async (input, init) => {
      const target = String(input);
      if (target === `${UPSTREAM_URL}/`) throw new TypeError("direct unavailable");
      if (target === `${proxyUrl}/tunnel?id=proxy-video`) {
        expect(new Headers(init?.headers).get("range")).toBe("bytes=0-1023");
        return new Response(Uint8Array.from([1, 2, 3]), {
          status: 206,
          headers: { "content-type": "video/mp4", "content-range": "bytes 0-2/100" },
        });
      }
      return Response.json({
        status: "tunnel",
        url: `${proxyUrl}/tunnel?id=proxy-video`,
        filename: "video.mp4",
      });
    });
    const response = await mediaResolver.fetch(
      new Request("https://media.bento.surf/resolve", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: "https://youtube.com/watch?v=dQw4w9WgXcQ",
          videoQuality: "1080",
          downloadMode: "auto",
        }),
      }),
      {
        ...envFor(fetcher),
        COBALT_YOUTUBE_SESSION_URL: `${UPSTREAM_URL}/youtube-session`,
        COBALT_PROXY_URL: proxyUrl,
      } as never,
    );

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      `${UPSTREAM_URL}/`,
      `${proxyUrl}/`,
      `${proxyUrl}/tunnel?id=proxy-video`,
    ]);
    expect(response.status).toBe(200);
  });

  it("does not spend fallback routes on non-retryable source errors", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json({ status: "error", error: { code: "error.api.content.private" } }),
      );
    const response = await mediaResolver.fetch(
      new Request("https://media.bento.surf/resolve", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://youtube.com/watch?v=dQw4w9WgXcQ" }),
      }),
      {
        ...envFor(fetcher),
        COBALT_YOUTUBE_SESSION_URL: `${UPSTREAM_URL}/youtube-session`,
        COBALT_PROXY_URL: `${UPSTREAM_URL}/webshare`,
      } as never,
    );

    expect(fetcher).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({
      status: "error",
      error: { code: "error.api.content.private" },
    });
  });

  it.each([
    {
      platform: "instagram",
      source: "https://www.instagram.com/reel/CxsaqgOPVJe/",
      thumbnail: "https://scontent.example.cdninstagram.com/cover.jpg",
    },
    {
      platform: "tiktok",
      source: "https://www.tiktok.com/@creator/video/1234567890123456789",
      thumbnail: "https://p19-common-sign.tiktokcdn-us.com/cover.image",
    },
  ] as const)("creates a signed $platform cover-image link from metadata", async (example) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ thumbnail_url: example.thumbnail, thumbnail_width: 640 }));
    const response = await mediaResolver.fetch(
      new Request("https://media.bento.surf/cover", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ platform: example.platform, url: example.source }),
      }),
      envFor(fetcher) as never,
    );
    const payload = (await response.json()) as {
      status: string;
      picker: Array<{ type: string; filename: string; url: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.status).toBe("picker");
    expect(payload.picker).toHaveLength(1);
    expect(payload.picker[0]).toMatchObject({ type: "photo" });
    const imageUrl = new URL(payload.picker[0].url);
    expect(imageUrl.origin).toBe("https://media.bento.surf");
    expect(imageUrl.pathname).toBe("/image");
    expect(imageUrl.searchParams.get("src")).toBe(example.thumbnail);
    expect(imageUrl.searchParams.get("signature")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("uses the authenticated Oracle/Webshare fallback when TikTok oEmbed is geo-blocked", async () => {
    const sourceUrl = "https://www.tiktok.com/@creator/video/1234567890123456789";
    const thumbnail = "https://p19-common-sign.tiktokcdn-us.com/fallback-cover.image";
    const metadataUrl = `${UPSTREAM_URL}/metadata/tiktok-cover`;
    const fetcher = vi.fn().mockImplementation(async (input, init) => {
      const target = String(input);
      if (target.startsWith("https://www.tiktok.com/oembed")) {
        return new Response("<html>TikTok is unavailable in this region</html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (target === metadataUrl) {
        expect(init?.method).toBe("POST");
        expect(init?.redirect).toBe("manual");
        expect(new Headers(init?.headers).get("authorization")).toBe(`Api-Key ${UPSTREAM_KEY}`);
        expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
        expect(JSON.parse(String(init?.body))).toEqual({ url: sourceUrl });
        return Response.json({ thumbnail_url: thumbnail });
      }
      throw new Error(`Unexpected fetch ${target}`);
    });
    const response = await mediaResolver.fetch(
      new Request("https://media.bento.surf/cover", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          platform: "tiktok",
          url: sourceUrl,
        }),
      }),
      { ...envFor(fetcher), TIKTOK_METADATA_URL: metadataUrl } as never,
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      status: string;
      picker: Array<{ filename: string; url: string }>;
    };
    expect(payload.status).toBe("picker");
    expect(payload.picker).toHaveLength(1);
    expect(payload.picker[0].filename).toBe("tiktok-1234567890123456789-cover.jpg");
    expect(new URL(payload.picker[0].url).searchParams.get("src")).toBe(thumbnail);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never sends the Oracle API key to a metadata origin outside the Cobalt origin", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response("<html>TikTok is unavailable in this region</html>", {
        headers: { "content-type": "text/html" },
      }),
    );
    const response = await mediaResolver.fetch(
      new Request("https://media.bento.surf/cover", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          platform: "tiktok",
          url: "https://www.tiktok.com/@creator/video/1234567890123456789",
        }),
      }),
      {
        ...envFor(fetcher),
        TIKTOK_METADATA_URL: "https://untrusted.invalid/metadata/tiktok-cover",
      } as never,
    );

    await expect(response.json()).resolves.toEqual({
      status: "error",
      error: { code: "error.api.cover.unavailable" },
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBeNull();
  });

  it("probes YouTube thumbnail sizes and streams a signed image as a download", async () => {
    const fetcher = vi.fn().mockImplementation(async (input, init) => {
      const source = String(input);
      if (init?.method === "HEAD") {
        return new Response(null, { headers: { "content-type": "image/jpeg" } });
      }
      if (source.startsWith("https://i.ytimg.com/")) {
        return new Response("jpeg", { headers: { "content-type": "image/jpeg" } });
      }
      throw new Error(`Unexpected fetch ${source}`);
    });
    const env = envFor(fetcher);
    const coverResponse = await mediaResolver.fetch(
      new Request("https://media.bento.surf/cover", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          platform: "youtube",
          url: "https://youtube.com/watch?v=dQw4w9WgXcQ",
        }),
      }),
      env as never,
    );
    const coverPayload = (await coverResponse.json()) as {
      picker: Array<{ url: string; filename: string }>;
    };
    expect(coverPayload.picker).toHaveLength(3);

    const downloadUrl = new URL(coverPayload.picker[0].url);
    downloadUrl.searchParams.set("bento_download", "1");
    const imageResponse = await mediaResolver.fetch(
      new Request(downloadUrl, { headers: { "cf-connecting-ip": "203.0.113.9" } }),
      env as never,
    );
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers.get("content-type")).toBe("image/jpeg");
    expect(imageResponse.headers.get("content-disposition")).toContain("attachment");
    expect(await imageResponse.text()).toBe("jpeg");
  });

  it("forwards byte ranges and streams tunnel responses without unsafe headers", async () => {
    const fetcher = vi.fn().mockImplementation(async (_input, init) => {
      expect(new Headers(init?.headers).get("range")).toBe("bytes=0-4");
      return new Response("media", {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "content-disposition": 'attachment; filename="clip.mp4"',
          "content-range": "bytes 0-4/5",
          "content-type": "video/mp4",
          "set-cookie": "provider=secret",
        },
      });
    });
    const response = await mediaResolver.fetch(
      new Request(
        "https://media.bento.surf/tunnel?id=video&bento_filename=creator%E2%80%AEcod.exe",
        {
          headers: { range: "bytes=0-4", "cf-connecting-ip": "203.0.113.8" },
        },
      ),
      envFor(fetcher) as never,
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe("bytes 0-4/5");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="creator-cod.mp4"',
    );
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-site");
    expect(await response.text()).toBe("media");
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain("bento_filename");
  });

  it("rejects oversized and active tunnel responses before streaming", async () => {
    const oversized = vi.fn().mockResolvedValue(
      new Response("media", {
        headers: { "content-length": String(512 * 1024 * 1024 + 1), "content-type": "video/mp4" },
      }),
    );
    const active = vi
      .fn()
      .mockResolvedValue(
        new Response("<script>alert(1)</script>", { headers: { "content-type": "text/html" } }),
      );

    const oversizedResponse = await mediaResolver.fetch(
      new Request("https://media.bento.surf/tunnel?id=large"),
      envFor(oversized) as never,
    );
    const activeResponse = await mediaResolver.fetch(
      new Request("https://media.bento.surf/tunnel?id=html"),
      envFor(active) as never,
    );

    expect(oversizedResponse.status).toBe(413);
    expect(activeResponse.status).toBe(502);
    expect(activeResponse.headers.get("content-type")).toContain("application/json");
  });

  it("cancels bounded JSON and tunnel streams as soon as they cross their ceiling", async () => {
    const oversizedJson = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4));
          controller.enqueue(new Uint8Array(4));
          controller.close();
        },
      }),
    );
    await expect(readBoundedBytes(oversizedJson, 7)).rejects.toThrow("oversized");

    const limited = streamWithByteLimit(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4));
          controller.enqueue(new Uint8Array(4));
          controller.close();
        },
      }),
      7,
      new AbortController().signal,
    );
    const reader = limited.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await expect(reader.read()).rejects.toThrow("media-too-large");
  });

  it("releases a global stream slot only after completion or cancellation", async () => {
    const gate = new StreamConcurrencyGate(1);
    const release = gate.acquire();
    expect(release).not.toBeNull();
    expect(gate.acquire()).toBeNull();

    const response = releaseWhenStreamEnds(new Response("media"), release!);
    expect(gate.acquire()).toBeNull();
    await response.text();

    const releaseAfterCompletion = gate.acquire();
    expect(releaseAfterCompletion).not.toBeNull();
    const cancelled = releaseWhenStreamEnds(new Response("media"), releaseAfterCompletion!);
    await cancelled.body?.cancel("test-cancel");
    const releaseAfterCancel = gate.acquire();
    expect(releaseAfterCancel).not.toBeNull();
    releaseAfterCancel?.();
  });

  it("reports a sanitized live-container health result", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        cobalt: {
          url: `${UPSTREAM_URL}/`,
          version: "11.7.1",
          services: ["instagram", "tiktok", "twitter", "youtube"],
        },
        git: { commit: "should-not-leak" },
      }),
    );
    const response = await mediaResolver.fetch(
      new Request("https://media.bento.surf/health", {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      envFor(fetcher) as never,
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      version: "11.7.1",
      services: ["instagram", "tiktok", "twitter", "youtube"],
      routes: [
        {
          name: "direct",
          ok: true,
          version: "11.7.1",
          services: ["instagram", "tiktok", "twitter", "youtube"],
        },
      ],
    });
  });

  it("includes the authenticated TikTok metadata sidecar in health", async () => {
    const fetcher = vi.fn().mockImplementation(async (input, init) => {
      const target = String(input);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Api-Key ${UPSTREAM_KEY}`);
      return target.endsWith("/metadata/health")
        ? Response.json({ ok: true, services: ["tiktok-cover"] })
        : Response.json({
            cobalt: { url: target, version: "11.7.1", services: ["tiktok"] },
          });
    });
    const response = await mediaResolver.fetch(
      new Request("https://media.bento.surf/health", {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      {
        ...envFor(fetcher),
        TIKTOK_METADATA_URL: `${UPSTREAM_URL}/metadata/tiktok-cover`,
      } as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      routes: [
        { name: "direct", ok: true, version: "11.7.1", services: ["tiktok"] },
        { name: "tiktok-metadata", ok: true, version: null, services: ["tiktok-cover"] },
      ],
    });
  });

  it("fails health closed before sending a key to an untrusted metadata origin", async () => {
    const fetcher = vi.fn();
    const response = await mediaResolver.fetch(
      new Request("https://media.bento.surf/health", {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      {
        ...envFor(fetcher),
        TIKTOK_METADATA_URL: "https://untrusted.invalid/metadata/tiktok-cover",
      } as never,
    );

    expect(response.status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails health unless every configured Oracle route responds", async () => {
    const fetcher = vi.fn().mockImplementation(async (input) => {
      const target = String(input);
      return target.includes("/webshare/")
        ? new Response("unavailable", { status: 503 })
        : Response.json({
            cobalt: { url: target, version: "11.7.1", services: ["youtube"] },
          });
    });
    const response = await mediaResolver.fetch(
      new Request("https://media.bento.surf/health", {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      {
        ...envFor(fetcher),
        COBALT_YOUTUBE_SESSION_URL: `${UPSTREAM_URL}/youtube-session`,
        COBALT_PROXY_URL: `${UPSTREAM_URL}/webshare`,
      } as never,
    );

    expect(response.status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects redirected, mismatched, and duplicate health routes", async () => {
    const redirecting = vi.fn().mockImplementation(async (input, init) => {
      expect(init?.redirect).toBe("manual");
      return String(input).includes("/youtube-session/")
        ? Response.redirect(`${UPSTREAM_URL}/`, 302)
        : Response.json({
            cobalt: { url: String(input), version: "11.7.1", services: ["youtube"] },
          });
    });
    const redirected = await mediaResolver.fetch(
      new Request("https://media.bento.surf/health", {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      {
        ...envFor(redirecting),
        COBALT_YOUTUBE_SESSION_URL: `${UPSTREAM_URL}/youtube-session`,
      } as never,
    );
    expect(redirected.status).toBe(503);

    const mismatchedFetcher = vi.fn().mockResolvedValue(
      Response.json({
        cobalt: { url: "https://different.invalid/", version: "11.7.1", services: ["youtube"] },
      }),
    );
    const mismatched = await mediaResolver.fetch(
      new Request("https://media.bento.surf/health", {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      envFor(mismatchedFetcher) as never,
    );
    expect(mismatched.status).toBe(503);

    const duplicateFetcher = vi.fn();
    const duplicate = await mediaResolver.fetch(
      new Request("https://media.bento.surf/health", {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      {
        ...envFor(duplicateFetcher),
        COBALT_PROXY_URL: UPSTREAM_URL,
      } as never,
    );
    expect(duplicate.status).toBe(503);
    expect(duplicateFetcher).not.toHaveBeenCalled();
  });
});
