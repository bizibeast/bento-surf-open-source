import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ used: 0, allowance: 100, plan: "store", adjustments: vi.fn() }));
vi.mock("./plan.server", async () => ({
  ...(await vi.importActual<typeof import("./plan.server")>("./plan.server")),
  getPlan: vi.fn(async () => state.plan),
  getStorageAllowanceMb: vi.fn(async () => state.allowance),
}));
vi.mock("./r2-usage-cache.server", () => ({
  cachedR2UserStorageBytes: vi.fn(async () => state.used),
  adjustCachedR2UserStorageBytes: async (_userId: string, size: number) => {
    state.used += size;
    state.adjustments(size);
  },
}));
vi.mock("./posthog.server", () => ({ captureServerEvent: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: vi.fn() } }));

import {
  beginMcpMediaUpload,
  handleMcpMediaUpload,
  MCP_UPLOAD_PART_BYTES,
} from "./mcp-media-upload.server";
import { defaultBentoMcpOperations } from "./mcp.server";

const userId = "00000000-0000-4000-8000-000000000001";
const auth = { token: "secret-account-token", clientId: "test", scopes: [], extra: { userId } };
const origin = "https://app.bento.surf";
const context = { waitUntil: vi.fn() };
const MiB = 1024 * 1024;
function video(size: number) {
  const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
  bytes[size - 1] = 42;
  return bytes;
}

function bucketMock() {
  const objects = new Map<string, { key: string; size: number }>();
  const uploads = new Map<string, Map<number, Uint8Array>>();
  const bucket = {
    head: vi.fn(async (key: string) => objects.get(key) || null),
    delete: vi.fn(async (key: string) => objects.delete(key)),
    put: vi.fn(async (key: string, stream: ReadableStream<Uint8Array>) => {
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      const object = { key, size: bytes.length };
      objects.set(key, object);
      return object;
    }),
    createMultipartUpload: vi.fn(async (key: string) => {
      uploads.set(key, new Map());
      return { key, uploadId: `id-${key}` };
    }),
    resumeMultipartUpload: vi.fn((key: string, uploadId: string) => ({
      uploadPart: async (partNumber: number, stream: ReadableStream<Uint8Array>) => {
        if (uploadId !== `id-${key}` || !uploads.has(key)) throw new Error("Unknown upload");
        uploads.get(key)!.set(partNumber, new Uint8Array(await new Response(stream).arrayBuffer()));
        return { partNumber, etag: `part-${partNumber}` };
      },
      complete: async (parts: { partNumber: number; etag: string }[]) => {
        const stored = uploads.get(key);
        if (
          !stored ||
          parts.some((p) => !stored.has(p.partNumber) || p.etag !== `part-${p.partNumber}`)
        )
          throw new Error("Missing part");
        const object = {
          key,
          size: [...stored.values()].reduce((sum, value) => sum + value.length, 0),
        };
        objects.set(key, object);
        uploads.delete(key);
        return object;
      },
      abort: async () => {
        if (!uploads.delete(key)) throw new Error("Not unfinished");
      },
    })),
  };
  return { bucket: bucket as unknown as R2Bucket, objects, uploads };
}

