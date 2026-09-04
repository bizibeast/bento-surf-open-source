import { describe, expect, it } from "vitest";
import hardeningMigration from "../../supabase/migrations/20260730170000_store_performance_hardening.sql?raw";
import { privateProductAssetKeys } from "./commerce-delete.functions";

describe("privateProductAssetKeys", () => {
  it("returns only deduplicated private product files owned by the creator", () => {
    expect(
      privateProductAssetKeys(
        {
          files: [
            { key: "private/users/user-1/store/guide.pdf" },
            { key: "private/users/user-1/store/guide.pdf" },
            { key: "private/users/user-2/store/secret.pdf" },
            { key: "users/user-1/image/public.png" },
            { key: "private/users/user-1/store/../secret.pdf" },
          ],
        },
        "user-1",
      ),
    ).toEqual(["private/users/user-1/store/guide.pdf"]);
  });

  it("handles missing and malformed settings safely", () => {
    expect(privateProductAssetKeys(null, "user-1")).toEqual([]);
    expect(privateProductAssetKeys({ files: "not-an-array" }, "user-1")).toEqual([]);
  });

  it("deletes unused products and their Bento blocks in one database transaction", () => {
    expect(hardeningMigration).toContain("delete_unused_commerce_product");
    expect(hardeningMigration).toContain("for update");
    expect(hardeningMigration).toContain("content->>'productId' = product_row.id::text");
    expect(hardeningMigration).toContain("'archived', true");
    expect(hardeningMigration).toContain("'deleted', true");
    expect(hardeningMigration).toContain(
      "grant execute on function public.delete_unused_commerce_product(uuid)",
    );
  });
});
