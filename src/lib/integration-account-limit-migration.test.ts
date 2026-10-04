import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = join(process.cwd(), "supabase/migrations");
const migration = readdirSync(migrationsDir).find((name) =>
  name.endsWith("_one_account_per_workspace_integration.sql"),
);
const sql = migration ? readFileSync(join(migrationsDir, migration), "utf8").toLowerCase() : "";

describe("one active integration account migration", () => {
  it("reconciles duplicates before enforcing one active provider account", () => {
    expect(migration).toBeDefined();
    expect(sql).toContain("instagram_dm_automations");
    expect(sql).toContain("facebook_dm_automations");
    expect(sql).toContain("twitter_dm_automations");
    expect(sql).toContain("row_number() over");
    expect(sql).toContain("updated_at desc");
    expect(sql).toContain("set status = 'revoked'");
    expect(sql).toContain("set status = 'disconnected'");
  });

  it("adds active-only uniqueness without deleting audit rows", () => {
    expect(sql).toMatch(
      /create unique index social_connections_one_active_provider[\s\S]+\(user_id, provider\)[\s\S]+where status = 'active'/,
    );
    expect(sql).toMatch(
      /create unique index content_connections_one_active_provider[\s\S]+\(user_id, provider\)[\s\S]+where status = 'active'/,
    );
    expect(sql).not.toMatch(/delete from public\.(social_connections|content_connections)/);
    expect(sql).toContain("replace_active_social_connection");
    expect(sql).toContain("replace_active_content_connection");
    expect(sql).toContain("and id <> new.id");
  });
});
