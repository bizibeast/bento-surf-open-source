import { describe, expect, it } from "vitest";
import migration from "../../supabase/migrations/20260901155705_email_marketing_multi_publication.sql?raw";

describe("multi-publication migration", () => {
  it("replaces one-publication constraint with creator-scoped slugs and one default", () => {
    expect(migration).toContain("drop constraint newsletter_publications_creator_unique");
    expect(migration).toContain("unique (creator_id, slug)");
    expect(migration).toContain("where is_default");
  });

  it("scopes lists and new broadcasts to publications", () => {
    expect(migration).toContain("add column publication_id uuid");
    expect(migration).toContain("audience_lists");
    expect(migration).toContain("commerce_validate_newsletter_campaign");
  });

  it("stores a nullable allow-listed template identity on newsletter posts", () => {
    expect(migration).toMatch(
      /alter table public\.audience_campaigns[\s\S]*add column template_id text[\s\S]*check \(template_id is null or template_id in \('editorial','minimal','bold-digest','product-launch','personal-note','weekly-roundup'\)\)/,
    );
  });

  it("intersects publication broadcasts with active publication subscriptions and their list", () => {
    const recipientFunction = migration.match(
      /create or replace function public\.prepare_audience_campaign_recipients\([\s\S]*?\$\$;/,
    )?.[0];

    expect(recipientFunction).toBeDefined();
    expect(recipientFunction).toMatch(
      /campaign\.kind = 'broadcast'[\s\S]*campaign\.publication_id is null[\s\S]*subscription\.status = 'subscribed'[\s\S]*subscription\.email_enabled[\s\S]*member\.list_id = campaign\.list_id/,
    );
    expect(recipientFunction?.match(/subscription\.status = 'subscribed'/g)).toHaveLength(6);
  });

  it("rechecks publication broadcasts immediately before provider delivery", () => {
    const authorization = migration.match(
      /create or replace function public\.authorize_audience_campaign_delivery\([\s\S]*?\$\$;/,
    )?.[0];
    const broadcastBranch = authorization?.match(
      /if campaign_record\.kind = 'broadcast' then[\s\S]*?elsif campaign_record\.kind = 'newsletter' then/,
    )?.[0];

    expect(broadcastBranch).toBeDefined();
    expect(broadcastBranch).toMatch(/campaign_record\.publication_id is null/);
    expect(broadcastBranch).toMatch(/publication_record\.status <> 'archived'/);
    expect(broadcastBranch).toMatch(/subscription_record\.status = 'subscribed'/);
    expect(broadcastBranch).toContain("subscription_record.email_enabled");
    expect(broadcastBranch).toMatch(
      /audience_list\.publication_id is not distinct from campaign_record\.publication_id/,
    );
  });

  it("deduplicates consent events atomically by creator and stable import batch key", () => {
    expect(migration).toMatch(
      /alter table public\.audience_consent_events[\s\S]*add column idempotency_key text/,
    );
    expect(migration).toMatch(
      /create unique index audience_consent_events_creator_idempotency_unique[\s\S]*\(creator_id, idempotency_key\)[\s\S]*where idempotency_key is not null/,
    );
  });

  it("rejects cross-publication campaign lists while preserving matched nullable legacy lists", () => {
    const validator = migration.match(
      /create or replace function public\.commerce_validate_newsletter_campaign\(\)[\s\S]*?\$\$;/,
    )?.[0];
    const recipientFunction = migration.match(
      /create or replace function public\.prepare_audience_campaign_recipients\([\s\S]*?\$\$;/,
    )?.[0];

    expect(validator).toMatch(/list_row public\.audience_lists%rowtype/);
    expect(validator).toMatch(/list_row\.creator_id is distinct from new\.creator_id/);
    expect(validator).toMatch(/list_row\.publication_id is distinct from new\.publication_id/);
    expect(migration).toMatch(
      /create trigger audience_campaigns_validate_newsletter[\s\S]*update of[\s\S]*list_id/,
    );
    expect(recipientFunction?.match(/join public\.audience_lists audience_list/g)).toHaveLength(3);
    expect(
      recipientFunction?.match(
        /audience_list\.publication_id is not distinct from campaign\.publication_id/g,
      ),
    ).toHaveLength(3);
  });

  it("validates a legacy global broadcast list before the null-publication return", () => {
    const validator = migration.match(
      /create or replace function public\.commerce_validate_newsletter_campaign\(\)[\s\S]*?\$\$;/,
    )?.[0];
    const listValidation = validator?.indexOf("if new.list_id is not null then") ?? -1;
    const legacyReturn =
      validator?.indexOf("if new.publication_id is null then\n      return new;") ?? -1;

    expect(listValidation).toBeGreaterThan(-1);
    expect(legacyReturn).toBeGreaterThan(-1);
    expect(listValidation).toBeLessThan(legacyReturn);
    expect(validator).toMatch(/list_row\.creator_id is distinct from new\.creator_id/);
    expect(validator).toMatch(/list_row\.publication_id is distinct from new\.publication_id/);
  });

  it("switches the owned active default in one locked transaction", () => {
    expect(migration).toMatch(
      /create or replace function public\.set_default_newsletter_publication\([\s\S]*security definer[\s\S]*pg_advisory_xact_lock[\s\S]*creator_id = p_creator_id[\s\S]*status <> 'archived'[\s\S]*for update[\s\S]*set is_default = false[\s\S]*set is_default = true/,
    );
    expect(migration).toContain(
      "grant execute on function public.set_default_newsletter_publication(uuid, uuid) to service_role;",
    );
  });

  it("archives an owned active non-default publication in one locked transaction", () => {
    expect(migration).toMatch(
      /create or replace function public\.archive_newsletter_publication\([\s\S]*security definer[\s\S]*pg_advisory_xact_lock[\s\S]*creator_id = p_creator_id[\s\S]*status <> 'archived'[\s\S]*for update[\s\S]*is_default[\s\S]*count\(\*\)[\s\S]*set status = 'archived'/,
    );
    expect(migration).toContain(
      "grant execute on function public.archive_newsletter_publication(uuid, uuid, text) to service_role;",
    );
  });

  it("unsubscribes a selected publication batch atomically before any suppression changes", () => {
    const batch = migration.match(
      /create or replace function public\.unsubscribe_public_newsletter_subscriptions\([\s\S]*?\$\$;/,
    )?.[0];
    expect(batch).toMatch(/security definer/);
    expect(batch).toMatch(
      /p_creator_id uuid[\s\S]*p_publication_id uuid[\s\S]*p_subscribers jsonb/,
    );
    expect(batch).toMatch(/creator_id = p_creator_id[\s\S]*for update/);
    expect(batch).toMatch(/raise exception 'Invalid newsletter subscriber batch'/);
    expect(batch).toMatch(
      /update public\.newsletter_subscriptions[\s\S]*update public\.email_outbox[\s\S]*update public\.audience_campaign_recipients/,
    );
    expect(migration).toContain(
      "grant execute on function public.unsubscribe_public_newsletter_subscriptions(uuid, uuid, jsonb) to service_role;",
    );
  });

  it("matches paid grants to audience contacts through normalized database identity", () => {
    const paidAccess = migration.match(
      /create or replace function public\.get_publication_audience_paid_access\([\s\S]*?\$\$;/,
    )?.[0];
    expect(paidAccess).toMatch(
      /p_creator_id uuid[\s\S]*p_publication_id uuid[\s\S]*p_contact_ids uuid\[\]/,
    );
    expect(paidAccess).toMatch(/publication\.paid_product_id/);
    expect(paidAccess).toMatch(/lower\(btrim\(access\.buyer_email\)\) = contact\.email_normalized/);
    expect(paidAccess).toMatch(/access\.status = 'active'/);
    expect(paidAccess).toMatch(/access\.expires_at is null or access\.expires_at > now\(\)/);
    expect(migration).toContain(
      "grant execute on function public.get_publication_audience_paid_access(uuid, uuid, uuid[]) to service_role;",
    );
  });
});
