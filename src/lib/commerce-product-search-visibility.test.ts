import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { productDraftSchema, resolveProductNoindex } from "./commerce.functions";

const migration = readFileSync(
  "supabase/migrations/20260827131552_add_product_search_visibility.sql",
  "utf8",
);

const draft = {
  kind: "digital_product" as const,
  title: "Creator guide",
  subtitle: "",
  description: "A useful guide.",
  cover_url: null,
  pricing_type: "one_time" as const,
  price_amount: 1_900,
  currency: "usd",
  billing_interval: null,
  cta_label: "Buy now",
  settings: {},
  inventory_limit: null,
};

describe("commerce product search visibility", () => {
  it("keeps an omitted preference distinguishable for safe updates", () => {
    expect(productDraftSchema.parse(draft).noindex).toBeUndefined();
  });

  it("preserves an existing product draft that is visible in search", () => {
    expect(productDraftSchema.parse({ ...draft, noindex: false }).noindex).toBe(false);
  });

  it("defaults new products to hidden without changing an existing preference", () => {
    expect(resolveProductNoindex(undefined)).toBe(true);
    expect(resolveProductNoindex(undefined, false)).toBe(false);
    expect(resolveProductNoindex(false, true)).toBe(false);
    expect(resolveProductNoindex(true, false)).toBe(true);
  });

  it("keeps legacy drafts hidden and grants owners access to the new column", () => {
    expect(migration).toContain("when status = 'published' then false");
    expect(migration).toContain("grant insert (noindex)");
    expect(migration).toContain("grant update (noindex)");
    expect(migration).toContain("where onboarded = false");
    expect(migration).toContain("with (security_invoker = true)");
    expect(migration).toContain(
      "revoke all on public.sitemap_profiles, public.sitemap_products from public, anon, authenticated",
    );
    expect(migration).not.toContain("'_nachiketmore'");
    expect(migration).toContain("select max(root_block.updated_at)");
  });
});
