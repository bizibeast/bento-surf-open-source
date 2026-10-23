// The single source of truth for pricing, entitlements, limits, and upgrade copy.
// Keep this file framework-agnostic so client UI and server enforcement cannot drift.

export type PlanId = "free" | "store" | "creator" | "creator_plus";
export type PaidPlanId = Exclude<PlanId, "free">;
export type BillingPeriod = "monthly" | "yearly";
export type BillingCatalog = "legacy" | "2026-10";
export const CURRENT_BILLING_CATALOG: BillingCatalog = "2026-10";
export const NEW_BILLING_PERIODS: readonly BillingPeriod[] = ["monthly", "yearly"];

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
  | "verifiedBadge"
  | "discover"
  | "brain"
  | "contentAgent"
  | "contentRoutines"
  | "weeklyStrategyReview"
  | "mcpSocialAutomation";

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
  available?: boolean;
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

export const TRIAL_DAYS = 3;
export const EXTENDED_TRIAL_DAYS = 7;
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
  discover: false,
  brain: false,
  contentAgent: false,
  contentRoutines: false,
  weeklyStrategyReview: false,
  mcpSocialAutomation: false,
};

const storeEntitlements: Record<EntitlementKey, boolean> = {
  ...freeEntitlements,
  liveSocialPreviews: true,
  advancedAutoDM: false,
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

const creatorEntitlements: Record<EntitlementKey, boolean> = {
  ...storeEntitlements,
  advancedAnalytics: true,
  advancedAutoDM: true,
  socialConnections: true,
  socialAnalytics: true,
  customDomain: true,
  postScheduler: true,
  emailListBuilder: true,
  emailMarketing: true,
  verifiedBadge: true,
  discover: true,
  mcpSocialAutomation: true,
};

export const PLAN_CONFIG: Record<PlanId, PlanDefinition> = {
  free: {
    id: "free",
    name: "Free",
    description: "Legacy hosted access. New hosted accounts require a paid plan.",
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
      storageMb: 10 * GB,
      maxLinksAndBlocks: null,
      imageUploadMb: 15,
      videoUploadMb: 250,
      productAssetUploadMb: 1024,
    },
    pricing: {
      monthly: { amount: 19, label: "$19", cadence: "/month" },
      yearly: {
        amount: 190,
        label: "$190",
        cadence: "/year",
        sublabel: "$15.83/month, billed yearly · save $38",
        badge: "2 months free",
      },
    },
    highlights: [
      "Your link in bio and complete creator store",
      "Unlimited pages and blocks",
      "10 GB file storage",
      "Bento Store and one-tap checkout",
      "0% Bento platform fee on sales",
      "Calendar bookings with Google Meet",
      "Basic Auto DMs",
      "Courses, communities and memberships",
      `Email capture up to ${BASE_MARKETING_CONTACTS} contacts`,
    ],
  },
  creator: {
    id: "creator",
    name: "Creator",
    description: "Build, monetize, automate and grow.",
    entitlements: creatorEntitlements,
    limits: {
      analyticsHistoryDays: null,
      maxPages: null,
      storageMb: 50 * GB,
      maxLinksAndBlocks: null,
      imageUploadMb: 15,
      videoUploadMb: 250,
      productAssetUploadMb: 1024,
    },
    pricing: {
      monthly: { amount: 39, label: "$39", cadence: "/month" },
      yearly: {
        amount: 390,
        label: "$390",
        cadence: "/year",
        sublabel: "$32.50/month, billed yearly · save $78",
        badge: "2 months free",
      },
    },
    highlights: [
      "Everything in Store",
      "50 GB file storage",
      "Discover ideas for your next post",
      "Follower counts on social cards",
      "Post scheduler",
      "In-depth social media analytics",
      "Advanced Auto DMs with follow and email capture",
      "MCP access for posting and Auto DMs",
      `Newsletter: ${BASE_MARKETING_CONTACTS} contacts, unlimited sends`,
    ],
  },
  creator_plus: {
    id: "creator_plus",
    name: "Creator Plus",
    description: "A Brain that knows your business and helps you build it.",
    entitlements: {
      ...creatorEntitlements,
      brain: true,
      contentAgent: true,
      contentRoutines: true,
      weeklyStrategyReview: true,
    },
    limits: {
      analyticsHistoryDays: null,
      maxPages: null,
      storageMb: 100 * GB,
      maxLinksAndBlocks: null,
      imageUploadMb: 15,
      videoUploadMb: 250,
      productAssetUploadMb: 1024,
    },
    pricing: {
      monthly: { amount: 49, label: "$49", cadence: "/month" },
      yearly: {
        amount: 490,
        label: "$490",
        cadence: "/year",
        sublabel: "$40.83/month, billed yearly · save $98",
        badge: "2 months free",
      },
    },
    highlights: [
      "Everything in Creator",
      "100 GB file storage",
      "Brain: your voice, audience and strategy",
      "Agent for content and business guidance",
      "Routines that keep work moving",
      "Weekly strategy reviews",
    ],
  },
};

