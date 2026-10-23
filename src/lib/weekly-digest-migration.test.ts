import { describe, expect, it } from "vitest";
import migration from "../../supabase/migrations/20261020120000_weekly_digest_once_per_user.sql?raw";

describe("weekly digest migration", () => {
  it("leaves onboarding enqueue in place and stops per-profile digest inserts", () => {
    expect(migration).toContain("'onboarding-quick-win:' || profile.id::text");
    expect(migration).toContain("'commerce-feature:' || profile.id::text");
    expect(migration).toContain("'pro-upgrade:' || profile.id::text");
    expect(migration).not.toContain("'weekly_digest'");
    expect(migration).not.toContain("weekly-digest:");
    expect(migration).toContain(
      "grant execute on function public.enqueue_due_lifecycle_emails() to service_role",
    );
  });

  it("exposes page stats only to the service role", () => {
    expect(migration).toContain("function public.weekly_digest_page_stats(p_since date)");
    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain(
      "grant execute on function public.weekly_digest_page_stats(date) to service_role",
    );
    expect(migration).toContain(
      "revoke all on function public.weekly_digest_page_stats(date) from public, anon, authenticated",
    );
  });

  it("lowers the shared daily email caps", () => {
    expect(migration).toMatch(
      /update public\.provider_budget_policies\s+set daily_limit = 70\s+where resource = 'marketing_emails'/,
    );
    expect(migration).toMatch(
      /update public\.provider_budget_policies\s+set daily_limit = 100\s+where resource = 'transactional_emails'/,
    );
  });
});
