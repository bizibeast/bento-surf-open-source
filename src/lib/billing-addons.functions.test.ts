import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const subscription = {
    plan_id: "creator",
    status: "active",
    cancel_at_period_end: false,
    current_period_end: "2099-01-01T00:00:00.000Z",
    dodo_subscription_id: "sub_123",
    customer_id: "cus_123",
    billing_interval: "monthly",
    pending_plan_id: null,
    pending_plan_effective_at: null,
    retention_offer_redeemed_at: null,
    retention_offer_expires_at: null,
    contact_tier_contacts: 50000,
    storage_addon_units: 12,
  };
  const adminUpdates: unknown[] = [];
  const supabase = {
    from: vi.fn(() => {
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({ data: subscription, error: null })),
      };
      return query;
    }),
  };
  const adminFrom = vi.fn(() => {
    const query = {
      update: vi.fn((value: unknown) => {
        adminUpdates.push(value);
        return query;
      }),
      eq: vi.fn(() => query),
      then: (resolve: (value: { error: null }) => unknown) =>
        Promise.resolve({ error: null }).then(resolve),
    };
    return query;
  });

  return {
    adminFrom,
    adminUpdates,
    checkoutCreate: vi.fn(),
    changePlan: vi.fn(),
    enforceRequestRateLimit: vi.fn(),
    retrieveSubscription: vi.fn(),
    subscription,
    supabase,
  };
});

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (input: unknown) => input;
    const builder = {
      middleware: () => builder,
      validator: (next: (input: unknown) => unknown) => {
        validate = next;
        return builder;
      },
      handler:
        (
          handler: (input: {
            data: unknown;
            context: { claims: { email: string }; supabase: typeof mocks.supabase; userId: string };
          }) => unknown,
        ) =>
        async (input: { data?: unknown }) =>
          handler({
            data: validate(input.data),
            context: {
              claims: { email: "ari@example.com" },
              supabase: mocks.supabase,
              userId: "11111111-1111-4111-8111-111111111111",
            },
          }),
    };
    return builder;
  },
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.adminFrom },
}));
vi.mock("@/integrations/dodo/client.server", () => ({
  dodo: {
    checkoutSessions: { create: mocks.checkoutCreate },
    subscriptions: { changePlan: mocks.changePlan, retrieve: mocks.retrieveSubscription },
  },
}));
vi.mock("./request-security.server", () => ({
  enforceRequestRateLimit: mocks.enforceRequestRateLimit,
}));

import { createCheckout, updateMyBillingAddons } from "./billing.functions";

