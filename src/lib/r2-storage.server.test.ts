import { describe, expect, it, vi } from "vitest";

const planServerMocks = vi.hoisted(() => {
  const responses: Record<string, unknown> = {
    profiles: { plan_id: "free", is_pro: false },
    complimentary_plan_grants: null,
    subscriptions: null,
  };
  return {
    responses,
    from: vi.fn((table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: responses[table], error: null }),
        }),
      }),
    })),
  };
});

const storageAnalyticsMocks = vi.hoisted(() => ({
  captureServerEvent: vi.fn(
    async (_userId: string, _event: string, _properties: Record<string, unknown>, _env: unknown) =>
      undefined,
  ),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: planServerMocks.from },
}));

vi.mock("./posthog.server", () => storageAnalyticsMocks);

import { getStorageAllowanceMb } from "./plan.server";
import {
  handleR2StorageRequest,
  mediaObjectUrl,
  sanitizeFileExtension,
  validateMediaObjectKey,
} from "./r2-storage.server";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7");

function storedObject(key: string, size: number): R2Object {
  return {
    key,
    version: "1",
    size,
    etag: "etag",
    httpEtag: '"etag"',
    checksums: { toJSON: () => ({}) },
    uploaded: new Date("2026-07-16T00:00:00Z"),
    storageClass: "Standard",
    writeHttpMetadata() {},
  } as R2Object;
}

function mockBucket() {
  const put = vi.fn(
    async (key: string, value: ReadableStream<Uint8Array>, _options?: R2PutOptions) => {
      const bytes = await new Response(value).arrayBuffer();
      return storedObject(key, bytes.byteLength);
    },
  );
  const bucket: R2Bucket = {
    head: vi.fn(async () => null),
    get: vi.fn(async () => null),
    put,
    delete: vi.fn(async () => undefined),
    list: vi.fn(async (): Promise<R2Objects> => ({
      objects: [],
      truncated: false,
      delimitedPrefixes: [],
    })),
    createMultipartUpload: vi.fn(async () => {
      throw new Error("not implemented in test");
    }),
    resumeMultipartUpload: vi.fn(() => {
      throw new Error("not implemented in test");
    }),
  };
  return { bucket, put };
}

function mockMultipart(bucket: R2Bucket, completedSize: number) {
  const uploadPart = vi.fn(async (partNumber: number, value: ReadableStream<Uint8Array>) => {
    await new Response(value).arrayBuffer();
    return { partNumber, etag: `etag-${partNumber}` };
  });
  const complete = vi.fn(async () => storedObject("completed", completedSize));
  const resumeMultipartUpload = vi.fn((key: string, uploadId: string) => ({
    key,
    uploadId,
    uploadPart,
    complete,
    abort: vi.fn(async () => undefined),
  }));
  bucket.resumeMultipartUpload =
    resumeMultipartUpload as unknown as R2Bucket["resumeMultipartUpload"];
  return { uploadPart, complete, resumeMultipartUpload };
}

describe("R2 media storage paths", () => {
  it("accepts safe extensions and rejects path-like values", () => {
    expect(sanitizeFileExtension("WEBP")).toBe("webp");
    expect(sanitizeFileExtension("tar.gz")).toBeNull();
    expect(sanitizeFileExtension("../js")).toBeNull();
  });

  it("accepts generated object keys and blocks traversal or empty segments", () => {
    expect(validateMediaObjectKey("users/user-id/image/file-name.webp")).toBe(
      "users/user-id/image/file-name.webp",
    );
    expect(validateMediaObjectKey("users/user-id/../secret")).toBeNull();
    expect(validateMediaObjectKey("/users/user-id/image.png")).toBeNull();
    expect(validateMediaObjectKey("users//image.png")).toBeNull();
  });

  it("creates same-origin CDN URLs without carrying query strings", () => {
    expect(mediaObjectUrl("cache/instagram/bizibeast/POST_1.jpg", "https://bento.surf/")).toBe(
      "https://bento.surf/cdn/cache/instagram/bizibeast/POST_1.jpg",
    );
  });
});

