import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "test-upload-token" } },
        error: null,
      }),
    },
  },
}));
import { uploadFileResult } from "./upload";

afterEach(() => vi.unstubAllGlobals());
const video = () => new File([new Uint8Array(9 * 1024 ** 2)], "camera.mp4", { type: "video/mp4" });
const key = "users/user/video/camera-mpu-9437184.mp4";

describe("multipart media upload recovery", () => {
  it("accepts private Agent uploads without requiring a public URL", async () => {
    const privateKey = "private/users/user/agent/brief.txt";
    vi.stubGlobal("fetch", async () =>
      Response.json({ key: privateKey, publicUrl: null, size: 5 }),
    );
    const result = await uploadFileResult(
      new File(["brief"], "brief.txt", { type: "text/plain" }),
      "agent_file",
    );
    expect(result.key).toBe(privateKey);
    expect(result.publicUrl).toBeNull();
  });

  it("retries the interrupted segment while retaining the upload and reporting progress", async () => {
    const calls: string[] = [],
      parts: number[] = [],
      progress: number[] = [];
    let firstFailed = false;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const action = new URL(url, "https://bento.surf").searchParams.get("action")!;
      calls.push(action);
      if (action === "mpu-create")
        return Response.json({
          key,
          uploadId: "upload-1",
          publicUrl: "https://bento.surf/cdn/video.mp4",
        });
      if (action === "mpu-uploadpart") {
        const part = Number(new URL(url, "https://bento.surf").searchParams.get("partNumber"));
        parts.push(part);
        expect((init.body as Blob).size).toBe(part === 1 ? 8 * 1024 ** 2 : 1024 ** 2);
        if (part === 1 && !firstFailed) {
          firstFailed = true;
          return Response.json(
            { error: "Temporary outage" },
            { status: 503, headers: { "retry-after": "0" } },
          );
        }
        return Response.json({ partNumber: part, etag: `etag-${part}` });
      }
      expect(action).toBe("mpu-complete");
      return Response.json({
        key,
        publicUrl: "https://bento.surf/cdn/video.mp4",
        size: 9 * 1024 ** 2,
      });
    });
    await expect(
      uploadFileResult(video(), "video", {
        optimize: false,
        onProgress: (fraction) => progress.push(fraction),
      }),
    ).resolves.toMatchObject({ key });
    expect(parts).toEqual([1, 1, 2]);
    expect(calls.filter((action) => action === "mpu-create")).toHaveLength(1);
    expect(calls.filter((action) => action === "mpu-complete")).toHaveLength(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(1);
  });

  it("cancels an unfinished upload and never completes it after the user cancels", async () => {
    const controller = new AbortController();
    const actions: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const action = new URL(url, "https://bento.surf").searchParams.get("action")!;
      actions.push(action);
      if (action === "mpu-create")
        return Response.json({
          key,
          uploadId: "upload-1",
          publicUrl: "https://bento.surf/cdn/video.mp4",
        });
      if (action === "mpu-uploadpart") return Response.json({ partNumber: 1, etag: "etag-1" });
      expect(action).toBe("mpu-abort");
      return Response.json({ aborted: true });
    });
    await expect(
      uploadFileResult(video(), "video", {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(actions).toEqual(["mpu-create", "mpu-uploadpart", "mpu-abort"]);
  });

  it.each([413, 429])(
    "does not retry permanent errors or a long provider cooldown (%i)",
    async (status) => {
      const actions: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => {
        const action = new URL(url, "https://bento.surf").searchParams.get("action")!;
        actions.push(action);
        if (action === "mpu-create")
          return Response.json({
            key,
            uploadId: "upload-1",
            publicUrl: "https://bento.surf/cdn/video.mp4",
          });
        if (action === "mpu-uploadpart")
          return Response.json(
            { error: "Upload unavailable" },
            { status, headers: { "retry-after": "60" } },
          );
        expect(action).toBe("mpu-abort");
        return Response.json({ aborted: true });
      });
      await expect(uploadFileResult(video(), "video")).rejects.toThrow("Upload unavailable");
      expect(actions).toEqual(["mpu-create", "mpu-uploadpart", "mpu-abort"]);
    },
  );
});