let env: Env;
let mock: ReturnType<typeof bucketMock>;
beforeEach(() => {
  state.used = 0;
  state.allowance = 100;
  state.plan = "store";
  state.adjustments.mockClear();
  vi.stubEnv("WORKSPACE_COOKIE_SIGNING_KEY", "test-only-signing-key-at-least-32-characters");
  vi.stubEnv("VITE_APP_URL", origin);
  mock = bucketMock();
  env = {
    MEDIA_BUCKET: mock.bucket,
    APP_ENV: "staging",
    UPLOAD_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
  } as unknown as Env;
  vi.stubGlobal("__env__", env);
  vi.stubGlobal("Blob", NodeBlob);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const prepare = (size = 21 * MiB) =>
  beginMcpMediaUpload(userId, "https://mcp.bento.surf", {
    fileName: "Original video.mp4",
    kind: "video",
    mimeType: "video/mp4",
    size,
  });
type Prepared = Awaited<ReturnType<typeof prepare>>;
const send = (upload: Prepared, method: string, body?: BodyInit, suffix = "") =>
  handleMcpMediaUpload(
    new Request(upload.uploadUrl + suffix, { method, headers: upload.headers, body }),
    env,
    context,
  );

describe("MCP original media uploads", () => {
  it("uploads an original 21 MiB video in bounded binary parts and completes exactly once", async () => {
    const upload = await prepare();
    expect(upload.uploadUrl).toBe(`${origin}/api/mcp-media-upload`);
    expect(upload.partCount).toBe(3);
    expect(JSON.stringify(upload)).not.toContain(auth.token);
    const bytes = video(21 * MiB);
    const parts = [];
    for (let offset = 0; offset < bytes.length; offset += upload.partSize) {
      const partNumber = parts.length + 1;
      const response = await send(
        upload,
        "PUT",
        bytes.slice(offset, offset + upload.partSize),
        `?partNumber=${partNumber}`,
      );
      expect(response.status).toBe(200);
      parts.push(await response.json());
    }
    const stored = mock.uploads.get(upload.key)!;
    expect(
      Buffer.from(stored.get(1)!).equals(Buffer.from(bytes.subarray(0, MCP_UPLOAD_PART_BYTES))),
    ).toBe(true);
    expect(
      Buffer.from(stored.get(3)!).equals(Buffer.from(bytes.subarray(2 * MCP_UPLOAD_PART_BYTES))),
    ).toBe(true);
    const completion = await send(upload, "POST", JSON.stringify({ parts }));
    expect(completion.status).toBe(201);
    expect(await completion.json()).toMatchObject({
      media: {
        key: upload.key,
        size: bytes.length,
        name: "Original video.mp4",
        url: `${origin}/cdn/${upload.key}`,
        mimeType: "video/mp4",
      },
    });
    expect((await send(upload, "POST", JSON.stringify({ parts }))).status).toBe(201);
    expect(state.adjustments).toHaveBeenCalledExactlyOnceWith(bytes.length);
    expect((await send(upload, "DELETE")).ok).toBe(false);
    expect(mock.objects.has(upload.key)).toBe(true);
  });

  it("supports larger videos up to the plan limit and rejects full storage before allocation", async () => {
    state.allowance = 1024;
    expect((await prepare(250 * MiB)).partCount).toBe(32);
    await expect(prepare(251 * MiB)).rejects.toThrow("250 MB");
    state.used = 1000 * MiB;
    await expect(prepare(30 * MiB)).rejects.toThrow("storage");
    expect(mock.bucket.createMultipartUpload).toHaveBeenCalledTimes(1);
    state.used = 0;
    state.plan = "free";
    await expect(prepare()).rejects.toThrow("10 MB");
  });

  it("rechecks storage at completion if other uploads used the remaining space", async () => {
    const upload = await prepare(1024);
    const part = await (await send(upload, "PUT", video(1024), "?partNumber=1")).json();
    state.used = state.allowance * MiB;
    const response = await send(upload, "POST", JSON.stringify({ parts: [part] }));
    expect(response.status).toBe(413);
    expect(mock.objects.size).toBe(0);
    expect((await send(upload, "DELETE")).status).toBe(200);
    expect(mock.uploads.size).toBe(0);
  });

  it("rejects missing, tampered, expired and cross-origin credentials without touching storage", async () => {
    const upload = await prepare(1024);
    const calls = vi.mocked(mock.bucket.resumeMultipartUpload);
    const raw = upload.headers.Authorization;
    const [encoded, signature] = raw.slice(7).split(".");
    const tampered = JSON.parse(Buffer.from(encoded, "base64url").toString());
    tampered.userId = "00000000-0000-4000-8000-000000000002";
    for (const authorization of [
      "",
      `${raw}bad`,
      `Bearer ${Buffer.from(JSON.stringify(tampered)).toString("base64url")}.${signature}`,
    ]) {
      expect(
        (
          await handleMcpMediaUpload(
            new Request(upload.uploadUrl, {
              method: "DELETE",
              headers: { Authorization: authorization },
            }),
            env,
            context,
          )
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await handleMcpMediaUpload(
          new Request("https://other.example/api/mcp-media-upload", {
            method: "DELETE",
            headers: upload.headers,
          }),
          env,
          context,
        )
      ).status,
    ).toBe(401);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(upload.expiresAt));
    expect((await send(upload, "DELETE")).status).toBe(401);
    expect(calls).not.toHaveBeenCalled();
  });

  it("ignores caller-supplied object keys and rejects wrong sizes, signatures and incomplete parts", async () => {
    const upload = await prepare(1024);
    expect((await send(upload, "PUT", video(1025), "?partNumber=1")).status).toBe(400);
    expect((await send(upload, "PUT", new Uint8Array(1024), "?partNumber=1")).status).toBe(415);
    expect((await send(upload, "PUT", video(1024), "?partNumber=2")).status).toBe(400);
    expect((await send(upload, "POST", JSON.stringify({ parts: [] }))).status).toBe(400);
    const response = await send(
      upload,
      "PUT",
      video(1024),
      "?partNumber=1&key=users/other/video.mp4&uploadId=other",
    );
    expect(response.status).toBe(200);
    expect(mock.bucket.resumeMultipartUpload).toHaveBeenLastCalledWith(
      upload.key,
      `id-${upload.key}`,
    );
  });

  it("accepts the original 21 MiB inline upload without the string-iterator allocation", async () => {
    const bytes = video(21 * MiB);
    const media = await defaultBentoMcpOperations.uploadMedia(auth, "https://mcp.bento.surf", {
      fileName: "original.mp4",
      kind: "video",
      mimeType: "video/mp4",
      base64: Buffer.from(bytes).toString("base64"),
    });
    expect(media.size).toBe(bytes.length);
    expect(media.url).toMatch(/^https:\/\/app.bento.surf\/cdn\//);
    expect(mock.bucket.put).toHaveBeenCalledOnce();
  });

  it("streams a public video larger than the inline limit and validates its actual length", async () => {
    const bytes = video(30 * MiB);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(bytes, { headers: { "content-length": String(bytes.length) } }),
      ),
    );
    const input = {
      sourceUrl: "https://example.com/video.mp4",
      fileName: "video.mp4",
      kind: "video" as const,
      mimeType: "video/mp4",
    };
    expect((await defaultBentoMcpOperations.uploadMedia(auth, origin, input)).size).toBe(
      bytes.length,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(video(1024), { headers: { "content-length": "1023" } })),
    );
    await expect(defaultBentoMcpOperations.uploadMedia(auth, origin, input)).rejects.toThrow(
      "file size",
    );
  });
});
