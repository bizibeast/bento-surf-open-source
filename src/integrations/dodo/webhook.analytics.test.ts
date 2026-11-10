import { describe, expect, it } from "vitest";

import {
  billingAnalyticsDistinctId,
  buildBillingAnalyticsProperties,
  type DodoEvent,
} from "./webhook.server";

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

  it("marks card-optional trial activations as trials", () => {
    const trial = buildBillingAnalyticsProperties(
      event("subscription.active", {
        subscription_id: "sub_trial",
        status: "active",
        trial_period_days: 7,
        metadata: { trial_checkout_key: "key_1" },
      }),
      "webhook-trial-1",
    );
    const paid = buildBillingAnalyticsProperties(
      event("subscription.active", { subscription_id: "sub_paid", trial_period_days: 0 }),
      "webhook-paid-1",
    );

    expect(trial.trial).toBe(true);
    expect(trial.billing_status).toBe("active");
    expect(paid.trial).toBe(false);
  });

  it("sends only a test-account boolean, never the customer email", () => {
    const test = buildBillingAnalyticsProperties(
      event("subscription.active", {
        subscription_id: "sub_test",
        customer: { email: "owner+release@qa.example.test" },
      }),
      "webhook-test-1",
    );
    const real = buildBillingAnalyticsProperties(
      event("subscription.active", {
        subscription_id: "sub_real",
        customer: { email: "creator@gmail.com" },
      }),
      "webhook-real-1",
    );
    const unknown = buildBillingAnalyticsProperties(
      event("subscription.active", { subscription_id: "sub_unknown" }),
      "webhook-unknown-1",
    );

    expect(test.is_test_account).toBe(true);
    expect(real.is_test_account).toBe(false);
    expect(unknown.is_test_account).toBeUndefined();
    expect(JSON.stringify([test, real])).not.toContain("@");
  });

  it("attributes billing events to the checkout owner when known", () => {
    const withOwner = event("subscription.active", {
      metadata: { workspace_id: "workspace-1", auth_user_id: "user-1" },
    });
    const personal = event("subscription.active", { metadata: { workspace_id: "user-2" } });

    expect(billingAnalyticsDistinctId(withOwner, "workspace-1")).toBe("user-1");
    expect(billingAnalyticsDistinctId(personal, "user-2")).toBe("user-2");
    expect(billingAnalyticsDistinctId(personal, null)).toBeNull();
  });
});