export const PLAN_ORDER: readonly PlanId[] = ["free", "store", "creator", "creator_plus"];
export const PAID_PLAN_IDS: readonly PaidPlanId[] = ["store", "creator", "creator_plus"];

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: PLAN_CONFIG.free.limits,
  store: PLAN_CONFIG.store.limits,
  creator: PLAN_CONFIG.creator.limits,
  creator_plus: PLAN_CONFIG.creator_plus.limits,
};

export const PLAN_PRICING: Record<PaidPlanId, Record<BillingPeriod, PlanPrice>> = {
  store: PLAN_CONFIG.store.pricing!,
  creator: PLAN_CONFIG.creator.pricing!,
  creator_plus: PLAN_CONFIG.creator_plus.pricing!,
};

export const PLAN_HIGHLIGHTS: Record<PlanId, readonly string[]> = {
  free: PLAN_CONFIG.free.highlights,
  store: PLAN_CONFIG.store.highlights,
  creator: PLAN_CONFIG.creator.highlights,
  creator_plus: PLAN_CONFIG.creator_plus.highlights,
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
  creator_plus: {
    monthly: "DODO_CREATOR_PLUS_MONTHLY_PRODUCT_ID",
    yearly: "DODO_CREATOR_PLUS_YEARLY_PRODUCT_ID",
  },
};

