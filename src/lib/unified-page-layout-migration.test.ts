import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260905090000_unified_page_navigation_and_layout.sql",
  "utf8",
);
const hardeningSql = readFileSync(
  "supabase/migrations/20260905094500_harden_unified_page_layout_access.sql",
  "utf8",
);
const invokerSql = readFileSync(
  "supabase/migrations/20260905095500_use_invoker_for_page_layout_functions.sql",
  "utf8",
);

describe("unified page layout migration", () => {
  it("preserves hidden system pages and makes reorder/layout replacement atomic", () => {
    expect(sql).toMatch(/add column system text/i);
    expect(sql).toMatch(/add column is_visible boolean not null default true/i);
    expect(sql).toMatch(/unique[\s\S]+user_id[\s\S]+system/i);
    expect(sql).toMatch(/create table public\.page_system_item_layouts/i);
    expect(sql).toMatch(/on delete cascade/i);
    expect(sql).toMatch(/reorder_creator_pages/i);
    expect(sql).toMatch(/replace_page_system_item_layout/i);
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).toMatch(/newsletter_publications/i);
  });

  it("backfills every system page with a collision-proof internal slug", () => {
    for (const system of ["calendar", "store", "insights", "newsletter"]) {
      expect(sql).toMatch(
        new RegExp(
          `'${system}'(?:\\:\\:text)? as system,[\\s\\S]*'__system_${system}'(?:\\:\\:text)? as slug`,
        ),
      );
    }
    expect(sql).toMatch(/pages_system_slug_check/i);
    expect(sql).toMatch(/system is null or slug = '__system_' \|\| system/i);
    expect(sql).toMatch(/pages_custom_slug_system_namespace_check/i);
    expect(sql).toMatch(/system is not null or slug !~ '\^__system_'/i);
  });

  it("allows legacy custom internal slugs without blocking system backfill", () => {
    const oldSlugConstraint = sql.indexOf("drop constraint if exists pages_user_id_slug_key");
    const backfill = sql.indexOf("with system_pages as");

    expect(oldSlugConstraint).toBeGreaterThan(-1);
    expect(oldSlugConstraint).toBeLessThan(backfill);
    expect(sql).toMatch(
      /create unique index if not exists pages_user_id_custom_slug_unique[\s\S]+on public\.pages \(user_id, slug\)[\s\S]+where system is null/i,
    );
    expect(sql).toMatch(/on conflict \(user_id, system\) where system is not null do nothing/i);
  });

  it("explicitly denies anonymous RPC execution and avoids duplicate select policies", () => {
    expect(hardeningSql).toMatch(
      /revoke all on function public\.reorder_creator_pages\(uuid\[\]\) from anon/i,
    );
    expect(hardeningSql).toMatch(
      /revoke all on function public\.replace_page_system_item_layout\(uuid, jsonb\) from anon/i,
    );
    expect(hardeningSql).toMatch(/create policy page_system_item_layouts_owner_insert/i);
    expect(hardeningSql).toMatch(/create policy page_system_item_layouts_owner_update/i);
    expect(hardeningSql).toMatch(/create policy page_system_item_layouts_owner_delete/i);
    expect(hardeningSql).not.toMatch(/create policy page_system_item_layouts_owner_write/i);
  });

  it("uses caller RLS for RPCs and gives layouts a composite primary key", () => {
    expect(invokerSql).toMatch(
      /alter function public\.reorder_creator_pages\(uuid\[\]\) security invoker/i,
    );
    expect(invokerSql).toMatch(
      /alter function public\.replace_page_system_item_layout\(uuid, jsonb\) security invoker/i,
    );
    expect(invokerSql).toMatch(/add primary key \(page_id, item_key\)/i);
  });
});
