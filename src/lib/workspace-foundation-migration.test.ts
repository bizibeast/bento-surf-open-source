import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = join(process.cwd(), "supabase/migrations");
const migration = readdirSync(migrationsDir).find((name) =>
  name.endsWith("_multi_workspace_foundation.sql"),
);
const sql = migration ? readFileSync(join(migrationsDir, migration), "utf8").toLowerCase() : "";

describe("multi-workspace foundation migration", () => {
  it("creates and backfills the workspace ownership model", () => {
    expect(migration).toBeDefined();
    expect(sql).toContain("create table public.workspace_memberships");
    expect(sql).toContain("create table public.account_preferences");
    expect(sql).toContain("create function private.is_workspace_member");
    expect(sql).toMatch(
      /insert into public\.workspace_memberships[\s\S]+select[^;]+from public\.profiles/i,
    );
    expect(sql).toContain("revoke all on function private.is_workspace_member(uuid) from public");
  });

  it("keeps membership and preferences behind row-level security", () => {
    expect(sql).toMatch(/alter table public\.workspace_memberships enable row level security/);
    expect(sql).toMatch(/alter table public\.account_preferences enable row level security/);
    expect(sql).toMatch(
      /create policy workspace_memberships_owner_update[\s\S]+for update[\s\S]+using\s*\([\s\S]+with check\s*\(/,
    );
    expect(sql).not.toContain("user_metadata");
  });

  it("creates workspace ownership when a user signs up", () => {
    expect(sql).toMatch(
      /create or replace function public\.handle_new_user\(\)[\s\S]+insert into public\.workspace_memberships\(auth_user_id, workspace_id, role, status\)[\s\S]+values \(new\.id, new\.id, 'owner', 'active'\)/,
    );
    expect(sql).toMatch(
      /create or replace function public\.handle_new_user\(\)[\s\S]+insert into public\.account_preferences\(auth_user_id, app_theme\)[\s\S]+values \(new\.id, 'light'\)/,
    );
  });
});
