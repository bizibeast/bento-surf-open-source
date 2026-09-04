import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260729233000_webinar_registration_lifecycle.sql",
);
const privilegeMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260729234500_webinar_registration_privileges.sql",
);
const optimizationMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260730000500_optimize_webinar_registration_access.sql",
);
const storeHardeningMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260730170000_store_performance_hardening.sql",
);

describe("webinar registration lifecycle migration", () => {
  it("creates one durable registration per access grant", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("create table if not exists public.commerce_webinar_registrations");
    expect(sql).toContain("access_grant_id uuid not null unique");
    expect(sql).toContain("on conflict (access_grant_id) do update");
    expect(sql).toContain("commerce_access_grants_sync_webinar_registration");
  });

  it("keeps immutable event details server-controlled", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("revoke all on public.commerce_webinar_registrations from anon");
    expect(sql).toContain("revoke all on public.commerce_webinar_registrations from authenticated");
    expect(sql).toContain(
      "grant update (status, attended_at)\n  on public.commerce_webinar_registrations to authenticated",
    );
    expect(sql).not.toContain(
      "grant select, update on public.commerce_webinar_registrations to authenticated",
    );
    expect(sql).toContain("grant all on public.commerce_webinar_registrations to service_role");
  });

  it("repairs inherited Supabase default privileges on existing deployments", async () => {
    const sql = (await readFile(privilegeMigrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("revoke all on public.commerce_webinar_registrations from authenticated");
    expect(sql).toContain("grant select on public.commerce_webinar_registrations to authenticated");
    expect(sql).toContain("grant update (status, attended_at)");
  });

  it("limits creator visibility and mutation to owned registrations", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("commerce_webinar_registrations_creator_read");
    expect(sql).toContain("commerce_webinar_registrations_creator_update");
    expect(sql.match(/auth\.uid\(\) = creator_id/g)).toHaveLength(3);
  });

  it("indexes order lookups and evaluates the creator identity once per query", async () => {
    const sql = (await readFile(optimizationMigrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("commerce_webinar_registrations_order_idx");
    expect(sql).toContain("on public.commerce_webinar_registrations(order_id)");
    expect(sql.match(/\(select auth\.uid\(\)\) = creator_id/g)).toHaveLength(3);
  });

  it("atomically keeps existing attendees synchronized when a webinar is rescheduled", async () => {
    const sql = (await readFile(storeHardeningMigrationPath, "utf8")).toLowerCase();
    expect(sql).toContain(
      "create or replace function public.sync_webinar_registrations_from_product",
    );
    expect(sql).toContain("commerce_products_sync_webinar_registrations");
    expect(sql).toContain("after update of settings on public.commerce_products");
    expect(sql).toContain("reminder_24h_sent_at = case");
    expect(sql).toContain("replay_ready_notified_at = case");
  });
});
