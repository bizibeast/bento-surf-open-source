import migration from "../../supabase/migrations/20260801214208_founder_creator_revenue_leaderboard.sql?raw";
import { describe, expect, it } from "vitest";

describe("founder creator revenue migration", () => {
  it("counts only recognized creator sales and subtracts refunds", () => {
    expect(migration).toContain("status in ('paid', 'partially_refunded', 'refunded')");
    expect(migration).toContain("greatest(0, gross_amount - refunded_amount)");
    expect(migration).toContain("greatest(0, net_amount - refunded_amount)");
  });

  it("keeps rankings and totals currency-safe", () => {
    expect(migration).toContain("partition by totals.currency");
    expect(migration).toContain("group by creator_id, currency");
    expect(migration).toContain("group by currency");
  });

  it("returns a bounded leaderboard without buyer identity data", () => {
    expect(migration).toContain("least(greatest(coalesce(p_limit, 50), 1), 100)");
    expect(migration).toContain("count(distinct buyer_email)");

    const outputShape = migration.slice(migration.indexOf("select jsonb_build_object("));
    expect(outputShape).not.toContain("'buyerEmail'");
    expect(outputShape).not.toContain("'buyerName'");
  });

  it("is executable only by the service role", () => {
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toContain("to service_role");
  });
});
