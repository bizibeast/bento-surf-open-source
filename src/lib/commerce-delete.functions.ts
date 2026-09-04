/* eslint-disable @typescript-eslint/no-explicit-any -- Commerce tables may be ahead of generated Supabase types. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getMediaBucket, validateMediaObjectKey } from "./r2-storage.server";
import { assertGenericCommerceProductMutationAllowed } from "./commerce";

const deleteProductSchema = z.object({ productId: z.string().uuid() });

export function privateProductAssetKeys(settings: unknown, userId: string) {
  if (!settings || typeof settings !== "object") return [];
  const files = (settings as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];
  const prefix = `private/users/${userId}/store/`;
  return Array.from(
    new Set(
      files
        .map((file) =>
          file && typeof file === "object" ? (file as { key?: unknown }).key : undefined,
        )
        .filter((key): key is string => typeof key === "string")
        .map((key) => validateMediaObjectKey(key))
        .filter((key): key is string => Boolean(key?.startsWith(prefix))),
    ),
  );
}

export const deleteCommerceProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => deleteProductSchema.parse(input))
  .handler(async ({ data, context }) => {
    const db = context.supabase as any;
    const { data: product, error: productError } = await db
      .from("commerce_products")
      .select("id, status, settings, kind")
      .eq("id", data.productId)
      .eq("creator_id", context.userId)
      .maybeSingle();
    if (productError) throw new Error("Product could not be loaded.");
    if (!product) throw new Error("Product not found.");
    assertGenericCommerceProductMutationAllowed(product.kind);

    const { data: result, error: deleteError } = await db.rpc("delete_unused_commerce_product", {
      p_product_id: product.id,
    });
    if (deleteError) throw new Error(deleteError.message || "Product could not be deleted.");
    if (!result || typeof result !== "object") {
      throw new Error("Product deletion did not return a result.");
    }
    const deleted = result.deleted === true;
    const archived = result.archived === true;
    const removedBlocks = Math.max(0, Number(result.removedBlocks || 0));

    const assetKeys = deleted ? privateProductAssetKeys(product.settings, context.userId) : [];
    if (deleted && assetKeys.length > 0) {
      try {
        await getMediaBucket().delete(assetKeys);
      } catch {
        // The database is authoritative. Orphaned private files remain inaccessible and can be
        // removed by storage maintenance without making a successful product deletion fail.
      }
    }

    return { deleted, archived, removedBlocks };
  });
