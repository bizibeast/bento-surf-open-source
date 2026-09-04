import { describe, expect, it } from "vitest";
import migration from "../../supabase/migrations/20260903050007_commerce_order_newsletter_subscriptions.sql?raw";

describe("purchaser newsletter subscription migration", () => {
  it("subscribes paid buyers to the default publication without reviving an unsubscribe", () => {
    expect(migration).toContain("commerce_subscribe_paid_order_buyer");
    expect(migration).toContain("new.status <> 'paid'");
    expect(migration).toContain("publication.is_default desc");
    expect(migration).toContain("subscription.status = 'unsubscribed'");
    expect(migration).toContain("contact.marketing_status = 'unsubscribed'");
    expect(migration).toContain("source:purchase_checkout");
    expect(migration).toContain("exception when sqlstate 'P0001'");
    expect(migration).toContain("contact_row_id uuid");
    expect(migration).not.toContain("contact_id uuid;");
  });

  it("backfills eligible paid buyers and keeps the trigger private", () => {
    expect(migration).toContain("backfill_ranked_buyers");
    expect(migration).toContain("row_number() over");
    expect(migration).toContain("commerce_subscribe_paid_order_buyer_for_order");
    expect(migration).not.toContain("set status = status");
    expect(migration).toContain(
      "revoke all on function public.commerce_subscribe_paid_order_buyer()",
    );
    expect(migration).toContain("commerce_orders_subscribe_newsletter");
  });
});
