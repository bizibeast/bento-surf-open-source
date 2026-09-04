import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260718120000_polar_creator_payments.sql",
);
const checkoutRecoveryMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260729124500_checkout_recovery_audience.sql",
);

describe("creator payment security migration", () => {
  it("keeps provider secrets and payment session tokens service-role only", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("revoke all on public.creator_payment_accounts from anon, authenticated");
    expect(sql).not.toContain("grant select on public.commerce_payment_sessions to authenticated");
    expect(sql).toContain("grant all on public.commerce_payment_sessions to service_role");
    expect(sql).not.toMatch(/grant select\s*\([^)]*ciphertext/s);
  });

  it("relies on the existing paid-order trigger for exactly one sales increment", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    const fulfillment = sql.slice(
      sql.indexOf("create or replace function public.fulfill_provider_commerce_order"),
    );
    expect(fulfillment).not.toContain("set sales_count = sales_count + 1");
  });

  it("restricts provider fulfillment to the service role", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  });

  it("tracks checkout lifecycle without copying sensitive session metadata", async () => {
    const sql = (await readFile(checkoutRecoveryMigrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("commerce_payment_sessions_sync_audience");
    expect(sql).toContain("'checkout_' || new.status");
    expect(sql).toContain("where status = 'pending'");
    expect(sql).toContain("set status = 'expired'");
    expect(sql).not.toContain("'metadata', new.metadata");
    expect(sql).not.toContain("new.metadata");
  });

  it("keeps the checkout audience trigger function inaccessible to browser roles", async () => {
    const sql = (await readFile(checkoutRecoveryMigrationPath, "utf8")).toLowerCase();
    expect(sql).toContain(
      "revoke all on function public.commerce_sync_payment_session_to_audience()",
    );
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  });
});
