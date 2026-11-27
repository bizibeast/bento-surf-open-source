/* eslint-disable @typescript-eslint/no-explicit-any -- Verified provider snapshots meet immutable session data here. */
import {
  applyCommerceSubscriptionLifecycle,
  type CommerceSubscriptionState,
} from "@/lib/commerce-subscription-lifecycle.server";
import type { RazorpayPaymentAccount } from "./client.server";
import type { RazorpayPayment } from "./checkout.functions";

export type RazorpaySubscription = {
  id: string;
  plan_id: string;
  status: string;
  quantity: number;
  paid_count: number;
  current_start: number | null;
  current_end: number | null;
  ended_at?: number | null;
  notes: Record<string, string>;
};

export type RazorpayInvoice = {
  id: string;
  subscription_id: string;
  payment_id: string;
  order_id: string;
  status: string;
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  billing_start: number | null;
  billing_end: number | null;
  line_items: Array<{ type: string; amount: number; quantity: number }>;
};

// Standard Checkout currently bounds mandates at ten years even though the
// Create Subscription API documents a longer maximum. Never change frequency
// to approximate an unsupported daily plan (daily interval has a minimum of 7).
export function razorpayRecurringPlan(interval: string | null) {
  if (interval === "week") return { period: "weekly", interval: 1, totalCount: 520 };
  if (interval === "month") return { period: "monthly", interval: 1, totalCount: 120 };
  if (interval === "year") return { period: "yearly", interval: 1, totalCount: 10 };
  throw new Error(
    "Razorpay subscriptions support weekly, monthly, or yearly billing. Daily billing is unavailable.",
  );
}

export function isRazorpaySubscriptionSession(session: any) {
  return session.metadata?.pricing_type === "subscription";
}

export function assertRazorpaySubscriptionBinding(
  account: RazorpayPaymentAccount,
  session: any,
  subscription: RazorpaySubscription,
) {
  if (
    session.provider !== "razorpay" ||
    session.connection_id !== account.id ||
    session.creator_id !== account.creator_id ||
    !isRazorpaySubscriptionSession(session) ||
    subscription.id !== session.provider_checkout_id ||
    !/^sub_[A-Za-z0-9]+$/.test(subscription.id)
  ) {
    throw new Error("Razorpay subscription does not match this Bento connection and checkout.");
  }
  if (
    !session.metadata?.razorpay_plan_id ||
    subscription.plan_id !== session.metadata.razorpay_plan_id ||
    subscription.quantity !== 1 ||
    subscription.notes?.bento_session_id !== session.id ||
    subscription.notes?.bento_product_id !== session.product_id ||
    subscription.notes?.bento_creator_id !== session.creator_id
  ) {
    throw new Error("Razorpay subscription plan does not match this Bento checkout.");
  }
}

export function razorpayTimestamp(value: number | null | undefined) {
  if (!value || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function assertRazorpaySubscriptionInvoice(
  session: any,
  subscription: RazorpaySubscription,
  payment: RazorpayPayment,
  invoice: RazorpayInvoice,
) {
  if (
    !Number.isInteger(subscription.paid_count) ||
    subscription.paid_count < 1 ||
    !["active", "pending", "halted", "paused", "completed", "cancelled"].includes(
      subscription.status,
    )
  ) {
    throw new Error(
      "Razorpay has authenticated the mandate but has not billed this subscription yet.",
    );
  }
  if (
    !payment.invoice_id ||
    invoice.id !== payment.invoice_id ||
    invoice.subscription_id !== subscription.id ||
    invoice.payment_id !== payment.id ||
    invoice.order_id !== payment.order_id ||
    !/^order_[A-Za-z0-9]+$/.test(invoice.order_id)
  ) {
    throw new Error("Razorpay invoice does not match this subscription payment.");
  }
  if (
    invoice.status !== "paid" ||
    invoice.amount_due !== 0 ||
    invoice.amount !== session.gross_amount ||
    invoice.amount_paid !== session.gross_amount ||
    invoice.currency.toLowerCase() !== String(session.currency).toLowerCase()
  ) {
    throw new Error("Razorpay subscription invoice is not fully paid at the checkout amount.");
  }
  const planLines = invoice.line_items?.filter((line) => line.type === "plan") || [];
  if (
    planLines.length !== 1 ||
    planLines[0].amount !== session.gross_amount ||
    planLines[0].quantity !== 1 ||
    !razorpayTimestamp(invoice.billing_start) ||
    !razorpayTimestamp(invoice.billing_end) ||
    Number(invoice.billing_end) <= Number(invoice.billing_start)
  ) {
    throw new Error("Razorpay payment is missing its billed subscription plan and period.");
  }
}

export function razorpaySubscriptionState(
  subscription: RazorpaySubscription,
): CommerceSubscriptionState | null {
  if (["pending", "halted", "paused"].includes(subscription.status)) return "past_due";
  if (subscription.status === "cancelled") return "revoked";
  if (subscription.status === "expired") return "expired";
  // Razorpay completes when its final invoice is generated. Retain the final
  // paid period instead of revoking access as soon as that invoice is charged.
  if (subscription.status === "completed") return "cancel_at_period_end";
  return null;
}

export async function applyRazorpaySubscriptionSnapshot(input: {
  account: RazorpayPaymentAccount;
  subscription: RazorpaySubscription;
  eventId: string;
  invoice?: RazorpayInvoice;
  fundingOrderId?: string;
}) {
  const state = razorpaySubscriptionState(input.subscription);
  // Authentication, activation and resume alone cannot extend paid access.
  if (!state && !input.invoice) return null;
  const snapshot = {
    provider: "razorpay",
    providerAccountId: input.account.provider_account_id,
    providerSubscriptionId: input.subscription.id,
    currentPeriodStart: razorpayTimestamp(
      input.invoice?.billing_start ?? input.subscription.current_start,
    ),
    currentPeriodEnd: razorpayTimestamp(
      input.invoice?.billing_end ?? input.subscription.current_end,
    ),
    metadata: {
      razorpay_status: input.subscription.status,
      razorpay_paid_count: input.subscription.paid_count,
    },
  };
  let paidPeriod = null;
  if (input.invoice) {
    // The shared guard advances the paid deadline only for a verified renewal.
    // Record the invoice before a final completed/cancelled/pending snapshot so
    // the customer's final paid cycle remains durable.
    paidPeriod = await applyCommerceSubscriptionLifecycle({
      ...snapshot,
      state: "renewed",
      fundingOrderId: input.fundingOrderId,
      providerEventId: `${input.eventId}:paid`,
    });
  }
  if (!state) return paidPeriod;
  return applyCommerceSubscriptionLifecycle({
    ...snapshot,
    state,
    providerEventId: `${input.eventId}:snapshot`,
    cancelAtPeriodEnd: state === "cancel_at_period_end",
  });
}
