import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("commerce product creation", () => {
  it("publishes new products without leaving a creator-visible draft", async () => {
    const functionsSource = await readFile(
      resolve(process.cwd(), "src/lib/commerce.functions.ts"),
      "utf8",
    );
    const productsSource = await readFile(
      resolve(process.cwd(), "src/routes/_authenticated/store.tsx"),
      "utf8",
    );
    const createSource = functionsSource.slice(
      functionsSource.indexOf("export const createCommerceProduct"),
      functionsSource.indexOf("async function validateCommerceProductPublication"),
    );
    const publicationValidationSource = functionsSource.slice(
      functionsSource.indexOf("async function validateCommerceProductPublication"),
      functionsSource.indexOf("export const updateCommerceProduct"),
    );

    expect(createSource).toContain("validateCommerceProductPublication");
    expect(createSource).toContain('.update({ status: "published"');
    expect(createSource).toContain("rollbackCreatedProduct");
    expect(publicationValidationSource).toContain("commerceDb(supabaseAdmin)");
    expect(functionsSource).toContain('status: z.enum(["published", "archived"])');
    expect(productsSource).not.toContain("Create draft + block");
    expect(productsSource).not.toContain("Saved as a draft until you publish it.");
  });

  it("publishes existing drafts with a repeat-safe backfill", async () => {
    const migration = await readFile(
      resolve(
        process.cwd(),
        "supabase/migrations/20260810000000_publish_commerce_product_drafts.sql",
      ),
      "utf8",
    );

    expect(migration).toContain("status = 'published'");
    expect(migration).toContain("published_at = coalesce(published_at, now())");
    expect(migration).toContain("where status = 'draft'");
  });
});
