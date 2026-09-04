import capacityMigration from "../../supabase/migrations/20260901050434_email_marketing_contact_capacity.sql?raw";
import { describe, expect, it } from "vitest";

function functionSection(name: string, nextName?: string) {
  const start = capacityMigration.indexOf(`create or replace function public.${name}`);
  const end = nextName
    ? capacityMigration.indexOf(`create or replace function public.${nextName}`, start + 1)
    : capacityMigration.length;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return capacityMigration.slice(start, end);
}

describe("email marketing contact capacity migration", () => {
  it("derives Free, Store, and Creator limits from server-owned state", () => {
    const limitFunction = functionSection(
      "email_marketing_contact_limit",
      "commerce_apply_audience_consent",
    );
    expect(limitFunction).toMatch(/security definer[\s\S]*set search_path = ''/);
    expect(limitFunction).toContain("from public.profiles profile");
    expect(limitFunction).toContain("from public.subscriptions subscription");
    expect(limitFunction).toContain(
      "current_subscription.status::text in ('active', 'trialing', 'past_due')",
    );
    expect(limitFunction).toContain("current_subscription.plan_id = 'creator'");
    expect(limitFunction).toMatch(
      /when creator_plan = 'free' then 0[\s\S]*when creator_plan = 'store' then 500[\s\S]*when creator_plan = 'creator'[\s\S]*coalesce\(current_subscription\.contact_tier_contacts, 500\)/,
    );
    expect(limitFunction).toMatch(
      /from public\.profiles profile[\s\S]*for update[\s\S]*from public\.subscriptions subscription[\s\S]*for update[\s\S]*creator_plan := creator_profile\.plan_id/,
    );
  });

  it("serializes only new subscribed transitions at the creator profile", () => {
    const triggerFunction = functionSection(
      "commerce_apply_audience_consent",
      "email_marketing_capacity",
    );
    expect(triggerFunction).toMatch(
      /from public\.profiles profile[\s\S]*where profile\.id = new\.creator_id[\s\S]*for update/,
    );
    expect(triggerFunction).toMatch(
      /from public\.subscriptions subscription[\s\S]*where subscription\.user_id = new\.creator_id[\s\S]*for update/,
    );
    expect(triggerFunction).toMatch(
      /new\.status = 'subscribed'[\s\S]*current_contact\.marketing_status is distinct from 'subscribed'/,
    );
    expect(triggerFunction).toMatch(
      /from public\.audience_contacts contact[\s\S]*contact\.marketing_status = 'subscribed'[\s\S]*contact\.id <> new\.contact_id/,
    );
    expect(triggerFunction).toContain("errcode = 'P0001'");
    expect(triggerFunction).toContain(
      "Email marketing contact allowance reached. Upgrade capacity or archive subscribed contacts.",
    );
    expect(triggerFunction).toContain("'subscribed', subscribed_count");
    expect(triggerFunction).toContain("'limit', contact_limit");
  });

  it("keeps contact consent updates intact and adds the subscribed partial index", () => {
    expect(capacityMigration).toContain("set marketing_consent = new.status = 'subscribed'");
    expect(capacityMigration).toContain("marketing_status = new.status");
    expect(capacityMigration).toContain("marketing_consented_at = case");
    expect(capacityMigration).toContain("marketing_unsubscribed_at = case");
    expect(capacityMigration).toMatch(
      /create index if not exists audience_contacts_creator_subscribed_idx[\s\S]*on public\.audience_contacts\(creator_id\)[\s\S]*where marketing_status = 'subscribed'/,
    );
  });

  it("exposes a qualified service-role-only capacity snapshot", () => {
    const capacityFunction = functionSection(
      "email_marketing_capacity",
      "prepare_audience_campaign_recipients_with_capacity",
    );
    expect(capacityFunction).toMatch(/security definer[\s\S]*set search_path = ''/);
    expect(capacityFunction).toMatch(
      /from public\.profiles profile[\s\S]*for update[\s\S]*from public\.subscriptions subscription[\s\S]*for update[\s\S]*creator_plan := creator_profile\.plan_id/,
    );
    expect(capacityFunction).toContain("from public.audience_contacts contact");
    expect(capacityFunction).toContain("'plan', creator_plan");
    expect(capacityFunction).toContain("'over_limit', subscribed_count > contact_limit");
  });

  it("holds capacity locks through one atomic recipient snapshot RPC", () => {
    const wrapperFunction = functionSection("prepare_audience_campaign_recipients_with_capacity");
    expect(wrapperFunction).toMatch(/security definer[\s\S]*set search_path = ''/);
    expect(wrapperFunction).toMatch(
      /from public\.profiles profile[\s\S]*for update[\s\S]*from public\.subscriptions subscription[\s\S]*for update[\s\S]*creator_plan := creator_profile\.plan_id/,
    );
    expect(wrapperFunction).toContain("creator_plan <> 'creator'");
    expect(wrapperFunction).toContain("subscribed_count > contact_limit");
    expect(wrapperFunction).toContain("public.prepare_audience_campaign_recipients(p_campaign_id)");
  });

  it("disambiguates the wrapper creator variable from contact columns", () => {
    const wrapperFunction = functionSection("prepare_audience_campaign_recipients_with_capacity");
    expect(wrapperFunction).toContain("v_creator_id uuid;");
    expect(wrapperFunction).toMatch(/select campaign\.creator_id[\s\S]*into v_creator_id/);
    expect(wrapperFunction).toContain("where contact.creator_id = v_creator_id");
    expect(wrapperFunction).toContain("'creator_id', v_creator_id");
    expect(wrapperFunction).not.toContain("contact.creator_id = creator_id");
  });

  it("revokes every privileged function and grants only service RPCs", () => {
    for (const signature of [
      "email_marketing_contact_limit(uuid)",
      "commerce_apply_audience_consent()",
      "email_marketing_capacity(uuid)",
      "prepare_audience_campaign_recipients_with_capacity(uuid)",
    ]) {
      expect(capacityMigration).toContain(
        `revoke all on function public.${signature}\n  from public, anon, authenticated;`,
      );
    }
    for (const signature of [
      "email_marketing_capacity(uuid)",
      "prepare_audience_campaign_recipients_with_capacity(uuid)",
    ]) {
      expect(capacityMigration).toContain(
        `grant execute on function public.${signature} to service_role;`,
      );
    }
    expect(capacityMigration).not.toMatch(
      /grant execute on function public\.(email_marketing_contact_limit|commerce_apply_audience_consent)/,
    );
    expect(capacityMigration).not.toMatch(/grant execute[\s\S]*to (anon|authenticated)/);
  });
});
