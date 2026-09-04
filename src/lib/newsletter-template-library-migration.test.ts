import { describe, expect, it } from "vitest";
import migration from "../../supabase/migrations/20260903120000_newsletter_template_expansion.sql?raw";
import { NEWSLETTER_TEMPLATE_IDS } from "./newsletter-templates";

describe("newsletter template library migration", () => {
  it("allows every shipped template for publications and posts", () => {
    for (const templateId of NEWSLETTER_TEMPLATE_IDS) {
      expect(migration.match(new RegExp(`'${templateId}'`, "g"))).toHaveLength(2);
    }
    expect(migration).toContain("newsletter_publications_default_template_id_check");
    expect(migration).toContain("audience_campaigns_template_id_check");
  });
});
