import { z } from "zod";
import { publicProductPath } from "./application-urls";

export const COMMERCE_PRODUCT_KINDS = [
  "digital_product",
  "coaching_call",
  "course",
  "webinar",
  "paid_community",
  "membership",
  "custom_product",
  "priority_dm",
  "bundle",
  "newsletter",
  "lead_form",
  "bento_affiliate",
] as const;

export type CommerceProductKind = (typeof COMMERCE_PRODUCT_KINDS)[number];

export function assertGenericCommerceProductMutationAllowed(kind: string) {
  if (kind === "newsletter") {
    throw new Error("Manage paid newsletters in Email Marketing.");
  }
}
export const COMMERCE_OFFER_KINDS = [
  "digital_product",
  "coaching_call",
  "course",
  "webinar",
  "paid_community",
  "membership",
  "custom_product",
  "priority_dm",
  "bundle",
  "newsletter",
] as const satisfies readonly CommerceProductKind[];
export const COMMERCE_GROWTH_KINDS = [
  "lead_form",
  "bento_affiliate",
] as const satisfies readonly CommerceProductKind[];
export type CommerceOfferKind = (typeof COMMERCE_OFFER_KINDS)[number];
export type CommerceGrowthKind = (typeof COMMERCE_GROWTH_KINDS)[number];
export type CommercePricingType = "free" | "one_time" | "subscription";
export type CommerceProductStatus = "draft" | "published" | "archived";

const COMMERCE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COMMERCE_CHECKOUT_STATUSES = new Set([
  "pending",
  "approved",
  "paid",
  "expired",
  "canceled",
  "failed",
]);

export function isStartedCommerceCheckoutStatus(status: unknown) {
  return typeof status === "string" && COMMERCE_CHECKOUT_STATUSES.has(status);
}

export function isCompletedCommerceCheckoutStatus(status: unknown) {
  return status === "paid";
}

export type CommerceOrderConfirmationState =
  "confirmed" | "processing" | "unavailable" | "not_found";

export function commerceOrderConfirmationState(input: {
  orderStatus?: unknown;
  sessionStatus?: unknown;
}): CommerceOrderConfirmationState {
  if (input.orderStatus === "paid" || input.orderStatus === "partially_refunded") {
    return "confirmed";
  }
  if (
    ["refunded", "disputed", "failed", "canceled"].includes(String(input.orderStatus || "")) ||
    ["expired", "canceled", "failed"].includes(String(input.sessionStatus || ""))
  ) {
    return "unavailable";
  }
  if (
    input.orderStatus === "pending" ||
    input.sessionStatus === "pending" ||
    input.sessionStatus === "approved" ||
    input.sessionStatus === "paid"
  ) {
    return input.sessionStatus === "paid" ? "confirmed" : "processing";
  }
  return "not_found";
}

export type CommerceAsset = {
  id: string;
  key?: string;
  name: string;
  size: number;
  mimeType: string;
};

export type CommerceLesson = {
  id: string;
  moduleTitle?: string;
  position?: number;
  title: string;
  summary?: string;
  contentType?: "text" | "video" | "file" | "link";
  body?: string;
  url?: string;
  isPreview?: boolean;
};

export type CommerceFormField = {
  id: string;
  label: string;
  type: "email" | "text";
  required: boolean;
};

export type CommerceBuyerAnswer = {
  question: string;
  answer: string;
  priorityDmRequestId?: string;
};

export type CommerceProductSettings = {
  files?: CommerceAsset[];
  durationMinutes?: number;
  timezone?: string;
  availabilitySummary?: string;
  availabilityDays?: number[];
  availabilityStart?: string;
  availabilityEnd?: string;
  weeklyRules?: Array<{ day: number; start: string; end: string }>;
  dateOverrides?: Array<{
    date: string;
    unavailable?: boolean;
    ranges?: Array<{ start: string; end: string }>;
  }>;
  minimumNoticeMinutes?: number;
  maximumDaysAhead?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  slotIntervalMinutes?: number;
  meetingUrl?: string;
  recordingAddonEnabled?: boolean;
  recordingAddonPrice?: number;
  lessons?: CommerceLesson[];
  startsAt?: string;
  joinUrl?: string;
  replayUrl?: string;
  replayAvailable?: boolean;
  welcomeMessage?: string;
  rules?: string;
  allowMemberPosts?: boolean;
  benefits?: string[];
  fulfillmentInstructions?: string;
  buyerQuestions?: string[];
  priorityPrompt?: string;
  responseTimeHours?: number;
  freeFollowUpLimit?: number;
  followUpPriceAmount?: number;
  bundledProductIds?: string[];
  fields?: CommerceFormField[];
  confirmationMessage?: string;
  targetUrl?: string;
  newsletterPublicationId?: string;
};

