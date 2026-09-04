// The single source of truth for pricing, entitlements, limits, and upgrade copy.
// Keep this file framework-agnostic so client UI and server enforcement cannot drift.

export type PlanId = "free" | "store" | "creator";
export type PaidPlanId = Exclude<PlanId, "free">;
export type BillingPeriod = "monthly" | "yearly";

export type EntitlementKey =
  | "advancedAnalytics"
  | "customFonts"
  | "allThemes"
  | "instagramAutoDM"
  | "facebookAutoDM"
  | "twitterAutoDM"
  | "advancedAutoDM"
  | "socialConnections"
  | "liveSocialPreviews"
  | "socialAnalytics"
  | "customDomain"
  | "postScheduler"
  | "calendarBookings"
  | "storeCards"
  | "courses"
  | "communities"
  | "subscriptions"
  | "oneTapCheckout"
  | "emailCollection"
  | "emailListBuilder"
  | "emailMarketing"
  | "discountCodes"
  | "orderBumps"
  | "verifiedBadge";

export type PlanLimits = {
  analyticsHistoryDays: number | null;
  maxPages: number | null;
  storageMb: number;
  maxLinksAndBlocks: number | null;
  imageUploadMb: number;
  videoUploadMb: number;
  productAssetUploadMb: number;
};

export type PlanPrice = {
  amount: number;
  label: string;
  cadence: string;
  sublabel?: string;
  badge?: string;
};

type PlanDefinition = {
  id: PlanId;
  name: string;
  description: string;
  entitlements: Record<EntitlementKey, boolean>;
  limits: PlanLimits;
  highlights: readonly string[];
  pricing?: Record<BillingPeriod, PlanPrice>;
};

export const TRIAL_DAYS = 7;
const GB = 1024;

export const BASE_MARKETING_CONTACTS = 500;
export const PAID_CONTACT_TIER_OPTIONS = [5_000, 10_000, 25_000, 50_000, 100_000, 150_000] as const;
export type PaidContactTier = (typeof PAID_CONTACT_TIER_OPTIONS)[number];
export const CONTACT_TIER_OPTIONS = [
  BASE_MARKETING_CONTACTS,
  ...PAID_CONTACT_TIER_OPTIONS,
] as const;
export type ContactTier = (typeof CONTACT_TIER_OPTIONS)[number];
export const CONTACT_TIER_PRICING: Record<PaidContactTier, Record<BillingPeriod, number>> = {
  5_000: { monthly: 50, yearly: 500 },
  10_000: { monthly: 100, yearly: 1_000 },
  25_000: { monthly: 200, yearly: 2_000 },
  50_000: { monthly: 300, yearly: 3_000 },
  100_000: { monthly: 500, yearly: 5_000 },
  150_000: { monthly: 700, yearly: 7_000 },
};
export const STORAGE_ADDON_UNIT_MB = 10 * GB;
export const MAX_STORAGE_ADDON_UNITS = 100;
export const storageAddonPrice = (period: BillingPeriod, units: number) =>
  units * (period === "monthly" ? 1 : 10);

const freeEntitlements: Record<EntitlementKey, boolean> = {
  advancedAnalytics: false,
  customFonts: true,
  allThemes: true,
  instagramAutoDM: true,
  facebookAutoDM: true,
  twitterAutoDM: true,
  advancedAutoDM: false,
  socialConnections: false,
  liveSocialPreviews: false,
  socialAnalytics: false,
  customDomain: false,
  postScheduler: false,
  calendarBookings: false,
  storeCards: false,
  courses: false,
  communities: false,
  subscriptions: false,
  oneTapCheckout: false,
  emailCollection: false,
  emailListBuilder: false,
  emailMarketing: false,
  discountCodes: false,
  orderBumps: false,
  verifiedBadge: false,
};

const storeEntitlements: Record<EntitlementKey, boolean> = {
  ...freeEntitlements,
  liveSocialPreviews: true,
  advancedAutoDM: true,
  calendarBookings: true,
  storeCards: true,
  courses: true,
  communities: true,
  subscriptions: true,
  oneTapCheckout: true,
  emailCollection: true,
  emailListBuilder: false,
  emailMarketing: false,
  discountCodes: true,
  orderBumps: true,
};

