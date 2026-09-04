import {
  BASE_MARKETING_CONTACTS,
  CONTACT_TIER_OPTIONS,
  MAX_STORAGE_ADDON_UNITS,
  type BillingPeriod,
  type ContactTier,
  type PaidPlanId,
} from "./plans";

type PaidContactTier = Exclude<ContactTier, typeof BASE_MARKETING_CONTACTS>;

const billingPeriods = ["monthly", "yearly"] as const;
export type DodoAddonCartItem = { addon_id: string; quantity: number };
export type DodoAddonEnvironment = Record<string, string | undefined>;
export type VerifiedDodoAddonState = {
  contactTierContacts: ContactTier;
  storageAddonUnits: number;
};

const paidContactTiers = CONTACT_TIER_OPTIONS.filter(
  (tier): tier is PaidContactTier => tier !== BASE_MARKETING_CONTACTS,
);

function contactTierEnvKey(tier: PaidContactTier, period: BillingPeriod) {
  return `DODO_CONTACT_TIER_${tier}_${period.toUpperCase()}_ADDON_ID`;
}

function storageEnvKey(period: BillingPeriod) {
  return `DODO_STORAGE_10GB_${period.toUpperCase()}_ADDON_ID`;
}

export const DODO_ADDON_ENV_NAMES = [
  ...CONTACT_TIER_OPTIONS.filter((tier) => tier !== BASE_MARKETING_CONTACTS).flatMap((tier) =>
    billingPeriods.map((period) => contactTierEnvKey(tier as PaidContactTier, period)),
  ),
  ...billingPeriods.map(storageEnvKey),
] as const;

function addonEnvValue(env: DodoAddonEnvironment, key: string) {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
}

export function dodoAddonIdsAreUnique(env: DodoAddonEnvironment) {
  const configuredIds = DODO_ADDON_ENV_NAMES.map((key) => addonEnvValue(env, key)).filter(
    (value): value is string => Boolean(value),
  );
  return new Set(configuredIds).size === configuredIds.length;
}

export function isDodoAddonConfigurationReady(env: DodoAddonEnvironment) {
  return (
    DODO_ADDON_ENV_NAMES.every((key) => Boolean(addonEnvValue(env, key))) &&
    dodoAddonIdsAreUnique(env)
  );
}

function configuredAddonId(env: DodoAddonEnvironment, key: string, errorMessage: string) {
  const addonId = env[key]?.trim();
  if (!addonId) throw new Error(errorMessage);
  return addonId;
}

function isContactTier(value: number): value is ContactTier {
  return (CONTACT_TIER_OPTIONS as readonly number[]).includes(value);
}

function validStorageUnits(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_STORAGE_ADDON_UNITS;
}

export function desiredDodoAddonCart(input: {
  plan: PaidPlanId;
  period: BillingPeriod;
  contactTier: ContactTier;
  storageUnits: number;
  env: DodoAddonEnvironment;
}): DodoAddonCartItem[] {
  if (!dodoAddonIdsAreUnique(input.env)) throw new Error("Dodo add-on IDs must be unique.");
  if (!isContactTier(input.contactTier)) throw new Error("Unsupported contact tier.");
  if (!validStorageUnits(input.storageUnits))
    throw new Error("Storage add-on units must be between 0 and 100.");
  if (input.plan !== "creator" && input.contactTier !== BASE_MARKETING_CONTACTS) {
    throw new Error("Contact tiers require Creator");
  }

  const addons: DodoAddonCartItem[] = [];
  if (input.contactTier !== BASE_MARKETING_CONTACTS) {
    addons.push({
      addon_id: configuredAddonId(
        input.env,
        contactTierEnvKey(input.contactTier, input.period),
        `No Dodo contact tier add-on configured for ${input.period}.`,
      ),
      quantity: 1,
    });
  }
  if (input.storageUnits > 0) {
    addons.push({
      addon_id: configuredAddonId(
        input.env,
        storageEnvKey(input.period),
        `No Dodo storage add-on configured for ${input.period}.`,
      ),
      quantity: input.storageUnits,
    });
  }
  return addons;
}

export function verifiedDodoAddonState(
  addons: readonly DodoAddonCartItem[] | undefined,
  period: BillingPeriod | null,
  env: DodoAddonEnvironment,
): VerifiedDodoAddonState | null {
  if (addons === undefined) return null;
  if (!dodoAddonIdsAreUnique(env)) {
    console.warn("[dodo] ignoring add-on cart because configured IDs are not unique");
    return { contactTierContacts: BASE_MARKETING_CONTACTS, storageAddonUnits: 0 };
  }
  if (!period) {
    console.warn("[dodo] ignoring add-on cart without a known billing period");
    return { contactTierContacts: BASE_MARKETING_CONTACTS, storageAddonUnits: 0 };
  }

  const contactIds = new Map(
    paidContactTiers.flatMap((tier) => {
      const addonId = env[contactTierEnvKey(tier, period)]?.trim();
      return addonId ? [[addonId, tier] as const] : [];
    }),
  );
  const storageId = env[storageEnvKey(period)]?.trim();
  const knownIds = new Set([...contactIds.keys(), ...(storageId ? [storageId] : [])]);
  const unknownCount = addons.filter((addon) => !knownIds.has(addon.addon_id)).length;
  if (unknownCount > 0) console.warn("[dodo] ignoring unknown add-ons", { count: unknownCount });

  const matchedContactTiers = addons
    .map((addon) => contactIds.get(addon.addon_id))
    .filter((tier): tier is PaidContactTier => tier !== undefined);
  if (matchedContactTiers.length > 1) {
    console.warn("[dodo] ignoring conflicting contact tier add-ons", {
      count: matchedContactTiers.length,
    });
  }
  const storageAddons = storageId ? addons.filter((addon) => addon.addon_id === storageId) : [];
  if (storageAddons.length > 1) {
    console.warn("[dodo] ignoring duplicate storage add-ons", { count: storageAddons.length });
  }

  return {
    contactTierContacts:
      matchedContactTiers.length === 1 ? matchedContactTiers[0] : BASE_MARKETING_CONTACTS,
    storageAddonUnits:
      storageAddons.length === 1 && validStorageUnits(storageAddons[0].quantity)
        ? storageAddons[0].quantity
        : 0,
  };
}
