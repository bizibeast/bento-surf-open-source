import { beforeEach, describe, expect, it, vi } from "vitest";

const handlerMocks = vi.hoisted(() => {
  const updates: unknown[] = [];
  const subscription = {
    billing_interval: "monthly",
    cancel_at_period_end: false,
    contact_tier_contacts: 50_000,
    current_period_end: "2099-01-01T00:00:00.000Z",
    customer_id: "cus_123",
    dodo_subscription_id: "sub_123",
    pending_plan_effective_at: null,
    pending_plan_id: null,
    plan_id: "creator",
    retention_offer_expires_at: null,
    retention_offer_redeemed_at: null,
    status: "active",
    storage_addon_units: 12,
  };
  const supabase = {
    from: vi.fn(() => {
      const query = {
        eq: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({ data: subscription, error: null })),
        select: vi.fn(() => query),
      };
      return query;
    }),
  };
  const adminFrom = vi.fn(() => {
    const query = {
      eq: vi.fn(() => query),
      then: (resolve: (value: { error: null }) => unknown) =>
        Promise.resolve({ error: null }).then(resolve),
      update: vi.fn((value: unknown) => {
        updates.push(value);
        return query;
      }),
    };
    return query;
  });
  return {
    adminFrom,
    cancelChangePlan: vi.fn().mockResolvedValue(undefined),
    changePlan: vi.fn().mockResolvedValue(undefined),
    checkoutCreate: vi.fn().mockResolvedValue({
      checkout_url: "https://checkout.dodopayments.com/session",
    }),
    retrieve: vi.fn().mockResolvedValue({ payment_frequency_interval: "Month" }),
    productRetrieve: vi.fn(),
    subscription,
    supabase,
    updates,
  };
});

vi.mock("./billing-sync.server", () => ({
  withWorkspaceBillingSync: (_id: string, action: (lease: string) => unknown) => action("lease"),
}));
vi.mock("@/integrations/dodo/webhook.server", () => ({ refreshWorkspaceSubscription: vi.fn() }));

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (handler: unknown) => handler,
  createServerFn: () => {
    let validate = (input: unknown) => input;
    const builder = {
      handler:
        (
          handler: (input: {
            data: unknown;
            context: {
              claims: Record<string, never>;
              supabase: typeof handlerMocks.supabase;
              userId: string;
              authUserId: string;
            };
          }) => unknown,
        ) =>
        async (input: { data?: unknown }) =>
          handler({
            data: validate(input.data),
            context: {
              claims: {},
              supabase: handlerMocks.supabase,
              userId: "user_123",
              authUserId: "owner",
            },
          }),
      middleware: () => builder,
      validator: (next: (input: unknown) => unknown) => {
        validate = next;
        return builder;
      },
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: handlerMocks.adminFrom },
}));
vi.mock("@/integrations/dodo/client.server", () => ({
  dodo: {
    checkoutSessions: { create: handlerMocks.checkoutCreate },
    products: { retrieve: handlerMocks.productRetrieve },
    subscriptions: {
      cancelChangePlan: handlerMocks.cancelChangePlan,
      changePlan: handlerMocks.changePlan,
      retrieve: handlerMocks.retrieve,
    },
  },
}));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: vi.fn() }));

import { cancelMyPlanChange, changeMyPlan } from "./billing.functions";

