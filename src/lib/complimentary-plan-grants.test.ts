import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isComplimentaryGrantActive, resolveAuthoritativePlan } from "./plan.server";

const baseMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260720193557_complimentary_plan_grants.sql",
);
const upgradeMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260721030539_founder_plan_upgrades.sql",
);
const revokeMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260721031111_founder_plan_revoke_paid_restore.sql",
);
const durationMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260801215708_complimentary_plan_grant_duration.sql",
);
const billingWebhookPath = resolve(process.cwd(), "src/integrations/dodo/webhook.server.ts");
const adminFunctionsPath = resolve(process.cwd(), "src/lib/admin.functions.ts");
const adminRoutePath = resolve(process.cwd(), "src/routes/_authenticated/admin.tsx");

describe("complimentary early tester plans", () => {
  it("uses the highest plan across founder access and paid/profile access", () => {
    expect(resolveAuthoritativePlan("store", "free", false)).toBe("store");
    expect(resolveAuthoritativePlan("link", "store", true)).toBe("store");
    expect(resolveAuthoritativePlan(null, "store", true)).toBe("store");
    expect(resolveAuthoritativePlan(null, "free", false)).toBe("free");
  });

  it("only treats unexpired active founder grants as usable", () => {
    const now = Date.parse("2026-08-02T12:00:00.000Z");
    expect(isComplimentaryGrantActive("active", "2026-08-03T12:00:00.000Z", now)).toBe(true);
    expect(isComplimentaryGrantActive("active", "2026-08-02T12:00:00.000Z", now)).toBe(false);
    expect(isComplimentaryGrantActive("active", "2026-08-01T12:00:00.000Z", now)).toBe(false);
    expect(isComplimentaryGrantActive("revoked", "2026-08-03T12:00:00.000Z", now)).toBe(false);
    expect(isComplimentaryGrantActive("expired", "2026-08-03T12:00:00.000Z", now)).toBe(false);
  });

  it("keeps grant data and management functions service-role only", async () => {
    const sql = (await readFile(baseMigrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
    expect(sql).not.toContain(
      "grant select on table public.complimentary_plan_grants to authenticated",
    );
  });

  it("keeps complimentary creator access separate from founder dashboard access", async () => {
    const [serverSource, routeSource, durationSql] = await Promise.all([
      readFile(adminFunctionsPath, "utf8"),
      readFile(adminRoutePath, "utf8"),
      readFile(durationMigrationPath, "utf8"),
    ]);

    expect(serverSource).toContain('.from("user_roles")');
    expect(serverSource).toContain('.eq("role", "admin")');
    expect(serverSource).toContain("await assertAdmin(context.userId)");
    expect(durationSql.toLowerCase()).not.toContain("insert into public.user_roles");
    expect(durationSql.toLowerCase()).not.toContain("update public.user_roles");
    expect(routeSource).toContain("This unlocks creator app features only.");
    expect(routeSource).toContain("It never grants access to the founder");
    expect(routeSource).not.toContain("Set founder access to");
  });

  it("shows the year in founder grant timestamps", async () => {
    const routeSource = await readFile(adminRoutePath, "utf8");
    expect(routeSource).toContain('year: "numeric"');
    expect(routeSource).toContain("Granted {dateTime(grant.grantedAt)}");
    expect(routeSource).toContain("{dateTime(grant.expiresAt)}");
  });

  it("allows paid users to be upgraded and restores their billing plan on revoke", async () => {
    const upgradeSql = (await readFile(upgradeMigrationPath, "utf8")).toLowerCase();
    const revokeSql = (await readFile(revokeMigrationPath, "utf8")).toLowerCase();
    expect(upgradeSql).not.toContain("this creator already has a paid subscription");
    expect(upgradeSql).toContain("v_effective_plan");
    expect(upgradeSql).toContain("v_paid_plan = 'store'");
    expect(upgradeSql).toContain("coalesce(v_paid_plan, 'free')");
    expect(revokeSql).not.toContain("dodo_subscription_id is not null");
    expect(revokeSql).toContain("set plan_id = v_paid_plan");
  });

  it("keeps active complimentary access when a late billing webhook arrives", async () => {
    const source = await readFile(billingWebhookPath, "utf8");
    expect(source).toContain('.from("complimentary_plan_grants")');
    expect(source).toContain('eq("status", "active")');
    expect(source).toContain("highestPlan(grantedPlan, plan)");
    expect(source).toContain("plan_id: effectiveProfilePlan");
    expect(source).toContain('.gt("expires_at", new Date().toISOString())');
  });

  it("stores a bounded duration and restores the paid plan when access expires", async () => {
    const sql = (await readFile(durationMigrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("add column if not exists expires_at timestamptz");
    expect(sql).toContain("p_duration_days integer default 365");
    expect(sql).toContain("p_duration_days < 1 or p_duration_days > 3650");
    expect(sql).toContain("make_interval(days => p_duration_days)");
    expect(sql).toContain("set status = 'expired'");
    expect(sql).toContain("set plan_id = v_paid_plan");
    expect(sql).toContain("to service_role");
    expect(sql).not.toContain(
      "grant execute on function public.expire_complimentary_plan_grant(uuid) to authenticated",
    );
  });
});
