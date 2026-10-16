import { afterEach, describe, expect, it, vi } from "vitest";

const { checkpoints } = vi.hoisted(() => ({ checkpoints: [] as Record<string, unknown>[] }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      update: (values: Record<string, unknown>) => {
        checkpoints.push(values);
        return { eq: async () => ({ error: null }) };
      },
    }),
  },
}));
import { publishYouTube } from "./social-publisher.server";

const media = {
  key: "video.mp4",
  url: "https://bento.surf/video.mp4",
  name: "video.mp4",
  mimeType: "video/mp4",
  size: 1,
};
const location = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test-session";
afterEach(() => {
  vi.unstubAllGlobals();
  checkpoints.length = 0;
});

describe("YouTube bounded resumable video upload", () => {
  it("streams the reported 156 MB file without buffering it and uses actual stored size", async () => {
    const total = 156_581_249;
    let sourceBytes = 0,
      received = 0,
      inits = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === media.url) {
        const response = new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sourceBytes === total) {
                controller.close();
                return;
              }
              const count = Math.min(1024 ** 2, total - sourceBytes);
              controller.enqueue(new Uint8Array(count));
              sourceBytes += count;
            },
          }),
          { headers: { "content-type": "video/mp4", "content-length": String(total) } },
        );
        response.arrayBuffer = vi.fn(() => {
          throw new Error("Must not buffer the video");
        });
        return response;
      }
      if (url.includes("uploadType=resumable")) {
        inits += 1;
        expect((init?.headers as Record<string, string>)["X-Upload-Content-Length"]).toBe(
          String(total),
        );
        return new Response(null, { headers: { location } });
      }
      expect(url).toBe(location);
      const chunk = init!.body as Uint8Array;
      expect(chunk.byteLength).toBeLessThanOrEqual(2 * 1024 ** 2);
      expect((init?.headers as Record<string, string>)["Content-Range"]).toBe(
        `bytes ${received}-${received + chunk.byteLength - 1}/${total}`,
      );
      received += chunk.byteLength;
      return received === total
        ? Response.json({ id: "video-1" })
        : new Response(null, { status: 308, headers: { range: `bytes=0-${received - 1}` } });
    });
    await expect(
      publishYouTube("token", "Title", "Body", [media], {}, { id: "target" }),
    ).resolves.toMatchObject({ id: "video-1" });
    expect(inits).toBe(1);
    expect(received).toBe(total);
    expect(checkpoints.at(-1)).toMatchObject({
      remote_post_id: "video-1",
      upload_byte_offset: total,
      upload_session_url: null,
    });
  }, 20_000);

  it("resumes from Google's acknowledged bytes when the local checkpoint is stale", async () => {
    const uploaded: number[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === media.url)
        return new Response(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8]), {
          headers: { "content-type": "video/mp4", "content-length": "9" },
        });
      expect(url).toBe(location);
      if ((init?.headers as Record<string, string>)["Content-Range"] === "bytes */9")
        return new Response(null, { status: 308, headers: { range: "bytes=0-2" } });
      expect((init?.headers as Record<string, string>)["Content-Range"]).toBe("bytes 3-8/9");
      uploaded.push(...(init!.body as Uint8Array));
      return Response.json({ id: "video-2" });
    });
    await expect(
      publishYouTube(
        "token",
        "Title",
        "Body",
        [media],
        {},
        { id: "target", upload_session_url: location, upload_byte_offset: 8 },
      ),
    ).resolves.toMatchObject({ id: "video-2" });
    expect(uploaded).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it("recovers the completed video after a final-response timeout without publishing it again", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === media.url)
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "video/mp4", "content-length": "3" },
        });
      expect(url).toBe(location);
      expect(init?.body).toBeUndefined();
      return Response.json({ id: "already-created" });
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(
      publishYouTube(
        "token",
        "Title",
        "Body",
        [media],
        {},
        { id: "target", upload_session_url: location },
      ),
    ).resolves.toMatchObject({ id: "already-created" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("withholds the final segment for truncated or overlong source streams", async () => {
    for (const bytes of [new Uint8Array(5), new Uint8Array(7)]) {
      const fetcher = vi.fn(async (url: string) => {
        if (url === media.url)
          return new Response(bytes, {
            headers: { "content-type": "video/mp4", "content-length": "6" },
          });
        if (url.includes("uploadType=resumable"))
          return new Response(null, { headers: { location } });
        throw new Error("Must not send a final segment");
      });
      vi.stubGlobal("fetch", fetcher);
      await expect(
        publishYouTube("token", "Title", "Body", [media], {}, { id: "target" }),
      ).rejects.toMatchObject({ code: "media_unavailable", retryable: true });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it("rejects an invalid saved upload URL before sending provider credentials", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(new Uint8Array(6), {
          headers: { "content-type": "video/mp4", "content-length": "6" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      publishYouTube(
        "token",
        "Title",
        "Body",
        [media],
        {},
        { id: "target", upload_session_url: "https://untrusted.example/upload" },
      ),
    ).rejects.toMatchObject({ code: "upload_session_invalid", retryable: false });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
