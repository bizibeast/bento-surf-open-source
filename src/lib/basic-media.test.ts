import { describe, it, expect, vi } from "vitest";
import { isBasicMediaSource, resolveBasicMedia, tunnelBasicMedia } from "./basic-media";

const token = "private-test-credential-for-service-only";
const signal = new AbortController().signal;
function setup() {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      id: "a".repeat(32),
      filename: "youtube-jNQXAC9IVRw.mp4",
      contentType: "video/mp4",
    }),
  );
  return {
    fetch,
    env: {
      BASIC_MEDIA_RESOLVER: { fetch },
      BASIC_MEDIA_TOKEN: token,
      RESOLVER_SHARED_SECRET: "test-link-signature-credential-private",
    },
  };
}
async function link(env: ReturnType<typeof setup>["env"]) {
  return (await resolveBasicMedia(
    { url: "https://youtu.be/jNQXAC9IVRw" },
    env,
    "https://media.test.bento.surf",
    signal,
  )) as { url: string };
}
describe("private basic media bridge", () => {
  it("does not route working social integrations or arbitrary URLs to compute", async () => {
    const { fetch, env } = setup();
    for (const url of [
      "https://www.instagram.com/reel/DfznZqxxssC/",
      "https://x.com/a/status/123",
      "https://127.0.0.1",
      "https://www.tiktok.com.evil/@a/video/7039716639834656002",
    ]) {
      expect(isBasicMediaSource(url)).toBe(false);
      expect(await resolveBasicMedia({ url }, env, "https://bento.surf", signal)).toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("fails closed without private credentials and signs links without leaking secrets", async () => {
    const { fetch, env } = setup();
    expect(
      await resolveBasicMedia(
        { url: "https://youtu.be/jNQXAC9IVRw" },
        {},
        "https://bento.surf",
        signal,
      ),
    ).toBeNull();
    const result = await link(env);
    expect(result.url).toContain("/basic-media?");
    expect(result.url).not.toContain(token);
    expect(fetch.mock.calls[0][0].headers.get("authorization")).toBe(`Bearer ${token}`);
  });
  it("rejects modified IDs, filenames, duplicate parameters and expired signatures without compute", async () => {
    const { fetch, env } = setup();
    const result = await link(env);
    fetch.mockClear();
    const denied = vi.fn().mockResolvedValue(null);
    for (const change of [
      (u: URL) => u.searchParams.set("id", "b".repeat(32)),
      (u: URL) => u.searchParams.set("bento_filename", "youtube-jNQXAC9IVRw.mp3"),
      (u: URL) => u.searchParams.append("id", "a".repeat(32)),
      (u: URL) => u.searchParams.set("expires", "1700000000"),
    ]) {
      const u = new URL(result.url);
      change(u);
      expect((await tunnelBasicMedia(new Request(u), env, denied)).status).toBe(404);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(denied).not.toHaveBeenCalled();
  });
  it("HEAD never starts another stream and rate limits precede paid execution", async () => {
    const { fetch, env } = setup();
    const { url } = await link(env);
    fetch.mockClear();
    expect(
      (await tunnelBasicMedia(new Request(url, { method: "HEAD" }), env, async () => null)).status,
    ).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect(
      (
        await tunnelBasicMedia(
          new Request(url),
          env,
          async () => new Response(null, { status: 429 }),
        )
      ).status,
    ).toBe(429);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("streams only the signed format and cancels invalid responses", async () => {
    const { fetch, env } = setup();
    const { url } = await link(env);
    fetch.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } }),
    );
    const response = await tunnelBasicMedia(new Request(url), env, async () => null);
    expect(response.headers.get("content-disposition")).toContain("youtube-jNQXAC9IVRw.mp4");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    fetch.mockResolvedValueOnce(
      new Response("not media", { headers: { "content-type": "text/html" } }),
    );
    expect((await tunnelBasicMedia(new Request(url), env, async () => null)).status).toBe(502);
  });
  it("surfaces hard budget denial without creating a download link", async () => {
    const { fetch, env } = setup();
    fetch.mockResolvedValueOnce(
      Response.json({ code: "error.api.basic_media.limit" }, { status: 429 }),
    );
    expect(
      await resolveBasicMedia(
        { url: "https://youtu.be/jNQXAC9IVRw" },
        env,
        "https://bento.surf",
        signal,
      ),
    ).toEqual({ status: "error", error: { code: "error.api.basic_media.limit" } });
  });
});

import { streamWithByteLimit } from "./media-resolver.worker-core";
import { MEDIA_DOWNLOAD_MAX_BYTES, MEDIA_TOOLS_API_PATH } from "./media-tools";
it.each([3, 5])(
  "accepts a %i GiB stream with bounded chunks rather than buffering the file",
  async (gib) => {
    const bytes = gib * 1024 ** 3;
    const chunk = new Uint8Array(8 * 1024 * 1024);
    let generated = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (generated === bytes) {
          controller.close();
          return;
        }
        generated += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const reader = streamWithByteLimit(
      body,
      MEDIA_DOWNLOAD_MAX_BYTES,
      new AbortController().signal,
    ).getReader();
    let read = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      read += next.value.byteLength;
    }
    expect(read).toBe(bytes);
  },
);

import mediaResolver from "./media-resolver.worker-core";
import { handleFreeToolMediaRequest } from "./media-tools.server";
it("connects the public tool response to an authenticated gateway and signed private stream", async () => {
  const { fetch, env } = setup();
  const gatewayEnv = {
    ...env,
    TUNNEL_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
  };
  const response = await handleFreeToolMediaRequest(
    new Request(`https://test.bento.surf${MEDIA_TOOLS_API_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://test.bento.surf" },
      body: JSON.stringify({
        toolSlug: "youtube-video-downloader",
        url: "https://youtu.be/jNQXAC9IVRw",
      }),
    }),
    {
      APP_ENV: "development",
      COBALT_API_URL: "https://media.test.bento.surf",
      COBALT_API_KEY: env.RESOLVER_SHARED_SECRET,
    },
    { fetcher: async (input, init) => mediaResolver.fetch(new Request(input, init), gatewayEnv) },
  );
  expect(response?.status).toBe(200);
  const data = (await response!.json()) as { items: { url: string; filename: string }[] };
  expect(data.items[0].url).toContain("/basic-media?");
  expect(data.items[0].filename).toBe("youtube-jNQXAC9IVRw.mp4");
  fetch.mockResolvedValueOnce(
    new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } }),
  );
  const streamed = await mediaResolver.fetch(new Request(data.items[0].url), gatewayEnv);
  expect(streamed.status).toBe(200);
  expect((await streamed.arrayBuffer()).byteLength).toBe(3);
});

it("preserves a working legacy origin after a retryable private-host refusal", async () => {
  const { fetch, env } = setup();
  fetch.mockResolvedValueOnce(Response.json({ code: "error.api.fetch.fail" }, { status: 422 }));
  const cobalt = vi.fn().mockResolvedValue(
    Response.json({
      status: "tunnel",
      url: "https://origin-media.invalid/tunnel/valid",
      filename: "tiktok.mp4",
    }),
  );
  vi.stubGlobal("fetch", cobalt);
  try {
    const response = await mediaResolver.fetch(
      new Request("https://media.test.bento.surf/resolve", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.RESOLVER_SHARED_SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: "https://www.tiktok.com/@cookierun_dev/video/7039716639834656002",
        }),
      }),
      {
        ...env,
        COBALT_UPSTREAM_URL: "https://origin-media.invalid",
        COBALT_UPSTREAM_API_KEY: "00000000-0000-4000-8000-000000000000",
      },
    );
    const data = (await response.json()) as { status: string; url: string };
    expect(data.status).toBe("tunnel");
    expect(data.url).toContain("https://media.test.bento.surf/tunnel/valid");
    expect(cobalt).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});
it("never bypasses a private-host budget denial through the legacy origin", async () => {
  const { fetch, env } = setup();
  fetch.mockResolvedValueOnce(
    Response.json({ code: "error.api.basic_media.limit" }, { status: 429 }),
  );
  const cobalt = vi.fn();
  vi.stubGlobal("fetch", cobalt);
  try {
    const response = await mediaResolver.fetch(
      new Request("https://media.test.bento.surf/resolve", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.RESOLVER_SHARED_SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: "https://www.tiktok.com/@cookierun_dev/video/7039716639834656002",
        }),
      }),
      { ...env, COBALT_UPSTREAM_URL: "https://origin-media.invalid" },
    );
    expect(await response.json()).toEqual({
      status: "error",
      error: { code: "error.api.basic_media.limit" },
    });
    expect(cobalt).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
it("reports a platform media refusal without delivering a broken video", async () => {
  const { fetch, env } = setup();
  const { url } = await link(env);
  fetch.mockResolvedValueOnce(
    Response.json({ code: "error.api.tiktok.blocked", phase: "download" }, { status: 502 }),
  );
  const response = await tunnelBasicMedia(new Request(url), env, async () => null);
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({
    error: "TikTok did not allow this download. Try another public post or use the original file.",
  });
});
