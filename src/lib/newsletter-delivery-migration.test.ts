import deliveryMigration from "../../supabase/migrations/20260831034434_newsletter_delivery_hardening.sql?raw";
import schedulingMigration from "../../supabase/migrations/20260902080000_newsletter_recipient_counts.sql?raw";
import { describe, expect, it } from "vitest";

describe("newsletter delivery migration", () => {
  it("publishes a scheduled newsletter only inside the due campaign claim", () => {
    expect(schedulingMigration).toContain("publish_on_delivery boolean not null default false");
    expect(schedulingMigration).toMatch(
      /function public\.claim_due_audience_campaigns[\s\S]*campaign\.delivery_status = 'scheduled'[\s\S]*coalesce\(campaign\.scheduled_at, now\(\)\) <= now\(\)[\s\S]*for update skip locked/,
    );
    expect(schedulingMigration).toMatch(
      /set delivery_status = 'sending'[\s\S]*when campaign\.kind = 'newsletter' and campaign\.publish_on_delivery then 'published'[\s\S]*published_at = case[\s\S]*coalesce\(campaign\.published_at, now\(\)\)/,
    );
  });

  it("does not reclaim a stale publish-on-delivery Post without a claim token", () => {
    expect(schedulingMigration).toMatch(
      /campaign\.delivery_status = 'sending'[\s\S]*campaign\.updated_at <= now\(\) - interval '10 minutes'[\s\S]*not \([\s\S]*campaign\.kind = 'newsletter'[\s\S]*campaign\.publish_on_delivery[\s\S]*\)/,
    );
  });

  it("atomically claims due campaigns and idempotently reserves monthly creator quota", () => {
    expect(deliveryMigration).toContain("claim_due_audience_campaigns");
    expect(deliveryMigration).toContain("for update skip locked");
    expect(deliveryMigration).toContain("email_marketing_send_reservations");
    expect(deliveryMigration).toContain("reserve_email_marketing_sends");
    expect(deliveryMigration).toContain("pg_advisory_xact_lock");
    expect(deliveryMigration).toContain("unique (creator_id, campaign_id, period_start)");
  });

  it("resolves consented newsletter recipients and paid access inside the database boundary", () => {
    expect(deliveryMigration).toContain("prepare_audience_campaign_recipients");
    expect(deliveryMigration).toContain("newsletter_subscriptions");
    expect(deliveryMigration).toContain("subscription.status = 'subscribed'");
    expect(deliveryMigration).toContain("subscription.email_enabled");
    expect(deliveryMigration).toContain("commerce_access_grants");
    expect(deliveryMigration).toContain("access.expires_at > now()");
    expect(deliveryMigration).toContain("eligible_contacts as");
    expect(deliveryMigration).toContain("set status = 'skipped'");
    expect(deliveryMigration).toContain("recipient.status in ('pending', 'queued')");
  });

  it("links exact campaign event keys and prioritizes transactional outbox claims", () => {
    expect(deliveryMigration).toContain("link_audience_campaign_outbox");
    expect(deliveryMigration).toContain("'audience-campaign:' || p_campaign_id::text || ':'");
    expect(deliveryMigration).toContain("case when category = 'transactional' then 0 else 1 end");
    expect(deliveryMigration).toMatch(/'delivered'.*'bounced'.*'complained'/s);
  });

  it("authorizes each campaign outbox from one service-role-only row-locking snapshot", () => {
    expect(deliveryMigration).toContain("authorize_audience_campaign_delivery");
    expect(deliveryMigration).toMatch(
      /create or replace function public\.authorize_audience_campaign_delivery\(p_outbox_id uuid\)[\s\S]*security definer[\s\S]*set search_path = ''/,
    );
    expect(deliveryMigration).toMatch(
      /from public\.email_outbox[\s\S]*for update[\s\S]*from public\.audience_campaign_recipients[\s\S]*for update[\s\S]*from public\.audience_campaigns[\s\S]*for update/,
    );
    expect(deliveryMigration).toContain("from public.newsletter_subscriptions");
    expect(deliveryMigration).toContain("from public.commerce_access_grants");
    expect(deliveryMigration).toMatch(
      /update public\.email_outbox[\s\S]*status = 'suppressed'[\s\S]*update public\.audience_campaign_recipients[\s\S]*status = 'suppressed'[\s\S]*refresh_audience_campaign_delivery/,
    );
    expect(deliveryMigration).toMatch(
      /revoke all on function public\.authorize_audience_campaign_delivery\(uuid\)[\s\S]*grant execute on function public\.authorize_audience_campaign_delivery\(uuid\) to service_role/,
    );
  });

  it("locks global suppression and routes it through terminal campaign aggregation", () => {
    expect(deliveryMigration).toMatch(
      /function public\.authorize_audience_campaign_delivery[\s\S]*suppression_record public\.email_suppressions%rowtype[\s\S]*from public\.email_suppressions[\s\S]*where email = lower\(outbox_record\.recipient_email\)[\s\S]*for update/,
    );
    expect(deliveryMigration).toContain("suppression_record.email is null");
    expect(deliveryMigration).toMatch(
      /function public\.authorize_audience_campaign_delivery[\s\S]*update public\.email_outbox[\s\S]*status = 'suppressed'[\s\S]*update public\.audience_campaign_recipients[\s\S]*status = 'suppressed'[\s\S]*refresh_audience_campaign_delivery/,
    );
  });

  it("keeps delivery tables and RPCs private to the service role", () => {
    expect(deliveryMigration).toContain("enable row level security");
    expect(deliveryMigration).toMatch(
      /revoke all on function public\.claim_due_audience_campaigns/s,
    );
    expect(deliveryMigration).toMatch(
      /grant execute on function public\.claim_due_audience_campaigns/s,
    );
    expect(deliveryMigration).not.toMatch(/grant execute[\s\S]*to anon/);
  });

  it("keeps quota reservations idempotent only inside the creator campaign month", () => {
    expect(deliveryMigration).toContain("unique (creator_id, campaign_id, period_start)");
    expect(deliveryMigration).toMatch(
      /where creator_id = p_creator_id[\s\S]*campaign_id = p_campaign_id[\s\S]*period_start = period/,
    );
    expect(deliveryMigration).not.toContain(
      "already_reserved.recipient_count <> p_recipient_count",
    );
    expect(deliveryMigration).toContain("existing.campaign_id = campaign.id");
  });

  it("advances recipient states monotonically and aggregates terminal campaign truth", () => {
    expect(deliveryMigration).toContain("'suppressed'");
    expect(deliveryMigration).toContain("update_audience_campaign_recipient_status");
    expect(deliveryMigration).toContain("refresh_audience_campaign_delivery");
    expect(deliveryMigration).toContain("recipient.status = p_status");
    expect(deliveryMigration).toContain("recipient.status = 'sent'");
    expect(deliveryMigration).toContain("accepted_count > 0");
    expect(deliveryMigration).toContain("terminal_count <> recipient_count");
    expect(deliveryMigration).toContain(
      "recipient.status = 'delivered' and p_status = 'complained'",
    );
    expect(deliveryMigration).not.toContain(
      "recipient.status = 'delivered' and p_status in ('sent', 'bounced', 'failed')",
    );
  });

  it("copies defensive terminal outbox state and immediately aggregates linked recipients", () => {
    expect(deliveryMigration).toContain("skip_audience_campaign_recipients");
    expect(deliveryMigration).toMatch(
      /status = case[\s\S]*when outbox\.status = 'sent' then 'sent'[\s\S]*when outbox\.status = 'failed' then 'failed'[\s\S]*when outbox\.status = 'suppressed' then 'suppressed'[\s\S]*else 'queued'/,
    );
    expect(deliveryMigration).toMatch(
      /function public\.link_audience_campaign_outbox[\s\S]*perform public\.refresh_audience_campaign_delivery\(p_campaign_id\)/,
    );
  });
});
