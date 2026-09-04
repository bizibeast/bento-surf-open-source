import { describe, expect, it } from "vitest";
import migration from "../../supabase/migrations/20260831060319_newsletter_subscription_confirmation.sql?raw";

describe("newsletter subscription confirmation migration", () => {
  it("keeps capture and confirmation atomic and service-role only", () => {
    expect(migration).toContain("capture_public_newsletter_subscription");
    expect(migration).toContain("confirm_public_newsletter_subscription");
    expect(migration.match(/set search_path = ''/g)).toHaveLength(2);
    expect(migration).toContain("security definer");
    expect(migration).toContain("returns jsonb");
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toContain("to service_role");
  });

  it("commits pending state and its nonce-keyed outbox row atomically", () => {
    expect(migration).toContain("add column if not exists confirmation_nonce uuid");
    expect(migration).toContain("insert into public.email_outbox");
    expect(migration).toContain(
      "'newsletter-confirmation:' || subscription_row.id || ':' || subscription_row.confirmation_nonce",
    );
    expect(migration).toContain("on conflict (event_key) do nothing");
    expect(migration).toContain("'confirmationNonce', subscription_row.confirmation_nonce");
  });

  it("validates block, publication, contact, and creator ownership", () => {
    expect(migration).toContain("block_row.type <> 'email_capture'");
    expect(migration).toContain("newsletterPublicationId");
    expect(migration).toContain("publication_row.status <> 'published'");
    expect(migration).toContain("publication_row.creator_id <> block_row.user_id");
    expect(migration).toContain("contact_row.creator_id <> publication_row.creator_id");
  });

  it("returns the confirmation transition and confirms idempotently", () => {
    expect(migration).toContain("'confirmation_required', true");
    expect(migration).toContain("'confirmation_required', false");
    expect(migration).toContain("subscription_row.status = 'pending'");
    expect(migration).toContain("subscription_row.status = 'subscribed'");
    expect(migration).toContain("'newsletter_confirmation'");
  });

  it("reuses pending nonces and rotates the nonce for resubscribe", () => {
    expect(migration).toContain("confirmation_nonce, consent_proof");
    expect(migration).toContain("gen_random_uuid()");
    expect(migration).toMatch(
      /status = 'pending',[\s\S]*confirmation_nonce = gen_random_uuid\(\)[\s\S]*status = 'pending'[\s\S]*confirmation_nonce is null/,
    );
  });

  it("confirms immutable publication and subscription IDs without block lookup", () => {
    const confirm = migration.slice(migration.indexOf("confirm_public_newsletter_subscription"));
    expect(confirm).toContain("p_publication_id uuid");
    expect(confirm).toContain("p_subscription_id uuid");
    expect(confirm).toContain("p_confirmation_nonce uuid");
    expect(confirm).not.toContain("p_block_id uuid");
    expect(confirm).not.toContain("newsletterPublicationId");
    expect(confirm).toContain("confirmation_nonce = p_confirmation_nonce");
    expect(confirm).toContain("confirmation_nonce = null");
    expect(migration).toContain("confirm_public_newsletter_subscription(uuid, uuid, uuid, text)");
    expect(migration).not.toContain("p_confirmation_url");
  });

  it("leaves the legacy single-opt-in capture RPC intact", () => {
    expect(migration).not.toContain("drop function public.capture_public_email_audience");
  });
});
