import migration from "../../supabase/migrations/20260730143000_commerce_growth_foundation.sql?raw";
import indexesMigration from "../../supabase/migrations/20260730150000_commerce_growth_indexes.sql?raw";
import hardeningMigration from "../../supabase/migrations/20260730170000_store_performance_hardening.sql?raw";
import { describe, expect, it } from "vitest";

describe("commerce growth foundation migration", () => {
  it("creates the complete discount, bump, consent, list, and campaign model", () => {
    for (const table of [
      "commerce_discount_codes",
      "commerce_order_bumps",
      "commerce_discount_redemptions",
      "commerce_order_items",
      "audience_consent_events",
      "audience_lists",
      "audience_list_members",
      "audience_campaigns",
      "audience_campaign_recipients",
    ]) {
      expect(migration).toContain(`public.${table}`);
      expect(migration).toContain(`alter table public.${table} enable row level security`);
    }
  });

  it("keeps all entitlement-gated mutations behind server-side plan checks", () => {
    expect(migration).toContain("from anon, authenticated");
    expect(migration).not.toMatch(
      /grant\s+(?:select,\s*)?insert(?:,\s*update)?(?:,\s*delete)?\s+on\s+public\.(?:commerce_discount_codes|commerce_order_bumps|audience_lists|audience_campaigns)\s+to\s+authenticated/i,
    );
    expect(migration).toContain(
      "grant execute on function public.reserve_commerce_discount(uuid, uuid, text, integer)",
    );
    expect(migration).toContain("to service_role");
  });

  it("reserves redemptions atomically and records immutable checkout line items", () => {
    expect(migration).toContain("for update");
    expect(migration).toContain("max_redemptions_per_email");
    expect(migration).toContain("unique nulls not distinct (order_id, item_role, product_id)");
    expect(migration).toContain("commerce_orders_finalize_growth_attribution");
    expect(migration).toContain("on conflict do nothing");
  });

  it("uses append-only consent events to drive the current contact status", () => {
    expect(migration).toContain("audience_consent_events_apply");
    expect(migration).toContain("marketing_status = new.status");
    expect(migration).toContain("Audience contact does not belong to creator");
  });

  it("covers every foreign key added by the growth schema", () => {
    for (const index of [
      "commerce_order_bumps_bump_product_idx",
      "audience_campaigns_list_idx",
      "audience_campaign_recipients_contact_idx",
      "audience_campaign_recipients_outbox_idx",
    ]) {
      expect(indexesMigration).toContain(index);
    }
  });

  it("releases a reserved discount immediately when checkout terminates unpaid", () => {
    expect(hardeningMigration).toContain("release_terminal_commerce_discount_reservation");
    expect(hardeningMigration).toContain("new.status in ('failed', 'expired', 'canceled')");
    expect(hardeningMigration).toContain("set status = 'released'");
    expect(hardeningMigration).toContain(
      "after update of status on public.commerce_payment_sessions",
    );
  });

  it("enforces creator, currency, pricing, and publication rules on growth relationships", () => {
    const normalizedMigration = hardeningMigration.replace(/\s+/g, " ");

    expect(hardeningMigration).toContain("commerce_validate_growth_relationships");
    expect(hardeningMigration).toContain("commerce_discount_codes_validate_relationships");
    expect(hardeningMigration).toContain("commerce_order_bumps_validate_relationships");
    expect(normalizedMigration).toContain(
      "before insert or update of creator_id, product_id, discount_type, discount_value, currency, is_active",
    );
    expect(normalizedMigration).toContain(
      "before insert or update of creator_id, primary_product_id, bump_product_id, is_active",
    );
  });

  it("fulfills paid provider checkouts from the immutable payment-session snapshot", () => {
    expect(hardeningMigration).toContain(
      "create or replace function public.fulfill_provider_commerce_order",
    );
    expect(hardeningMigration).toContain("session_row.buyer_email");
    expect(hardeningMigration).toContain("session_row.gross_amount");
    expect(hardeningMigration).toContain("session_row.currency");
    expect(hardeningMigration).toContain("session_row.connection_id");
    expect(hardeningMigration).toContain("session_row.status in ('failed', 'expired', 'canceled')");
    expect(hardeningMigration).not.toContain("product_row.currency <> lower(trim(p_currency))");
    expect(hardeningMigration).toContain("created_new_order boolean := false");
    expect(hardeningMigration).toContain("'already_processed', not created_new_order");
  });

  it("protects products referenced by approved as well as pending payment sessions", () => {
    expect(hardeningMigration).toContain("status in ('pending', 'approved')");
    expect(hardeningMigration).toContain("or bump_product_id = product_row.id");
    expect(hardeningMigration).toContain("from public.commerce_order_items");
    expect(hardeningMigration).toContain("update public.commerce_products");
    expect(hardeningMigration).toContain("set status = 'archived'");
  });

  it("reserves finite primary and bump inventory before a buyer can pay", () => {
    expect(hardeningMigration).toContain("guard_commerce_checkout_inventory");
    expect(hardeningMigration).toContain(
      "before insert or update of product_id, bump_product_id, status, expires_at",
    );
    expect(hardeningMigration).toContain("order by id");
    expect(hardeningMigration).toContain("session_row.expires_at > now()");
    expect(hardeningMigration).toContain("or session_row.bump_product_id = new.product_id");
    expect(
      hardeningMigration.match(/session_row\.product_id = new\.bump_product_id/g),
    ).toHaveLength(1);
    expect(
      hardeningMigration.match(/session_row\.bump_product_id = new\.bump_product_id/g),
    ).toHaveLength(1);
    expect(hardeningMigration).toContain(
      "product_row.sales_count + reserved_count >= product_row.inventory_limit",
    );
  });

  it("does not restore disputed or terminal subscription access", () => {
    expect(hardeningMigration).toContain("guard_commerce_access_restoration");
    expect(hardeningMigration).toContain("new.dispute_suspended_at is not null");
    expect(hardeningMigration).toContain("subscription_row.status = 'revoked'");
    expect(hardeningMigration).toContain("subscription_row.status = 'expired'");
    expect(hardeningMigration).toContain("before insert or update of status, dispute_suspended_at");
  });

  it("rejects stale or mismatched dispute events before they can restore access", () => {
    expect(hardeningMigration).toContain(
      "create or replace function public.apply_commerce_dispute_guarded",
    );
    expect(hardeningMigration).toContain(
      "order_row.dispute_id is distinct from normalized_dispute_id",
    );
    expect(hardeningMigration).toContain("event_time < latest_dispute_time");
    expect(hardeningMigration).toContain("'state_applied', false");
  });

  it("keeps subscription lifecycle active after refund or dispute order transitions", () => {
    expect(hardeningMigration).toContain(
      "create or replace function public.apply_commerce_subscription_lifecycle_guarded",
    );
    expect(hardeningMigration).toContain(
      "status in ('paid', 'partially_refunded', 'refunded', 'disputed')",
    );
    expect(hardeningMigration).toContain(
      "coalesce(base_result->>'reason', '') <> 'paid_order_not_found'",
    );
  });

  it("atomically leases webhook events so concurrent deliveries cannot double-process", () => {
    expect(hardeningMigration).toContain(
      "create or replace function public.claim_commerce_webhook_event",
    );
    expect(hardeningMigration).toContain(
      "status in ('pending', 'processing', 'processed', 'failed')",
    );
    expect(hardeningMigration).toContain(
      "status = 'processing' and updated_at < now() - interval '5 minutes'",
    );
    expect(hardeningMigration).toContain("return 'busy'");
  });

  it("makes free hosted claims idempotent without invalidating earlier access links", () => {
    expect(hardeningMigration).toContain(
      "create or replace function public.claim_free_commerce_offer",
    );
    expect(hardeningMigration).toContain("provider_checkout_id = p_provider_checkout_id");
    expect(hardeningMigration).toContain("public.commerce_customer_access_tokens");
    expect(hardeningMigration).toContain("'created_new_order', false");
    expect(hardeningMigration).toContain("'created_new_order', true");
    expect(hardeningMigration).toContain(
      "grant execute on function public.claim_free_commerce_offer",
    );
  });
});
