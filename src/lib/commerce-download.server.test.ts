import { describe, expect, it, vi } from "vitest";
import { COMMERCE_DOWNLOAD_PATH, handleCommerceDownloadRequest } from "./commerce-download.server";

function envWithLimiter(success = true) {
  return {
    MEDIA_BUCKET: {} as R2Bucket,
    PUBLIC_API_RATE_LIMITER: {
      limit: vi.fn(async () => ({ success })),
    },
  } as Pick<Env, "MEDIA_BUCKET" | "PUBLIC_API_RATE_LIMITER">;
}

function successfulDownloadFixture() {
  const grant = {
    id: "grant-1",
    product_id: "product-1",
    creator_id: "creator-1",
    status: "active",
    expires_at: null,
    delivery_snapshot: {} as Record<string, unknown>,
  };
  const auditRows: Record<string, unknown>[] = [];
  const accessUpdates: Record<string, unknown>[] = [];
  const parentProduct = {
    kind: "digital_product",
    settings: {
      files: [
        {
          id: "asset",
          key: "private/users/creator-1/store/guide.pdf",
          name: 'Guide "final".pdf',
          size: 5,
          mimeType: "application/pdf",
        },
      ],
    },
  };
  const bundledProducts: Array<Record<string, unknown>> = [];
  const db = {
    from: vi.fn((table: string) => {
      if (table === "commerce_products") {
        const query = {
          select: vi.fn(() => query),
          eq: vi.fn(() => query),
          in: vi.fn(async () => ({ data: bundledProducts, error: null })),
          single: vi.fn(async () => ({ data: parentProduct, error: null })),
        };
        return query;
      }
      if (table === "commerce_access_grants") {
        return {
          update: vi.fn((value: Record<string, unknown>) => {
            accessUpdates.push(value);
            return { eq: vi.fn(async () => ({ error: null })) };
          }),
        };
      }
      if (table === "commerce_download_events") {
        return {
          insert: vi.fn(async (value: Record<string, unknown>) => {
            auditRows.push(value);
            return { error: null };
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    }),
  };
  const object = {
    size: 5,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("guide"));
        controller.close();
      },
    }),
    writeHttpMetadata(headers: Headers) {
      headers.set("content-type", "application/pdf");
    },
  };
  const mediaBucket = {
    get: vi.fn(async () => object),
    head: vi.fn(async () => object),
  };
  const env = {
    ...envWithLimiter(),
    MEDIA_BUCKET: mediaBucket,
  } as unknown as ReturnType<typeof envWithLimiter> & {
    MEDIA_BUCKET: typeof mediaBucket;
  };
  const pending: Promise<unknown>[] = [];
  const context = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };
  return {
    grant,
    db,
    env,
    object,
    auditRows,
    accessUpdates,
    pending,
    context,
    parentProduct,
    bundledProducts,
  };
}

