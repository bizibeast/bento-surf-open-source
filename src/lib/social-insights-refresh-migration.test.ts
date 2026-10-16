import { describe, expect, it } from "vitest";
import sql from "../../supabase/migrations/20260920174302_social_insights_daily_refresh.sql?raw";
import repairSql from "../../supabase/migrations/20261010160000_repair_social_insights_refresh.sql?raw";

describe("daily Social Insights refresh migration", () => {
  it("stores due time and atomically leases only due active connections", () => {
    expect(sql).toContain("add column if not exists next_refresh_at timestamptz");
    expect(sql).toContain("social_analytics_snapshots_next_refresh_idx");
    expect(sql).toContain("claim_due_social_insights_refreshes");
    expect(sql.toLowerCase()).toContain("for update of snapshot skip locked");
    expect(sql).toContain("connection.status = 'active'");
    expect(sql).toContain("refresh_job_id = gen_random_uuid()");
  });

  it("keeps the claim function service-role-only", () => {
    expect(sql).toMatch(
      /revoke all on function public\.claim_due_social_insights_refreshes\(integer\)\s+from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.claim_due_social_insights_refreshes\(integer\)\s+to service_role/i,
    );
    expect(sql).not.toMatch(
      /grant execute on function public\.claim_due_social_insights_refreshes\(integer\) to authenticated/i,
    );
  });

  it("recovers failed imports with no next refresh date", () => {
    expect(repairSql).toContain("set next_refresh_at = now()");
    expect(repairSql).toContain("snapshot.next_refresh_at is null");
    expect(repairSql).toContain("snapshot.fetched_at <= now() - interval '24 hours'");
    expect(repairSql).toContain("for update of snapshot skip locked");
  });
});
