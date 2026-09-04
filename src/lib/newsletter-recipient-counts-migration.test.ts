import { expect, it } from "vitest";
import migration from "../../supabase/migrations/20260902080000_newsletter_recipient_counts.sql?raw";

it("counts only publication-enabled subscribed contacts and scoped list members", () => {
  expect(migration).toContain("get_newsletter_publication_recipient_counts");
  expect(migration).toContain("subscription.status = 'subscribed'");
  expect(migration).toContain("subscription.email_enabled");
  expect(migration).toContain("contact.marketing_status = 'subscribed'");
  expect(migration).toContain("audience_list.publication_id = p_publication_id");
});
