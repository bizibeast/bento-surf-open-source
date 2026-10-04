import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

export const WORKSPACE_OWNER_COLUMNS = [
  ["profiles", "id"],
  ["profile_username_aliases", "user_id"],
  ["pages", "user_id"],
  ["blocks", "user_id"],
  ["custom_domains", "user_id"],
  ["subscriptions", "user_id"],
  ["complimentary_plan_grants", "user_id"],
  ["analytics_hourly", "user_id"],
  ["analytics_daily", "user_id"],
  ["analytics_daily_dimensions", "user_id"],
  ["analytics_block_daily", "user_id"],
  ["analytics_daily_visitors", "user_id"],
  ["profile_visit_totals", "user_id"],
  ["profile_views", "user_id"],
  ["block_clicks", "user_id"],
  ["social_connections", "user_id"],
  ["social_oauth_states", "user_id"],
  ["social_posts", "user_id"],
  ["social_posting_schedules", "user_id"],
  ["social_analytics_snapshots", "user_id"],
  ["social_analytics_history", "user_id"],
  ["social_content_insights", "user_id"],
  ["instagram_dm_automations", "user_id"],
  ["instagram_dm_runs", "user_id"],
  ["facebook_dm_automations", "user_id"],
  ["facebook_dm_runs", "user_id"],
  ["twitter_dm_automations", "user_id"],
  ["creator_content_profiles", "user_id"],
  ["creator_brain_items", "user_id"],
  ["creator_content_recommendations", "user_id"],
  ["content_agent_threads", "user_id"],
  ["content_agent_messages", "user_id"],
  ["content_routines", "user_id"],
  ["content_routine_runs", "user_id"],
  ["content_connections", "user_id"],
  ["content_connection_states", "user_id"],
  ["content_source_records", "user_id"],
  ["telegram_actions", "user_id"],
  ["audience_contacts", "creator_id"],
  ["audience_events", "creator_id"],
  ["audience_consent_events", "creator_id"],
  ["audience_lists", "creator_id"],
  ["audience_campaigns", "creator_id"],
  ["newsletter_publications", "creator_id"],
  ["email_marketing_send_reservations", "creator_id"],
  ["email_preferences", "user_id"],
  ["email_signups", "owner_user_id"],
  ["commerce_products", "creator_id"],
  ["commerce_orders", "creator_id"],
  ["commerce_access_grants", "creator_id"],
  ["commerce_leads", "creator_id"],
  ["commerce_course_lessons", "creator_id"],
  ["commerce_bookings", "creator_id"],
  ["commerce_community_posts", "creator_id"],
  ["commerce_community_comments", "creator_id"],
  ["commerce_community_notifications", "creator_id"],
  ["commerce_discount_codes", "creator_id"],
  ["commerce_order_bumps", "creator_id"],
  ["commerce_discount_redemptions", "creator_id"],
  ["commerce_subscription_access", "creator_id"],
  ["commerce_download_events", "creator_id"],
  ["commerce_webinar_registrations", "creator_id"],
  ["commerce_priority_dm_requests", "creator_id"],
  ["creator_payment_accounts", "creator_id"],
  ["commerce_payout_requests", "creator_id"],
  ["payment_oauth_states", "creator_id"],
  ["commerce_payment_sessions", "creator_id"],
  ["commerce_product_provider_refs", "creator_id"],
  ["booking_calendar_oauth_states", "user_id"],
  ["booking_calendar_connections", "user_id"],
  ["booking_availability", "creator_id"],
  ["booking_fathom_oauth_states", "user_id"],
  ["booking_fathom_connections", "user_id"],
  ["booking_reviews", "creator_id"],
  ["billing_events", "user_id"],
  ["payments", "user_id"],
  ["refunds", "user_id"],
  ["tips", "recipient_user_id"],
  ["referral_accounts", "user_id"],
] as const;

const migrationsDir = join(process.cwd(), "supabase/migrations");
const migration = readdirSync(migrationsDir).find((name) =>
  name.endsWith("_workspace_owner_isolation.sql"),
);
const sql = migration ? readFileSync(join(migrationsDir, migration), "utf8").toLowerCase() : "";

describe("workspace owner isolation migration", () => {
  it("enumerates every direct creator-owned column", () => {
    expect(migration).toBeDefined();
    for (const [table, column] of WORKSPACE_OWNER_COLUMNS) {
      expect(sql, `${table}.${column}`).toContain(`('${table}', '${column}')`);
    }
  });

  it("moves creator foreign keys and policies to workspace membership", () => {
    expect(sql).toContain("references public.profiles(id)");
    expect(sql).toContain("private.is_workspace_member");
    expect(sql).toContain("workspace owner column still references auth.users");
    expect(sql).toContain("workspace owner table missing membership policy");
    expect(sql).toContain("to_regclass('public.' || owner.table_name) is not null");
    expect(sql).toContain('owner.table_name collate "c"');
  });

  it("does not expose service-only delivery or secret tables", () => {
    expect(sql).not.toMatch(
      /grant[^;]+on public\.(?:email_outbox|telegram_update_receipts|social_outbox_events|commerce_webhook_events)[^;]+authenticated/,
    );
  });
});
