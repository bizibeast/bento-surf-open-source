import { describe, expect, it, vi } from "vitest";
import {
  resolveBundleDeliveryProductIds,
  resolveBundleDigitalDeliveryFiles,
  resolveDigitalDeliveryFiles,
  verifyDigitalProductAssets,
} from "./commerce-assets.server";

const userId = "00000000-0000-4000-8000-000000000001";
const file = {
  id: "asset-1",
  key: `private/users/${userId}/store/file.pdf`,
  name: "Guide.pdf",
  size: 12,
  mimeType: "application/pdf",
};

describe("digital product asset verification", () => {
  it("accepts existing files owned by the authenticated creator", async () => {
    const bucket = { head: vi.fn(async () => ({ size: 12 })) };
    await expect(
      verifyDigitalProductAssets(userId, "digital_product", { files: [file] }, bucket as never),
    ).resolves.toBeUndefined();
    expect(bucket.head).toHaveBeenCalledWith(file.key);
  });

  it("rejects another creator's private object before touching R2", async () => {
    const bucket = { head: vi.fn() };
    await expect(
      verifyDigitalProductAssets(
        userId,
        "digital_product",
        {
          files: [
            {
              ...file,
              key: "private/users/00000000-0000-4000-8000-000000000002/store/file.pdf",
            },
          ],
        },
        bucket as never,
      ),
    ).rejects.toThrow("does not belong to this account");
    expect(bucket.head).not.toHaveBeenCalled();
  });

  it("rejects missing, changed, and duplicate objects", async () => {
    await expect(
      verifyDigitalProductAssets(userId, "digital_product", { files: [file] }, {
        head: vi.fn(async () => null),
      } as never),
    ).rejects.toThrow("is missing");
    await expect(
      verifyDigitalProductAssets(userId, "digital_product", { files: [file] }, {
        head: vi.fn(async () => ({ size: 13 })),
      } as never),
    ).rejects.toThrow("changed during upload");
    await expect(
      verifyDigitalProductAssets(
        userId,
        "digital_product",
        { files: [file, { ...file, id: "asset-2" }] },
        { head: vi.fn(async () => ({ size: 12 })) } as never,
      ),
    ).rejects.toThrow("only be attached once");
  });

  it("does not inspect assets for other offer types", async () => {
    const bucket = { head: vi.fn() };
    await expect(
      verifyDigitalProductAssets(userId, "course", { files: [file] }, bucket as never),
    ).resolves.toBeUndefined();
    expect(bucket.head).not.toHaveBeenCalled();
  });
});

describe("digital delivery snapshots", () => {
  it("keeps the fulfilled manifest when the product is edited later", () => {
    const replacement = { ...file, id: "asset-2", key: `${file.key}.new` };
    expect(resolveDigitalDeliveryFiles({ files: [file] }, { files: [replacement] })).toEqual([
      file,
    ]);
  });

  it("treats an explicit empty snapshot as authoritative", () => {
    expect(resolveDigitalDeliveryFiles({ files: [] }, { files: [file] })).toEqual([]);
  });

  it("falls back to current settings only for legacy grants", () => {
    expect(resolveDigitalDeliveryFiles({}, { files: [file] })).toEqual([file]);
    expect(resolveDigitalDeliveryFiles(null, { files: [file] })).toEqual([file]);
  });
});

describe("bundle delivery snapshots", () => {
  const productId = "00000000-0000-4000-8000-000000000010";

  it("keeps the purchased products and files when the bundle changes later", () => {
    const replacement = { ...file, id: "asset-2", key: `${file.key}.new` };
    const snapshot = {
      bundleProductIds: [productId],
      bundleFiles: [{ productId, file }],
    };
    expect(
      resolveBundleDeliveryProductIds(snapshot, {
        bundledProductIds: ["00000000-0000-4000-8000-000000000011"],
      }),
    ).toEqual([productId]);
    expect(
      resolveBundleDigitalDeliveryFiles(snapshot, productId, { files: [replacement] }),
    ).toEqual([file]);
  });

  it("falls back to current bundle settings for legacy grants", () => {
    expect(resolveBundleDeliveryProductIds({}, { bundledProductIds: [productId] })).toEqual([
      productId,
    ]);
    expect(resolveBundleDigitalDeliveryFiles({}, productId, { files: [file] })).toEqual([file]);
  });
});