export const PLAN_CONFIG: Record<PlanId, PlanDefinition> = {
  free: {
    id: "free",
    name: "Free",
    description: "A beautiful link in bio, free forever.",
    entitlements: freeEntitlements,
    limits: {
      analyticsHistoryDays: 7,
      maxPages: 5,
      storageMb: GB,
      maxLinksAndBlocks: null,
      imageUploadMb: 1,
      videoUploadMb: 10,
      productAssetUploadMb: 0,
    },
    highlights: [
      "5 pages and unlimited blocks",
      "1 GB file storage",
      "Last 7 days of Bento analytics",
      "All themes and custom fonts",
      "Profile card with QR code",
      "Unlimited basic Auto DM automations",
    ],
  },
  store: {
    id: "store",
    name: "Store",
    description: "Monetize and automate your creator business.",
    entitlements: storeEntitlements,
    limits: {
      analyticsHistoryDays: 7,
      maxPages: null,
      storageMb: 5 * GB,
      maxLinksAndBlocks: null,
      imageUploadMb: 15,
      videoUploadMb: 250,
      productAssetUploadMb: 1024,
    },
    pricing: {
      monthly: { amount: 15, label: "$15", cadence: "/month" },
      yearly: {
        amount: 150,
        label: "$150",
        cadence: "/year",
        sublabel: "$12.50/month - 2 months free",
        badge: "2 months free",
      },
    },
    highlights: [
      "Everything in Free",
      "Unlimited pages and blocks",
      "5 GB file storage",
      "Bento Store and one-tap checkout",
      "0% Bento platform fee on sales",
      "Calendar bookings with Google Meet",
      "Advanced Auto DMs and lead capture",
      "Courses, communities and memberships",
      `Email capture up to ${BASE_MARKETING_CONTACTS} contacts`,
    ],
  },
  creator: {
    id: "creator",
    name: "Creator",
    description: "Build, monetize, automate and grow.",
    entitlements: Object.fromEntries(
      (Object.keys(freeEntitlements) as EntitlementKey[]).map((key) => [key, true]),
    ) as Record<EntitlementKey, boolean>,
    limits: {
      analyticsHistoryDays: null,
      maxPages: null,
      storageMb: 5 * GB,
      maxLinksAndBlocks: null,
      imageUploadMb: 15,
      videoUploadMb: 250,
      productAssetUploadMb: 1024,
    },
    pricing: {
      monthly: { amount: 30, label: "$30", cadence: "/month" },
      yearly: {
        amount: 300,
        label: "$300",
        cadence: "/year",
        sublabel: "$25/month - 2 months free",
        badge: "2 months free",
      },
    },
    highlights: [
      "Everything in Store",
      "Creator-only social account features",
      "Follower counts on social cards",
      "Post scheduler",
      "In-depth social media analytics",
      "Advanced social performance insights",
      `Email Marketing ${BASE_MARKETING_CONTACTS} contacts, unlimited sends`,
    ],
  },
};

export const PLAN_ORDER: readonly PlanId[] = ["free", "store", "creator"];
export const PAID_PLAN_IDS: readonly PaidPlanId[] = ["store", "creator"];

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: PLAN_CONFIG.free.limits,
  store: PLAN_CONFIG.store.limits,
  creator: PLAN_CONFIG.creator.limits,
};

export const PLAN_PRICING: Record<PaidPlanId, Record<BillingPeriod, PlanPrice>> = {
  store: PLAN_CONFIG.store.pricing!,
  creator: PLAN_CONFIG.creator.pricing!,
};

export const PLAN_HIGHLIGHTS: Record<PlanId, readonly string[]> = {
  free: PLAN_CONFIG.free.highlights,
  store: PLAN_CONFIG.store.highlights,
  creator: PLAN_CONFIG.creator.highlights,
};

export const DODO_PRODUCT_ENV: Record<PaidPlanId, Record<BillingPeriod, string>> = {
  store: {
    monthly: "DODO_STORE_MONTHLY_PRODUCT_ID",
    yearly: "DODO_STORE_YEARLY_PRODUCT_ID",
  },
  creator: {
    monthly: "DODO_CREATOR_MONTHLY_PRODUCT_ID",
    yearly: "DODO_CREATOR_YEARLY_PRODUCT_ID",
  },
};

export const ENTITLEMENT_LABELS: Record<EntitlementKey, string> = {
  advancedAnalytics: "Advanced analytics",
  customFonts: "Font selection",
  allThemes: "All themes",
  instagramAutoDM: "Instagram Auto DMs",
  facebookAutoDM: "Facebook Auto DMs",
  twitterAutoDM: "X Auto DMs",
  advancedAutoDM: "Advanced Auto DMs",
  socialConnections: "Creator social account connections",
  liveSocialPreviews: "Live social stats, posts and activity",
  socialAnalytics: "In-depth social media analytics",
  customDomain: "Custom domains",
  postScheduler: "Post scheduler",
  calendarBookings: "Calendar bookings and Google Meet",
  storeCards: "Bento Store cards",
  courses: "Course creation and hosting",
  communities: "Community creation and hosting",
  subscriptions: "Recurring subscriptions",
  oneTapCheckout: "One-tap checkout",
  emailCollection: "Email collection",
  emailListBuilder: "Email list builder",
  emailMarketing: "Email marketing",
  discountCodes: "Discount codes",
  orderBumps: "Order bumps",
  verifiedBadge: "Verified blue badge",
};

