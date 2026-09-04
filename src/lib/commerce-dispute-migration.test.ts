import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260729113000_commerce_dispute_lifecycle.sql",
);
const repairMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260817193000_fix_commerce_dispute_access_status.sql",
);

describe("commerce dispute security migration", () => {
  it("keeps the atomic lifecycle RPC service-role only", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("create or replace function public.apply_commerce_dispute");
    expect(sql).toContain("security definer");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  });

  it("suspends only purchase grants and restores only dispute-suspended access", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("where order_id = order_row.id");
    expect(sql).toContain("and status = 'active'");
    expect(sql).toContain("and dispute_suspended_at is not null");
  });

  it("does not count a restored disputed order as a second sale", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("old.status is distinct from 'disputed'");
  });

  it("repairs favorable grant restoration with explicit enum casts", async () => {
    const sql = (await readFile(repairMigrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("''expired''::public.commerce_access_status");
    expect(sql).toContain("''active''::public.commerce_access_status");
    expect(sql).toContain("expired_branch_count <> 1 or active_branch_count <> 1");
    expect(sql).toContain("execute repaired_definition");
  });
});
