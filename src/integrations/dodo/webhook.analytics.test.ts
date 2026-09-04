import { describe, expect, it } from "vitest";

import { buildBillingAnalyticsProperties, type DodoEvent } from "./webhook.server";

function event(type: string, data: DodoEvent["data"]): DodoEvent {
  return { type, timestamp: "2026-07-15T00:00:00.000Z", data };
}

describe("Dodo billing analytics", () => {
  it("maps a successful payment to positive minor-unit revenue", () => {
    const properties = buildBillingAnalyticsProperties(
      event("payment.succeeded", {
        payment_id: "pay_123",
        subscription_id: "sub_123",
        total_amount: 1900,
        currency: "usd",
        product_id: "pro_monthly",
      }),
      "webhook-payment-1",
    );

    expect(properties).toMatchObject({
      $insert_id: "dodo:webhook-payment-1",
      provider: "dodo",
      revenue: 1900,
      revenue_kind: "payment",
      currency: "USD",
      product: "pro_monthly",
      subscription_id: "sub_123",
      payment_id: "pay_123",
    });
  });

  it("maps a successful refund to negative minor-unit revenue", () => {
    const properties = buildBillingAnalyticsProperties(
      event("refund.succeeded", {
        refund_id: "ref_123",
        payment_id: "pay_123",
        amount: 500,
        currency: "USD",
      }),
      "webhook-refund-1",
    );

    expect(properties).toMatchObject({
      $insert_id: "dodo:webhook-refund-1",
      revenue: -500,
      revenue_kind: "refund",
      refund_id: "ref_123",
      payment_id: "pay_123",
    });
  });

  it("does not classify subscription lifecycle amounts as booked revenue", () => {
    const properties = buildBillingAnalyticsProperties(
      event("subscription.active", {
        subscription_id: "sub_123",
        recurring_pre_tax_amount: 1900,
        currency: "USD",
      }),
      "webhook-subscription-1",
    );

    expect(properties.amount).toBe(1900);
    expect(properties.revenue).toBeNull();
    expect(properties.revenue_kind).toBeNull();
  });
});
