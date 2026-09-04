import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const billingSource = resolve(process.cwd(), "src/lib/billing.functions.ts");
const settingsSource = resolve(process.cwd(), "src/routes/_authenticated/settings.tsx");
const migrationSource = resolve(
  process.cwd(),
  "supabase/migrations/20260802153000_subscription_retention_offers.sql",
);

describe("subscription retention and plan controls", () => {
  it("persists the one-time retention-offer state", async () => {
    const migration = await readFile(migrationSource, "utf8");

    expect(migration).toContain("retention_offer_redeemed_at");
    expect(migration).toContain("retention_offer_expires_at");
    expect(migration).toContain("retention_offer_reason");
  });

  it("claims the retention offer atomically and extends the provider billing date", async () => {
    const source = await readFile(billingSource, "utf8");

    expect(source).toContain('.is("retention_offer_redeemed_at", null)');
    expect(source).toContain("next_billing_date: extendedUntil");
    expect(source).toContain("cancellation_feedback: cancellation.reason");
    expect(source).toContain("cancellation_comment: cancellation.details || null");
  });

  it("shows every plan and keeps cancellation transparent", async () => {
    const source = await readFile(settingsSource, "utf8");

    expect(source).toContain("PLAN_ORDER.map");
    expect(source).toContain("Apply 3 free months");
    expect(source).toContain("No thanks, continue cancelling");
    expect(source).toContain('setStep("loss")');
    expect(source).toContain("Here is what you will miss");
    expect(source).toContain("Do you really want to cancel?");
    expect(source).toContain("Yes, cancel my subscription");
    expect(source).toContain("retentionResetTimer");
    expect(source).toContain("window.clearTimeout(retentionResetTimer)");
    expect(source).toContain("complimentaryAccessExpiresAt");
  });
});
