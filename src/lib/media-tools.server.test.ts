import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectMediaToolPlatform,
  handleFreeToolMediaRequest,
  MAX_MEDIA_DOWNLOAD_ITEMS,
  normalizeMediaSourceUrl,
  parseMediaToolRequest,
} from "./media-tools.server";
import { MAX_TRANSCRIPTION_BYTES, type TranscriptionResult } from "./transcription-tool";
import { MEDIA_TOOLS_API_PATH } from "./media-tools";
import { TURNSTILE_ACTION, TURNSTILE_TOKEN_HEADER } from "./turnstile";

afterEach(() => vi.unstubAllGlobals());

const COBALT_ORIGIN = "https://cobalt.bento.surf";
const TUNNEL_URL = `${COBALT_ORIGIN}/tunnel/temporary-token`;
const transcriptResult: TranscriptionResult = {
  transcript: "Hello from Bento.",
  wordCount: 3,
  language: "en",
  durationSeconds: 2.5,
  segments: [{ start: 0, end: 2.5, text: "Hello from Bento." }],
};

function mp3Bytes(size = 64) {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("ID3"));
  return bytes;
}

function jsonRequest(
  body: unknown = {
    toolSlug: "youtube-video-downloader",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  },
  init: { method?: string; headers?: Record<string, string>; rawBody?: string } = {},
) {
  return new Request(`http://localhost:8080${MEDIA_TOOLS_API_PATH}`, {
    method: init.method ?? "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:8080",
      ...init.headers,
    },
    body: (init.method ?? "POST") === "GET" ? undefined : (init.rawBody ?? JSON.stringify(body)),
  });
}

function developmentEnv(overrides: Record<string, unknown> = {}) {
  return {
    APP_ENV: "development",
    COBALT_API_URL: COBALT_ORIGIN,
    COBALT_API_KEY: "test-cobalt-key",
    ...overrides,
  };
}

function tunnelFetcher(
  options: { audio?: Uint8Array; audioContentType?: string; cobaltResponse?: unknown } = {},
) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url === COBALT_ORIGIN || url === `${COBALT_ORIGIN}/`) {
      return Response.json(
        options.cobaltResponse ?? {
          status: "tunnel",
          url: TUNNEL_URL,
          filename: "youtube_dQw4w9WgXcQ.mp4",
        },
      );
    }
    if (url === TUNNEL_URL || url.startsWith(`${TUNNEL_URL}?`)) {
      const audio = options.audio ?? mp3Bytes();
      const responseBytes = new Uint8Array(audio.byteLength);
      responseBytes.set(audio);
      return new Response(responseBytes.buffer, {
        headers: { "content-type": options.audioContentType ?? "audio/mpeg" },
      });
    }
    throw new Error(`Unexpected test fetch: ${url}`);
  });
}

describe("media tool request parsing", () => {
  it("strictly accepts the documented request and derives operation server-side", () => {
    expect(
      parseMediaToolRequest(
        JSON.stringify({
          toolSlug: "youtube-video-downloader",
          url: "https://youtu.be/dQw4w9WgXcQ",
          quality: "720p",
        }),
      ),
    ).toEqual({
      toolSlug: "youtube-video-downloader",
      url: "https://youtu.be/dQw4w9WgXcQ",
      quality: "720p",
      operation: "download",
      platform: "youtube",
      mediaFilter: "video",
    });
  });

  it.each([
    ["social-media-downloader", "auto", "all"],
    ["instagram-photo-downloader", "instagram", "image"],
    ["instagram-carousel-downloader", "instagram", "all"],
    ["tiktok-photo-downloader", "tiktok", "image"],
    ["twitter-image-downloader", "twitter", "image"],
  ] as const)("derives the %s media filter server-side", (toolSlug, platform, mediaFilter) => {
    expect(
      parseMediaToolRequest(
        JSON.stringify({
          toolSlug,
          url: "https://www.instagram.com/p/CxsaqgOPVJe/",
        }),
      ),
    ).toMatchObject({ toolSlug, platform, operation: "download", mediaFilter });
  });

  it.each([
    "not-json",
    "null",
    "[]",
    JSON.stringify({ url: "https://youtu.be/dQw4w9WgXcQ" }),
    JSON.stringify({ toolSlug: "unknown", url: "https://youtu.be/dQw4w9WgXcQ" }),
    JSON.stringify({
      toolSlug: "youtube-video-downloader",
      url: "https://youtu.be/dQw4w9WgXcQ",
      platform: "youtube",
    }),
    JSON.stringify({
      toolSlug: "youtube-video-downloader",
      url: "https://youtu.be/dQw4w9WgXcQ",
      quality: "4k",
    }),
    JSON.stringify({
      toolSlug: "youtube-thumbnail-downloader",
      url: "https://youtu.be/dQw4w9WgXcQ",
      quality: "720p",
    }),
    JSON.stringify({
      toolSlug: "instagram-photo-downloader",
      url: "https://www.instagram.com/p/CxsaqgOPVJe/",
      quality: "720p",
    }),
  ])("rejects malformed, unknown, and over-posted payloads", (body) => {
    expect(parseMediaToolRequest(body)).toBeNull();
  });
});

