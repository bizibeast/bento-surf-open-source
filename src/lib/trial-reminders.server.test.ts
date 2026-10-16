import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
  remote: {} as Record<string, unknown>,
  retrieve: vi.fn(),
  preview: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: state.current, error: null }),
      };
      return q;
    },
  },
}));
vi.mock("@/integrations/dodo/client.server", () => ({
  dodo: { subscriptions: { retrieve: state.retrieve, previewChangePlan: state.preview } },
}));
vi.mock("./billing-trial-terms.server", () => ({
  readTrialTerms: vi.fn(async () => ({ days: 7, approvedExtensionEnd: null })),
}));
vi.mock("./email.server", () => ({ enqueueBentoBillingEmail: vi.fn() }));
import { readTrialReminder } from "./trial-reminders.server";
const end = "2026-10-14T12:00:00.000Z";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T12:01:00Z"));
  vi.clearAllMocks();
  vi.stubEnv("DODO_STORE_19_MONTHLY_PRODUCT_ID", "new-store");
  vi.stubEnv("DODO_CREATOR_39_MONTHLY_PRODUCT_ID", "new-creator");
  vi.stubEnv("DODO_STORE_190_YEARLY_PRODUCT_ID", "new-store-yearly");
  vi.stubEnv("RESEND_REPLY_TO", "support@example.com");
  state.current = {
    dodo_subscription_id: "subscription",
    status: "trialing",
    trial_ends_at: end,
    current_period_end: end,
    cancel_at_period_end: false,
  };
  state.remote = {
    status: "active",
    created_at: "2026-10-07T12:00:00Z",
    next_billing_date: end,
    trial_period_days: 7,
    product_id: "new-store",
    recurring_pre_tax_amount: 1900,
    currency: "USD",
    tax_inclusive: false,
    cancel_at_next_billing_date: false,
    metadata: { auth_user_id: "owner", trial_checkout_key: "checkout" },
  };
  state.retrieve.mockImplementation(async () => state.remote);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe("verified day-before-billing email", () => {
  it("uses the provider amount, date and monitored reply address", async () => {
    expect(await readTrialReminder("workspace", "subscription", end)).toMatchObject({
      amount: 1900,
      currency: "USD",
      planName: "Store",
      chargeAt: end,
      replyTo: "support@example.com",
    });
  });
  it("passes the verified yearly period to the reminder", async () => {
    state.remote.product_id = "new-store-yearly";
    state.remote.recurring_pre_tax_amount = 19000;
    expect(await readTrialReminder("workspace", "subscription", end)).toMatchObject({
      amount: 19000,
      billingPeriod: "yearly",
    });
  });
  it("suppresses an already queued email when renewal is canceled", async () => {
    state.remote.cancel_at_next_billing_date = true;
    expect(await readTrialReminder("workspace", "subscription", end)).toBeNull();
  });
  it("suppresses stale dates instead of emailing an inaccurate first charge", async () => {
    state.remote.next_billing_date = "2026-10-15T12:00:00Z";
    expect(await readTrialReminder("workspace", "subscription", end)).toBeNull();
  });
  it("quotes the scheduled renewal plan instead of the temporary trial product", async () => {
    state.remote.scheduled_change = {
      product_id: "new-creator",
      quantity: 1,
      addons: [],
      effective_at: end,
    };
    state.preview.mockResolvedValue({
      new_plan: {
        product_id: "new-creator",
        recurring_pre_tax_amount: 3900,
        currency: "USD",
        tax_inclusive: false,
      },
    });
    expect(await readTrialReminder("workspace", "subscription", end)).toMatchObject({
      amount: 3900,
      planName: "Creator",
    });
    expect(state.preview).toHaveBeenCalledWith(
      "subscription",
      expect.objectContaining({ proration_billing_mode: "do_not_bill" }),
    );
  });
  it("does not send a late reminder after the first charge date", async () => {
    vi.setSystemTime(new Date(end));
    expect(await readTrialReminder("workspace", "subscription", end)).toBeNull();
    expect(state.retrieve).not.toHaveBeenCalled();
  });
});
