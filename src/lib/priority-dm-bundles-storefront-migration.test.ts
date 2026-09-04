import { describe, expect, it } from "vitest";
import migrationSql from "../../supabase/migrations/20260823160000_priority_dm_bundles_storefront.sql?raw";

const migration = migrationSql.toLowerCase();

describe("priority DM, bundles, and storefront migration", () => {
  it("adds the product kinds, storefront toggle, and immutable bundle delivery", () => {
    expect(migration).toContain("add value if not exists 'priority_dm'");
    expect(migration).toContain("add value if not exists 'bundle'");
    expect(migration).toContain("store_page_enabled boolean not null default false");
    expect(migration).toContain("'bundleproductids'");
    expect(migration).toContain("'bundlefiles'");
  });

  it("keeps paid messages private to their creator", () => {
    expect(migration).toContain("create table if not exists public.commerce_priority_dm_requests");
    expect(migration).toContain(
      "alter table public.commerce_priority_dm_requests enable row level security",
    );
    expect(migration).toContain("auth.uid() = creator_id");
    expect(migration).toContain("grant update (status, creator_reply, replied_at)");
    expect(migration).not.toContain(
      "grant select, update on public.commerce_priority_dm_requests to authenticated",
    );
    expect(migration).toContain(
      "grant all on public.commerce_priority_dm_requests to service_role",
    );
  });
});
