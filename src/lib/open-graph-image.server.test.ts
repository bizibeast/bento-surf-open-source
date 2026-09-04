import { describe, expect, it, vi } from "vitest";
import { handleOpenGraphImageRequest, parseOpenGraphImagePath } from "./open-graph-image.server";
import {
  publicPageOpenGraphImageUrl,
  publicPagePreviewVersion,
  type PublicPagePreviewData,
} from "./open-graph";

function previewData(): PublicPagePreviewData & { notFound: false } {
  return {
    profile: {
      id: "profile-1",
      username: "creator",
      display_name: "Creator",
      bio: "Creator bio",
      updated_at: "2026-07-20T10:00:00.000Z",
    },
    pages: [],
    blocks: [{ id: "block-1", updated_at: "2026-07-20T10:00:00.000Z" }],
    activePageId: null,
    notFound: false,
  };
}

function jpegBytes(size = 2_048) {
  const bytes = new Uint8Array(size).fill(7);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[size - 2] = 0xff;
  bytes[size - 1] = 0xd9;
  return bytes;
}

function screenshotResponse(bytes = jpegBytes()) {
  return new Response(bytes, { headers: { "content-type": "image/jpeg" } });
}

function storedObject(bytes: Uint8Array): R2ObjectBody {
  const buffer = Uint8Array.from(bytes).buffer;
  return {
    key: "preview.jpg",
    version: "version-1",
    size: bytes.byteLength,
    etag: "etag",
    httpEtag: '"etag"',
    uploaded: new Date("2026-07-20T10:00:00.000Z"),
    checksums: {} as R2Checksums,
    storageClass: "Standard",
    body: new Response(buffer).body!,
    bodyUsed: false,
    arrayBuffer: async () => buffer,
    bytes: async () => bytes,
    text: async () => new TextDecoder().decode(bytes),
    json: async <T>() => JSON.parse("{}") as T,
    blob: async () => new Blob([buffer]),
    writeHttpMetadata: () => undefined,
  };
}

function mockBucket() {
  const objects = new Map<string, Uint8Array>();
  const put = vi.fn(async (key: string, value: unknown) => {
    if (!(value instanceof Uint8Array)) throw new Error("Expected byte upload");
    objects.set(key, value);
    return storedObject(value);
  });
  const bucket = {
    get: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? storedObject(bytes) : null;
    }),
    head: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? storedObject(bytes) : null;
    }),
    put,
    delete: vi.fn(async () => undefined),
    list: vi.fn(async (): Promise<R2Objects> => ({
      objects: [],
      delimitedPrefixes: [],
      truncated: false,
    })),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  } as R2Bucket;
  return { bucket, objects, put };
}

