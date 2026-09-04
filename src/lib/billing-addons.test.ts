import { describe, expect, it, vi } from "vitest";

import { desiredDodoAddonCart, verifiedDodoAddonState } from "./billing-addons";

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

describe("desired Dodo add-on cart", () => {
  it("maps a Creator selection to configured monthly Dodo add-ons", () => {
    expect(
      desiredDodoAddonCart({
        plan: "creator",
        period: "monthly",
        contactTier: 25_000,
        storageUnits: 7,
        env,
      }),
    ).toEqual([
      { addon_id: "contact-25000-monthly", quantity: 1 },
      { addon_id: "storage-10gb-monthly", quantity: 7 },
    ]);
  });

  it("rejects paid contact tiers outside Creator", () => {
    expect(() =>
      desiredDodoAddonCart({
        plan: "store",
        period: "monthly",
        contactTier: 5_000,
        storageUnits: 0,
        env,
      }),
    ).toThrow("Contact tiers require Creator");
  });

  it("rejects a selection whose configured provider add-on is missing", () => {
    const { DODO_STORAGE_10GB_MONTHLY_ADDON_ID: _, ...missingStorage } = env;

    expect(() =>
      desiredDodoAddonCart({
        plan: "creator",
        period: "monthly",
        contactTier: 500,
        storageUnits: 1,
        env: missingStorage,
      }),
    ).toThrow("No Dodo storage add-on configured for monthly.");
  });

  it("rejects an ambiguous configured add-on ID before creating a cart", () => {
    expect(() =>
      desiredDodoAddonCart({
        plan: "creator",
        period: "monthly",
        contactTier: 5_000,
        storageUnits: 1,
        env: {
          ...env,
          DODO_STORAGE_10GB_MONTHLY_ADDON_ID: env.DODO_CONTACT_TIER_5000_MONTHLY_ADDON_ID,
        },
      }),
    ).toThrow("Dodo add-on IDs must be unique.");
  });

  it("grants no add-on capacity when configured IDs are ambiguous", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      verifiedDodoAddonState([{ addon_id: "shared-monthly", quantity: 1 }], "monthly", {
        ...env,
        DODO_CONTACT_TIER_5000_MONTHLY_ADDON_ID: "shared-monthly",
        DODO_STORAGE_10GB_MONTHLY_ADDON_ID: "shared-monthly",
      }),
    ).toEqual({ contactTierContacts: 500, storageAddonUnits: 0 });

    consoleWarn.mockRestore();
  });
});