describe("paid plan changes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlerMocks.updates.length = 0;
    handlerMocks.cancelChangePlan.mockResolvedValue(undefined);
    handlerMocks.changePlan.mockResolvedValue(undefined);
    handlerMocks.checkoutCreate.mockResolvedValue({
      checkout_url: "https://checkout.dodopayments.com/session",
    });
    handlerMocks.retrieve.mockResolvedValue({ payment_frequency_interval: "Month" });
    handlerMocks.productRetrieve.mockImplementation(async (productId: string) => ({
      product_id: productId,
      is_recurring: true,
      price: {
        type: "recurring_price",
        currency: "USD",
        price: productId === "creator-new-yearly" ? 39000 : 19000,
        payment_frequency_count: 1,
        payment_frequency_interval: "Year",
        subscription_period_count: 1,
        subscription_period_interval: "Year",
        discount: 0,
      },
    }));
    Object.assign(process.env, {
      DODO_CONTACT_TIER_50000_MONTHLY_ADDON_ID: "contact-50000-monthly",
      DODO_CONTACT_TIER_50000_YEARLY_ADDON_ID: "contact-50000-yearly",
      DODO_CREATOR_39_MONTHLY_PRODUCT_ID: "creator-new-monthly",
      DODO_CREATOR_390_YEARLY_PRODUCT_ID: "creator-new-yearly",
      DODO_STORE_19_MONTHLY_PRODUCT_ID: "store-new-monthly",
      DODO_STORE_190_YEARLY_PRODUCT_ID: "store-new-yearly",
      DODO_CREATOR_PLUS_MONTHLY_PRODUCT_ID: "plus-monthly",
      DODO_CREATOR_PLUS_490_YEARLY_PRODUCT_ID: "plus-yearly",
      DODO_CREATOR_MONTHLY_PRODUCT_ID: "creator-monthly",
      DODO_CREATOR_YEARLY_PRODUCT_ID: "creator-yearly",
      DODO_STORAGE_10GB_MONTHLY_ADDON_ID: "storage-monthly",
      DODO_STORAGE_10GB_YEARLY_ADDON_ID: "storage-yearly",
      DODO_STORE_MONTHLY_PRODUCT_ID: "store-monthly",
      DODO_STORE_YEARLY_PRODUCT_ID: "store-yearly",
    });
    Object.assign(handlerMocks.subscription, {
      billing_interval: "monthly",
      cancel_at_period_end: false,
      contact_tier_contacts: 50_000,
      pending_plan_effective_at: null,
      pending_plan_id: null,
      plan_id: "creator",
      status: "active",
      storage_addon_units: 12,
    });
  });

  it("preserves existing annual contracts instead of silently repricing them", async () => {
    handlerMocks.retrieve.mockResolvedValue({ payment_frequency_interval: "Year" });
    Object.assign(handlerMocks.subscription, { billing_interval: "yearly", plan_id: "store" });
    await expect(changeMyPlan({ data: { plan: "creator" } })).rejects.toThrow(
      "existing annual contract",
    );
    expect(handlerMocks.changePlan).not.toHaveBeenCalled();
    expect(handlerMocks.updates).toEqual([]);
  });

  it("changes a current yearly plan within the yearly catalog", async () => {
    handlerMocks.retrieve.mockResolvedValue({
      payment_frequency_interval: "Year",
      product_id: "store-new-yearly",
      metadata: { billing_catalog: "2026-10" },
    });
    Object.assign(handlerMocks.subscription, { billing_interval: "yearly", plan_id: "store" });
    await changeMyPlan({ data: { plan: "creator" } });
    expect(handlerMocks.changePlan).toHaveBeenCalledWith(
      "sub_123",
      expect.objectContaining({
        product_id: "creator-new-yearly",
        metadata: expect.objectContaining({ period: "yearly", billing_catalog: "2026-10" }),
      }),
    );
  });

  it("moves an explicitly changed legacy monthly contract to the current catalog", async () => {
    handlerMocks.retrieve.mockResolvedValue({
      payment_frequency_interval: "Month",
      product_id: "creator-monthly",
      metadata: { user_id: "user_123" },
    });
    Object.assign(handlerMocks.subscription, { plan_id: "creator", status: "active" });
    await changeMyPlan({ data: { plan: "store" } });
    expect(handlerMocks.changePlan).toHaveBeenCalledWith(
      "sub_123",
      expect.objectContaining({
        effective_at: "next_billing_date",
        metadata: expect.objectContaining({
          billing_catalog: "2026-10",
          workspace_id: "user_123",
          auth_user_id: "owner",
        }),
      }),
    );
  });

  it("defers an upgrade during the trial without charging or resetting it", async () => {
    handlerMocks.retrieve.mockResolvedValue({
      payment_frequency_interval: "Month",
      status: "active",
      trial_period_days: 7,
      created_at: new Date().toISOString(),
      next_billing_date: new Date(Date.now() + 7 * 86400000).toISOString(),
      metadata: { auth_user_id: "owner", billing_catalog: "2026-10" },
    });
    Object.assign(handlerMocks.subscription, { plan_id: "store", status: "trialing" });
    await changeMyPlan({ data: { plan: "creator_plus" } });
    expect(handlerMocks.changePlan).toHaveBeenCalledWith(
      "sub_123",
      expect.objectContaining({
        effective_at: "next_billing_date",
        proration_billing_mode: "full_immediately",
        metadata: expect.objectContaining({ auth_user_id: "owner" }),
      }),
    );
  });

  it("does not create a replacement charge when the old subscription cannot be verified", async () => {
    handlerMocks.retrieve.mockRejectedValueOnce(
      Object.assign(new Error("missing"), { status: 404 }),
    );
    await expect(changeMyPlan({ data: { plan: "store" } })).rejects.toThrow(
      "No replacement checkout or charge has been started",
    );
    expect(handlerMocks.checkoutCreate).not.toHaveBeenCalled();
    expect(handlerMocks.changePlan).not.toHaveBeenCalled();
    expect(handlerMocks.updates).toEqual([]);
  });

  it("returns a sanitized error when Dodo cannot verify the subscription", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    handlerMocks.retrieve.mockRejectedValueOnce(
      Object.assign(new Error("provider details"), { status: 500 }),
    );

    await expect(changeMyPlan({ data: { plan: "store" } })).rejects.toThrow(
      "Your subscription could not be verified.",
    );

    expect(handlerMocks.changePlan).not.toHaveBeenCalled();
    expect(handlerMocks.updates).toEqual([]);
    consoleError.mockRestore();
  });

  it("returns a sanitized error and preserves verified state when Dodo rejects a plan change", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    handlerMocks.changePlan.mockRejectedValueOnce(new Error("provider details"));

    await expect(changeMyPlan({ data: { plan: "store" } })).rejects.toThrow(
      "Your plan could not be changed right now.",
    );

    expect(handlerMocks.updates).toEqual([]);
    consoleError.mockRestore();
  });

  it("keeps verified add-ons until a scheduled Creator to Store downgrade takes effect", async () => {
    Object.assign(process.env, {
      DODO_STORAGE_10GB_MONTHLY_ADDON_ID: "storage-monthly",
      DODO_STORE_MONTHLY_PRODUCT_ID: "store-monthly",
    });
    handlerMocks.updates.length = 0;

    await expect(changeMyPlan({ data: { plan: "store" } })).resolves.toMatchObject({
      mode: "changed",
      billing: { contactTierContacts: 50_000, storageAddonUnits: 12 },
    });

    expect(handlerMocks.changePlan).toHaveBeenCalledWith(
      "sub_123",
      expect.objectContaining({
        addons: [{ addon_id: "storage-monthly", quantity: 12 }],
        product_id: "store-new-monthly",
      }),
    );
    expect(handlerMocks.updates).not.toContainEqual(
      expect.objectContaining({ contact_tier_contacts: 500 }),
    );

    Object.assign(handlerMocks.subscription, {
      pending_plan_effective_at: "2099-01-01T00:00:00.000Z",
      pending_plan_id: "store",
    });
    await expect(cancelMyPlanChange({} as never)).resolves.toMatchObject({
      contactTierContacts: 50_000,
      storageAddonUnits: 12,
    });
    expect(handlerMocks.cancelChangePlan).toHaveBeenCalledWith("sub_123");
  });
});