describe("Bento add-on billing server boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adminUpdates.length = 0;
    Object.assign(process.env, {
      DODO_CONTACT_TIER_50000_MONTHLY_ADDON_ID: "contact-50000-monthly",
      DODO_CONTACT_TIER_50000_YEARLY_ADDON_ID: "contact-50000-yearly",
      DODO_CREATOR_MONTHLY_PRODUCT_ID: "creator-monthly",
      DODO_CREATOR_YEARLY_PRODUCT_ID: "creator-yearly",
      DODO_STORAGE_10GB_MONTHLY_ADDON_ID: "storage-monthly",
      DODO_STORAGE_10GB_YEARLY_ADDON_ID: "storage-yearly",
      DODO_STORE_MONTHLY_PRODUCT_ID: "store-monthly",
      DODO_STORE_YEARLY_PRODUCT_ID: "store-yearly",
      VITE_APP_URL: "https://app.bento.surf",
    });
    mocks.checkoutCreate.mockResolvedValue({
      checkout_url: "https://checkout.dodopayments.com/session",
    });
    mocks.changePlan.mockResolvedValue(undefined);
    mocks.retrieveSubscription.mockResolvedValue({
      payment_frequency_interval: "Month",
      product_id: "creator-monthly",
    });
    Object.assign(mocks.subscription, {
      billing_interval: "monthly",
      cancel_at_period_end: false,
      contact_tier_contacts: 50000,
      pending_plan_effective_at: null,
      pending_plan_id: null,
      plan_id: "creator",
      status: "active",
      storage_addon_units: 12,
    });
  });

  it("maps checkout add-on selections to the configured Dodo cart", async () => {
    await expect(
      createCheckout({
        data: {
          contactTier: 50000,
          period: "monthly",
          plan: "creator",
          returnTo: "dashboard",
          storageUnits: 12,
        },
      }),
    ).resolves.toEqual({ url: "https://checkout.dodopayments.com/session" });

    expect(mocks.checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        product_cart: [
          {
            addons: [
              { addon_id: "contact-50000-monthly", quantity: 1 },
              { addon_id: "storage-monthly", quantity: 12 },
            ],
            product_id: "creator-monthly",
            quantity: 1,
          },
        ],
      }),
    );
  });

  it("rejects a Store paid contact tier before starting checkout", async () => {
    await expect(
      createCheckout({
        data: {
          contactTier: 50000,
          period: "monthly",
          plan: "store",
          returnTo: "dashboard",
          storageUnits: 0,
        },
      }),
    ).rejects.toThrow("Contact tier add-ons require the Creator plan.");

    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
  });

  it("rejects storage quantities above the configured maximum before starting checkout", async () => {
    await expect(
      createCheckout({
        data: {
          contactTier: 500,
          period: "monthly",
          plan: "creator",
          returnTo: "dashboard",
          storageUnits: 101,
        },
      }),
    ).rejects.toThrow();

    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
  });

  it("updates an active subscription with its trusted product and complete desired cart", async () => {
    await expect(
      updateMyBillingAddons({ data: { contactTier: 50000, storageUnits: 12 } }),
    ).resolves.toMatchObject({
      contactTierContacts: 50000,
      storageAddonUnits: 12,
    });

    expect(mocks.changePlan).toHaveBeenCalledWith("sub_123", {
      addons: [
        { addon_id: "contact-50000-monthly", quantity: 1 },
        { addon_id: "storage-monthly", quantity: 12 },
      ],
      on_payment_failure: "prevent_change",
      product_id: "creator-monthly",
      proration_billing_mode: "difference_immediately",
      quantity: 1,
    });
    expect(mocks.adminUpdates).toContainEqual({
      contact_tier_contacts: 50000,
      storage_addon_units: 12,
    });
  });

  it("rejects add-on changes while a base-plan change is pending", async () => {
    Object.assign(mocks.subscription, {
      pending_plan_effective_at: "2099-01-01T00:00:00.000Z",
      pending_plan_id: "store",
    });

    await expect(
      updateMyBillingAddons({ data: { contactTier: 50000, storageUnits: 12 } }),
    ).rejects.toThrow("Finish or cancel your scheduled plan change first.");

    expect(mocks.retrieveSubscription).not.toHaveBeenCalled();
    expect(mocks.changePlan).not.toHaveBeenCalled();
    expect(mocks.adminUpdates).toEqual([]);
  });

  it.each([
    ["an unknown product", "unknown-product", "Month"],
    ["a different local plan", "store-monthly", "Month"],
    ["a different local period", "creator-yearly", "Year"],
  ])("fails closed when Dodo returns %s", async (_label, productId, interval) => {
    mocks.retrieveSubscription.mockResolvedValue({
      payment_frequency_interval: interval,
      product_id: productId,
    });

    await expect(
      updateMyBillingAddons({ data: { contactTier: 50000, storageUnits: 12 } }),
    ).rejects.toThrow("Your subscription could not be verified.");

    expect(mocks.changePlan).not.toHaveBeenCalled();
    expect(mocks.adminUpdates).toEqual([]);
  });

  it("does not persist add-on state when Dodo rejects the update", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.changePlan.mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(
      updateMyBillingAddons({ data: { contactTier: 50000, storageUnits: 12 } }),
    ).rejects.toThrow("Your add-ons could not be changed right now.");

    expect(mocks.adminUpdates).toEqual([]);
    consoleError.mockRestore();
  });
});
