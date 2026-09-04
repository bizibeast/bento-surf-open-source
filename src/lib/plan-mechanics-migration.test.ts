import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260820170000_free_store_creator_plans.sql",
);
const downgradeMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260820171500_fix_auto_dm_downgrade_enforcement.sql",
);

describe("Free, Store, and Creator database mechanics", () => {
  it("migrates legacy plan ids without deleting account data", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("plan_id in ('free', 'store', 'creator')");
    expect(sql).toContain("when plan_id in ('pro', 'link') then 'store'");
    expect(sql).toContain("when plan_id = 'max' then 'creator'");
    expect(sql).not.toContain("delete from public.profiles");
    expect(sql).not.toContain("delete from public.subscriptions");
  });

  it("enforces Free page and advanced Auto DM boundaries in Postgres", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("create trigger enforce_free_page_limit");
    expect(sql).toContain("free includes up to 5 pages");
    expect(sql).toContain("create trigger enforce_instagram_auto_dm_plan");
    expect(sql).toContain("create trigger enforce_facebook_auto_dm_plan");
    expect(sql).toContain("create trigger enforce_twitter_auto_dm_plan");
    expect(sql).toContain("advanced auto dms require the store plan");
    expect(sql).toContain("create trigger disable_advanced_auto_dms_on_free");
  });

  it("keeps Founder grants on Store or Creator and restores billing access", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("p_plan_id not in ('store', 'creator')");
    expect(sql).toContain("when p_plan_id = 'creator' or v_paid_plan = 'creator'");
    expect(sql).toContain("set plan_id = v_paid_plan");
  });

  it("preserves advanced drafts but disables them for Free", async () => {
    const sql = (await readFile(downgradeMigrationPath, "utf8")).toLowerCase();
    expect(sql.match(/if new\.enabled/g)).toHaveLength(3);
    expect(sql.match(/set enabled = false/g)).toHaveLength(3);
    expect(sql).toContain("profile.plan_id = 'free'");
  });
});
