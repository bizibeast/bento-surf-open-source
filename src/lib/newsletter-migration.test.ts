import { describe, expect, it } from "vitest";
import migration from "../../supabase/migrations/20260831034413_newsletter_foundation.sql?raw";

describe("newsletter foundation migration", () => {
  it("creates one publication per creator and one subscription per contact", () => {
    expect(migration).toContain("create table public.newsletter_publications");
    expect(migration).toContain("create table public.newsletter_subscriptions");
    expect(migration).toMatch(/unique\s*\(creator_id\)/i);
    expect(migration).toMatch(/unique\s*\(publication_id,\s*contact_id\)/i);
    expect(migration).toContain("'pending', 'subscribed', 'unsubscribed'");
  });

  it("extends campaigns without creating a second issue table", () => {
    expect(migration).toContain("alter table public.audience_campaigns");
    expect(migration).toContain("kind text not null default 'broadcast'");
    expect(migration).toContain(
      "publication_id uuid references public.newsletter_publications(id)",
    );
    expect(migration).toContain("content jsonb not null default '[]'::jsonb");
    expect(migration).toContain("web_visibility text not null default 'private'");
    expect(migration).toContain("audience_campaigns_body_markdown_check");
    expect(migration).toContain("kind = 'newsletter' and length(body_markdown) <= 100000");
    expect(migration).toContain("create unique index audience_campaigns_publication_slug_unique");
    expect(migration).not.toContain("create table public.newsletter_issues");
  });

  it("validates campaign and paid-product ownership", () => {
    expect(migration).toContain("commerce_validate_newsletter_publication");
    expect(migration).toContain("commerce_validate_newsletter_campaign");
    expect(migration).toContain("publication_row.creator_id is distinct from new.creator_id");
    expect(migration).toContain("product_row.creator_id is distinct from new.creator_id");
    expect(migration).toContain("new.kind = 'broadcast'");
  });

  it("runs every relationship trigger with an empty search path", () => {
    expect(migration).not.toContain("set search_path = public");
    expect(migration.match(/set search_path = ''/g)).toHaveLength(3);
  });

  it("rejects cross-creator publication contacts at the database boundary", () => {
    expect(migration).toContain("commerce_validate_newsletter_subscription");
    expect(migration).toContain(
      "publication_row.creator_id is distinct from contact_row.creator_id",
    );
    expect(migration).toContain("newsletter_subscriptions_validate_relationship");
    expect(migration).toContain(
      "revoke all on function public.commerce_validate_newsletter_subscription()",
    );
  });

  it("keeps browser writes revoked and service-role access explicit", () => {
    for (const table of ["newsletter_publications", "newsletter_subscriptions"]) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
    }
    expect(migration).toContain("from anon, authenticated");
    expect(migration).toContain("to service_role");
    expect(migration).toContain(
      "alter type public.commerce_product_kind add value if not exists 'newsletter'",
    );
  });
});