export type CommerceProductRecord = {
  id: string;
  creator_id?: string;
  kind: CommerceProductKind;
  status: CommerceProductStatus;
  slug: string;
  public_slug: string;
  title: string;
  subtitle: string;
  description: string;
  cover_url: string | null;
  pricing_type: CommercePricingType;
  price_amount: number;
  currency: string;
  billing_interval: "day" | "week" | "month" | "year" | null;
  cta_label: string;
  settings: CommerceProductSettings;
  inventory_limit: number | null;
  sales_count: number;
  noindex: boolean;
  published_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

function validCommerceTimezone(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function commerceClockMinutes(value: unknown) {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function commerceAvailabilityRules(settings: CommerceProductSettings, useDefaults = false) {
  if (Array.isArray(settings.weeklyRules)) return settings.weeklyRules;
  const days = Array.isArray(settings.availabilityDays)
    ? settings.availabilityDays
    : useDefaults
      ? [1, 2, 3, 4, 5]
      : [];
  return days.map((day) => ({
    day,
    start: settings.availabilityStart || (useDefaults ? "09:00" : ""),
    end: settings.availabilityEnd || (useDefaults ? "17:00" : ""),
  }));
}

function validCommerceHttpUrl(value: unknown) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Canonical server-side publication contract for every Store offer.
 *
 * Drafts may remain incomplete while a creator is editing them, but a product
 * must never become purchasable unless Bento can actually fulfil it.
 */
export function commerceProductPublishabilityError(
  product: Pick<CommerceProductRecord, "kind" | "description" | "settings"> &
    Partial<Pick<CommerceProductRecord, "pricing_type" | "price_amount" | "billing_interval">>,
  now = Date.now(),
) {
  const settings = product.settings ?? {};
  if (!product.description.trim()) return "Add a product description before publishing.";
  switch (product.kind) {
    case "digital_product":
      if (!Array.isArray(settings.files) || settings.files.length === 0) {
        return "Upload at least one buyer file before publishing.";
      }
      break;
    case "coaching_call": {
      const duration = Number(settings.durationMinutes);
      const interval = Number(settings.slotIntervalMinutes);
      const recordingAddonPrice = Number(settings.recordingAddonPrice);
      const rules = commerceAvailabilityRules(settings);
      if (!Number.isInteger(duration) || duration < 10 || duration > 480) {
        return "Choose a coaching call duration between 10 minutes and 8 hours.";
      }
      if (!validCommerceTimezone(settings.timezone)) {
        return "Choose a valid timezone before publishing.";
      }
      if (
        rules.length === 0 ||
        rules.some((rule) => !Number.isInteger(rule?.day) || rule.day < 0 || rule.day > 6)
      ) {
        return "Choose at least one valid available coaching day before publishing.";
      }
      const ranges = rules.map((rule) => ({
        start: commerceClockMinutes(rule?.start),
        end: commerceClockMinutes(rule?.end),
      }));
      if (ranges.some(({ start, end }) => start === null || end === null || start >= end)) {
        return "Choose valid coaching hours with the end time after the start time.";
      }
      if (!Number.isInteger(interval) || interval < 5 || interval > 240) {
        return "Choose a slot interval between 5 minutes and 4 hours.";
      }
      if (
        !ranges.some(({ start, end }) => start !== null && end !== null && end - start >= duration)
      ) {
        return "Your available hours must fit at least one complete coaching session.";
      }
      if (
        settings.recordingAddonEnabled &&
        (!Number.isInteger(recordingAddonPrice) ||
          recordingAddonPrice <= 0 ||
          recordingAddonPrice > 100_000_000)
      ) {
        return "Set a valid recording add-on price before publishing.";
      }
      break;
    }
    case "course":
      if (!Array.isArray(settings.lessons) || settings.lessons.length === 0) {
        return "Add at least one course lesson before publishing.";
      }
      if (settings.lessons.length > 200) {
        return "A course can contain no more than 200 lessons.";
      }
      if (
        settings.lessons.some(
          (lesson) =>
            !lesson ||
            !String(lesson.title || "").trim() ||
            String(lesson.title || "").trim().length > 180 ||
            String(lesson.moduleTitle || "").trim().length > 180 ||
            String(lesson.summary || "").trim().length > 1_000 ||
            String(lesson.body || "").length > 20_000 ||
            (String(lesson.url || "").trim() && !validCommerceHttpUrl(lesson.url)) ||
            (!String(lesson.body || "").trim() && !String(lesson.url || "").trim()),
        )
      ) {
        return "Every course lesson needs valid, reasonably sized content and a title.";
      }
      if (
        new Set(settings.lessons.map((lesson) => String(lesson.id || "").trim())).size !==
          settings.lessons.length ||
        settings.lessons.some((lesson) => !/^[A-Za-z0-9_-]{1,100}$/.test(String(lesson.id || "")))
      ) {
        return "Every course lesson needs a unique identifier.";
      }
      break;
    case "webinar": {
      const startsAt = new Date(String(settings.startsAt || ""));
      if (!Number.isFinite(startsAt.getTime())) {
        return "Choose a valid webinar date before publishing.";
      }
      if (startsAt.getTime() <= now) {
        return "Choose a future webinar date before publishing.";
      }
      if (!validCommerceTimezone(settings.timezone)) {
        return "Choose a valid webinar timezone before publishing.";
      }
      if (
        !Number.isInteger(Number(settings.durationMinutes)) ||
        Number(settings.durationMinutes) < 10 ||
        Number(settings.durationMinutes) > 480
      ) {
        return "Choose a webinar duration between 10 minutes and 8 hours.";
      }
      if (!validCommerceHttpUrl(settings.joinUrl)) {
        return "Add the private webinar join link before publishing.";
      }
      break;
    }
    case "paid_community":
      if (
        !String(settings.welcomeMessage ?? "").trim() ||
        String(settings.welcomeMessage).trim().length > 5_000
      ) {
        return "Add a community welcome message before publishing.";
      }
      if (String(settings.rules ?? "").length > 10_000) {
        return "Keep the community rules below 10,000 characters.";
      }
      break;
    case "membership": {
      if (!Array.isArray(settings.benefits) || settings.benefits.length === 0) {
        return "Add at least one membership benefit before publishing.";
      }
      if (
        settings.benefits.length > 100 ||
        settings.benefits.some(
          (benefit) => !String(benefit || "").trim() || String(benefit || "").trim().length > 500,
        ) ||
        new Set(settings.benefits.map((benefit) => String(benefit).trim().toLowerCase())).size !==
          settings.benefits.length
      ) {
        return "Add up to 100 unique membership benefits of 500 characters or fewer.";
      }
      break;
    }
    case "custom_product":
      if (!String(settings.fulfillmentInstructions ?? "").trim()) {
        return "Explain how the custom product will be fulfilled before publishing.";
      }
      if (
        settings.buyerQuestions !== undefined &&
        (!Array.isArray(settings.buyerQuestions) ||
          settings.buyerQuestions.length > 20 ||
          settings.buyerQuestions.some(
            (question) => !String(question || "").trim() || String(question).trim().length > 500,
          ))
      ) {
        return "Buyer questions must be between 1 and 500 characters.";
      }
      break;
    case "priority_dm": {
      if (
        String(settings.priorityPrompt ?? "").length > 500 ||
        !Number.isInteger(Number(settings.responseTimeHours)) ||
        Number(settings.responseTimeHours) < 1 ||
        Number(settings.responseTimeHours) > 720
      ) {
        return "Choose a response time between 1 hour and 30 days.";
      }
      const freeFollowUps = settings.freeFollowUpLimit;
      const followUpPrice = settings.followUpPriceAmount;
      if (
        (freeFollowUps !== undefined &&
          (!Number.isInteger(Number(freeFollowUps)) ||
            Number(freeFollowUps) < 0 ||
            Number(freeFollowUps) > 100)) ||
        (followUpPrice !== undefined &&
          (!Number.isInteger(Number(followUpPrice)) ||
            Number(followUpPrice) <= 0 ||
            Number(followUpPrice) > 100_000_000))
      ) {
        return "Choose 0 to 100 free follow-ups and a valid paid follow-up price.";
      }
      break;
    }
    case "bundle":
      if (
        !Array.isArray(settings.bundledProductIds) ||
        settings.bundledProductIds.length < 2 ||
        settings.bundledProductIds.length > 20 ||
        new Set(settings.bundledProductIds).size !== settings.bundledProductIds.length ||
        settings.bundledProductIds.some((id) => !COMMERCE_UUID_PATTERN.test(String(id)))
      ) {
        return "Choose between 2 and 20 unique products for this bundle.";
      }
      break;
    case "newsletter":
      if (product.pricing_type !== "subscription") {
        return "Newsletters require recurring pricing.";
      }
      if (!Number.isInteger(product.price_amount) || Number(product.price_amount) <= 0) {
        return "Newsletters require a positive price.";
      }
      if (product.billing_interval !== "month" && product.billing_interval !== "year") {
        return "Newsletters bill monthly or yearly.";
      }
      if (!COMMERCE_UUID_PATTERN.test(String(settings.newsletterPublicationId || ""))) {
        return "Link this offer to a newsletter publication.";
      }
      break;
    case "lead_form": {
      if (!Array.isArray(settings.fields) || settings.fields.length === 0) {
        return "Add at least one form field before publishing.";
      }
      if (settings.fields.length > 20) {
        return "A form can contain no more than 20 fields.";
      }
      const fieldIds = settings.fields.map((field) => String(field?.id || "").trim());
      if (
        new Set(fieldIds).size !== fieldIds.length ||
        settings.fields.some(
          (field) =>
            !field ||
            !/^[A-Za-z0-9_-]{1,100}$/.test(String(field.id || "")) ||
            !String(field.label || "").trim() ||
            String(field.label || "").trim().length > 120 ||
            !["email", "text"].includes(String(field.type)) ||
            typeof field.required !== "boolean",
        )
      ) {
        return "Every form field needs a unique identifier, label, and supported field type.";
      }
      if (!settings.fields.some((field) => field.type === "email")) {
        return "Add an email field before publishing the form.";
      }
      break;
    }
    case "bento_affiliate":
      break;
  }
  return null;
}

export type CommerceProductBlockSource = Pick<
  CommerceProductRecord,
  | "id"
  | "slug"
  | "public_slug"
  | "kind"
  | "title"
  | "subtitle"
  | "cover_url"
  | "pricing_type"
  | "price_amount"
  | "currency"
  | "billing_interval"
  | "cta_label"
  | "status"
>;

export function commerceProductBlockContent(
  product: CommerceProductBlockSource,
  creatorUsername?: string,
) {
  return {
    productId: product.id,
    slug: product.slug,
    publicSlug: product.public_slug,
    kind: product.kind,
    title: product.title,
    subtitle: product.subtitle,
    coverUrl: product.cover_url,
    pricingType: product.pricing_type,
    priceAmount: product.price_amount,
    currency: product.currency,
    billingInterval: product.billing_interval,
    ctaLabel: product.cta_label,
    status: product.status,
    href: creatorUsername
      ? publicProductPath(creatorUsername, product.public_slug)
      : `/p/${product.slug}`,
  };
}

/**
 * Build the checkout-specific product sent to a payment adapter.
 *
 * The final quote-not the catalogue price-is the source of truth when a
 * discount, order bump, or recording add-on changes the amount.
 */
export function commerceCheckoutProduct<
  T extends {
    pricing_type: CommercePricingType;
    price_amount: number;
    title: string;
  },
>(
  product: T,
  input: {
    grossAmount: number;
    hasAddons: boolean;
  },
): T {
  return {
    ...product,
    pricing_type:
      product.pricing_type === "free" && input.grossAmount > 0 ? "one_time" : product.pricing_type,
    price_amount: input.grossAmount,
    title: input.hasAddons ? `${product.title} + add-ons` : product.title,
  };
}

/** Public pages use the product row as the publication source of truth. */
export function hydratePublicCommerceBlocks<
  T extends { type: string; content: unknown; cover_url?: string | null },
>(
  blocks: T[],
  products: CommerceProductBlockSource[],
  storeCardsAllowed: boolean,
  creatorUsername?: string,
): T[] {
  const productsById = new Map(products.map((product) => [product.id, product]));

  return blocks.flatMap((block) => {
    if (block.type !== "commerce") return [block];
    if (!storeCardsAllowed || !block.content || typeof block.content !== "object") return [];
    const productId = (block.content as Record<string, unknown>).productId;
    if (typeof productId !== "string") return [];
    const product = productsById.get(productId);
    if (!product || product.status !== "published") return [];
    return [
      {
        ...block,
        content: commerceProductBlockContent(product, creatorUsername),
        cover_url: product.cover_url,
      },
    ];
  });
}

export type CommerceOrderRecord = {
  id: string;
  product_id: string;
  creator_id: string;
  buyer_email: string;
  buyer_name: string | null;
  status: string;
  gross_amount: number;
  platform_fee_amount: number;
  processor_fee_amount: number;
  tax_amount: number;
  net_amount: number;
  refunded_amount: number;
  currency: string;
  provider: string;
  provider_payment_id: string | null;
  metadata?: Record<string, unknown> | null;
  dispute_id: string | null;
  dispute_status: string | null;
  disputed_amount: number;
  dispute_reason: string | null;
  dispute_opened_at: string | null;
  dispute_resolved_at: string | null;
  paid_at: string | null;
  updated_at: string;
  created_at: string;
};

export type CommerceLeadRecord = {
  id: string;
  product_id: string;
  email: string;
  name: string | null;
  answers: Record<string, string>;
  created_at: string;
};

export type CommerceAudienceContactRecord = {
  id: string;
  creator_id: string;
  customer_id: string;
  email: string;
  name: string | null;
  marketing_consent: boolean;
  marketing_status: "unknown" | "subscribed" | "unsubscribed";
  marketing_consented_at: string | null;
  marketing_unsubscribed_at: string | null;
  first_source: string;
  last_source: string;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

export type CommerceDiscountCodeRecord = {
  id: string;
  creator_id: string;
  product_id: string | null;
  code: string;
  discount_type: "percent" | "fixed";
  /** Basis points for percent discounts; minor currency units for fixed discounts. */
  discount_value: number;
  currency: string | null;
  starts_at: string | null;
  expires_at: string | null;
  max_redemptions: number | null;
  max_redemptions_per_email: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type CommerceOrderBumpRecord = {
  id: string;
  creator_id: string;
  primary_product_id: string;
  bump_product_id: string;
  headline: string;
  description: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type CommerceOrderItemRecord = {
  id: string;
  order_id: string;
  product_id: string | null;
  item_role: "primary" | "bump" | "recording_addon";
  title: string;
  quantity: number;
  unit_amount: number;
  total_amount: number;
  currency: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type CommerceAudienceListRecord = {
  id: string;
  creator_id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
};

export type CommerceAudienceCampaignRecord = {
  id: string;
  creator_id: string;
  list_id: string | null;
  name: string;
  subject: string;
  preview_text: string;
  body_markdown: string;
  content: import("./newsletter").NewsletterContentBlock[];
  sender_postal_address: string | null;
  status: "draft" | "scheduled" | "sending" | "sent" | "failed" | "canceled";
  delivery_status?: "draft" | "scheduled" | "sending" | "sent" | "failed" | "canceled";
  scheduled_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CommerceAudienceEventRecord = {
  id: string;
  creator_id: string;
  contact_id: string;
  event_type: string;
  source_type: string;
  source_id: string | null;
  product_id: string | null;
  order_id: string | null;
  booking_id: string | null;
  amount: number | null;
  currency: string | null;
  metadata: Record<string, unknown>;
  occurred_at: string;
};

export type CommerceWebinarRegistrationRecord = {
  id: string;
  access_grant_id: string;
  order_id: string;
  product_id: string;
  creator_id: string;
  buyer_email: string;
  buyer_name: string | null;
  starts_at: string;
  ends_at: string;
  timezone: string;
  join_url: string | null;
  replay_url: string | null;
  status: "registered" | "attended" | "no_show" | "canceled";
  reminder_24h_sent_at: string | null;
  reminder_1h_sent_at: string | null;
  replay_ready_notified_at: string | null;
  attended_at: string | null;
  created_at: string;
  updated_at: string;
};

export const commerceProductKindSchema = z.enum(COMMERCE_PRODUCT_KINDS);
export const commercePricingTypeSchema = z.enum(["free", "one_time", "subscription"]);
export const commerceProductStatusSchema = z.enum(["draft", "published", "archived"]);

export type CommerceKindDefinition = {
  kind: CommerceProductKind;
  family: "sell" | "grow";
  label: string;
  shortLabel: string;
  description: string;
  setupHint: string;
  defaultPricing: CommercePricingType;
  defaultCta: string;
  tint: "sky" | "rose" | "mint" | "lavender" | "amber" | "neutral";
  accent: string;
};

export const COMMERCE_KINDS: readonly CommerceKindDefinition[] = [
  {
    kind: "digital_product",
    family: "sell",
    label: "Digital product",
    shortLabel: "Download",
    description: "Sell an ebook, template, preset, guide, file, or bundle.",
    setupHint: "Upload the files buyers receive after checkout.",
    defaultPricing: "one_time",
    defaultCta: "Get the download",
    tint: "sky",
    accent: "#3478f6",
  },
  {
    kind: "coaching_call",
    family: "sell",
    label: "Coaching call",
    shortLabel: "Coaching",
    description: "Sell a one-to-one or group call with your availability.",
    setupHint: "Set the duration, timezone, availability, and meeting details.",
    defaultPricing: "one_time",
    defaultCta: "Book a call",
    tint: "lavender",
    accent: "#8067e8",
  },
  {
    kind: "course",
    family: "sell",
    label: "e-Course",
    shortLabel: "Course",
    description: "Create a private course with modules, lessons, and files.",
    setupHint: "Add lessons now, then keep expanding the course after publishing.",
    defaultPricing: "one_time",
    defaultCta: "Start learning",
    tint: "amber",
    accent: "#f1a900",
  },
  {
    kind: "webinar",
    family: "sell",
    label: "Webinar",
    shortLabel: "Webinar",
    description: "Sell seats for a live or recorded online event.",
    setupHint: "Choose the date, capacity, join link, and replay access.",
    defaultPricing: "one_time",
    defaultCta: "Reserve my seat",
    tint: "rose",
    accent: "#ff5f6d",
  },
  {
    kind: "paid_community",
    family: "sell",
    label: "Paid community",
    shortLabel: "Community",
    description: "Host private posts and conversations for paying members.",
    setupHint: "Create the member promise, rules, welcome note, and billing cadence.",
    defaultPricing: "subscription",
    defaultCta: "Join the community",
    tint: "mint",
    accent: "#24a56a",
  },
  {
    kind: "membership",
    family: "sell",
    label: "Recurring membership",
    shortLabel: "Membership",
    description: "Charge regularly for ongoing content, resources, or access.",
    setupHint: "Describe the benefits and choose a renewal interval.",
    defaultPricing: "subscription",
    defaultCta: "Become a member",
    tint: "sky",
    accent: "#1f8bff",
  },
  {
    kind: "custom_product",
    family: "sell",
    label: "Custom product",
    shortLabel: "Custom",
    description: "Sell audits, personalised videos, reviews, or any custom offer.",
    setupHint: "Ask buyers what you need and explain how fulfilment works.",
    defaultPricing: "one_time",
    defaultCta: "Order now",
    tint: "neutral",
    accent: "#17213a",
  },
  {
    kind: "priority_dm",
    family: "sell",
    label: "Priority DM",
    shortLabel: "Priority message",
    description: "Charge for a message that goes straight to your priority inbox.",
    setupHint: "Set the response promise buyers see before they send their message.",
    defaultPricing: "one_time",
    defaultCta: "Send priority message",
    tint: "rose",
    accent: "#ff5f6d",
  },
  {
    kind: "bundle",
    family: "sell",
    label: "Product bundle",
    shortLabel: "Bundle",
    description: "Sell multiple existing downloads, courses, or custom products as one offer.",
    setupHint: "Choose the products included in this single purchase.",
    defaultPricing: "one_time",
    defaultCta: "Get the bundle",
    tint: "amber",
    accent: "#f1a900",
  },
  {
    kind: "newsletter",
    family: "sell",
    label: "Paid newsletter",
    shortLabel: "Newsletter",
    description: "Sell recurring access to paid newsletter issues.",
    setupHint: "Link the offer to your publication and choose a monthly or yearly price.",
    defaultPricing: "subscription",
    defaultCta: "Subscribe",
    tint: "sky",
    accent: "#3478f6",
  },
  {
    kind: "lead_form",
    family: "grow",
    label: "Emails & applications",
    shortLabel: "Application",
    description: "Collect emails, waitlist signups, intake forms, or applications.",
    setupHint: "Choose the questions and what happens after submission.",
    defaultPricing: "free",
    defaultCta: "Apply now",
    tint: "lavender",
    accent: "#9a71e8",
  },
  {
    kind: "bento_affiliate",
    family: "grow",
    label: "Bento affiliate link",
    shortLabel: "Affiliate",
    description: "Share a tracked Bento referral link from your storefront.",
    setupHint: "Bento records clicks and future eligible referrals automatically.",
    defaultPricing: "free",
    defaultCta: "Build your Bento",
    tint: "amber",
    accent: "#f0ad00",
  },
] as const;

export const commerceKind = (kind: CommerceProductKind) =>
  COMMERCE_KINDS.find((item) => item.kind === kind) ?? COMMERCE_KINDS[0];

export function isCommerceOfferKind(kind: string): kind is CommerceOfferKind {
  return (COMMERCE_OFFER_KINDS as readonly string[]).includes(kind);
}

export function isCommerceGrowthKind(kind: string): kind is CommerceGrowthKind {
  return (COMMERCE_GROWTH_KINDS as readonly string[]).includes(kind);
}

export function commercePlatformFeeBps() {
  // Bento does not take a percentage of creator sales. Keeping this decision in
  // one server-side primitive prevents a stale deployment variable from silently
  // reintroducing a commission at checkout.
  return 0;
}

export function calculateCommerceAmounts(
  grossAmount: number,
  platformFeeBps: number,
  processorFeeAmount = 0,
) {
  const gross = Math.max(0, Math.round(grossAmount));
  const feeBps = Math.min(10_000, Math.max(0, Math.round(platformFeeBps)));
  const processor = Math.max(0, Math.round(processorFeeAmount));
  const platform = Math.round((gross * feeBps) / 10_000);
  return {
    grossAmount: gross,
    platformFeeBps: feeBps,
    platformFeeAmount: platform,
    processorFeeAmount: processor,
    netAmount: Math.max(0, gross - platform - processor),
  };
}

export function formatCommerceMoney(amount: number, currency = "usd") {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: currency.toUpperCase(),
      maximumFractionDigits: amount % 100 === 0 ? 0 : 2,
    }).format(amount / 100);
  } catch {
    return `${currency.toUpperCase()} ${(amount / 100).toFixed(2)}`;
  }
}

export function slugifyCommerceProduct(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function isPlausibleCommerceAccessToken(value: string) {
  return /^[A-Za-z0-9_-]{20,200}$/.test(value);
}

export function pricingLabel(
  pricingType: CommercePricingType,
  priceAmount: number,
  currency: string,
  billingInterval?: string | null,
) {
  if (pricingType === "free") return "Free";
  const money = formatCommerceMoney(priceAmount, currency);
  return pricingType === "subscription" && billingInterval
    ? `${money} / ${billingInterval}`
    : money;
}

export function isHostedAccessKind(kind: CommerceProductKind) {
  return [
    "digital_product",
    "coaching_call",
    "course",
    "webinar",
    "paid_community",
    "membership",
    "custom_product",
    "bundle",
    "newsletter",
  ].includes(kind);
}

const COMMERCE_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function minutesFromClock(value: unknown) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * Validates a requested instant against the creator's recurring weekly schedule.
 * The instant remains UTC while schedule rules are evaluated in the creator's IANA timezone.
 */
export function commerceBookingSlotError(
  startsAt: Date,
  durationMinutes: number,
  settings: CommerceProductSettings,
  now = new Date(),
) {
  if (!Number.isFinite(startsAt.getTime()) || startsAt <= now) {
    return "Choose a future date and time.";
  }

  const timezone = String(settings.timezone || "UTC");
  const rules = commerceAvailabilityRules(settings, true);
  const interval = Math.min(240, Math.max(5, Number(settings.slotIntervalMinutes || 30)));
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(startsAt);
  } catch {
    return "The creator's timezone is not configured correctly.";
  }
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  const weekday = COMMERCE_WEEKDAYS.indexOf(part("weekday") as (typeof COMMERCE_WEEKDAYS)[number]);
  const requestedMinutes = Number(part("hour")) * 60 + Number(part("minute"));
  const rule = rules.find((item) => item?.day === weekday);
  if (!rule) return "That day is outside the creator's availability.";
  const startMinutes = minutesFromClock(rule.start);
  const endMinutes = minutesFromClock(rule.end);
  if (startMinutes === null || endMinutes === null || startMinutes >= endMinutes) {
    return "The creator's availability is not configured correctly.";
  }
  if (
    requestedMinutes < startMinutes ||
    requestedMinutes + durationMinutes > endMinutes ||
    (requestedMinutes - startMinutes) % interval !== 0
  ) {
    return "That time is outside the creator's available slots.";
  }
  return null;
}

/**
 * Integrations are runtime fulfilment dependencies rather than product copy.
 * Keep this check separate from the static publication contract so it can be
 * re-evaluated when a creator disconnects Google Calendar or Fathom later.
 */
export function commerceDeliveryIntegrationError(
  product: Pick<CommerceProductRecord, "kind" | "settings">,
  readiness: { calendar: boolean; fathom: boolean },
) {
  if (product.kind !== "coaching_call") return null;
  const settings = product.settings ?? {};
  if (!readiness.calendar && !validCommerceHttpUrl(settings.meetingUrl)) {
    return "Connect Google Calendar or add a fallback meeting link before selling this session.";
  }
  const recordingAddonPrice = Number(settings.recordingAddonPrice || 0);
  if (settings.recordingAddonEnabled && recordingAddonPrice > 0 && !readiness.fathom) {
    return "Connect Fathom before selling a recording add-on.";
  }
  return null;
}

function commerceSettingRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function commerceSettingArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

/**
 * Product settings mix public merchandising with private fulfilment data.
 * Every public product response must pass through this runtime allowlist.
 */
export function sanitizeCommerceSettingsForPublic(
  kind: CommerceProductKind,
  rawSettings: unknown,
): CommerceProductSettings {
  const settings = commerceSettingRecord(rawSettings);
  switch (kind) {
    case "digital_product":
      return {
        files: commerceSettingArray(settings.files).map((value) => {
          const file = commerceSettingRecord(value);
          return {
            id: String(file.id ?? ""),
            name: String(file.name ?? "Download"),
            size: Number(file.size ?? 0),
            mimeType: String(file.mimeType ?? "application/octet-stream"),
          };
        }),
      };
    case "coaching_call":
      return {
        durationMinutes: Number(settings.durationMinutes || 60),
        timezone: String(settings.timezone || ""),
        availabilitySummary: String(settings.availabilitySummary || ""),
        availabilityDays: commerceSettingArray(settings.availabilityDays)
          .map(Number)
          .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6),
        availabilityStart: String(settings.availabilityStart || "09:00"),
        availabilityEnd: String(settings.availabilityEnd || "17:00"),
        slotIntervalMinutes: Number(settings.slotIntervalMinutes || 30),
        recordingAddonEnabled: Boolean(settings.recordingAddonEnabled),
        recordingAddonPrice: Math.max(0, Number(settings.recordingAddonPrice || 0)),
      };
    case "course":
      return {
        lessons: commerceSettingArray(settings.lessons).map((value, index) => {
          const lesson = commerceSettingRecord(value);
          return {
            id: String(lesson.id ?? `lesson-${index + 1}`),
            title: String(lesson.title ?? "Lesson"),
            summary: String(lesson.summary ?? ""),
            isPreview: Boolean(lesson.isPreview),
          };
        }),
      };
    case "webinar":
      return {
        startsAt: String(settings.startsAt || ""),
        durationMinutes: Number(settings.durationMinutes || 60),
        replayAvailable: Boolean(settings.replayUrl),
      };
    case "paid_community":
      return {
        welcomeMessage: String(settings.welcomeMessage || ""),
        rules: String(settings.rules || ""),
        allowMemberPosts: settings.allowMemberPosts !== false,
      };
    case "membership":
      return {
        benefits: commerceSettingArray(settings.benefits)
          .map((benefit) => String(benefit))
          .filter(Boolean),
      };
    case "custom_product":
      return {
        buyerQuestions: commerceSettingArray(settings.buyerQuestions)
          .map((question) => String(question))
          .filter(Boolean),
      };
    case "priority_dm":
      return {
        priorityPrompt: String(settings.priorityPrompt || "What would you like to ask?"),
        responseTimeHours: Math.min(720, Math.max(1, Number(settings.responseTimeHours || 48))),
        freeFollowUpLimit:
          Number.isInteger(Number(settings.freeFollowUpLimit)) &&
          Number(settings.freeFollowUpLimit) >= 0 &&
          Number(settings.freeFollowUpLimit) <= 100
            ? Number(settings.freeFollowUpLimit)
            : 0,
        followUpPriceAmount:
          Number.isInteger(Number(settings.followUpPriceAmount)) &&
          Number(settings.followUpPriceAmount) > 0 &&
          Number(settings.followUpPriceAmount) <= 100_000_000
            ? Number(settings.followUpPriceAmount)
            : undefined,
      };
    case "bundle":
      return {
        bundledProductIds: commerceSettingArray(settings.bundledProductIds)
          .map((id) => String(id))
          .filter(Boolean),
      };
    case "newsletter":
      return {};
    case "lead_form":
      return {
        fields: commerceSettingArray(settings.fields).map((value, index) => {
          const field = commerceSettingRecord(value);
          return {
            id: String(field.id ?? `field-${index + 1}`),
            label: String(field.label ?? "Question"),
            type: field.type === "email" ? ("email" as const) : ("text" as const),
            required: Boolean(field.required),
          };
        }),
        confirmationMessage: String(settings.confirmationMessage || "You're in. Thank you."),
      };
    case "bento_affiliate":
      return {};
  }
}
