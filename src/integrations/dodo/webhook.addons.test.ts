import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureServerEvent: vi.fn(),
  captureServerException: vi.fn(),
  enqueueBentoBillingEmail: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  subscriptionUpsert: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("@/lib/email.server", () => ({ enqueueBentoBillingEmail: mocks.enqueueBentoBillingEmail }));
vi.mock("@/lib/posthog.server", () => ({
  captureServerEvent: mocks.captureServerEvent,
  captureServerException: mocks.captureServerException,
}));

import { verifiedDodoAddonState } from "@/lib/billing-addons";
import { processVerifiedDodoEvent, type DodoEvent } from "./webhook.server";

const env = {
  DODO_CONTACT_TIER_5000_MONTHLY_ADDON_ID: "contact-5000-monthly",
  DODO_CONTACT_TIER_10000_MONTHLY_ADDON_ID: "contact-10000-monthly",
  DODO_CONTACT_TIER_25000_MONTHLY_ADDON_ID: "contact-25000-monthly",
  DODO_CONTACT_TIER_50000_MONTHLY_ADDON_ID: "contact-50000-monthly",
  DODO_CONTACT_TIER_100000_MONTHLY_ADDON_ID: "contact-100000-monthly",
  DODO_CONTACT_TIER_150000_MONTHLY_ADDON_ID: "contact-150000-monthly",
  DODO_CONTACT_TIER_5000_YEARLY_ADDON_ID: "contact-5000-yearly",
  DODO_CONTACT_TIER_10000_YEARLY_ADDON_ID: "contact-10000-yearly",
  DODO_CONTACT_TIER_25000_YEARLY_ADDON_ID: "contact-25000-yearly",
  DODO_CONTACT_TIER_50000_YEARLY_ADDON_ID: "contact-50000-yearly",
  DODO_CONTACT_TIER_100000_YEARLY_ADDON_ID: "contact-100000-yearly",
  DODO_CONTACT_TIER_150000_YEARLY_ADDON_ID: "contact-150000-yearly",
  DODO_STORAGE_10GB_MONTHLY_ADDON_ID: "storage-10gb-monthly",
  DODO_STORAGE_10GB_YEARLY_ADDON_ID: "storage-10gb-yearly",
};

function subscriptionEvent(
  plan: "store" | "creator",
  type:
    | "subscription.active"
    | "subscription.cancelled"
    | "subscription.expired" = "subscription.active",
  addons?: Array<{ addon_id: string; quantity: number }>,
): DodoEvent {
  return {
    type,
    timestamp: "2026-09-01T00:00:00.000Z",
    data: {
      subscription_id: "sub_123",
      product_id: `${plan}-monthly`,
      status: type.split(".").at(-1),
      payment_frequency_interval: "monthly",
      metadata: { user_id: "user_123" },
      ...(addons === undefined ? {} : { addons }),
    },
  };
}

beforeEach(() => {
  mocks.captureServerEvent.mockResolvedValue(undefined);
  mocks.captureServerException.mockResolvedValue(undefined);
  mocks.enqueueBentoBillingEmail.mockResolvedValue(undefined);
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  mocks.subscriptionUpsert.mockResolvedValue({ error: null });
  mocks.from.mockImplementation((table: string) => {
    if (table === "complimentary_plan_grants") {
      const query = {
        eq: () => query,
        gt: () => query,
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return { select: () => query };
    }
    if (table === "profiles") return { update: () => ({ eq: async () => ({ error: null }) }) };
    if (table === "subscriptions") {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        upsert: mocks.subscriptionUpsert,
      };
    }
    if (table === "billing_events") {
      return { update: () => ({ eq: async () => ({ error: null }) }) };
    }
    throw new Error(`unexpected table: ${table}`);
  });
  vi.stubEnv("DODO_CREATOR_MONTHLY_PRODUCT_ID", "creator-monthly");
  vi.stubEnv("DODO_STORE_MONTHLY_PRODUCT_ID", "store-monthly");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("verified Dodo add-on state", () => {
  it("maps only configured IDs from an explicit webhook cart", () => {
    const explicitKnownCart = [
      { addon_id: "contact-10000-monthly", quantity: 1 },
      { addon_id: "storage-10gb-monthly", quantity: 4 },
    ];

    expect(verifiedDodoAddonState(explicitKnownCart, "monthly", env)).toEqual({
      contactTierContacts: 10_000,
      storageAddonUnits: 4,
    });
  });

  it("preserves local state when Dodo omits the add-on cart", () => {
    expect(verifiedDodoAddonState(undefined, "monthly", env)).toBeNull();
  });

  it("does not grant capacity for unknown add-ons", () => {
    expect(verifiedDodoAddonState([{ addon_id: "unknown", quantity: 99 }], "monthly", env)).toEqual(
      {
        contactTierContacts: 500,
        storageAddonUnits: 0,
      },
    );
  });

  it("persists top-level Dodo add-ons and emits the confirmed state", async () => {
    await processVerifiedDodoEvent(
      subscriptionEvent("creator", "subscription.active", [
        { addon_id: "contact-10000-monthly", quantity: 1 },
        { addon_id: "storage-10gb-monthly", quantity: 4 },
      ]),
      "webhook-creator",
    );

    expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ contact_tier_contacts: 10_000, storage_addon_units: 4 }),
      { onConflict: "user_id" },
    );
    expect(mocks.captureServerEvent).toHaveBeenCalledWith("user_123", "dodo_addons_verified", {
      plan: "creator",
      billing_period: "monthly",
      contact_tier: 10_000,
      storage_units: 4,
    });
  });

  it("preserves add-on columns when the provider omits top-level add-ons", async () => {
    await processVerifiedDodoEvent(subscriptionEvent("creator"), "webhook-omitted");

    expect(mocks.subscriptionUpsert.mock.calls[0][0]).not.toHaveProperty("contact_tier_contacts");
    expect(mocks.subscriptionUpsert.mock.calls[0][0]).not.toHaveProperty("storage_addon_units");
    expect(mocks.captureServerEvent).not.toHaveBeenCalledWith(
      "user_123",
      "dodo_addons_verified",
      expect.anything(),
    );
  });

  it("resets add-on columns for an explicit empty top-level add-on cart", async () => {
    await processVerifiedDodoEvent(
      subscriptionEvent("creator", "subscription.active", []),
      "webhook-empty",
    );

    expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ contact_tier_contacts: 500, storage_addon_units: 0 }),
      { onConflict: "user_id" },
    );
  });

  it("clamps Store contact add-ons while preserving verified storage", async () => {
    await processVerifiedDodoEvent(
      subscriptionEvent("store", "subscription.active", [
        { addon_id: "contact-10000-monthly", quantity: 1 },
        { addon_id: "storage-10gb-monthly", quantity: 4 },
      ]),
      "webhook-store",
    );

    expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ contact_tier_contacts: 500, storage_addon_units: 4 }),
      { onConflict: "user_id" },
    );
  });

  it.each(["subscription.cancelled", "subscription.expired"] as const)(
    "clears add-on capacity for %s",
    async (type) => {
      await processVerifiedDodoEvent(
        subscriptionEvent("creator", type, [
          { addon_id: "contact-10000-monthly", quantity: 1 },
          { addon_id: "storage-10gb-monthly", quantity: 4 },
        ]),
        `webhook-${type}`,
      );

      expect(mocks.subscriptionUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          plan_id: "free",
          contact_tier_contacts: 500,
          storage_addon_units: 0,
        }),
        { onConflict: "user_id" },
      );
    },
  );
});
