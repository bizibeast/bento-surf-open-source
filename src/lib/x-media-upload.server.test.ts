import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadXMediaChunked } from "./social-publisher.server";
import { X_MEDIA_CHUNK_BYTES } from "./social-provider-media";

afterEach(() => vi.unstubAllGlobals());

describe("X v2 media upload", () => {
  it("uploads the reported 156 MB failure unchanged in bounded chunks and retries only the failed chunk", async () => {
    const totalBytes = 156_581_249;
    let sent = 0;
    let appended = 0;
    let inits = 0;
    let finalizes = 0;
    const parts: number[] = [];
    let failed = false;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === "https://bento.surf/video.mp4")
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent === totalBytes) {
                controller.close();
                return;
              }
              const count = Math.min(1024 * 1024, totalBytes - sent);
              controller.enqueue(new Uint8Array(count));
              sent += count;
            },
          }),
          { headers: { "content-type": "video/mp4", "content-length": String(totalBytes) } },
        );
      if (url.endsWith("/initialize")) {
        inits += 1;
        expect(JSON.parse(String(init?.body))).toEqual({
          media_type: "video/mp4",
          total_bytes: totalBytes,
          media_category: "tweet_video",
        });
        return Response.json({ data: { id: "12345" } });
      }
      if (url.endsWith("/12345/append")) {
        const form = init!.body as FormData;
        expect(form.has("command")).toBe(false);
        const index = Number(form.get("segment_index"));
        if (index === 1 && !failed) {
          failed = true;
          return Response.json({ detail: "Temporary outage" }, { status: 503 });
        }
        expect(index).toBe(parts.length);
        const file = form.get("media") as File;
        expect(file.size).toBeLessThanOrEqual(X_MEDIA_CHUNK_BYTES);
        parts.push(file.size);
        appended += file.size;
        return Response.json({});
      }
      expect(url).toBe("https://api.x.com/2/media/upload/12345/finalize");
      expect(appended).toBe(totalBytes);
      finalizes += 1;
      return Response.json({ data: { id: "12345" } });
    });
    await expect(
      uploadXMediaChunked(
        "test-token",
        {
          key: "video.mp4",
          url: "https://bento.surf/video.mp4",
          mimeType: "video/mp4",
          name: "video.mp4",
          size: 1,
        },
        "tweet_video",
      ),
    ).resolves.toBe("12345");
    expect(inits).toBe(1);
    expect(finalizes).toBe(1);
    expect(parts.length).toBe(Math.ceil(totalBytes / X_MEDIA_CHUNK_BYTES));
    expect(failed).toBe(true);
  }, 20_000);

  it("never finalizes or creates a post after a truncated source", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (url === "https://bento.surf/video.mp4")
        return new Response(new Uint8Array(3), {
          headers: { "content-type": "video/mp4", "content-length": "6" },
        });
      if (url.endsWith("/initialize")) return Response.json({ data: { id: "12345" } });
      throw new Error("Should not finalize incomplete media");
    });
    await expect(
      uploadXMediaChunked(
        "test-token",
        {
          key: "video.mp4",
          url: "https://bento.surf/video.mp4",
          mimeType: "video/mp4",
          name: "video.mp4",
          size: 6,
        },
        "tweet_video",
      ),
    ).rejects.toMatchObject({ code: "media_unavailable", retryable: true });
    expect(calls).toHaveLength(2);
  });
});