describe("Open Graph image requests", () => {
  it("only accepts canonical creator and optional page paths", () => {
    expect(parseOpenGraphImagePath("/api/og/creator.jpg")).toEqual({
      username: "creator",
      pageSlug: null,
    });
    expect(parseOpenGraphImagePath("/api/og/creator/about-me.jpg")).toEqual({
      username: "creator",
      pageSlug: "about-me",
    });
    expect(parseOpenGraphImagePath("/api/og/../../secret.jpg")).toBeNull();
    expect(parseOpenGraphImagePath("/api/og/Creator.jpg")).toBeNull();
  });

  it("redirects forged or stale versions to the authoritative image URL", async () => {
    const data = previewData();
    const { bucket } = mockBucket();
    const browser = { quickAction: vi.fn() };
    const response = await handleOpenGraphImageRequest(
      new Request("https://bento.surf/api/og/creator.jpg?v=forged"),
      { MEDIA_BUCKET: bucket, BROWSER: browser },
      { loadProfile: vi.fn(async () => data) },
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe(
      publicPageOpenGraphImageUrl(data, "https://bento.surf"),
    );
    expect(response?.headers.get("cache-control")).toBe(
      "public, max-age=300, stale-while-revalidate=86400",
    );
    expect(browser.quickAction).not.toHaveBeenCalled();
  });

  it("generates one real screenshot and serves later requests from R2", async () => {
    const data = previewData();
    const version = publicPagePreviewVersion(data);
    const request = new Request(`https://bento.surf/api/og/creator.jpg?v=${version}`, {
      headers: { "cf-connecting-ip": "203.0.113.10" },
    });
    const bytes = jpegBytes();
    const browser = {
      quickAction: vi.fn(async () => screenshotResponse(bytes)),
    };
    const { bucket, put } = mockBucket();
    const loadProfile = vi.fn(async () => data);

    const generated = await handleOpenGraphImageRequest(
      request,
      { MEDIA_BUCKET: bucket, BROWSER: browser },
      { loadProfile },
    );
    expect(generated?.status).toBe(200);
    expect(generated?.headers.get("x-bento-og")).toBe("MISS");
    expect(browser.quickAction).toHaveBeenCalledWith(
      "screenshot",
      expect.objectContaining({
        url: expect.stringContaining(`__bento_preview=${version}`),
        viewport: { width: 1200, height: 630, deviceScaleFactor: 2 },
        screenshotOptions: expect.objectContaining({
          type: "jpeg",
          quality: 94,
          clip: { x: 0, y: 0, width: 1200, height: 630 },
        }),
      }),
    );
    expect(put).toHaveBeenCalledTimes(2);

    const cached = await handleOpenGraphImageRequest(
      request,
      { MEDIA_BUCKET: bucket, BROWSER: browser },
      { loadProfile },
    );
    expect(cached?.status).toBe(200);
    expect(cached?.headers.get("x-bento-og")).toBe("HIT");
    expect(browser.quickAction).toHaveBeenCalledTimes(1);
  });

  it("generates a missing preview for social crawlers that probe with HEAD", async () => {
    const data = previewData();
    const version = publicPagePreviewVersion(data);
    const browser = {
      quickAction: vi.fn(async () => screenshotResponse()),
    };
    const { bucket, put } = mockBucket();

    const response = await handleOpenGraphImageRequest(
      new Request(`https://bento.surf/api/og/creator.jpg?v=${version}`, { method: "HEAD" }),
      { MEDIA_BUCKET: bucket, BROWSER: browser },
      { loadProfile: vi.fn(async () => data) },
    );

    expect(response?.status).toBe(200);
    expect(response?.body).toBeNull();
    expect(response?.headers.get("content-length")).toBe("2048");
    expect(browser.quickAction).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("uses the same HD screenshot for Explore and social previews", async () => {
    const data = previewData();
    const version = publicPagePreviewVersion(data);
    const bytes = jpegBytes();
    const browser = {
      quickAction: vi.fn(async () => screenshotResponse(bytes)),
    };
    const { bucket } = mockBucket();

    const initial = await handleOpenGraphImageRequest(
      new Request("https://bento.surf/api/og/creator.jpg?mode=explore"),
      { MEDIA_BUCKET: bucket, BROWSER: browser },
      { loadProfile: vi.fn(async () => data) },
    );
    expect(initial?.status).toBe(302);
    expect(initial?.headers.get("location")).toBe(
      `https://bento.surf/api/og/creator.jpg?v=${version}`,
    );

    const generated = await handleOpenGraphImageRequest(
      new Request(`https://bento.surf/api/og/creator.jpg?v=${version}&mode=explore`),
      { MEDIA_BUCKET: bucket, BROWSER: browser },
      { loadProfile: vi.fn(async () => data) },
    );
    expect(generated?.status).toBe(200);
    expect(browser.quickAction).toHaveBeenCalledWith(
      "screenshot",
      expect.objectContaining({
        gotoOptions: { waitUntil: "load", timeout: 30_000 },
        viewport: { width: 1200, height: 630, deviceScaleFactor: 2 },
        cacheTTL: 0,
        waitForTimeout: 2_500,
        waitForSelector: expect.objectContaining({
          selector:
            '[data-bento-public-block-grid-ready="true"][data-bento-public-block-count="1"]',
        }),
        screenshotOptions: expect.objectContaining({
          type: "jpeg",
          quality: 94,
          fullPage: false,
          clip: { x: 0, y: 0, width: 1200, height: 630 },
        }),
      }),
    );

    const social = await handleOpenGraphImageRequest(
      new Request(`https://bento.surf/api/og/creator.jpg?v=${version}`),
      { MEDIA_BUCKET: bucket, BROWSER: browser },
      { loadProfile: vi.fn(async () => data) },
    );
    expect(social?.status).toBe(200);
    expect(social?.headers.get("x-bento-og")).toBe("HIT");
    expect(browser.quickAction).toHaveBeenCalledTimes(1);
  });

  it("retries one transient cold-render failure before serving an error", async () => {
    const data = previewData();
    const version = publicPagePreviewVersion(data);
    const browser = {
      quickAction: vi
        .fn()
        .mockResolvedValueOnce(new Response("cold start", { status: 502 }))
        .mockResolvedValueOnce(screenshotResponse()),
    };
    const { bucket } = mockBucket();

    const response = await handleOpenGraphImageRequest(
      new Request(`https://bento.surf/api/og/creator.jpg?v=${version}`),
      { MEDIA_BUCKET: bucket, BROWSER: browser },
      { loadProfile: vi.fn(async () => data) },
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-bento-og")).toBe("MISS");
    expect(browser.quickAction).toHaveBeenCalledTimes(2);
  });

  it("requires the exact hydrated block count before taking the screenshot", async () => {
    const data = {
      ...previewData(),
      blocks: [
        { id: "block-1", updated_at: "2026-07-20T10:00:00.000Z" },
        { id: "block-2", updated_at: "2026-07-20T10:01:00.000Z" },
      ],
    };
    const version = publicPagePreviewVersion(data);
    const browser = {
      quickAction: vi.fn(async () => screenshotResponse()),
    };
    const { bucket } = mockBucket();

    const response = await handleOpenGraphImageRequest(
      new Request(`https://bento.surf/api/og/creator.jpg?v=${version}`),
      { MEDIA_BUCKET: bucket, BROWSER: browser },
      { loadProfile: vi.fn(async () => data) },
    );

    expect(response?.status).toBe(200);
    expect(browser.quickAction).toHaveBeenCalledWith(
      "screenshot",
      expect.objectContaining({
        waitForSelector: expect.objectContaining({
          selector:
            '[data-bento-public-block-grid-ready="true"][data-bento-public-block-count="2"]',
        }),
      }),
    );
  });

  it("rejects malformed screenshots instead of poisoning the immutable preview cache", async () => {
    const data = previewData();
    const version = publicPagePreviewVersion(data);
    const browser = {
      quickAction: vi.fn(async () => screenshotResponse(new Uint8Array(2_048).fill(7))),
    };
    const { bucket, put } = mockBucket();

    const response = await handleOpenGraphImageRequest(
      new Request(`https://bento.surf/api/og/creator.jpg?v=${version}`),
      { MEDIA_BUCKET: bucket, BROWSER: browser },
      { loadProfile: vi.fn(async () => data) },
    );

    expect(response?.status).toBe(502);
    expect(put).not.toHaveBeenCalled();
  });
});