describe("commerce download boundary", () => {
  it("ignores unrelated paths", async () => {
    const response = await handleCommerceDownloadRequest(
      new Request("https://app.bento.surf/library/"),
      envWithLimiter(),
    );
    expect(response).toBeNull();
  });

  it("rejects methods other than GET and HEAD", async () => {
    const response = await handleCommerceDownloadRequest(
      new Request(`https://app.bento.surf${COMMERCE_DOWNLOAD_PATH}${"a".repeat(24)}/asset`, {
        method: "POST",
      }),
      envWithLimiter(),
    );
    expect(response?.status).toBe(405);
  });

  it("rejects malformed capability links before database access", async () => {
    const response = await handleCommerceDownloadRequest(
      new Request(`https://app.bento.surf${COMMERCE_DOWNLOAD_PATH}short/asset`),
      envWithLimiter(),
    );
    expect(response?.status).toBe(400);
  });

  it("rate limits repeated capability-token attempts without exposing the token", async () => {
    const env = envWithLimiter(false);
    const token = "sensitive-capability-token";
    const response = await handleCommerceDownloadRequest(
      new Request(`https://app.bento.surf${COMMERCE_DOWNLOAD_PATH}${token}/asset`),
      env,
    );
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("60");
    expect(env.PUBLIC_API_RATE_LIMITER.limit).toHaveBeenCalledOnce();
    const key = vi.mocked(env.PUBLIC_API_RATE_LIMITER.limit).mock.calls[0]?.[0].key;
    expect(key).not.toContain(token);
  });

  it("streams a verified creator-owned object with safe private download headers and an audit", async () => {
    const fixture = successfulDownloadFixture();
    const response = await handleCommerceDownloadRequest(
      new Request(
        `https://app.bento.surf${COMMERCE_DOWNLOAD_PATH}sensitive-capability-token/asset`,
      ),
      fixture.env as never,
      fixture.context,
      {
        db: fixture.db,
        resolveGrant: vi.fn(async () => fixture.grant),
      },
    );
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("guide");
    expect(response?.headers.get("content-type")).toBe("application/pdf");
    expect(response?.headers.get("content-disposition")).toBe(
      'attachment; filename="Guide -final-.pdf"',
    );
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
    await Promise.all(fixture.pending);
    expect(fixture.accessUpdates).toHaveLength(1);
    expect(fixture.auditRows).toEqual([
      expect.objectContaining({
        grant_id: "grant-1",
        product_id: "product-1",
        creator_id: "creator-1",
        asset_id: "asset",
        outcome: "downloaded",
        object_size: 5,
      }),
    ]);
  });

  it("serves the fulfilled file snapshot after the creator replaces the product file", async () => {
    const fixture = successfulDownloadFixture();
    fixture.grant.delivery_snapshot = {
      files: [
        {
          id: "asset",
          key: "private/users/creator-1/store/purchased-guide.pdf",
          name: "Purchased guide.pdf",
          size: 5,
          mimeType: "application/pdf",
        },
      ],
    };

    const response = await handleCommerceDownloadRequest(
      new Request(
        `https://app.bento.surf${COMMERCE_DOWNLOAD_PATH}sensitive-capability-token/asset`,
      ),
      fixture.env as never,
      fixture.context,
      {
        db: fixture.db,
        resolveGrant: vi.fn(async () => fixture.grant),
      },
    );

    expect(response?.status).toBe(200);
    expect(fixture.env.MEDIA_BUCKET.get).toHaveBeenCalledWith(
      "private/users/creator-1/store/purchased-guide.pdf",
    );
    expect(response?.headers.get("content-disposition")).toBe(
      'attachment; filename="Purchased guide.pdf"',
    );
  });

  it("serves a snapshotted bundle file and audits the included product", async () => {
    const fixture = successfulDownloadFixture();
    const bundledProductId = "00000000-0000-4000-8000-000000000010";
    fixture.parentProduct.kind = "bundle";
    fixture.parentProduct.settings = { files: [] };
    fixture.grant.delivery_snapshot = {
      bundleProductIds: [bundledProductId],
      bundleFiles: [
        {
          productId: bundledProductId,
          file: {
            id: "asset",
            key: "private/users/creator-1/store/bundled-guide.pdf",
            name: "Bundled guide.pdf",
            size: 5,
            mimeType: "application/pdf",
          },
        },
      ],
    };
    fixture.bundledProducts.push({
      id: bundledProductId,
      kind: "digital_product",
      settings: { files: [] },
    });

    const response = await handleCommerceDownloadRequest(
      new Request(
        `https://app.bento.surf${COMMERCE_DOWNLOAD_PATH}sensitive-capability-token/asset`,
      ),
      fixture.env as never,
      fixture.context,
      {
        db: fixture.db,
        resolveGrant: vi.fn(async () => fixture.grant),
      },
    );

    expect(response?.status).toBe(200);
    expect(fixture.env.MEDIA_BUCKET.get).toHaveBeenCalledWith(
      "private/users/creator-1/store/bundled-guide.pdf",
    );
    await Promise.all(fixture.pending);
    expect(fixture.auditRows).toEqual([
      expect.objectContaining({ product_id: bundledProductId, outcome: "downloaded" }),
    ]);
  });

  it("never reads a private object outside the product creator namespace", async () => {
    const fixture = successfulDownloadFixture();
    const productQuery = fixture.db.from("commerce_products") as {
      single: ReturnType<typeof vi.fn>;
    };
    productQuery.single.mockResolvedValueOnce({
      data: {
        kind: "digital_product",
        settings: {
          files: [
            {
              id: "asset",
              key: "private/users/someone-else/store/guide.pdf",
              name: "Guide.pdf",
              size: 5,
              mimeType: "application/pdf",
            },
          ],
        },
      },
      error: null,
    });
    fixture.db.from.mockImplementationOnce(() => productQuery as never);
    const response = await handleCommerceDownloadRequest(
      new Request(
        `https://app.bento.surf${COMMERCE_DOWNLOAD_PATH}sensitive-capability-token/asset`,
      ),
      fixture.env as never,
      fixture.context,
      {
        db: fixture.db,
        resolveGrant: vi.fn(async () => fixture.grant),
      },
    );
    expect(response?.status).toBe(404);
    expect(fixture.env.MEDIA_BUCKET.get).not.toHaveBeenCalled();
  });
});
