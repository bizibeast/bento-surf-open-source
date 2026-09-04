import type { CommerceAsset, CommerceProductKind, CommerceProductSettings } from "./commerce";
import { getMediaBucket, validateMediaObjectKey } from "./r2-storage.server";

type AssetBucket = Pick<R2Bucket, "head">;

export function commerceAssetOwnerPrefix(userId: string) {
  return `private/users/${userId}/store/`;
}

export function digitalProductFiles(
  kind: CommerceProductKind,
  settings: CommerceProductSettings | Record<string, unknown> | null | undefined,
) {
  if (kind !== "digital_product" || !Array.isArray(settings?.files)) return [];
  return settings.files as CommerceAsset[];
}

/**
 * Fulfilled buyers receive the immutable file manifest captured on their
 * access grant. The product settings fallback only exists for grants created
 * before delivery snapshots were introduced.
 */
export function resolveDigitalDeliveryFiles(
  deliverySnapshot: unknown,
  currentSettings: CommerceProductSettings | Record<string, unknown> | null | undefined,
) {
  if (
    deliverySnapshot &&
    typeof deliverySnapshot === "object" &&
    !Array.isArray(deliverySnapshot) &&
    Object.prototype.hasOwnProperty.call(deliverySnapshot, "files")
  ) {
    const files = (deliverySnapshot as { files?: unknown }).files;
    return Array.isArray(files) ? (files as CommerceAsset[]) : [];
  }
  return Array.isArray(currentSettings?.files) ? (currentSettings.files as CommerceAsset[]) : [];
}

export function resolveBundleDeliveryProductIds(
  deliverySnapshot: unknown,
  currentSettings: CommerceProductSettings | Record<string, unknown> | null | undefined,
) {
  const snapshot =
    deliverySnapshot && typeof deliverySnapshot === "object" && !Array.isArray(deliverySnapshot)
      ? (deliverySnapshot as Record<string, unknown>)
      : null;
  const value = snapshot?.bundleProductIds ?? currentSettings?.bundledProductIds;
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map(String)
        .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)),
    ),
  ];
}

export function resolveBundleDigitalDeliveryFiles(
  deliverySnapshot: unknown,
  productId: string,
  currentSettings: CommerceProductSettings | Record<string, unknown> | null | undefined,
) {
  const snapshot =
    deliverySnapshot && typeof deliverySnapshot === "object" && !Array.isArray(deliverySnapshot)
      ? (deliverySnapshot as Record<string, unknown>)
      : null;
  if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, "bundleFiles")) {
    const files = Array.isArray(snapshot.bundleFiles) ? snapshot.bundleFiles : [];
    return files.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const item = entry as { productId?: unknown; file?: unknown };
      return item.productId === productId && item.file && typeof item.file === "object"
        ? [item.file as CommerceAsset]
        : [];
    });
  }
  return resolveDigitalDeliveryFiles(null, currentSettings);
}

/**
 * Product settings are client-authored JSON. Never trust a stored R2 key until
 * the object has been verified against the authenticated creator's namespace.
 */
export async function verifyDigitalProductAssets(
  userId: string,
  kind: CommerceProductKind,
  settings: CommerceProductSettings | Record<string, unknown> | null | undefined,
  bucket?: AssetBucket,
) {
  const files = digitalProductFiles(kind, settings);
  if (!files.length) return;
  const storage = bucket ?? getMediaBucket();
  const prefix = commerceAssetOwnerPrefix(userId);
  const results = await Promise.all(
    files.map(async (file) => {
      const key = validateMediaObjectKey(String(file.key || ""));
      if (!key || !key.startsWith(prefix)) {
        throw new Error(`The buyer file "${file.name}" does not belong to this account.`);
      }
      const object = await storage.head(key);
      if (!object) throw new Error(`The buyer file "${file.name}" is missing. Upload it again.`);
      if (Number(file.size) !== object.size) {
        throw new Error(`The buyer file "${file.name}" changed during upload. Upload it again.`);
      }
      return key;
    }),
  );
  if (new Set(results).size !== results.length) {
    throw new Error("Each buyer file can only be attached once.");
  }
}