export const PLAN_FEATURES: Array<Record<PlanId, string> & { label: string }> = [
  { label: "Pages", free: "5 pages", store: "Unlimited", creator: "Unlimited" },
  { label: "Links and blocks", free: "Unlimited", store: "Unlimited", creator: "Unlimited" },
  { label: "Storage", free: "1 GB", store: "5 GB", creator: "5 GB" },
  { label: "Bento analytics", free: "Last 7 days", store: "Last 7 days", creator: "Full history" },
  { label: "Themes and custom fonts", free: "All", store: "All", creator: "All" },
  {
    label: "Follower counts on social cards",
    free: "-",
    store: "-",
    creator: "Included",
  },
  { label: "Basic Auto DMs", free: "Unlimited", store: "Unlimited", creator: "Unlimited" },
  { label: "Advanced Auto DMs", free: "-", store: "Included", creator: "Included" },
  { label: "Post scheduler", free: "-", store: "-", creator: "Included" },
  { label: "Social analytics", free: "-", store: "-", creator: "Included" },
  { label: "Calendar bookings", free: "-", store: "Included", creator: "Included" },
  { label: "Bento Store", free: "-", store: "Included", creator: "Included" },
  { label: "Courses and communities", free: "-", store: "Included", creator: "Included" },
  {
    label: "Email marketing",
    free: "-",
    store: `Capture up to ${BASE_MARKETING_CONTACTS}`,
    creator: `${BASE_MARKETING_CONTACTS} contacts, unlimited sends; larger tiers available`,
  },
];

export const FREE_HIGHLIGHTS = PLAN_HIGHLIGHTS.free;
export const PRO_HIGHLIGHTS = PLAN_HIGHLIGHTS.store;

/** Maps legacy database/billing values without taking access away during rollout. */
export function normalizePlan(value: unknown, legacyIsPro = false): PlanId {
  if (value === "creator" || value === "store" || value === "free") return value;
  if (value === "max") return "creator";
  if (value === "pro" || value === "link") return "store";
  return legacyIsPro ? "store" : "free";
}

export function isPaidPlan(plan: PlanId): plan is PaidPlanId {
  return plan !== "free";
}

/** Return the most capable plan without allowing a lower-priority source to remove access. */
export function highestPlan(...plans: PlanId[]): PlanId {
  return plans.reduce<PlanId>(
    (highest, plan) => (PLAN_ORDER.indexOf(plan) > PLAN_ORDER.indexOf(highest) ? plan : highest),
    "free",
  );
}

export function planLimits(plan: PlanId | boolean | null | undefined): PlanLimits {
  if (typeof plan === "boolean") return plan ? PLAN_LIMITS.store : PLAN_LIMITS.free;
  return PLAN_LIMITS[plan ?? "free"];
}

export function planHasEntitlement(plan: PlanId | string, entitlement: EntitlementKey): boolean {
  return PLAN_CONFIG[normalizePlan(plan)].entitlements[entitlement];
}

export function minimumPlanForEntitlement(entitlement: EntitlementKey): PaidPlanId {
  return planHasEntitlement("store", entitlement) ? "store" : "creator";
}

export function planName(plan: PlanId): string {
  return PLAN_CONFIG[plan].name;
}

export function entitlementUpgradeMessage(entitlement: EntitlementKey): string {
  const required = minimumPlanForEntitlement(entitlement);
  return `${ENTITLEMENT_LABELS[entitlement]} is included with the ${planName(required)} plan. Upgrade to continue.`;
}

export function usesAdvancedAutoDm(input: {
  excludedKeywords?: readonly string[];
  publicReplyEnabled?: boolean;
  openingMessage?: string | null;
  confirmationButtonLabel?: string | null;
  emailCaptureEnabled?: boolean;
  emailMarketingConsentEnabled?: boolean;
  followGateEnabled?: boolean;
}): boolean {
  return Boolean(
    input.excludedKeywords?.length ||
    input.publicReplyEnabled ||
    input.openingMessage ||
    input.confirmationButtonLabel ||
    input.emailCaptureEnabled ||
    input.emailMarketingConsentEnabled ||
    input.followGateEnabled,
  );
}

export function blockEntitlement(type: string): EntitlementKey | null {
  if (type === "commerce") return "storeCards";
  if (type === "email_capture") return "emailCollection";
  return null;
}

export function commerceEntitlement(kind: string): EntitlementKey {
  if (kind === "newsletter") return "emailMarketing";
  if (kind === "course") return "courses";
  if (kind === "paid_community") return "communities";
  if (kind === "membership") return "subscriptions";
  if (kind === "lead_form") return "emailCollection";
  return "storeCards";
}

export const FREE_PATTERN_IDS: readonly string[] = [
  "none",
  "custom_photo",
  "grid",
  "dots",
  "striped",
];

export function isPremiumPattern(id: string): boolean {
  return !FREE_PATTERN_IDS.includes(id);
}

export function uploadLimitMb(kind: string, plan: PlanId | boolean): number {
  const limits = planLimits(plan);
  if (kind === "product_file") return limits.productAssetUploadMb;
  return kind === "video" || kind === "audio" ? limits.videoUploadMb : limits.imageUploadMb;
}

export function analyticsDays(plan: PlanId | boolean): number | null {
  return planLimits(plan).analyticsHistoryDays;
}
