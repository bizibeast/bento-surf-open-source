import { describe, expect, it } from "vitest";
import migration from "../../supabase/migrations/20260831175936_newsletter_preferences_and_terminal_events.sql?raw";

describe("newsletter preference and terminal-event migration", () => {
  it("keeps publication unsubscribe atomic and service-role only", () => {
    expect(migration).toContain("unsubscribe_public_newsletter_subscription");
    expect(migration).toContain("set search_path = ''");
    expect(migration).toMatch(/publication_id\s*=\s*p_publication_id/);
    expect(migration).toMatch(/subscription_id|id\s*=\s*p_subscription_id/);
    expect(migration).toContain("email_enabled = false");
    expect(migration).toContain("status = 'unsubscribed'");
    expect(migration).toMatch(/update public\.email_outbox[\s\S]*status = 'suppressed'/);
    expect(migration).not.toContain("audience_consent_events");
    expect(migration).not.toContain("commerce_access_grants");
    expect(migration).toContain(
      "grant execute on function public.unsubscribe_public_newsletter_subscription(uuid, uuid, text) to service_role",
    );
  });

  it("replaces delivery functions with locked, qualified contracts", () => {
    const claim = migration.slice(migration.indexOf("function public.claim_email_outbox"));
    expect(claim).toContain("set search_path = ''");
    expect(claim).toContain("from public.email_outbox");
    expect(claim).toContain("update public.email_outbox");
    expect(migration).toContain("p_subscription_id uuid");
    expect(migration).toMatch(/recipient\.status = 'sent'[\s\S]*'failed'[\s\S]*'suppressed'/);
  });

  it("stores a required broadcast postal address and structured content", () => {
    expect(migration).toContain("sender_postal_address");
    expect(migration).toContain("commerce_validate_newsletter_campaign");
    const validator = migration.slice(
      migration.indexOf("function public.commerce_validate_newsletter_campaign"),
      migration.indexOf("function public.unsubscribe_public_newsletter_subscription"),
    );
    expect(validator).not.toContain("new.content <> '[]'::jsonb");
  });
});
