import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ apply: vi.fn() }));
vi.mock("@/lib/commerce-subscription-lifecycle.server", () => ({
  applyCommerceSubscriptionLifecycle: mocks.apply,
}));
import { processStripeSubscriptionLifecycle } from "./webhook.server";
beforeEach(() => vi.clearAllMocks());
describe("Stripe subscription webhook periods", () => {
  it("uses the paid subscription line's service period instead of the invoice's prior usage period", async () => {
    await processStripeSubscriptionLifecycle(
      {
        id: "evt-paid",
        type: "invoice.paid",
        data: {
          object: {
            id: "invoice",
            subscription: "subscription",
            period_start: 1000,
            period_end: 2000,
            lines: {
              data: [
                { type: "invoiceitem", period: { start: 2000, end: 9000 } },
                {
                  type: "subscription",
                  subscription: "subscription",
                  period: { start: 2000, end: 3000 },
                },
              ],
            },
          },
        },
      },
      "account",
    );
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        providerSubscriptionId: "subscription",
        currentPeriodStart: 2000000,
        currentPeriodEnd: 3000000,
        state: "renewed",
      }),
    );
  });
  it("supports Basil invoice subscription parents", async () => {
    await processStripeSubscriptionLifecycle(
      {
        id: "evt-paid",
        type: "invoice.paid",
        data: {
          object: {
            id: "invoice",
            parent: { subscription_details: { subscription: "subscription" } },
            lines: {
              data: [
                {
                  parent: { subscription_item_details: { subscription: "subscription" } },
                  period: { start: 2000, end: 3000 },
                },
              ],
            },
          },
        },
      },
      "account",
    );
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        providerSubscriptionId: "subscription",
        currentPeriodEnd: 3000000,
      }),
    );
  });
  it("uses Basil subscription item periods for scheduled cancellation", async () => {
    await processStripeSubscriptionLifecycle(
      {
        id: "evt-cancel",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "subscription",
            status: "active",
            cancel_at_period_end: true,
            items: { data: [{ current_period_start: 2000, current_period_end: 3000 }] },
          },
        },
      },
      "account",
    );
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "cancel_at_period_end",
        currentPeriodStart: 2000000,
        currentPeriodEnd: 3000000,
      }),
    );
  });
  it("does not advance the paid access period on invoice failure", async () => {
    await processStripeSubscriptionLifecycle(
      {
        id: "evt-failed",
        type: "invoice.payment_failed",
        data: {
          object: {
            id: "invoice",
            subscription: "subscription",
            period_start: 2000,
            period_end: 3000,
          },
        },
      },
      "account",
    );
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "past_due",
        currentPeriodStart: null,
        currentPeriodEnd: null,
      }),
    );
  });
  it("revokes paused subscriptions and gives unpaid status precedence over scheduled cancellation", async () => {
    await processStripeSubscriptionLifecycle(
      {
        id: "evt-unpaid",
        type: "customer.subscription.updated",
        data: { object: { id: "subscription", status: "unpaid", cancel_at_period_end: true } },
      },
      "account",
    );
    expect(mocks.apply).toHaveBeenLastCalledWith(expect.objectContaining({ state: "past_due" }));
    await processStripeSubscriptionLifecycle(
      {
        id: "evt-paused",
        type: "customer.subscription.updated",
        data: { object: { id: "subscription", status: "paused" } },
      },
      "account",
    );
    expect(mocks.apply).toHaveBeenLastCalledWith(expect.objectContaining({ state: "revoked" }));
  });
  it.each(["trialing", "incomplete", "pending", "unknown"])(
    "ignores %s updates before they can grant paid access",
    async (status) => {
      await processStripeSubscriptionLifecycle(
        {
          id: "evt-pending",
          type: "customer.subscription.updated",
          data: { object: { id: "subscription", status } },
        },
        "account",
      );
      expect(mocks.apply).not.toHaveBeenCalled();
    },
  );
});
