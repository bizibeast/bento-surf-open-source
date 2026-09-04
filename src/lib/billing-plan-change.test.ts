import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
    subscription,
    supabase,
    updates,
  };
});

vi.mock("@tanstack/react-start", () => ({
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
            };
          }) => unknown,
        ) =>
        async (input: { data?: unknown }) =>
          handler({
            data: validate(input.data),
            context: { claims: {}, supabase: handlerMocks.supabase, userId: "user_123" },
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
    subscriptions: {
      cancelChangePlan: handlerMocks.cancelChangePlan,
      changePlan: handlerMocks.changePlan,
      retrieve: handlerMocks.retrieve,
    },
  },
}));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: vi.fn() }));

import { cancelMyPlanChange, changeMyPlan } from "./billing.functions";

const settingsSource = resolve(process.cwd(), "src/routes/_authenticated/settings.tsx");

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
    Object.assign(process.env, {
      DODO_CONTACT_TIER_50000_MONTHLY_ADDON_ID: "contact-50000-monthly",
      DODO_CONTACT_TIER_50000_YEARLY_ADDON_ID: "contact-50000-yearly",
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

  it("uses Dodo's yearly interval for the target product and add-on cart", async () => {
    handlerMocks.retrieve.mockResolvedValue({ payment_frequency_interval: "Year" });
    Object.assign(handlerMocks.subscription, {
      billing_interval: "monthly",
      contact_tier_contacts: 50_000,
      plan_id: "store",
      storage_addon_units: 12,
    });

    await expect(changeMyPlan({ data: { plan: "creator" } })).resolves.toMatchObject({
      mode: "changed",
    });

    expect(handlerMocks.changePlan).toHaveBeenCalledWith(
      "sub_123",
      expect.objectContaining({
        addons: [
          { addon_id: "contact-50000-yearly", quantity: 1 },
          { addon_id: "storage-yearly", quantity: 12 },
        ],
        product_id: "creator-yearly",
      }),
    );
    expect(handlerMocks.retrieve.mock.invocationCallOrder[0]).toBeLessThan(
      handlerMocks.changePlan.mock.invocationCallOrder[0],
    );
    expect(handlerMocks.retrieve.mock.invocationCallOrder[0]).toBeLessThan(
      handlerMocks.adminFrom.mock.invocationCallOrder[0],
    );
  });

  it("redirects the browser when a legacy subscription requires live checkout", async () => {
    const source = await readFile(settingsSource, "utf8");

    expect(source).toContain('result.mode === "checkout"');
    expect(source).toContain("window.location.assign(destination)");
  });

  it("restarts checkout with compatible add-ons when Dodo no longer has the subscription", async () => {
    const missing = Object.assign(new Error("missing"), { status: 404 });
    handlerMocks.retrieve.mockRejectedValueOnce(missing);
    Object.assign(handlerMocks.subscription, {
      billing_interval: "monthly",
      contact_tier_contacts: 50_000,
      plan_id: "creator",
      storage_addon_units: 12,
    });

    await expect(changeMyPlan({ data: { plan: "store" } })).resolves.toEqual({
      mode: "checkout",
      url: "https://checkout.dodopayments.com/session",
    });

    expect(handlerMocks.checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        product_cart: [
          {
            addons: [{ addon_id: "storage-monthly", quantity: 12 }],
            product_id: "store-monthly",
            quantity: 1,
          },
        ],
      }),
    );
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

  it("returns a sanitized error and clears pending state when Dodo rejects a plan change", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    handlerMocks.changePlan.mockRejectedValueOnce(new Error("provider details"));

    await expect(changeMyPlan({ data: { plan: "store" } })).rejects.toThrow(
      "Your plan could not be changed right now.",
    );

    expect(handlerMocks.updates).toContainEqual({
      pending_plan_effective_at: null,
      pending_plan_id: null,
    });
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
        product_id: "store-monthly",
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