describe("media source URL policy", () => {
  it.each([
    ["youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["youtube", "https://youtu.be/dQw4w9WgXcQ"],
    ["instagram", "https://www.instagram.com/reel/CxsaqgOPVJe/"],
    ["tiktok", "https://www.tiktok.com/@creator/video/1234567890123456789"],
    ["tiktok", "https://www.tiktok.com/@creator/photo/1234567890123456789"],
    ["twitter", "https://x.com/creator/status/1234567890123456789"],
    ["twitter", "https://twitter.com/creator/status/1234567890123456789"],
  ] as const)("accepts a full %s media URL", (platform, url) => {
    expect(normalizeMediaSourceUrl(platform, url)).toMatch(/^https:\/\//);
  });

  it.each(["vm.tiktok.com", "vt.tiktok.com"])(
    "accepts a narrowly shaped TikTok short URL on %s",
    (host) => {
      expect(normalizeMediaSourceUrl("tiktok", `https://${host}/ZMabcdef1/`)).toBe(
        `https://${host}/ZMabcdef1/`,
      );
    },
  );

  it.each([
    ["youtube", "https://youtu.be/dQw4w9WgXcQ"],
    ["instagram", "https://www.instagram.com/p/CxsaqgOPVJe/?img_index=2"],
    ["tiktok", "https://www.tiktok.com/@creator/photo/1234567890123456789"],
    ["twitter", "https://x.com/creator/status/1234567890123456789"],
  ] as const)("auto-detects a supported %s URL", (platform, url) => {
    expect(detectMediaToolPlatform(url)).toBe(platform);
    expect(normalizeMediaSourceUrl("auto", url)).toMatch(/^https:\/\//u);
  });

  it("does not auto-detect unsupported or lookalike hosts", () => {
    expect(detectMediaToolPlatform("https://facebook.com/watch?v=123")).toBeNull();
    expect(
      detectMediaToolPlatform("https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ"),
    ).toBeNull();
  });

  it.each([
    ["youtube", "http://youtube.com/watch?v=dQw4w9WgXcQ"],
    ["youtube", "https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ"],
    ["youtube", "https://youtube.com:444/watch?v=dQw4w9WgXcQ"],
    ["youtube", "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ"],
    ["youtube", "https://youtube.com/@creator"],
    ["instagram", "https://instagram.com/creator"],
    ["tiktok", "https://tiktok.com/@creator"],
    ["tiktok", "https://vm.tiktok.com/"],
    ["tiktok", "https://vm.tiktok.com/a/b"],
    ["twitter", "https://x.com/creator"],
  ] as const)("rejects non-media or unsafe %s URL %s", (platform, url) => {
    expect(normalizeMediaSourceUrl(platform, url)).toBeNull();
  });
});

describe("free URL media endpoint", () => {
  it("rejects wrong methods, origins, content types, and bodies over 4 KB", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const requests = [
      jsonRequest(undefined, { method: "GET" }),
      jsonRequest(undefined, { headers: { origin: "https://attacker.example" } }),
      jsonRequest(undefined, { headers: { "content-type": "text/plain" } }),
      jsonRequest(undefined, { headers: { "content-length": "4097" } }),
      jsonRequest(undefined, { rawBody: "{" }),
    ];

    const responses = await Promise.all(
      requests.map((request) => handleFreeToolMediaRequest(request, developmentEnv(), { fetcher })),
    );

    expect(responses.map((response) => response?.status)).toEqual([405, 403, 415, 413, 400]);
    expect(responses[0]?.headers.get("allow")).toBe("POST");
    for (const response of responses) {
      expect(response?.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns null outside its exact route", async () => {
    await expect(
      handleFreeToolMediaRequest(
        new Request("http://localhost:8080/api/tools/not-media", { method: "POST" }),
        developmentEnv(),
      ),
    ).resolves.toBeNull();
  });

  it("uses the dedicated downloader limiter exactly once with the client IP", async () => {
    const mediaLimit = vi.fn().mockResolvedValue({ success: true });
    const transcriptionLimit = vi.fn().mockResolvedValue({ success: false });
    const fetcher = tunnelFetcher();
    const response = await handleFreeToolMediaRequest(
      jsonRequest(undefined, { headers: { "cf-connecting-ip": "203.0.113.10" } }),
      developmentEnv({
        APP_ENV: "development",
        FREE_TOOLS_MEDIA_RATE_LIMITER: { limit: mediaLimit },
        FREE_TOOLS_TRANSCRIPTION_RATE_LIMITER: { limit: transcriptionLimit },
      }),
      { fetcher },
    );

    expect(response?.status).toBe(200);
    expect(mediaLimit).toHaveBeenCalledOnce();
    expect(mediaLimit).toHaveBeenCalledWith({ key: "free-tool-media:203.0.113.10" });
    expect(transcriptionLimit).not.toHaveBeenCalled();
  });

  it("uses the existing transcript limiter exactly once and never the media limiter", async () => {
    const mediaLimit = vi.fn().mockResolvedValue({ success: false });
    const transcriptionLimit = vi.fn().mockResolvedValue({ success: true });
    const transcribeAudio = vi.fn().mockResolvedValue(transcriptResult);
    const fetcher = tunnelFetcher({
      cobaltResponse: {
        status: "tunnel",
        url: TUNNEL_URL,
        filename: "youtube_audio.mp3",
      },
    });
    const response = await handleFreeToolMediaRequest(
      jsonRequest(
        {
          toolSlug: "youtube-to-transcript",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        },
        { headers: { "cf-connecting-ip": "203.0.113.11" } },
      ),
      developmentEnv({
        APP_ENV: "development",
        FREE_TOOLS_MEDIA_RATE_LIMITER: { limit: mediaLimit },
        FREE_TOOLS_TRANSCRIPTION_RATE_LIMITER: { limit: transcriptionLimit },
        AI: {},
      }),
      { fetcher, transcribeAudio },
    );

    expect(response?.status).toBe(200);
    expect(transcriptionLimit).toHaveBeenCalledOnce();
    expect(transcriptionLimit).toHaveBeenCalledWith({
      key: "free-tool-transcription:203.0.113.11",
    });
    expect(mediaLimit).not.toHaveBeenCalled();
  });

  it("requires Turnstile after the production limiter and before provider work", async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    const fetcher = vi.fn<typeof fetch>();
    const response = await handleFreeToolMediaRequest(
      jsonRequest(),
      developmentEnv({
        APP_ENV: "production",
        FREE_TOOLS_MEDIA_RATE_LIMITER: { limit },
        TURNSTILE_VERIFIER_URL: "https://turnstile.example",
      }),
      { fetcher },
    );

    expect(response?.status).toBe(403);
    expect(limit).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("continues to provider work after valid production Turnstile verification", async () => {
    const verifier = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ success: true, action: TURNSTILE_ACTION, hostname: "localhost" }),
      );
    vi.stubGlobal("fetch", verifier);
    const provider = tunnelFetcher();
    const response = await handleFreeToolMediaRequest(
      jsonRequest(undefined, {
        headers: {
          "cf-connecting-ip": "203.0.113.20",
          [TURNSTILE_TOKEN_HEADER]: "valid-turnstile-token",
        },
      }),
      developmentEnv({
        APP_ENV: "production",
        FREE_TOOLS_MEDIA_RATE_LIMITER: {
          limit: vi.fn().mockResolvedValue({ success: true }),
        },
        TURNSTILE_VERIFIER_URL: "https://turnstile.example",
      }),
      { fetcher: provider },
    );

    expect(response?.status).toBe(200);
    expect(verifier).toHaveBeenCalledOnce();
    expect(provider).toHaveBeenCalled();
  });

  it.each([
    [undefined, 503],
    [vi.fn().mockResolvedValue({ success: false }), 429],
    [vi.fn().mockRejectedValue(new Error("transcript limiter detail")), 503],
  ])("fails closed when the URL transcript limiter is unavailable", async (limit, status) => {
    const transcribeAudio = vi.fn();
    const response = await handleFreeToolMediaRequest(
      jsonRequest({
        toolSlug: "youtube-to-transcript",
        url: "https://youtu.be/dQw4w9WgXcQ",
      }),
      developmentEnv({
        APP_ENV: "production",
        AI: {},
        FREE_TOOLS_TRANSCRIPTION_RATE_LIMITER: limit ? { limit } : undefined,
      }),
      { fetcher: tunnelFetcher(), transcribeAudio },
    );

    expect(response?.status).toBe(status);
    if (status === 429) expect(response?.headers.get("retry-after")).toBe("60");
    expect(await response?.text()).not.toContain("limiter detail");
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it.each([
    ["production", undefined, 503],
    ["staging", undefined, 503],
    ["production", vi.fn().mockResolvedValue({ success: false }), 429],
    ["production", vi.fn().mockRejectedValue(new Error("limiter secret detail")), 503],
  ])(
    "fails closed when the %s downloader limiter is missing, exhausted, or broken",
    async (appEnv, limit, expectedStatus) => {
      const response = await handleFreeToolMediaRequest(
        jsonRequest(),
        developmentEnv({
          APP_ENV: appEnv,
          FREE_TOOLS_MEDIA_RATE_LIMITER: limit ? { limit } : undefined,
        }),
        { fetcher: tunnelFetcher() },
      );

      expect(response?.status).toBe(expectedStatus);
      if (expectedStatus === 429) expect(response?.headers.get("retry-after")).toBe("60");
      expect(await response?.text()).not.toContain("secret detail");
    },
  );

  it("fails safely when the self-hosted Cobalt configuration is absent or official", async () => {
    const missing = await handleFreeToolMediaRequest(jsonRequest(), {
      APP_ENV: "development",
    });
    const official = await handleFreeToolMediaRequest(
      jsonRequest(),
      developmentEnv({ COBALT_API_URL: "https://api.cobalt.tools" }),
    );

    expect(missing?.status).toBe(503);
    expect(official?.status).toBe(503);
  });

  it("authenticates to Cobalt and forces proxy-only server processing", async () => {
    const fetcher = tunnelFetcher();
    const response = await handleFreeToolMediaRequest(
      jsonRequest({
        toolSlug: "youtube-video-downloader",
        url: "https://youtu.be/dQw4w9WgXcQ",
        quality: "720p",
      }),
      developmentEnv(),
      { fetcher },
    );

    expect(response?.status).toBe(200);
    const [providerUrl, init] = fetcher.mock.calls[0];
    expect(String(providerUrl)).toBe(`${COBALT_ORIGIN}/`);
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: "Api-Key test-cobalt-key",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      url: "https://youtu.be/dQw4w9WgXcQ",
      videoQuality: "720",
      downloadMode: "auto",
      alwaysProxy: true,
      localProcessing: "disabled",
    });
    expect(await response?.json()).toEqual({
      kind: "download",
      expiresInSeconds: 90,
      items: [
        {
          url: `${TUNNEL_URL}?bento_filename=youtube_dQw4w9WgXcQ.mp4`,
          filename: "youtube_dQw4w9WgXcQ.mp4",
          mediaType: "video",
        },
      ],
    });
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
  });

  it("auto-detects the platform and keeps mixed carousel media in provider order", async () => {
    const fetcher = tunnelFetcher({
      cobaltResponse: {
        status: "picker",
        picker: [
          { type: "photo", url: `${COBALT_ORIGIN}/tunnel/photo` },
          { type: "video", url: `${COBALT_ORIGIN}/tunnel/video` },
          { type: "gif", url: `${COBALT_ORIGIN}/tunnel/gif` },
        ],
      },
    });
    const response = await handleFreeToolMediaRequest(
      jsonRequest({
        toolSlug: "social-media-downloader",
        url: "https://www.instagram.com/p/CxsaqgOPVJe/?img_index=2",
        quality: "720p",
      }),
      developmentEnv(),
      { fetcher },
    );

    expect(response?.status).toBe(200);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      url: "https://www.instagram.com/p/CxsaqgOPVJe/?img_index=2",
      videoQuality: "720",
      downloadMode: "auto",
      alwaysProxy: true,
      localProcessing: "disabled",
    });
    await expect(response?.json()).resolves.toMatchObject({
      kind: "download",
      items: [
        { filename: "instagram-image-01.jpg", mediaType: "image" },
        { filename: "instagram-video-02.mp4", mediaType: "video" },
        { filename: "instagram-gif-03.gif", mediaType: "gif" },
      ],
    });
  });

  it("returns only photos for dedicated image tools and omits video quality", async () => {
    const fetcher = tunnelFetcher({
      cobaltResponse: {
        status: "picker",
        picker: [
          { type: "video", url: `${COBALT_ORIGIN}/tunnel/video` },
          { type: "photo", url: `${COBALT_ORIGIN}/tunnel/photo-one` },
          { type: "photo", url: `${COBALT_ORIGIN}/tunnel/photo-two` },
        ],
      },
    });
    const response = await handleFreeToolMediaRequest(
      jsonRequest({
        toolSlug: "tiktok-photo-downloader",
        url: "https://www.tiktok.com/@creator/photo/1234567890123456789",
      }),
      developmentEnv(),
      { fetcher },
    );

    expect(response?.status).toBe(200);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      url: "https://www.tiktok.com/@creator/photo/1234567890123456789",
      downloadMode: "auto",
      alwaysProxy: true,
      localProcessing: "disabled",
    });
    const payload = (await response?.json()) as { items: Array<{ mediaType: string }> };
    expect(payload.items).toHaveLength(2);
    expect(payload.items.every((item) => item.mediaType === "image")).toBe(true);
  });

  it("classifies a single tunneled image from its safe filename extension", async () => {
    const response = await handleFreeToolMediaRequest(
      jsonRequest({
        toolSlug: "twitter-image-downloader",
        url: "https://x.com/creator/status/1234567890123456789",
      }),
      developmentEnv(),
      {
        fetcher: tunnelFetcher({
          cobaltResponse: {
            status: "tunnel",
            url: TUNNEL_URL,
            filename: "twitter_1234567890123456789.jpeg",
          },
        }),
      },
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      items: [
        {
          filename: "twitter_1234567890123456789.jpeg",
          mediaType: "image",
          url: `${TUNNEL_URL}?bento_filename=twitter_1234567890123456789.jpeg`,
        },
      ],
    });
  });

  it("resolves cover tools through the signed cover endpoint without video quality", async () => {
    const coverUrl = `${COBALT_ORIGIN}/image?src=cover&bento_filename=youtube-dQw4w9WgXcQ-maxres.jpg`;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: "picker",
        picker: [
          {
            type: "photo",
            filename: "youtube-dQw4w9WgXcQ-maxres.jpg",
            url: coverUrl,
          },
        ],
      }),
    );
    const response = await handleFreeToolMediaRequest(
      jsonRequest({
        toolSlug: "youtube-thumbnail-downloader",
        url: "https://youtu.be/dQw4w9WgXcQ",
      }),
      developmentEnv(),
      { fetcher },
    );

    expect(response?.status).toBe(200);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`${COBALT_ORIGIN}/cover`);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      url: "https://youtu.be/dQw4w9WgXcQ",
      platform: "youtube",
    });
    await expect(response?.json()).resolves.toEqual({
      kind: "download",
      expiresInSeconds: 90,
      items: [
        {
          url: coverUrl,
          filename: "youtube-dQw4w9WgXcQ-maxres.jpg",
          mediaType: "image",
        },
      ],
    });
  });

  it.each([
    ["report\u202egnp.exe", "report-gnp.mp4", "video"],
    ["launch.webm", "launch.webm", "video"],
    ["reaction.gif", "reaction.gif", "gif"],
  ] as const)(
    "replaces unsafe provider filename %s and binds the safe name to the tunnel",
    async (providerFilename, expectedFilename, expectedType) => {
      const response = await handleFreeToolMediaRequest(jsonRequest(), developmentEnv(), {
        fetcher: tunnelFetcher({
          cobaltResponse: {
            status: "tunnel",
            url: `${TUNNEL_URL}?bento_filename=setup.exe&bento_filename=other.exe`,
            filename: providerFilename,
          },
        }),
      });
      const payload = (await response?.json()) as {
        items: Array<{ url: string; filename: string; mediaType: string }>;
      };
      const item = payload.items[0];
      const downloadUrl = new URL(item.url);

      expect(response?.status).toBe(200);
      expect(item.filename).toBe(expectedFilename);
      expect(item.mediaType).toBe(expectedType);
      expect(downloadUrl.origin).toBe(COBALT_ORIGIN);
      expect(downloadUrl.pathname).toBe("/tunnel/temporary-token");
      expect(downloadUrl.searchParams.getAll("bento_filename")).toEqual([expectedFilename]);
      expect(item.filename).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    },
  );

  it("requests 64 kbps proxied MP3 audio for URL transcription", async () => {
    const fetcher = tunnelFetcher({
      cobaltResponse: {
        status: "tunnel",
        url: TUNNEL_URL,
        filename: "tiktok_audio.mp3",
      },
    });
    const transcribeAudio = vi.fn().mockResolvedValue(transcriptResult);
    const response = await handleFreeToolMediaRequest(
      jsonRequest({
        toolSlug: "tiktok-to-transcript",
        url: "https://www.tiktok.com/@creator/video/1234567890123456789",
      }),
      developmentEnv({ AI: {} }),
      { fetcher, transcribeAudio },
    );

    expect(response?.status).toBe(200);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      url: "https://www.tiktok.com/@creator/video/1234567890123456789",
      downloadMode: "audio",
      audioFormat: "mp3",
      audioBitrate: "64",
      alwaysProxy: true,
      localProcessing: "disabled",
      tiktokFullAudio: false,
    });
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "GET", redirect: "manual" });
    expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get("bento_filename")).toBe(
      "tiktok_audio.mp3",
    );
    expect(transcribeAudio).toHaveBeenCalledOnce();
    expect(transcribeAudio.mock.calls[0][0]).toEqual(mp3Bytes());
    expect(transcribeAudio.mock.calls[0][1]).toBe("audio/mpeg");
    expect(await response?.json()).toEqual({
      kind: "transcript",
      filename: "tiktok_audio.mp3",
      ...transcriptResult,
    });
  });

  it("falls back to a low-resolution TikTok video when the audio tunnel fails", async () => {
    const video = new Uint8Array(64);
    video.set(new TextEncoder().encode("ftyp"), 4);
    const videoTunnel = `${COBALT_ORIGIN}/webshare/tunnel/video-token`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ status: "tunnel", url: TUNNEL_URL, filename: "tiktok_audio.mp3" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(
        Response.json({ status: "tunnel", url: videoTunnel, filename: "tiktok_video.mp4" }),
      )
      .mockResolvedValueOnce(new Response(video, { headers: { "content-type": "video/mp4" } }));
    const transcribeAudio = vi.fn().mockResolvedValue(transcriptResult);

    const response = await handleFreeToolMediaRequest(
      jsonRequest({
        toolSlug: "tiktok-to-transcript",
        url: "https://www.tiktok.com/@creator/video/1234567890123456789",
      }),
      developmentEnv({ AI: {} }),
      { fetcher, transcribeAudio },
    );

    expect(response?.status).toBe(200);
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toMatchObject({
      downloadMode: "auto",
      videoQuality: "360",
    });
    expect(transcribeAudio).toHaveBeenCalledWith(
      video,
      "audio/mp4",
      expect.objectContaining({ APP_ENV: "development" }),
      expect.any(AbortSignal),
    );
  });

  it("transcribes the supported audio container Cobalt actually returns", async () => {
    const m4a = new Uint8Array(64);
    m4a.set(new TextEncoder().encode("ftyp"), 4);
    const transcribeAudio = vi.fn().mockResolvedValue(transcriptResult);
    const fetcher = tunnelFetcher({
      audio: m4a,
      audioContentType: "audio/mp4",
      cobaltResponse: {
        status: "tunnel",
        url: TUNNEL_URL,
        filename: "youtube_audio.m4a",
      },
    });

    const response = await handleFreeToolMediaRequest(
      jsonRequest({
        toolSlug: "youtube-to-transcript",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
      developmentEnv({ AI: {} }),
      { fetcher, transcribeAudio },
    );

    expect(response?.status).toBe(200);
    expect(transcribeAudio).toHaveBeenCalledWith(
      m4a,
      "audio/mp4",
      expect.objectContaining({ APP_ENV: "development" }),
      expect.any(AbortSignal),
    );
  });

  it("caps, filters, and deduplicates picker tunnel items", async () => {
    const picker = [
      { type: "photo", url: `${COBALT_ORIGIN}/tunnel/photo` },
      { type: "video", url: `${COBALT_ORIGIN}/tunnel/repeated` },
      { type: "video", url: `${COBALT_ORIGIN}/tunnel/repeated` },
      ...Array.from({ length: MAX_MEDIA_DOWNLOAD_ITEMS + 3 }, (_, index) => ({
        type: index % 2 ? "gif" : "video",
        url: `${COBALT_ORIGIN}/tunnel/${index}`,
      })),
    ];
    const response = await handleFreeToolMediaRequest(jsonRequest(), developmentEnv(), {
      fetcher: tunnelFetcher({ cobaltResponse: { status: "picker", picker } }),
    });
    const payload = (await response?.json()) as { items: unknown[] };

    expect(response?.status).toBe(200);
    expect(payload.items).toHaveLength(MAX_MEDIA_DOWNLOAD_ITEMS);
    expect(payload.items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ mediaType: "photo" })]),
    );
    expect(
      payload.items.filter((item) => {
        const value = (item as { url?: string }).url;
        return value ? new URL(value).pathname === "/tunnel/repeated" : false;
      }),
    ).toHaveLength(1);
  });

  it("accepts the dedicated same-origin audio tunnel from a picker response", async () => {
    const transcribeAudio = vi.fn().mockResolvedValue(transcriptResult);
    const fetcher = tunnelFetcher({
      cobaltResponse: {
        status: "picker",
        picker: [{ type: "video", url: `${COBALT_ORIGIN}/tunnel/video` }],
        audio: TUNNEL_URL,
        audioFilename: "picker-audio.mp3",
      },
    });
    const response = await handleFreeToolMediaRequest(
      jsonRequest({
        toolSlug: "instagram-to-transcript",
        url: "https://instagram.com/reel/CxsaqgOPVJe/",
      }),
      developmentEnv({ AI: {} }),
      { fetcher, transcribeAudio },
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      kind: "transcript",
      filename: "picker-audio.mp3",
    });
  });

  it.each([
    [
      "cross-origin tunnel",
      { status: "tunnel", url: "https://evil.example/video", filename: "x.mp4" },
    ],
    [
      "credentialed tunnel",
      { status: "tunnel", url: "https://user@cobalt.bento.surf/video", filename: "x.mp4" },
    ],
    [
      "same-origin non-tunnel endpoint",
      { status: "tunnel", url: `${COBALT_ORIGIN}/admin`, filename: "x.mp4" },
    ],
    ["local processing", { status: "local-processing", type: "merge", service: "youtube" }],
    ["provider error", { status: "error", error: { code: "error.api.secret-detail" } }],
    ["malformed payload", { status: "tunnel", filename: "x.mp4" }],
  ])("rejects %s provider responses without leaking detail", async (_label, cobaltResponse) => {
    const response = await handleFreeToolMediaRequest(jsonRequest(), developmentEnv(), {
      fetcher: tunnelFetcher({ cobaltResponse }),
    });

    expect(response?.status).toBeGreaterThanOrEqual(400);
    expect(await response?.text()).not.toContain("secret-detail");
  });

  it("explains the configured 25-minute provider limit", async () => {
    const response = await handleFreeToolMediaRequest(jsonRequest(), developmentEnv(), {
      fetcher: tunnelFetcher({
        cobaltResponse: {
          status: "error",
          error: { code: "error.api.content.too_long" },
        },
      }),
    });

    expect(response?.status).toBe(422);
    await expect(response?.json()).resolves.toEqual({
      error: "This video is longer than Bento's 25-minute limit",
    });
  });

  it("bounds and validates provider JSON before parsing it", async () => {
    const oversized = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { headers: { "content-length": "65537" } }));
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response("not-json"));
    const nonSuccess = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("provider secret detail", { status: 500 }));

    for (const fetcher of [oversized, malformed, nonSuccess]) {
      const response = await handleFreeToolMediaRequest(jsonRequest(), developmentEnv(), {
        fetcher,
      });
      expect(response?.status).toBe(502);
      expect(await response?.text()).not.toContain("provider secret detail");
    }
  });

  it.each([
    new Response(null, { status: 429 }),
    Response.json({ status: "error", error: { code: "error.api.rate_limit" } }),
  ])("adds Retry-After to provider rate-limit responses", async (providerResponse) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(providerResponse.clone());
    const response = await handleFreeToolMediaRequest(jsonRequest(), developmentEnv(), { fetcher });

    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("60");
  });

  it("returns a retryable timeout without exposing the provider URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const response = await handleFreeToolMediaRequest(jsonRequest(), developmentEnv(), {
      fetcher,
      providerTimeoutMs: 5,
    });

    expect(response?.status).toBe(504);
    expect(await response?.text()).not.toContain(COBALT_ORIGIN);
  });

  it("bounds the transcript audio download independently from provider resolution", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ status: "tunnel", url: TUNNEL_URL, filename: "audio.mp3" }),
      )
      .mockImplementationOnce(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
    const transcribeAudio = vi.fn();

    const response = await handleFreeToolMediaRequest(
      jsonRequest({
        toolSlug: "youtube-to-transcript",
        url: "https://youtube.com/watch?v=dQw4w9WgXcQ",
      }),
      developmentEnv({ AI: {} }),
      { fetcher, transcribeAudio, transcriptDownloadTimeoutMs: 5 },
    );

    expect(response?.status).toBe(504);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("rejects oversized, redirected, and non-MP3 transcript audio", async () => {
    const cobalt = Response.json({
      status: "tunnel",
      url: TUNNEL_URL,
      filename: "audio.mp3",
    });
    const audioResponses = [
      new Response(null, { headers: { "content-length": String(MAX_TRANSCRIPTION_BYTES + 1) } }),
      new Response(null, { status: 302, headers: { location: "https://evil.example/audio" } }),
      new Response(new Uint8Array(64), { headers: { "content-type": "audio/mpeg" } }),
    ];

    for (const audioResponse of audioResponses) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(cobalt.clone())
        .mockResolvedValueOnce(audioResponse);
      const transcribeAudio = vi.fn();
      const response = await handleFreeToolMediaRequest(
        jsonRequest({
          toolSlug: "youtube-to-transcript",
          url: "https://youtube.com/watch?v=dQw4w9WgXcQ",
        }),
        developmentEnv({ AI: {} }),
        { fetcher, transcribeAudio },
      );

      expect(response?.status).toBe(
        audioResponse.status === 302 ? 502 : audioResponse.body ? 415 : 413,
      );
      expect(transcribeAudio).not.toHaveBeenCalled();
    }
  });

  it("uses the shared Workers AI transcription path and falls back to Groq", async () => {
    const ai = { run: vi.fn().mockRejectedValue(new Error("workers unavailable")) };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `${COBALT_ORIGIN}/`) {
        return Response.json({
          status: "tunnel",
          url: TUNNEL_URL,
          filename: "instagram_audio.mp3",
        });
      }
      if (url === TUNNEL_URL || url.startsWith(`${TUNNEL_URL}?`)) {
        return new Response(mp3Bytes());
      }
      if (url === "https://api.groq.com/openai/v1/audio/transcriptions") {
        expect(init?.headers).toEqual({ Authorization: "Bearer groq-secret" });
        return Response.json({
          text: transcriptResult.transcript,
          language: transcriptResult.language,
          duration: transcriptResult.durationSeconds,
          segments: transcriptResult.segments,
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const response = await handleFreeToolMediaRequest(
      jsonRequest({
        toolSlug: "instagram-to-transcript",
        url: "https://instagram.com/reel/CxsaqgOPVJe/",
      }),
      developmentEnv({ AI: ai as unknown as Ai, GROQ_API_KEY: "groq-secret" }),
      { fetcher },
    );

    expect(response?.status).toBe(200);
    expect(ai.run).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(await response?.json()).toMatchObject({
      kind: "transcript",
      transcript: "Hello from Bento.",
    });
  });

  it("uses Workers AI directly when it returns a valid URL transcript", async () => {
    const ai = {
      run: vi.fn().mockResolvedValue({
        text: transcriptResult.transcript,
        word_count: transcriptResult.wordCount,
        transcription_info: {
          language: transcriptResult.language,
          duration: transcriptResult.durationSeconds,
        },
        segments: transcriptResult.segments,
      }),
    };
    const fetcher = tunnelFetcher({
      cobaltResponse: {
        status: "tunnel",
        url: TUNNEL_URL,
        filename: "youtube_audio.mp3",
      },
    });
    const response = await handleFreeToolMediaRequest(
      jsonRequest({
        toolSlug: "youtube-to-transcript",
        url: "https://youtu.be/dQw4w9WgXcQ",
      }),
      developmentEnv({ AI: ai as unknown as Ai }),
      { fetcher },
    );

    expect(response?.status).toBe(200);
    expect(ai.run).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
