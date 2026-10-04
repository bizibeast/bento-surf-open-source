import { describe, expect, it } from "vitest";
import sql from "../../supabase/migrations/20260918090000_content_agent_workspace.sql?raw";
import advisorSql from "../../supabase/migrations/20260919185032_content_agent_advisor_fixes.sql?raw";
import discoverSql from "../../supabase/migrations/20260920090349_discover_social_post_metadata.sql?raw";
import isolationSql from "../../supabase/migrations/20260920185430_workspace_owner_isolation.sql?raw";

describe("content agent workspace migration", () => {
  it("creates owner-isolated Brain, Agent, recommendation, and Routine records", () => {
    for (const table of [
      "creator_content_profiles",
      "creator_brain_items",
      "content_trend_briefs",
      "creator_content_recommendations",
      "content_agent_threads",
      "content_agent_messages",
      "content_routines",
      "content_routine_runs",
    ]) {
      expect(sql).toContain(`create table public.${table}`);
    }
    expect(sql.match(/enable row level security/g)?.length).toBeGreaterThanOrEqual(8);
    expect(sql).toContain("claim_due_content_routines");
    expect(sql).toContain("finish_content_routine_run");
    expect(sql).toMatch(/unique\s*\(niche_key,\s*language,\s*region,\s*brief_date\)/i);
    expect(sql).toMatch(/unique\s*\(routine_id,\s*scheduled_for\)/i);
    expect(sql).toContain("creator_content_recommendations_fingerprint_unique");
  });

  it("keeps shared briefs server-only and creator rows owner scoped", () => {
    expect(sql).toContain("on public.creator_brain_items for all");
    expect(sql).toContain("auth.uid() = user_id");
    expect(sql).toContain(
      "revoke all on public.content_trend_briefs from public, anon, authenticated",
    );
    expect(sql).toContain("grant all on public.content_trend_briefs to service_role");
    expect(sql).toMatch(/for update skip locked/i);
  });

  it("moves creator Content records behind workspace membership", () => {
    for (const table of [
      "creator_content_profiles",
      "creator_brain_items",
      "content_agent_threads",
      "content_routines",
      "content_connections",
      "content_source_records",
    ]) {
      expect(isolationSql).toContain(`('${table}', 'user_id')`);
    }
    expect(isolationSql).toContain("private.is_workspace_member");
  });

  it("bounds chat retention and routine leases", () => {
    expect(sql).toContain("expires_at timestamptz not null default (now() + interval '180 days')");
    expect(sql).toContain("lease_expires_at");
    expect(sql).toContain("attempts integer not null default 0");
  });

  it("stores bounded social-post metadata for Discover details", () => {
    expect(discoverSql).toContain("add column if not exists metadata jsonb");
    expect(discoverSql).toContain("jsonb_typeof(metadata) = 'object'");
    expect(discoverSql).toContain("'pending', 'liked', 'saved', 'not_relevant'");
  });

  it("keeps owner policies efficient and covers Content foreign keys", () => {
    expect(advisorSql.match(/\(select auth\.uid\(\)\) = user_id/g)).toHaveLength(15);
    for (const index of [
      "content_agent_messages_thread_owner_idx",
      "content_agent_messages_user_created_idx",
      "creator_content_recommendations_insight_idx",
      "creator_content_recommendations_trend_idx",
      "telegram_actions_user_idx",
    ]) {
      expect(advisorSql).toContain(`create index ${index}`);
    }
  });
});
