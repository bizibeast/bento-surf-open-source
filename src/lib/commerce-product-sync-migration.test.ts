import { describe, expect, it } from "vitest";
import migrationSql from "../../supabase/migrations/20260730183000_atomic_commerce_block_sync.sql?raw";

const migration = migrationSql.toLowerCase();

describe("atomic commerce block synchronization migration", () => {
  it("updates only the creator's linked commerce blocks", () => {
    expect(migration).toContain("create trigger commerce_products_sync_blocks");
    expect(migration).toContain("where user_id = new.creator_id");
    expect(migration).toContain("and type = 'commerce'");
    expect(migration).toContain("content->>'productid' = new.id::text");
  });

  it("mirrors every storefront-facing field in the same transaction", () => {
    for (const field of [
      "'slug', new.slug",
      "'kind', new.kind",
      "'title', new.title",
      "'subtitle', new.subtitle",
      "'coverurl', new.cover_url",
      "'pricingtype', new.pricing_type",
      "'priceamount', new.price_amount",
      "'currency', new.currency",
      "'billinginterval', new.billing_interval",
      "'ctalabel', new.cta_label",
      "'status', new.status",
    ]) {
      expect(migration).toContain(field);
    }
  });

  it("cannot be invoked directly by browser roles", () => {
    expect(migration).toContain("revoke all on function public.sync_commerce_product_blocks()");
    expect(migration).toContain("from public, anon, authenticated");
  });
});
