import { describe, expect, it } from "vitest";
import migration from "../../supabase/migrations/20260730060000_commerce_subscription_lifecycle.sql?raw";
import staleEventGuard from "../../supabase/migrations/20260730061000_guard_stale_subscription_terminal_events.sql?raw";

describe("commerce subscription lifecycle migration", () => {
  it("keeps financial orders separate from durable subscription access", () => {
    expect(migration).toContain("create table if not exists public.commerce_subscription_access");
    expect(migration).toContain("access_grant_id uuid references");
    expect(migration).not.toMatch(
      /update public\.commerce_orders[\\s\\S]{0,180}status = 'canceled'/,
    );
  });

  it("supports renewal, cancellation at period end, grace, and terminal states", () => {
    expect(migration).toContain("'renewed'");
    expect(migration).toContain("'cancel_at_period_end'");
    expect(migration).toContain("'past_due'");
    expect(migration).toContain("make_interval(days => p_grace_days)");
    expect(migration).toContain("'expired'");
    expect(migration).toContain("'revoked'");
  });

  it("expires access through a service-only scheduled function", () => {
    expect(migration).toContain("public.expire_commerce_subscription_access");
    expect(migration).toContain("grant execute on function");
    expect(migration).toContain("to service_role");
    expect(migration).toContain("revoke all on function");
  });

  it("rejects stale period shortening and duplicate provider events", () => {
    expect(migration).toContain("last_provider_event_id = p_provider_event_id");
    expect(migration).toContain("Never let a delayed webhook shorten a newer paid billing period");
    expect(migration).toContain("effective_period_end < subscription_row.current_period_end");
    expect(staleEventGuard).toContain("'stale_terminal_event'");
    expect(staleEventGuard).toContain("p_current_period_end < subscription_row.current_period_end");
  });
});