describe("verified storage allowance", () => {
  it.each([
    ["Free", { plan_id: "free", is_pro: false }, null, null, 1024],
    [
      "Store",
      { plan_id: "store", is_pro: false },
      null,
      { plan_id: "store", status: "active", storage_addon_units: 0 },
      5 * 1024,
    ],
    [
      "Store with seven units",
      { plan_id: "store", is_pro: false },
      null,
      { plan_id: "store", status: "active", storage_addon_units: 7 },
      75 * 1024,
    ],
    [
      "Creator with 100 units",
      { plan_id: "creator", is_pro: false },
      null,
      { plan_id: "creator", status: "trialing", storage_addon_units: 100 },
      1005 * 1024,
    ],
    [
      "inactive subscription",
      { plan_id: "store", is_pro: false },
      null,
      { plan_id: "store", status: "canceled", storage_addon_units: 100 },
      5 * 1024,
    ],
    [
      "free subscription",
      { plan_id: "free", is_pro: false },
      null,
      { plan_id: "free", status: "active", storage_addon_units: 100 },
      1024,
    ],
    [
      "complimentary Creator without a paid subscription",
      { plan_id: "free", is_pro: false },
      {
        id: "grant-1",
        plan_id: "creator",
        status: "active",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
      null,
      5 * 1024,
    ],
  ])(
    "returns the expected allowance for %s",
    async (_name, profile, grant, subscription, expected) => {
      planServerMocks.responses.profiles = profile;
      planServerMocks.responses.complimentary_plan_grants = grant;
      planServerMocks.responses.subscriptions = subscription;

      await expect(getStorageAllowanceMb("user-123")).resolves.toBe(expected);
    },
  );
});

describe("self-service storage management", () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const publicKey = `users/${userId}/image/object.jpg`;
  const privateKey = `private/users/${userId}/store/download.pdf`;

  it("lists only the authenticated user's public and private objects with a stable cursor", async () => {
    const { bucket } = mockBucket();
    bucket.list = vi.fn(async (options = {}): Promise<R2Objects> => {
      if (!options.include) {
        return {
          objects:
            options.prefix === `users/${userId}/`
              ? [storedObject(publicKey, 12)]
              : [storedObject(privateKey, 20)],
          truncated: false,
          delimitedPrefixes: [],
        };
      }
      if (options.prefix === `users/${userId}/`) {
        return {
          objects: [
            Object.assign(storedObject(publicKey, 12), {
              customMetadata: { originalFilename: "Campaign image.jpg", kind: "image" },
              httpMetadata: { contentType: "image/jpeg" },
            }),
          ],
          truncated: false,
          delimitedPrefixes: [],
        };
      }
      return {
        objects: [
          Object.assign(storedObject(privateKey, 20), {
            customMetadata: { originalFilename: "Guide.pdf", kind: "product_file" },
            httpMetadata: { contentType: "application/pdf" },
          }),
        ],
        truncated: true,
        cursor: "private-next",
        delimitedPrefixes: [],
      };
    });
    const rateLimit = vi.fn(async () => ({ success: true }));

    const response = await handleR2StorageRequest(
      new Request("https://bento.surf/api/storage/manage", {
        headers: { authorization: "Bearer test" },
      }),
      { MEDIA_BUCKET: bucket, UPLOAD_RATE_LIMITER: { limit: rateLimit } },
      { waitUntil: vi.fn() },
      {
        authenticate: async () => userId,
        getStorageAllowanceMb: async () => 5,
      },
    );
    const payload = (await response?.json()) as {
      objects: Array<{ key: string; name: string; publicUrl: string | null }>;
      usedBytes: number;
      allowedBytes: number;
      cursor: string | null;
    };

    expect(response?.status).toBe(200);
    expect(payload).toMatchObject({
      usedBytes: 32,
      allowedBytes: 5 * 1024 * 1024,
      cursor: "private:private-next",
    });
    expect(payload.objects).toEqual([
      expect.objectContaining({ key: publicKey, name: "Campaign image.jpg" }),
      expect.objectContaining({ key: privateKey, name: "Guide.pdf", publicUrl: null }),
    ]);
    expect(payload.objects[0].publicUrl).toContain(`/cdn/${publicKey}`);
    expect(JSON.stringify(payload.objects[1])).not.toContain(`/cdn/${privateKey}`);
    expect(
      vi
        .mocked(bucket.list)
        .mock.calls.map(([options]) => options)
        .filter((options) => options?.include),
    ).toEqual([
      {
        prefix: `users/${userId}/`,
        limit: 100,
        cursor: undefined,
        include: ["httpMetadata", "customMetadata"],
      },
      {
        prefix: `private/users/${userId}/`,
        limit: 99,
        cursor: undefined,
        include: ["httpMetadata", "customMetadata"],
      },
    ]);
    expect(rateLimit).toHaveBeenCalledWith({ key: `${userId}:manage:get` });

    vi.mocked(bucket.list).mockClear();
    const next = await handleR2StorageRequest(
      new Request("https://bento.surf/api/storage/manage?cursor=private%3Aprivate-next", {
        headers: { authorization: "Bearer test" },
      }),
      { MEDIA_BUCKET: bucket, UPLOAD_RATE_LIMITER: { limit: rateLimit } },
      { waitUntil: vi.fn() },
      {
        authenticate: async () => userId,
        getStorageAllowanceMb: async () => 5,
      },
    );
    expect(next?.status).toBe(200);
    expect(
      vi
        .mocked(bucket.list)
        .mock.calls.map(([options]) => options)
        .find((options) => options?.include),
    ).toMatchObject({ prefix: `private/users/${userId}/`, cursor: "private-next" });
  });

  it("rejects invalid delete payloads before touching R2", async () => {
    const { bucket } = mockBucket();
    const request = (keys: unknown) =>
      handleR2StorageRequest(
        new Request("https://bento.surf/api/storage/manage", {
          method: "DELETE",
          headers: { authorization: "Bearer test", "content-type": "application/json" },
          body: JSON.stringify({ keys }),
        }),
        { MEDIA_BUCKET: bucket },
        { waitUntil: vi.fn() },
        { authenticate: async () => userId },
      );

    const invalid = [
      [],
      [publicKey, publicKey],
      [`users/${userId}/../secret.jpg`],
      ["users/22222222-2222-4222-8222-222222222222/image/object.jpg"],
      [`avatars/${userId}/avatar.jpg`],
      [`users/${userId}/avatar/avatar.jpg`],
      Array.from({ length: 101 }, (_, index) => `users/${userId}/image/${index}.jpg`),
    ];
    for (const keys of invalid) {
      const response = await request(keys);
      expect(response?.status).toBeGreaterThanOrEqual(400);
    }
    expect(bucket.head).not.toHaveBeenCalled();
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it("reports truthful partial deletion results and key-free analytics", async () => {
    const { bucket } = mockBucket();
    vi.mocked(bucket.head).mockImplementation(async (key) =>
      key === publicKey ? storedObject(publicKey, 12) : storedObject(privateKey, 20),
    );
    vi.mocked(bucket.delete).mockImplementation(async (key) => {
      if (key === privateKey) throw new Error("R2 unavailable");
    });
    const waitUntil = vi.fn();
    storageAnalyticsMocks.captureServerEvent.mockClear();

    const response = await handleR2StorageRequest(
      new Request("https://bento.surf/api/storage/manage", {
        method: "DELETE",
        headers: { authorization: "Bearer test", "content-type": "application/json" },
        body: JSON.stringify({ keys: [publicKey, privateKey] }),
      }),
      { MEDIA_BUCKET: bucket },
      { waitUntil },
      { authenticate: async () => userId },
    );
    const payload = await response?.json();

    expect(response?.status).toBe(207);
    expect(payload).toEqual({
      deletedKeys: [publicKey],
      failedKeys: [privateKey],
      freedBytes: 12,
    });
    expect(bucket.delete).toHaveBeenCalledTimes(2);
    expect(waitUntil).toHaveBeenCalledOnce();
    await waitUntil.mock.calls[0][0];
    const analyticsPayload = storageAnalyticsMocks.captureServerEvent.mock.calls[0][2];
    expect(analyticsPayload).toEqual({ deleted_count: 1, failed_count: 1, freed_bytes: 12 });
    expect(JSON.stringify(analyticsPayload)).not.toContain(userId);
    expect(JSON.stringify(analyticsPayload)).not.toContain("object.jpg");
  });

  it("stores a sanitized original filename in R2 metadata", async () => {
    const { bucket, put } = mockBucket();
    const response = await handleR2StorageRequest(
      new Request("https://bento.surf/api/storage/upload", {
        method: "PUT",
        headers: {
          "content-length": String(PNG_BYTES.length),
          "content-type": "image/png",
          "x-bento-file-extension": "png",
          "x-bento-file-name": encodeURIComponent(`../${"a".repeat(200)}.png`),
          "x-bento-file-size": String(PNG_BYTES.length),
          "x-bento-upload-kind": "image",
        },
        body: PNG_BYTES,
      }),
      { MEDIA_BUCKET: bucket },
      { waitUntil: vi.fn() },
      {
        authenticate: async () => userId,
        getPlan: async () => "free",
        getStorageAllowanceMb: async () => 1,
      },
    );

    expect(response?.status).toBe(201);
    const metadata = put.mock.calls[0][2]?.customMetadata;
    expect([...(metadata?.originalFilename ?? "")].length).toBeLessThanOrEqual(180);
    expect(metadata?.originalFilename).not.toMatch(/[\\/]/);

    const emojiBoundaryName = `${"a".repeat(179)}😀tail.png`;
    const emojiResponse = await handleR2StorageRequest(
      new Request("https://bento.surf/api/storage/upload", {
        method: "PUT",
        headers: {
          "content-length": String(PNG_BYTES.length),
          "content-type": "image/png",
          "x-bento-file-extension": "png",
          "x-bento-file-name": encodeURIComponent(emojiBoundaryName),
          "x-bento-file-size": String(PNG_BYTES.length),
          "x-bento-upload-kind": "image",
        },
        body: PNG_BYTES,
      }),
      { MEDIA_BUCKET: bucket },
      { waitUntil: vi.fn() },
      {
        authenticate: async () => userId,
        getPlan: async () => "free",
        getStorageAllowanceMb: async () => 1,
      },
    );

    expect(emojiResponse?.status).toBe(201);
    const emojiFilename = put.mock.calls[1][2]?.customMetadata?.originalFilename;
    expect(emojiFilename).toBe(`${"a".repeat(179)}😀`);
    expect([...(emojiFilename ?? "")]).toHaveLength(180);
  });
});

describe("R2 upload boundary", () => {
  it("fails closed when deployed upload rate limiting is missing", async () => {
    const { bucket } = mockBucket();
    const response = await handleR2StorageRequest(
      new Request("https://bento.surf/api/storage/upload", { method: "PUT" }),
      { APP_ENV: "production", MEDIA_BUCKET: bucket },
      { waitUntil: vi.fn() },
    );

    expect(response?.status).toBe(503);
  });

  it("stores an authenticated image under the user's isolated prefix", async () => {
    const { bucket, put } = mockBucket();
    const response = await handleR2StorageRequest(
      new Request("https://bento.surf/api/storage/upload", {
        method: "PUT",
        headers: {
          "content-length": String(PNG_BYTES.length),
          "content-type": "image/png",
          "x-bento-file-extension": "png",
          "x-bento-file-size": String(PNG_BYTES.length),
          "x-bento-upload-kind": "image",
        },
        body: PNG_BYTES,
      }),
      { MEDIA_BUCKET: bucket },
      { waitUntil: vi.fn() },
      { authenticate: async () => "user-123", isPro: async () => false },
    );
    const payload = (await response?.json()) as { key: string; publicUrl: string };
    expect(response?.status).toBe(201);
    expect(payload.key).toMatch(/^users\/user-123\/image\/.+\.png$/);
    expect(payload.publicUrl).toBe(`https://bento.surf/cdn/${payload.key}`);
    expect(put).toHaveBeenCalledOnce();
  });

  it("uploads avatars without resolving storage allowance", async () => {
    const { bucket, put } = mockBucket();
    const getStorageAllowanceMb = vi.fn(async () => {
      throw new Error("allowance lookup must not run for avatars");
    });

    const response = await handleR2StorageRequest(
      new Request("https://bento.surf/api/storage/upload", {
        method: "PUT",
        headers: {
          "content-length": String(PNG_BYTES.length),
          "content-type": "image/png",
          "x-bento-file-extension": "png",
          "x-bento-file-size": String(PNG_BYTES.length),
          "x-bento-upload-kind": "avatar",
        },
        body: PNG_BYTES,
      }),
      { MEDIA_BUCKET: bucket },
      { waitUntil: vi.fn() },
      {
        authenticate: async () => "user-123",
        getPlan: async () => "free",
        getStorageAllowanceMb,
      },
    );

    expect(response?.status).toBe(201);
    expect(getStorageAllowanceMb).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledOnce();
  });

  it("rejects unauthenticated and oversized uploads before writing", async () => {
    const { bucket, put } = mockBucket();
    const request = (size: number) =>
      new Request("https://bento.surf/api/storage/upload", {
        method: "PUT",
        headers: {
          "content-length": String(size),
          "content-type": "image/png",
          "x-bento-file-extension": "png",
          "x-bento-file-size": String(size),
          "x-bento-upload-kind": "image",
        },
        body: new Uint8Array([1]),
      });
    const unauthorized = await handleR2StorageRequest(
      request(1),
      { MEDIA_BUCKET: bucket },
      { waitUntil: vi.fn() },
      { authenticate: async () => Promise.reject(new Error("Unauthorized")) },
    );
    const oversized = await handleR2StorageRequest(
      request(2 * 1024 * 1024),
      { MEDIA_BUCKET: bucket },
      { waitUntil: vi.fn() },
      { authenticate: async () => "user-123", isPro: async () => false },
    );
    expect(unauthorized?.status).toBe(401);
    expect(unauthorized?.headers.get("www-authenticate")).toBe("Bearer");
    expect(oversized?.status).toBe(413);
    expect(put).not.toHaveBeenCalled();
  });

  it.each([
    ["image/svg+xml", "svg"],
    ["text/html", "html"],
    ["application/javascript", "js"],
    ["application/octet-stream", "exe"],
    ["application/octet-stream", "lnk"],
    ["application/octet-stream", "url"],
    ["application/vnd.ms-word.document.macroEnabled.12", "docm"],
  ])("rejects active content %s", async (contentType, extension) => {
    const { bucket, put } = mockBucket();
    const response = await handleR2StorageRequest(
      new Request("https://bento.surf/api/storage/upload", {
        method: "PUT",
        headers: {
          "content-length": "3",
          "content-type": contentType,
          "x-bento-file-extension": extension,
          "x-bento-file-size": "3",
          "x-bento-upload-kind": "file",
        },
        body: new Uint8Array([1, 2, 3]),
      }),
      { MEDIA_BUCKET: bucket },
      { waitUntil: vi.fn() },
      { authenticate: async () => "user-123", isPro: async () => false },
    );
    expect(response?.status).toBe(415);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects a body that lies about Content-Length", async () => {
    const { bucket } = mockBucket();
    const response = await handleR2StorageRequest(
      new Request("https://bento.surf/api/storage/upload", {
        method: "PUT",
        headers: {
          "content-length": "3",
          "content-type": "image/png",
          "x-bento-file-extension": "png",
          "x-bento-file-size": "1",
          "x-bento-upload-kind": "image",
        },
        body: new Uint8Array([1, 2, 3]),
      }),
      { MEDIA_BUCKET: bucket },
      { waitUntil: vi.fn() },
      { authenticate: async () => "user-123", isPro: async () => false },
    );
    expect(response?.status).toBe(400);
  });

  it("keeps paid product files private and refuses public CDN access", async () => {
    const { bucket, put } = mockBucket();
    const upload = await handleR2StorageRequest(
      new Request("https://test.bento.surf/api/storage/upload", {
        method: "PUT",
        headers: {
          "content-length": String(PDF_BYTES.length),
          "content-type": "application/pdf",
          "x-bento-file-extension": "pdf",
          "x-bento-file-size": String(PDF_BYTES.length),
          "x-bento-upload-kind": "product_file",
        },
        body: PDF_BYTES,
      }),
      { MEDIA_BUCKET: bucket },
      { waitUntil: vi.fn() },
      { authenticate: async () => "user-123", getPlan: async () => "store" },
    );
    const payload = (await upload?.json()) as { key: string; publicUrl: string | null };
    expect(upload?.status).toBe(201);
    expect(payload.key).toMatch(/^private\/users\/user-123\/store\/.+\.pdf$/);
    expect(payload.publicUrl).toBeNull();
    expect(put).toHaveBeenCalledOnce();

    const read = await handleR2StorageRequest(
      new Request(`https://test.bento.surf/cdn/${payload.key}`),
      { MEDIA_BUCKET: bucket },
      { waitUntil: vi.fn() },
    );
    expect(read?.status).toBe(404);
  });

  it("accepts the browser file-size header when Content-Length is unavailable", async () => {
    const { bucket, put } = mockBucket();
    const response = await handleR2StorageRequest(
      new Request("https://bento.surf/api/storage/upload", {
        method: "PUT",
        headers: {
          "content-type": "application/pdf",
          "x-bento-file-extension": "pdf",
          "x-bento-file-size": String(PDF_BYTES.length),
          "x-bento-upload-kind": "product_file",
        },
        body: PDF_BYTES,
      }),
      { MEDIA_BUCKET: bucket },
      { waitUntil: vi.fn() },
      { authenticate: async () => "user-123", getPlan: async () => "store" },
    );

    expect(response?.status).toBe(201);
    expect(put).toHaveBeenCalledOnce();
  });

  it("uses the effective storage allowance for a single upload quota check", async () => {
    const { bucket, put } = mockBucket();
    const allowanceMb = 75 * 1024;
    bucket.list = vi.fn(async ({ prefix }): Promise<R2Objects> => ({
      objects:
        prefix === "users/user-123/"
          ? [
              storedObject(
                "users/user-123/video/existing.mp4",
                allowanceMb * 1024 * 1024 - PDF_BYTES.length,
              ),
            ]
          : [],
      truncated: false,
      delimitedPrefixes: [],
    }));

    const response = await handleR2StorageRequest(
      new Request("https://bento.surf/api/storage/upload", {
        method: "PUT",
        headers: {
          "content-length": String(PDF_BYTES.length),
          "content-type": "application/pdf",
          "x-bento-file-extension": "pdf",
          "x-bento-file-size": String(PDF_BYTES.length),
          "x-bento-upload-kind": "file",
        },
        body: PDF_BYTES,
      }),
      { MEDIA_BUCKET: bucket },
      { waitUntil: vi.fn() },
      {
        authenticate: async () => "user-123",
        getPlan: async () => "free",
        getStorageAllowanceMb: async () => allowanceMb,
      },
    );

    expect(response?.status).toBe(201);
    expect(put).toHaveBeenCalledOnce();
  });

  it("schedules key-free capacity analytics when a single upload is blocked", async () => {
    const { bucket, put } = mockBucket();
    const allowanceMb = 1024;
    const waitUntil = vi.fn();
    storageAnalyticsMocks.captureServerEvent.mockClear();
    bucket.list = vi.fn(async ({ prefix }): Promise<R2Objects> => ({
      objects:
        prefix === "users/user-123/"
          ? [storedObject("users/user-123/image/existing.png", allowanceMb * 1024 * 1024)]
          : [],
      truncated: false,
      delimitedPrefixes: [],
    }));

    const response = await handleR2StorageRequest(
      new Request("https://bento.surf/api/storage/upload", {
        method: "PUT",
        headers: {
          "content-length": String(PNG_BYTES.length),
          "content-type": "image/png",
          "x-bento-file-extension": "png",
          "x-bento-file-size": String(PNG_BYTES.length),
          "x-bento-upload-kind": "image",
        },
        body: PNG_BYTES,
      }),
      { MEDIA_BUCKET: bucket },
      { waitUntil },
      {
        authenticate: async () => "user-123",
        getPlan: async () => "free",
        getStorageAllowanceMb: async () => allowanceMb,
      },
    );

    expect(response?.status).toBe(413);
    expect(put).not.toHaveBeenCalled();
    expect(waitUntil).toHaveBeenCalledOnce();
    await waitUntil.mock.calls[0][0];
    expect(storageAnalyticsMocks.captureServerEvent).toHaveBeenCalledWith(
      "user-123",
      "storage_capacity_blocked",
      {
        plan: "free",
        used_bytes: allowanceMb * 1024 * 1024,
        storage_allowance_mb: allowanceMb,
        attempted_upload_bytes: PNG_BYTES.length,
      },
      { MEDIA_BUCKET: bucket },
    );
  });

  it("creates an authenticated multipart upload session for large videos", async () => {
    const { bucket } = mockBucket();
    const createMultipartUpload = vi.fn(async (key: string) => ({
      key,
      uploadId: "upload-1",
    }));
    bucket.createMultipartUpload =
      createMultipartUpload as unknown as R2Bucket["createMultipartUpload"];

    const declaredSize = 20 * 1024 * 1024;
    const allowanceMb = 1005 * 1024;
    bucket.list = vi.fn(async ({ prefix }): Promise<R2Objects> => ({
      objects: [
        ...(prefix === "users/user-123/"
          ? [
              storedObject(
                "users/user-123/video/existing.mp4",
                allowanceMb * 1024 * 1024 - declaredSize,
              ),
            ]
          : []),
      ],
      truncated: false,
      delimitedPrefixes: [],
    }));

    const response = await handleR2StorageRequest(
      new Request("https://bento.surf/api/storage/upload?action=mpu-create", {
        method: "POST",
        headers: {
          "content-type": "video/mp4",
          "x-bento-file-extension": "mp4",
          "x-bento-file-size": String(declaredSize),
          "x-bento-upload-kind": "video",
        },
      }),
      { MEDIA_BUCKET: bucket },
      { waitUntil: vi.fn() },
      {
        authenticate: async () => "user-123",
        getPlan: async () => "store",
        getStorageAllowanceMb: async () => allowanceMb,
      },
    );
    const payload = (await response?.json()) as {
      key: string;
      uploadId: string;
      publicUrl: string;
    };

    expect(response?.status).toBe(200);
    expect(payload.uploadId).toBe("upload-1");
    expect(payload.key).toMatch(new RegExp(`^users/user-123/video/.+-mpu-${declaredSize}\\.mp4$`));
    expect(payload.publicUrl).toContain("/cdn/");
    expect(createMultipartUpload).toHaveBeenCalledOnce();
  });

  it("schedules key-free capacity analytics when multipart creation is blocked", async () => {
    const { bucket } = mockBucket();
    const allowanceMb = 5 * 1024;
    const declaredSize = 20 * 1024 * 1024;
    const waitUntil = vi.fn();
    storageAnalyticsMocks.captureServerEvent.mockClear();
    bucket.list = vi.fn(async ({ prefix }): Promise<R2Objects> => ({
      objects:
        prefix === "users/user-123/"
          ? [storedObject("users/user-123/video/existing.mp4", allowanceMb * 1024 * 1024)]
          : [],
      truncated: false,
      delimitedPrefixes: [],
    }));

    const response = await handleR2StorageRequest(
      new Request("https://bento.surf/api/storage/upload?action=mpu-create", {
        method: "POST",
        headers: {
          "content-type": "video/mp4",
          "x-bento-file-extension": "mp4",
          "x-bento-file-size": String(declaredSize),
          "x-bento-upload-kind": "video",
        },
      }),
      { MEDIA_BUCKET: bucket },
      { waitUntil },
      {
        authenticate: async () => "user-123",
        getPlan: async () => "store",
        getStorageAllowanceMb: async () => allowanceMb,
      },
    );

    expect(response?.status).toBe(413);
    expect(waitUntil).toHaveBeenCalledOnce();
    await waitUntil.mock.calls[0][0];
    expect(storageAnalyticsMocks.captureServerEvent).toHaveBeenCalledWith(
      "user-123",
      "storage_capacity_blocked",
      {
        plan: "store",
        used_bytes: allowanceMb * 1024 * 1024,
        storage_allowance_mb: allowanceMb,
        attempted_upload_bytes: declaredSize,
      },
      { MEDIA_BUCKET: bucket },
    );
  });

  it("rejects a renamed executable and a MIME/signature mismatch", async () => {
    const { bucket, put } = mockBucket();
    const upload = (contentType: string, extension: string, bytes: Uint8Array<ArrayBuffer>) =>
      handleR2StorageRequest(
        new Request("https://bento.surf/api/storage/upload", {
          method: "PUT",
          headers: {
            "content-length": String(bytes.length),
            "content-type": contentType,
            "x-bento-file-extension": extension,
            "x-bento-file-size": String(bytes.length),
            "x-bento-upload-kind": "file",
          },
          body: bytes,
        }),
        { MEDIA_BUCKET: bucket },
        { waitUntil: vi.fn() },
        { authenticate: async () => "user-123", getPlan: async () => "store" },
      );

    const executable = await upload(
      "application/octet-stream",
      "txt",
      new Uint8Array([0x4d, 0x5a, 0x90, 0x00]),
    );
    const mismatched = await upload("image/png", "png", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));

    expect(executable?.status).toBe(415);
    expect(mismatched?.status).toBe(415);
    expect(put).not.toHaveBeenCalled();
  });

  it("accepts valid JPEG and PDF signatures", async () => {
    const { bucket, put } = mockBucket();
    const upload = async (contentType: string, extension: string, bytes: Uint8Array<ArrayBuffer>) =>
      handleR2StorageRequest(
        new Request("https://bento.surf/api/storage/upload", {
          method: "PUT",
          headers: {
            "content-length": String(bytes.length),
            "content-type": contentType,
            "x-bento-file-extension": extension,
            "x-bento-file-size": String(bytes.length),
            "x-bento-upload-kind": "file",
          },
          body: bytes,
        }),
        { MEDIA_BUCKET: bucket },
        { waitUntil: vi.fn() },
        { authenticate: async () => "user-123", getPlan: async () => "store" },
      );

    const jpeg = await upload("image/jpeg", "jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
    const pdf = await upload("application/pdf", "pdf", PDF_BYTES);

    expect(jpeg?.status).toBe(201);
    expect(pdf?.status).toBe(201);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("starts storing before a live upload stream closes", async () => {
    const { bucket } = mockBucket();
    let source: ReadableStreamDefaultController<Uint8Array>;
    const bytes = new Uint8Array(512);
    bytes.set([0xff, 0xd8, 0xff, 0xe0]);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        controller.enqueue(bytes);
      },
    });
    bucket.put = vi.fn(async (key: string, value: ReadableStream<Uint8Array>) => {
      source.close();
      await new Response(value).arrayBuffer();
      return storedObject(key, bytes.length);
    }) as R2Bucket["put"];

    const result = await Promise.race([
      handleR2StorageRequest(
        new Request("https://bento.surf/api/storage/upload", {
          method: "PUT",
          headers: {
            "content-length": String(bytes.length),
            "content-type": "image/jpeg",
            "x-bento-file-extension": "jpg",
            "x-bento-file-size": String(bytes.length),
            "x-bento-upload-kind": "image",
          },
          body,
          duplex: "half",
        } as RequestInit & { duplex: "half" }),
        { MEDIA_BUCKET: bucket },
        { waitUntil: vi.fn() },
        { authenticate: async () => "user-123", isPro: async () => false },
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
    ]);

    expect(result).not.toBe("timeout");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(201);
  });

  it("rejects a multipart part whose actual bytes exceed its trusted size", async () => {
    const { bucket } = mockBucket();
    const { uploadPart } = mockMultipart(bucket, 4);
    const key = "users/user-123/video/file-mpu-4.webm";
    const response = await handleR2StorageRequest(
      new Request(
        `https://bento.surf/api/storage/upload?action=mpu-uploadpart&key=${encodeURIComponent(key)}&uploadId=upload-1&partNumber=1`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "x-bento-file-size": "4",
          },
          body: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00]),
        },
      ),
      { MEDIA_BUCKET: bucket },
      { waitUntil: vi.fn() },
      { authenticate: async () => "user-123" },
    );

    expect(response?.status).toBe(400);
    expect(uploadPart).toHaveBeenCalledOnce();
  });

  it("rejects duplicate completion parts and deletes a mismatched completed object", async () => {
    const { bucket } = mockBucket();
    const multipart = mockMultipart(bucket, 5);
    const key = "users/user-123/video/file-mpu-4.webm";
    const complete = (parts: Array<{ etag: string; partNumber: number }>) =>
      handleR2StorageRequest(
        new Request(
          `https://bento.surf/api/storage/upload?action=mpu-complete&key=${encodeURIComponent(key)}&uploadId=upload-1`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ parts }),
          },
        ),
        { MEDIA_BUCKET: bucket },
        { waitUntil: vi.fn() },
        { authenticate: async () => "user-123" },
      );

    const duplicateKey = "users/user-123/video/file-mpu-8388609.webm";
    const duplicate = await handleR2StorageRequest(
      new Request(
        `https://bento.surf/api/storage/upload?action=mpu-complete&key=${encodeURIComponent(duplicateKey)}&uploadId=upload-1`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            parts: [
              { etag: "one", partNumber: 1 },
              { etag: "again", partNumber: 1 },
            ],
          }),
        },
      ),
      { MEDIA_BUCKET: bucket },
      { waitUntil: vi.fn() },
      { authenticate: async () => "user-123" },
    );
    const mismatched = await complete([{ etag: "one", partNumber: 1 }]);

    expect(duplicate?.status).toBe(400);
    expect(mismatched?.status).toBe(400);
    expect(multipart.complete).toHaveBeenCalledOnce();
    expect(bucket.delete).toHaveBeenCalledWith(key);
  });

  it("bounds multipart completion JSON", async () => {
    const { bucket } = mockBucket();
    const key = "users/user-123/video/file-mpu-4.webm";
    const response = await handleR2StorageRequest(
      new Request(
        `https://bento.surf/api/storage/upload?action=mpu-complete&key=${encodeURIComponent(key)}&uploadId=upload-1`,
        {
          method: "POST",
          headers: { "content-length": String(64 * 1024 + 1) },
          body: "{}",
        },
      ),
      { MEDIA_BUCKET: bucket },
      { waitUntil: vi.fn() },
      { authenticate: async () => "user-123" },
    );

    expect(response?.status).toBe(413);
  });
});
