import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260717190000_security_hardening.sql",
);

describe("database security hardening migration", () => {
  it("removes direct public reads and untrusted event writes", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    expect(sql).toContain('drop policy if exists "profiles_public_read"');
    expect(sql).toContain('drop policy if exists "pages_public_read"');
    expect(sql).toContain('drop policy if exists "blocks_public_read"');
    expect(sql).toContain("revoke select on public.profiles from anon, authenticated");
    expect(sql).toContain("revoke insert on public.profile_views from anon, authenticated");
    expect(sql).toContain("revoke insert on public.block_clicks from anon, authenticated");
    expect(sql).toContain("revoke insert on public.email_signups from anon, authenticated");
  });

  it("retains privileged analytics execution only for the service role", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  });
});