/** New products must not reuse any product IDs of existing contracts. */
export const CURRENT_DODO_PRODUCT_ENV: Record<PaidPlanId, Record<BillingPeriod, string>> = {
  store: {
    monthly: "DODO_STORE_19_MONTHLY_PRODUCT_ID",
    yearly: "DODO_STORE_190_YEARLY_PRODUCT_ID",
  },
  creator: {
    monthly: "DODO_CREATOR_39_MONTHLY_PRODUCT_ID",
    yearly: "DODO_CREATOR_390_YEARLY_PRODUCT_ID",
  },
  creator_plus: {
    monthly: "DODO_CREATOR_PLUS_MONTHLY_PRODUCT_ID",
    yearly: "DODO_CREATOR_PLUS_490_YEARLY_PRODUCT_ID",
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
  emailMarketing: "Newsletter",
  discountCodes: "Discount codes",
  orderBumps: "Order bumps",
  verifiedBadge: "Verified blue badge",
  discover: "Discover",
  brain: "Brain",
  contentAgent: "Agent",
  contentRoutines: "Routines",
  weeklyStrategyReview: "Weekly strategy reviews",
  mcpSocialAutomation: "MCP posting and Auto DMs",
};

export const PLAN_FEATURES: Array<Record<PlanId, string> & { label: string }> = (
  [
    { label: "Pages", free: "5 pages", store: "Unlimited", creator: "Unlimited" },
    { label: "Links and blocks", free: "Unlimited", store: "Unlimited", creator: "Unlimited" },
    { label: "Storage", free: "1 GB", store: "10 GB", creator: "50 GB" },
    {
      label: "Bento analytics",
      free: "Last 7 days",
      store: "Last 7 days",
      creator: "Full history",
    },
    { label: "Themes and custom fonts", free: "All", store: "All", creator: "All" },
    {
      label: "Follower counts on social cards",
      free: "-",
      store: "-",
      creator: "Included",
    },
    { label: "Basic Auto DMs", free: "Unlimited", store: "Unlimited", creator: "Unlimited" },
    { label: "Advanced Auto DMs", free: "-", store: "-", creator: "Included" },
    { label: "Post scheduler", free: "-", store: "-", creator: "Included" },
    { label: "Social analytics", free: "-", store: "-", creator: "Included" },
    { label: "Calendar bookings", free: "-", store: "Included", creator: "Included" },
    { label: "Bento Store", free: "-", store: "Included", creator: "Included" },
    { label: "Courses and communities", free: "-", store: "Included", creator: "Included" },
    {
      label: "Newsletter",
      free: "-",
      store: `Capture up to ${BASE_MARKETING_CONTACTS}`,
      creator: `${BASE_MARKETING_CONTACTS} contacts, unlimited sends; larger tiers available`,
    },
  ] as Array<Record<Exclude<PlanId, "creator_plus">, string> & { label: string }>
)
  .map((row) => ({ ...row, creator_plus: row.label === "Storage" ? "100 GB" : row.creator }))
  .concat([
    { label: "Discover", free: "-", store: "-", creator: "Included", creator_plus: "Included" },
    {
      label: "MCP posting and Auto DMs",
      free: "-",
      store: "-",
      creator: "Included",
      creator_plus: "Included",
    },
    ...["Brain", "Agent", "Routines", "Weekly strategy reviews"].map((label) => ({
      label,
      free: "-",
      store: "-",
      creator: "-",
      creator_plus: "Included",
    })),
  ]);

export const FREE_HIGHLIGHTS = PLAN_HIGHLIGHTS.free;
export const PRO_HIGHLIGHTS = PLAN_HIGHLIGHTS.store;

/** Maps legacy database/billing values without taking access away during rollout. */
export function normalizePlan(value: unknown, legacyIsPro = false): PlanId {
  if (value === "creator_plus" || value === "creator" || value === "store" || value === "free")
    return value;
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

export function planHasEntitlement(
  plan: PlanId | string,
  entitlement: EntitlementKey,
  catalog: BillingCatalog = CURRENT_BILLING_CATALOG,
): boolean {
  const normalized = normalizePlan(plan);
  if (catalog === "legacy") {
    if (normalized === "store" && entitlement === "advancedAutoDM") return true;
    if (normalized === "creator") return PLAN_CONFIG.creator_plus.entitlements[entitlement];
  }
  return PLAN_CONFIG[normalized].entitlements[entitlement] === true;
}

export const CONNECTED_PAYMENTS_REQUIRED_MESSAGE =
  "Connected payments are included with the Store plan. Start a 3-day Store trial to connect a provider.";
export const CONNECT_PAYMENTS_BANNER_TITLE = "Connect payments with a 3-day Store trial";
export const CONNECT_PAYMENTS_BANNER_BODY =
  "Connected payments stay on the Store plan. A card is required. If the 3-day trial is already used, checkout charges the Store plan today. You come back here to connect a provider.";

/** Payments stay paid. A trialing subscription that includes one-tap checkout can connect. */
export function creatorPaymentsUnlocked(input: {
  plan: PlanId;
  catalog?: BillingCatalog;
  subscriptionStatus?: string | null;
  subscriptionPlan?: string | null;
}): boolean {
  const catalog = input.catalog ?? CURRENT_BILLING_CATALOG;
  if (input.plan !== "free" && planHasEntitlement(input.plan, "oneTapCheckout", catalog)) {
    return true;
  }
  return (
    input.subscriptionStatus === "trialing" &&
    planHasEntitlement(normalizePlan(input.subscriptionPlan), "oneTapCheckout", catalog)
  );
}

export function minimumPlanForEntitlement(entitlement: EntitlementKey): PaidPlanId {
  return PAID_PLAN_IDS.find((plan) => planHasEntitlement(plan, entitlement)) ?? "creator_plus";
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
  if (kind === "agent_file") return Math.min(8, limits.imageUploadMb);
  return kind === "video" || kind === "audio" ? limits.videoUploadMb : limits.imageUploadMb;
}

export function analyticsDays(plan: PlanId | boolean): number | null {
  return planLimits(plan).analyticsHistoryDays;
}
