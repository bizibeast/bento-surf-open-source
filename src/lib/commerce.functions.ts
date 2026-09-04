/* eslint-disable @typescript-eslint/no-explicit-any -- Commerce tables are introduced by the pending staging migration; remove after regenerating Supabase types. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { nextEmptyGridRow } from "./grid-geometry";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enforceRequestRateLimit } from "./request-security.server";
import { parsePublicHttpUrl } from "./safe-url";
import {
  enqueueBookingCancellationEmails,
  enqueueBookingConfirmationEmails,
  enqueueCommerceOrderEmails,
  enqueueCreatorLeadEmail,
  recordEmailMarketingCapacityBlock,
} from "./email.server";
import { getPlan, requirePlanEntitlement } from "./plan.server";
import { commerceEntitlement, entitlementUpgradeMessage, planHasEntitlement } from "./plans";
import {
  calculateCommerceAmounts,
  commerceCheckoutProduct,
  commerceDeliveryIntegrationError,
  commerceKind,
  commerceProductBlockContent,
  commerceProductPublishabilityError,
  type CommerceBuyerAnswer,
  type CommerceFormField,
  isPlausibleCommerceAccessToken,
  commercePlatformFeeBps,
  commercePricingTypeSchema,
  commerceProductKindSchema,
  isHostedAccessKind,
  isCommerceOfferKind,
  isCompletedCommerceCheckoutStatus,
  isStartedCommerceCheckoutStatus,
  commerceOrderConfirmationState,
  sanitizeCommerceSettingsForPublic,
  assertGenericCommerceProductMutationAllowed,
  slugifyCommerceProduct,
  type CommerceProductRecord,
} from "./commerce";
import { availableSlotsForAccessToken, bookingContextForAccessToken } from "./booking.functions";
import { bookingBlockedWindow, bookingCanBeCanceled } from "./booking";
import { createGoogleMeetEvent, deleteGoogleCalendarEvent } from "./booking-google.server";
import {
  creatorPaymentCompatibility,
  creatorPaymentSupportsCheckoutAdjustments,
  type CreatorPaymentProvider,
} from "./payment-providers";
import {
  creatorStorePaymentSetup,
  requireCreatorStorePaymentSetup,
  requireReadyCreatorPaymentProvider,
} from "./payment-connection-policy.server";
import { resolveCommerceCheckoutGrowth } from "./commerce-growth.server";
import { resolveCommerceGrantByToken } from "./commerce-access.server";
import {
  resolveBundleDeliveryProductIds,
  resolveBundleDigitalDeliveryFiles,
  resolveDigitalDeliveryFiles,
  verifyDigitalProductAssets,
} from "./commerce-assets.server";
import { communityMemberName } from "./community-member";
import { resolvePublicUsername } from "./username-alias.server";
import {
  configuredAppOrigin,
  configuredPublicOrigin,
  publicProductSuccessPath,
} from "./application-urls";
import { currentCustomerSession } from "./customer-library-auth.server";
import { priorityDmFollowUpAnswer } from "./priority-dm";
import { loadPriorityDmPaidFollowUp } from "./priority-dm.server";

const uuidSchema = z.string().uuid();
const pageIdSchema = uuidSchema.nullable().optional();
const httpUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .refine((value) => Boolean(parsePublicHttpUrl(value)), "Use a public HTTP or HTTPS URL.");
const currencySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{3}$/);
const billingIntervalSchema = z.enum(["day", "week", "month", "year"]);

export const requireCommerceKind = (userId: string, kind: string) => {
  const entitlement = commerceEntitlement(kind);
  return requirePlanEntitlement(userId, entitlement, entitlementUpgradeMessage(entitlement));
};

export async function requireCalendarBlockSetup(db: any, userId: string) {
  const [availability, calendar, session] = await Promise.all([
    db.from("booking_availability").select("creator_id").eq("creator_id", userId).maybeSingle(),
    db
      .from("booking_calendar_connections")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "active")
      .limit(1)
      .maybeSingle(),
    db
      .from("commerce_products")
      .select("id")
      .eq("creator_id", userId)
      .eq("kind", "coaching_call")
      .neq("status", "archived")
      .limit(1)
      .maybeSingle(),
  ]);
  if (availability.error) throw new Error(availability.error.message);
  if (calendar.error) throw new Error(calendar.error.message);
  if (session.error) throw new Error(session.error.message);
  if (!calendar.data || !availability.data || !session.data) {
    throw new Error(
      "Finish Calendar setup before adding this block: connect Google Calendar, save your availability, and create a session.",
    );
  }
}

function unsafeCommerceSetting(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (typeof value === "string") return value.length > 20_000;
  if (Array.isArray(value)) {
    return value.length > 200 || value.some((item) => unsafeCommerceSetting(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      entries.length > 200 ||
      entries.some(
        ([key, item]) =>
          key.length > 100 ||
          ["__proto__", "prototype", "constructor"].includes(key) ||
          unsafeCommerceSetting(item, depth + 1),
      )
    );
  }
  return false;
}

export const productDraftSchema = z
  .object({
    kind: commerceProductKindSchema,
    title: z.string().trim().min(1).max(120),
    subtitle: z.string().trim().max(180).default(""),
    description: z.string().trim().max(20_000).default(""),
    cover_url: httpUrlSchema.nullable().optional(),
    pricing_type: commercePricingTypeSchema,
    price_amount: z.number().int().min(0).max(100_000_000),
    currency: currencySchema.default("usd"),
    billing_interval: billingIntervalSchema.nullable().optional(),
    cta_label: z.string().trim().min(1).max(40),
    settings: z.record(z.string(), z.any()).default({}),
    inventory_limit: z.number().int().positive().max(1_000_000).nullable().optional(),
    noindex: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (JSON.stringify(value.settings).length > 100_000) {
      context.addIssue({ code: "custom", message: "Product settings are too large." });
    }
    if (unsafeCommerceSetting(value.settings)) {
      context.addIssue({ code: "custom", message: "Product settings contain invalid data." });
    }
    if (value.pricing_type === "free" && value.price_amount !== 0) {
      context.addIssue({ code: "custom", message: "Free products must have a zero price." });
    }
    if (value.pricing_type !== "free" && value.price_amount <= 0) {
      context.addIssue({ code: "custom", message: "Paid products need a price." });
    }
    if (value.pricing_type === "subscription" && !value.billing_interval) {
      context.addIssue({ code: "custom", message: "Subscriptions need a billing interval." });
    }
    if (value.pricing_type !== "subscription" && value.billing_interval) {
      context.addIssue({ code: "custom", message: "Only subscriptions use a billing interval." });
    }
    if (["lead_form", "bento_affiliate"].includes(value.kind) && value.pricing_type !== "free") {
      context.addIssue({ code: "custom", message: "This block is always free for the visitor." });
    }
    if (["priority_dm", "bundle"].includes(value.kind) && value.pricing_type !== "one_time") {
      context.addIssue({
        code: "custom",
        path: ["pricing_type"],
        message: "Priority messages and bundles use one-time pricing.",
      });
    }
    const settings = value.settings;
    if (value.kind === "priority_dm") {
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
        context.addIssue({
          code: "custom",
          path: ["settings"],
          message: "Choose 0 to 100 free follow-ups and a valid paid follow-up price.",
        });
      }
    }
    if (value.kind === "digital_product" && settings.files !== undefined) {
      if (!Array.isArray(settings.files) || settings.files.length > 100) {
        context.addIssue({
          code: "custom",
          path: ["settings", "files"],
          message: "Add no more than 100 buyer files.",
        });
      } else {
        const ids = new Set<string>();
        const keys = new Set<string>();
        settings.files.forEach((candidate: unknown, index: number) => {
          const file =
            candidate && typeof candidate === "object"
              ? (candidate as Record<string, unknown>)
              : {};
          const id = String(file.id || "");
          const key = String(file.key || "");
          const name = String(file.name || "").trim();
          const size = Number(file.size);
          const mimeType = String(file.mimeType || "");
          if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
            context.addIssue({
              code: "custom",
              path: ["settings", "files", index, "id"],
              message: "Buyer file identifier is invalid.",
            });
          }
          if (
            !key ||
            key.length > 500 ||
            key.startsWith("/") ||
            key.includes("..") ||
            !key.startsWith("private/users/")
          ) {
            context.addIssue({
              code: "custom",
              path: ["settings", "files", index, "key"],
              message: "Buyer file storage reference is invalid.",
            });
          }
          if (!name || name.length > 180 || /[\r\n"\\/]/.test(name)) {
            context.addIssue({
              code: "custom",
              path: ["settings", "files", index, "name"],
              message: "Buyer file name is invalid.",
            });
          }
          if (!Number.isSafeInteger(size) || size <= 0 || size > 5 * 1024 * 1024 * 1024) {
            context.addIssue({
              code: "custom",
              path: ["settings", "files", index, "size"],
              message: "Buyer file size is invalid.",
            });
          }
          if (!mimeType || mimeType.length > 200 || /[\r\n]/.test(mimeType)) {
            context.addIssue({
              code: "custom",
              path: ["settings", "files", index, "mimeType"],
              message: "Buyer file type is invalid.",
            });
          }
          if (ids.has(id) || keys.has(key)) {
            context.addIssue({
              code: "custom",
              path: ["settings", "files", index],
              message: "Each buyer file can only be attached once.",
            });
          }
          ids.add(id);
          keys.add(key);
        });
      }
    }
    if (value.kind === "coaching_call" && settings.recordingAddonEnabled) {
      const recordingPrice = Number(settings.recordingAddonPrice);
      if (
        !Number.isInteger(recordingPrice) ||
        recordingPrice <= 0 ||
        recordingPrice > 100_000_000
      ) {
        context.addIssue({
          code: "custom",
          path: ["settings", "recordingAddonPrice"],
          message: "Set a valid recording add-on price.",
        });
      }
    }
    if (value.kind === "custom_product" && settings.buyerQuestions !== undefined) {
      if (!Array.isArray(settings.buyerQuestions) || settings.buyerQuestions.length > 20) {
        context.addIssue({
          code: "custom",
          path: ["settings", "buyerQuestions"],
          message: "Add no more than 20 buyer questions.",
        });
      } else {
        const normalized = new Set<string>();
        settings.buyerQuestions.forEach((question: unknown, index: number) => {
          const value = String(question || "").trim();
          if (!value || value.length > 500) {
            context.addIssue({
              code: "custom",
              path: ["settings", "buyerQuestions", index],
              message: "Buyer questions must be between 1 and 500 characters.",
            });
          }
          const key = value.toLowerCase();
          if (key && normalized.has(key)) {
            context.addIssue({
              code: "custom",
              path: ["settings", "buyerQuestions", index],
              message: "Buyer questions must be unique.",
            });
          }
          normalized.add(key);
        });
      }
    }
    const checkHttpSetting = (setting: unknown, path: (string | number)[]) => {
      if (setting === undefined || setting === null || setting === "") return;
      const parsed = httpUrlSchema.safeParse(setting);
      if (!parsed.success) {
        context.addIssue({
          code: "custom",
          path: ["settings", ...path],
          message: "Use a valid HTTP or HTTPS URL.",
        });
      }
    };
    if (value.kind === "coaching_call") checkHttpSetting(settings.meetingUrl, ["meetingUrl"]);
    if (value.kind === "webinar") {
      if (
        settings.startsAt &&
        !z.string().datetime({ offset: true }).safeParse(settings.startsAt).success
      ) {
        context.addIssue({
          code: "custom",
          path: ["settings", "startsAt"],
          message: "Choose a valid webinar date and time.",
        });
      }
      checkHttpSetting(settings.joinUrl, ["joinUrl"]);
      checkHttpSetting(settings.replayUrl, ["replayUrl"]);
    }
    if (value.kind === "course" && Array.isArray(settings.lessons)) {
      settings.lessons.forEach((lesson: unknown, index: number) => {
        if (lesson && typeof lesson === "object") {
          checkHttpSetting((lesson as Record<string, unknown>).url, ["lessons", index, "url"]);
        }
      });
    }
  });

export function resolveProductNoindex(value: boolean | undefined, existing = true) {
  return value ?? existing;
}

type CommerceProductRow = CommerceProductRecord & {
  creator_id: string;
  created_at: string;
  updated_at: string;
};

type CreatorBookingIntegrationReadiness = {
  calendar: boolean;
  fathom: boolean;
};

async function creatorBookingIntegrationReadiness(
  creatorId: string,
): Promise<CreatorBookingIntegrationReadiness> {
  const db = commerceDb(supabaseAdmin);
  const [calendarResult, fathomResult] = await Promise.all([
    db
      .from("booking_calendar_connections")
      .select("id")
      .eq("user_id", creatorId)
      .eq("status", "active")
      .eq("is_default", true)
      .limit(1)
      .maybeSingle(),
    db
      .from("booking_fathom_connections")
      .select("id")
      .eq("user_id", creatorId)
      .eq("status", "active")
      .eq("is_default", true)
      .limit(1)
      .maybeSingle(),
  ]);
  if (calendarResult.error) throw new Error(calendarResult.error.message);
  if (fathomResult.error) throw new Error(fathomResult.error.message);
  return {
    calendar: Boolean(calendarResult.data),
    fathom: Boolean(fathomResult.data),
  };
}

async function requireCommerceDeliveryIntegrations(
  product: CommerceProductRow,
  readiness?: CreatorBookingIntegrationReadiness,
) {
  if (product.kind !== "coaching_call") return;
  const reason = commerceDeliveryIntegrationError(
    product,
    readiness || (await creatorBookingIntegrationReadiness(product.creator_id)),
  );
  if (reason) throw new Error(reason);
}

async function commerceRuntimeAvailabilityError(
  product: CommerceProductRow,
  configuredProvider: string,
  readiness?: CreatorBookingIntegrationReadiness,
) {
  const staticError = commerceProductPublishabilityError(product);
  if (staticError) return staticError;
  try {
    await requireCommerceDeliveryIntegrations(product, readiness);
    const recordingAddonAmount =
      product.kind === "coaching_call" && product.settings?.recordingAddonEnabled
        ? Math.max(0, Math.round(Number(product.settings.recordingAddonPrice || 0)))
        : 0;
    const effectivePricingType =
      product.pricing_type === "free" && recordingAddonAmount > 0
        ? ("one_time" as const)
        : product.pricing_type;
    if (effectivePricingType === "free") return null;
    const deployment = process.env.APP_ENV || process.env.VITE_APP_ENV || "production";
    if (configuredProvider === "mock" && deployment === "staging") return null;
    const compatibility = creatorPaymentCompatibility(
      configuredProvider,
      product.kind,
      effectivePricingType,
    );
    if (!compatibility.supported) {
      return compatibility.reason || "This payment gateway cannot sell this offer.";
    }
    if (
      recordingAddonAmount > 0 &&
      !creatorPaymentSupportsCheckoutAdjustments(configuredProvider)
    ) {
      return "Paid recording add-ons require Stripe, PayPal, or Razorpay.";
    }
    await requireReadyCreatorPaymentProvider(
      product.creator_id,
      configuredProvider as CreatorPaymentProvider,
    );
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "This offer is temporarily unavailable.";
  }
}

async function commerceOrderBumpAvailability(
  db: any,
  input: {
    bumpProductId: string;
    creatorId: string;
    configuredProvider: string;
  },
) {
  const { data: bumpProduct, error } = await db
    .from("commerce_products")
    .select("*")
    .eq("id", input.bumpProductId)
    .eq("creator_id", input.creatorId)
    .eq("status", "published")
    .eq("pricing_type", "one_time")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!bumpProduct) {
    return { product: null, reason: "That order bump is no longer available." };
  }
  if (bumpProduct.inventory_limit && bumpProduct.sales_count >= bumpProduct.inventory_limit) {
    return { product: null, reason: "That order bump is sold out." };
  }
  const reason = await commerceRuntimeAvailabilityError(bumpProduct, input.configuredProvider);
  return reason ? { product: null, reason } : { product: bumpProduct, reason: null };
}

function commerceDb(client: unknown) {
  return client as any;
}

function appUrl() {
  return configuredAppOrigin(process.env.VITE_APP_URL);
}

function publicAppUrl() {
  return configuredPublicOrigin(process.env.VITE_PUBLIC_URL);
}

function deliveredCourseLesson(row: any) {
  const content =
    row?.content && typeof row.content === "object" && !Array.isArray(row.content)
      ? row.content
      : {};
  return {
    id: String(row.id),
    moduleTitle: String(row.module_title || "Course"),
    position: Number(row.position || 0),
    title: String(row.title || "Lesson"),
    summary: String(row.summary || ""),
    contentType: ["video", "file", "link"].includes(row.content_type) ? row.content_type : "text",
    body: String(content.body || ""),
    url: String(content.url || ""),
    isPreview: Boolean(row.is_preview),
  };
}

export async function uniqueProductSlug(db: any, username: string, title: string) {
  const root = slugifyCommerceProduct(`${username}-${title}`) || `${username}-product`;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${crypto.randomUUID().slice(0, 6)}`;
    const candidate = `${root.slice(0, 90 - suffix.length)}${suffix}`;
    const { data, error } = await db
      .from("commerce_products")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return candidate;
  }
  return `${root.slice(0, 80)}-${crypto.randomUUID().slice(0, 12)}`;
}

export async function uniquePublicProductSlug(db: any, creatorId: string, title: string) {
  const titleSlug = slugifyCommerceProduct(title);
  const root = titleSlug.length >= 3 ? titleSlug : `${titleSlug || "product"}-product`;
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const candidate = `${root.slice(0, 64 - suffix.length)}${suffix}`;
    const { data, error } = await db
      .from("commerce_products")
      .select("id")
      .eq("creator_id", creatorId)
      .eq("public_slug", candidate)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return candidate;
  }
  return `${root.slice(0, 51)}-${crypto.randomUUID().slice(0, 12)}`;
}

export const getMyCommerce = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = commerceDb(supabaseAdmin);
    const [
      plan,
      paymentSetup,
      productsResult,
      ordersResult,
      leadsResult,
      contactsResult,
      eventsResult,
      webinarRegistrationsResult,
      paymentSessionsResult,
      discountCodesResult,
      orderBumpsResult,
      orderItemsResult,
      audienceListsResult,
      audienceListMembersResult,
      audienceCampaignsResult,
      dashboardStatsResult,
    ] = await Promise.all([
      getPlan(context.userId),
      creatorStorePaymentSetup(context.userId),
      db
        .from("commerce_products")
        .select("*")
        .eq("creator_id", context.userId)
        .order("created_at", { ascending: false }),
      db
        .from("commerce_orders")
        .select("*")
        .eq("creator_id", context.userId)
        .order("created_at", { ascending: false })
        .limit(100),
      db
        .from("commerce_leads")
        .select("*")
        .eq("creator_id", context.userId)
        .order("created_at", { ascending: false })
        .limit(100),
      db
        .from("audience_contacts")
        .select("*")
        .eq("creator_id", context.userId)
        .order("last_seen_at", { ascending: false })
        .limit(500),
      db
        .from("audience_events")
        .select("*")
        .eq("creator_id", context.userId)
        .order("occurred_at", { ascending: false })
        .limit(1_000),
      db
        .from("commerce_webinar_registrations")
        .select("*")
        .eq("creator_id", context.userId)
        .order("starts_at", { ascending: false })
        .limit(1_000),
      db
        .from("commerce_payment_sessions")
        .select(
          "id, product_id, status, amount:gross_amount, currency, subtotal_amount, discount_amount, bump_amount, attribution, created_at, updated_at",
        )
        .eq("creator_id", context.userId)
        .order("created_at", { ascending: false })
        .limit(2_000),
      db
        .from("commerce_discount_codes")
        .select("*")
        .eq("creator_id", context.userId)
        .order("created_at", { ascending: false }),
      db
        .from("commerce_order_bumps")
        .select("*")
        .eq("creator_id", context.userId)
        .order("created_at", { ascending: false }),
      db
        .from("commerce_order_items")
        .select("*, commerce_orders!inner(creator_id)")
        .eq("commerce_orders.creator_id", context.userId)
        .order("created_at", { ascending: false })
        .limit(2_000),
      db
        .from("audience_lists")
        .select("*")
        .eq("creator_id", context.userId)
        .order("created_at", { ascending: false }),
      db
        .from("audience_list_members")
        .select("list_id, contact_id, audience_lists!inner(creator_id)")
        .eq("audience_lists.creator_id", context.userId)
        .limit(10_000),
      db
        .from("audience_campaigns")
        .select("*")
        .eq("creator_id", context.userId)
        .order("created_at", { ascending: false })
        .limit(500),
      db.rpc("get_creator_commerce_dashboard_stats", { p_creator_id: context.userId }),
    ]);
    if (productsResult.error) throw new Error(productsResult.error.message);
    const rowsOrEmpty = (label: string, result: any) => {
      if (result.error) {
        console.error(`[Commerce] ${label} dashboard read failed: ${result.error.message}`);
        return [];
      }
      return result.data ?? [];
    };
    const products = productsResult.data ?? [];
    const orders = rowsOrEmpty("orders", ordersResult);
    const completedOrders = orders.filter((order: any) =>
      ["paid", "partially_refunded", "refunded"].includes(order.status),
    );
    const leads = rowsOrEmpty("leads", leadsResult);
    const contacts = rowsOrEmpty("audience contacts", contactsResult);
    const events = rowsOrEmpty("audience events", eventsResult);
    const webinarRegistrations = rowsOrEmpty("webinar registrations", webinarRegistrationsResult);
    const paymentSessions = rowsOrEmpty("payment sessions", paymentSessionsResult);
    const discountCodes = rowsOrEmpty("discount codes", discountCodesResult);
    const orderBumps = rowsOrEmpty("order bumps", orderBumpsResult);
    const orderItems = rowsOrEmpty("order items", orderItemsResult);
    const audienceLists = rowsOrEmpty("audience lists", audienceListsResult);
    const audienceListMembers = rowsOrEmpty("audience list members", audienceListMembersResult);
    const audienceCampaigns = rowsOrEmpty("audience campaigns", audienceCampaignsResult);
    const recentStartedCheckouts = paymentSessions.filter((session: any) =>
      isStartedCommerceCheckoutStatus(session.status),
    ).length;
    const recentCompletedCheckouts = paymentSessions.filter((session: any) =>
      isCompletedCommerceCheckoutStatus(session.status),
    ).length;
    const recentDiscountedCheckouts = paymentSessions.filter(
      (session: any) => Number(session.discount_amount || 0) > 0,
    ).length;
    const recentBumpCheckouts = paymentSessions.filter(
      (session: any) => Number(session.bump_amount || 0) > 0,
    ).length;
    const recentFailedCheckouts = paymentSessions.filter((session: any) =>
      ["failed", "expired", "canceled"].includes(session.status),
    ).length;
    const recentTotalsByCurrency = new Map<
      string,
      { currency: string; orders: number; revenue: number; net: number; fees: number }
    >();
    for (const order of completedOrders) {
      const currency = String(order.currency || "usd").toLowerCase();
      const totals = recentTotalsByCurrency.get(currency) || {
        currency,
        orders: 0,
        revenue: 0,
        net: 0,
        fees: 0,
      };
      totals.orders += 1;
      totals.revenue += Math.max(
        0,
        Number(order.gross_amount || 0) - Number(order.refunded_amount || 0),
      );
      totals.net += Math.max(0, Number(order.net_amount || 0) - Number(order.refunded_amount || 0));
      totals.fees +=
        Number(order.platform_fee_amount || 0) + Number(order.processor_fee_amount || 0);
      recentTotalsByCurrency.set(currency, totals);
    }
    const fallbackStats = {
      orders: completedOrders.length,
      leads: leads.length,
      audience: contacts.length,
      checkoutStarted: recentStartedCheckouts,
      checkoutCompleted: recentCompletedCheckouts,
      checkoutFailed: recentFailedCheckouts,
      discountedCheckouts: recentDiscountedCheckouts,
      bumpCheckouts: recentBumpCheckouts,
      moneyByCurrency: [...recentTotalsByCurrency.values()],
    };
    if (dashboardStatsResult.error) {
      console.error(
        `[Commerce] exact dashboard stats read failed: ${dashboardStatsResult.error.message}`,
      );
    }
    const exactStats =
      dashboardStatsResult.data &&
      typeof dashboardStatsResult.data === "object" &&
      !Array.isArray(dashboardStatsResult.data)
        ? (dashboardStatsResult.data as Record<string, unknown>)
        : fallbackStats;
    const countStat = (key: keyof typeof fallbackStats) => {
      const value = Number(exactStats[key]);
      return Number.isSafeInteger(value) && value >= 0 ? value : Number(fallbackStats[key] || 0);
    };
    const moneyByCurrency = Array.isArray(exactStats.moneyByCurrency)
      ? exactStats.moneyByCurrency
          .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
          .map((row) => ({
            currency: String(row.currency || "usd").toLowerCase(),
            orders: Math.max(0, Number(row.orders || 0)),
            revenue: Math.max(0, Number(row.revenue || 0)),
            net: Math.max(0, Number(row.net || 0)),
            fees: Math.max(0, Number(row.fees || 0)),
          }))
      : fallbackStats.moneyByCurrency;
    const singleCurrencyTotals =
      moneyByCurrency.length === 1
        ? moneyByCurrency[0]
        : { revenue: 0, net: 0, fees: 0, currency: null };
    const startedCheckouts = countStat("checkoutStarted");
    const completedCheckouts = countStat("checkoutCompleted");
    return {
      products: productsResult.data ?? [],
      orders,
      leads,
      audienceContacts: contacts,
      audienceEvents: events,
      webinarRegistrations,
      paymentSessions,
      discountCodes,
      orderBumps,
      orderItems: orderItems.map(({ commerce_orders: _commerceOrders, ...item }: any) => item),
      audienceLists,
      audienceListMembers: audienceListMembers.map(
        ({ audience_lists: _audienceLists, ...member }: any) => member,
      ),
      audienceCampaigns,
      stats: {
        products: products.filter((product: any) => isCommerceOfferKind(product.kind)).length,
        growth: products.filter((product: any) => !isCommerceOfferKind(product.kind)).length,
        published: products.filter(
          (product: any) => isCommerceOfferKind(product.kind) && product.status === "published",
        ).length,
        orders: countStat("orders"),
        leads: countStat("leads"),
        audience: countStat("audience"),
        checkoutStarted: startedCheckouts,
        checkoutCompleted: completedCheckouts,
        checkoutFailed: countStat("checkoutFailed"),
        checkoutConversion:
          startedCheckouts > 0
            ? Math.round((completedCheckouts / startedCheckouts) * 10_000) / 100
            : 0,
        discountedCheckouts: countStat("discountedCheckouts"),
        bumpCheckouts: countStat("bumpCheckouts"),
        revenue: singleCurrencyTotals.revenue,
        net: singleCurrencyTotals.net,
        fees: singleCurrencyTotals.fees,
        currency: singleCurrencyTotals.currency,
        moneyByCurrency,
      },
      environment: {
        app: process.env.APP_ENV || process.env.VITE_APP_ENV || "production",
        payments: process.env.COMMERCE_PAYMENT_PROVIDER || "disabled",
      },
      locked: !planHasEntitlement(plan, "storeCards"),
      plan,
      storeSetup: paymentSetup,
    };
  });

export const getStoreOnboardingStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [plan, paymentSetup] = await Promise.all([
      getPlan(context.userId),
      creatorStorePaymentSetup(context.userId),
    ]);
    return {
      locked: !planHasEntitlement(plan, "storeCards"),
      plan,
      ...paymentSetup,
    };
  });

export const setWebinarRegistrationAttendance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        registrationId: uuidSchema,
        status: z.enum(["registered", "attended", "no_show"]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const db = commerceDb(context.supabase);
    const { data: registration, error } = await db
      .from("commerce_webinar_registrations")
      .update({
        status: data.status,
        attended_at: data.status === "attended" ? new Date().toISOString() : null,
      })
      .eq("id", data.registrationId)
      .eq("creator_id", context.userId)
      .neq("status", "canceled")
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!registration) throw new Error("Webinar registration not found or canceled.");
    return registration;
  });

export const createCommerceProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        product: productDraftSchema,
        addToBento: z.boolean().default(true),
        pageId: pageIdSchema,
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    assertGenericCommerceProductMutationAllowed(data.product.kind);
    await requireCommerceKind(context.userId, data.product.kind);
    if (
      isCommerceOfferKind(data.product.kind) &&
      (data.product.kind !== "coaching_call" || data.addToBento)
    ) {
      await requireCreatorStorePaymentSetup(context.userId);
    }
    await verifyDigitalProductAssets(context.userId, data.product.kind, data.product.settings);
    const db = commerceDb(context.supabase);
    if (data.product.kind === "coaching_call" && data.addToBento) {
      await requireCalendarBlockSetup(db, context.userId);
    }
    const { data: profile, error: profileError } = await db
      .from("profiles")
      .select("username")
      .eq("id", context.userId)
      .single();
    if (profileError || !profile) throw new Error(profileError?.message || "Profile not found.");
    const [slug, publicSlug] = await Promise.all([
      uniqueProductSlug(db, profile.username, data.product.title),
      uniquePublicProductSlug(db, context.userId, data.product.title),
    ]);
    const productInput = {
      ...data.product,
      noindex: resolveProductNoindex(data.product.noindex),
      creator_id: context.userId,
      slug,
      public_slug: publicSlug,
      cover_url: data.product.cover_url || null,
      billing_interval:
        data.product.pricing_type === "subscription" ? data.product.billing_interval : null,
      inventory_limit: data.product.inventory_limit ?? null,
    };

    // Resolve the target page layout before writing the product. A failed layout read must not
    // leave a product behind while the creator sees a failed creation message.
    let existingLayout: Array<{ y: number; h: number }> = [];
    if (data.addToBento) {
      let layoutQuery = db.from("blocks").select("y,h").eq("user_id", context.userId);
      layoutQuery = data.pageId
        ? layoutQuery.eq("page_id", data.pageId)
        : layoutQuery.is("page_id", null);
      const { data: layout, error: layoutError } = await layoutQuery;
      if (layoutError) throw new Error(layoutError.message);
      existingLayout = layout ?? [];
    }

    const { data: created, error } = await db
      .from("commerce_products")
      .insert(productInput)
      .select("*")
      .single();
    if (error || !created) throw new Error(error?.message || "Product could not be created.");

    const rollbackCreatedProduct = async () => {
      const { error: rollbackError } = await db
        .from("commerce_products")
        .delete()
        .eq("id", created.id)
        .eq("creator_id", context.userId);
      if (rollbackError) {
        console.error(
          `[Commerce] Failed to roll back product ${created.id}: ${rollbackError.message}`,
        );
      }
      return !rollbackError;
    };

    let product = created;
    try {
      await validateCommerceProductPublication(context.userId, created);
      const { data: published, error: publishError } = await db
        .from("commerce_products")
        .update({ status: "published", published_at: new Date().toISOString() })
        .eq("id", created.id)
        .eq("creator_id", context.userId)
        .select("*")
        .single();
      if (publishError || !published) {
        throw new Error(publishError?.message || "Product could not be published.");
      }
      product = published;
    } catch (publishError) {
      if (!(await rollbackCreatedProduct())) {
        throw new Error(
          "The product was created but could not be published. Refresh Products before trying again.",
        );
      }
      throw publishError;
    }

    let block = null;
    if (data.addToBento) {
      const { data: createdBlock, error: blockError } = await db
        .from("blocks")
        .insert({
          user_id: context.userId,
          type: "commerce",
          content: commerceProductBlockContent(product, profile.username),
          cover_url: product.cover_url,
          x: 0,
          y: nextEmptyGridRow(existingLayout),
          w: 2,
          h: 2,
          position: existingLayout.length,
          page_id: data.pageId ?? null,
        })
        .select("*")
        .single();
      if (blockError || !createdBlock) {
        if (!(await rollbackCreatedProduct())) {
          throw new Error(
            "The product was created but its Bento block could not be added. Refresh Products before trying again.",
          );
        }
        throw new Error(blockError?.message || "The Bento block could not be created.");
      }
      block = createdBlock;
    }
    return { product, block };
  });

export async function validateCommerceProductPublication(
  creatorId: string,
  product: CommerceProductRow,
) {
  await requireCommerceKind(creatorId, product.kind);
  const reason = commerceProductPublishabilityError(product);
  if (reason) throw new Error(reason);
  if (product.kind === "bundle") {
    const db = commerceDb(supabaseAdmin);
    const productIds = product.settings?.bundledProductIds || [];
    const { data: bundledProducts, error: bundleError } = await db
      .from("commerce_products")
      .select("id, kind, status")
      .eq("creator_id", creatorId)
      .in("id", productIds);
    if (bundleError) throw new Error(bundleError.message);
    if (
      bundledProducts?.length !== productIds.length ||
      bundledProducts.some(
        (item: { id: string; kind: string; status: string }) =>
          item.id === product.id ||
          item.status !== "published" ||
          !["digital_product", "course", "custom_product"].includes(item.kind),
      )
    ) {
      throw new Error(
        "Bundles can include your published downloads, courses, and custom products.",
      );
    }
  }
  await verifyDigitalProductAssets(creatorId, product.kind, product.settings);
  await requireCommerceDeliveryIntegrations(product);

  const recordingAddonAmount =
    product.kind === "coaching_call" && product.settings?.recordingAddonEnabled
      ? Math.max(0, Math.round(Number(product.settings.recordingAddonPrice || 0)))
      : 0;
  const effectivePricingType =
    product.pricing_type === "free" && recordingAddonAmount > 0
      ? ("one_time" as const)
      : product.pricing_type;
  if (effectivePricingType === "free") return;

  const { data: profile, error: profileError } = await commerceDb(supabaseAdmin)
    .from("profiles")
    .select("commerce_payment_provider,username")
    .eq("id", creatorId)
    .single();
  if (profileError) throw new Error(profileError.message);
  const deployment = process.env.APP_ENV || process.env.VITE_APP_ENV || "production";
  const configuredProvider = String(
    profile?.commerce_payment_provider || process.env.COMMERCE_PAYMENT_PROVIDER || "disabled",
  );
  if (configuredProvider === "mock" && deployment === "staging") return;

  const compatibility = creatorPaymentCompatibility(
    configuredProvider,
    product.kind,
    effectivePricingType,
  );
  if (!compatibility.supported) throw new Error(compatibility.reason || "Unavailable.");
  if (recordingAddonAmount > 0 && !creatorPaymentSupportsCheckoutAdjustments(configuredProvider)) {
    throw new Error(
      "Paid recording add-ons require Stripe, PayPal, or Razorpay. Connect one of those gateways before publishing.",
    );
  }

  const [discountResult, primaryBumpResult, attachedBumpResult] = await Promise.all([
    effectivePricingType === "one_time"
      ? commerceDb(supabaseAdmin)
          .from("commerce_discount_codes")
          .select("id, product_id, discount_type, discount_value, currency")
          .eq("creator_id", creatorId)
          .eq("is_active", true)
          .or(`product_id.is.null,product_id.eq.${product.id}`)
      : Promise.resolve({ data: [], error: null }),
    commerceDb(supabaseAdmin)
      .from("commerce_order_bumps")
      .select("id, bump_product_id")
      .eq("creator_id", creatorId)
      .eq("primary_product_id", product.id)
      .eq("is_active", true),
    commerceDb(supabaseAdmin)
      .from("commerce_order_bumps")
      .select("id, primary_product_id")
      .eq("creator_id", creatorId)
      .eq("bump_product_id", product.id)
      .eq("is_active", true),
  ]);
  if (discountResult.error) throw new Error(discountResult.error.message);
  if (primaryBumpResult.error) throw new Error(primaryBumpResult.error.message);
  if (attachedBumpResult.error) throw new Error(attachedBumpResult.error.message);

  const productDiscounts = (discountResult.data || []).filter(
    (discount: any) => discount.product_id === product.id,
  );
  if (
    productDiscounts.some(
      (discount: any) =>
        (discount.discount_type === "fixed" &&
          (discount.currency !== product.currency ||
            Number(discount.discount_value) >= product.price_amount)) ||
        (discount.discount_type === "percent" && Number(discount.discount_value) >= 10_000),
    )
  ) {
    throw new Error(
      "An active discount no longer fits this product's price or currency. Update or disable the discount before saving.",
    );
  }

  const activeBumps = [
    ...(primaryBumpResult.data || []).map((rule: any) => ({
      id: rule.id,
      relatedProductId: rule.bump_product_id,
    })),
    ...(attachedBumpResult.data || []).map((rule: any) => ({
      id: rule.id,
      relatedProductId: rule.primary_product_id,
    })),
  ];
  if (activeBumps.length) {
    if (effectivePricingType !== "one_time") {
      throw new Error(
        "This product is used by an active order bump. Disable that order bump before changing its pricing type.",
      );
    }
    const relatedIds = Array.from(
      new Set(activeBumps.map((rule) => String(rule.relatedProductId)).filter(Boolean)),
    );
    const { data: relatedProducts, error: relatedError } = await commerceDb(supabaseAdmin)
      .from("commerce_products")
      .select("id, status, pricing_type, currency, inventory_limit, sales_count")
      .in("id", relatedIds);
    if (relatedError) throw new Error(relatedError.message);
    const relatedById = new Map<string, any>(
      (relatedProducts || []).map((related: any) => [String(related.id), related]),
    );
    if (
      activeBumps.some((rule) => {
        const related = relatedById.get(String(rule.relatedProductId));
        return (
          !related ||
          related.status !== "published" ||
          related.pricing_type !== "one_time" ||
          related.currency !== product.currency ||
          (related.inventory_limit != null &&
            Number(related.sales_count) >= Number(related.inventory_limit))
        );
      })
    ) {
      throw new Error(
        "An active order bump no longer matches this product. Update or disable the order bump before saving.",
      );
    }
  }

  const hasCheckoutAdjustment =
    Boolean(discountResult.data?.length) || activeBumps.length > 0 || recordingAddonAmount > 0;
  if (hasCheckoutAdjustment && !creatorPaymentSupportsCheckoutAdjustments(configuredProvider)) {
    throw new Error(
      "Active discounts, order bumps, and paid recording add-ons require Stripe, PayPal, or Razorpay. Disable them or connect a compatible gateway before publishing.",
    );
  }
  await requireReadyCreatorPaymentProvider(creatorId, configuredProvider as CreatorPaymentProvider);
}

export const updateCommerceProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: uuidSchema, product: productDraftSchema }).parse(input))
  .handler(async ({ data, context }) => {
    assertGenericCommerceProductMutationAllowed(data.product.kind);
    const db = commerceDb(context.supabase);
    const { data: current, error: currentError } = await db
      .from("commerce_products")
      .select("*")
      .eq("id", data.id)
      .eq("creator_id", context.userId)
      .maybeSingle();
    if (currentError || !current) {
      throw new Error(currentError?.message || "Product not found.");
    }
    assertGenericCommerceProductMutationAllowed(current.kind);
    if (current.kind !== data.product.kind) {
      throw new Error("An existing item cannot be changed into a different type.");
    }
    await requireCommerceKind(context.userId, current.kind);
    await verifyDigitalProductAssets(context.userId, data.product.kind, data.product.settings);
    const patch = {
      ...data.product,
      noindex: resolveProductNoindex(data.product.noindex, current.noindex),
      cover_url: data.product.cover_url || null,
      billing_interval:
        data.product.pricing_type === "subscription" ? data.product.billing_interval : null,
      inventory_limit: data.product.inventory_limit ?? null,
    };
    if (current.status === "published") {
      await validateCommerceProductPublication(context.userId, {
        ...current,
        ...patch,
      });
    }
    const { data: updated, error } = await db
      .from("commerce_products")
      .update(patch)
      .eq("id", data.id)
      .eq("creator_id", context.userId)
      .select("*")
      .single();
    if (error || !updated) {
      throw new Error(error?.message || "Product could not be updated.");
    }
    return updated;
  });

export const setCommerceProductStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ id: uuidSchema, status: z.enum(["published", "archived"]) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const db = commerceDb(context.supabase);
    const { data: current, error: loadError } = await db
      .from("commerce_products")
      .select("*")
      .eq("id", data.id)
      .eq("creator_id", context.userId)
      .single();
    if (loadError || !current) throw new Error(loadError?.message || "Product not found.");
    assertGenericCommerceProductMutationAllowed(current.kind);
    if (data.status === "published") {
      await validateCommerceProductPublication(context.userId, current);
    }
    const { data: updated, error } = await db
      .from("commerce_products")
      .update({
        status: data.status,
        published_at:
          data.status === "published" ? current.published_at || new Date().toISOString() : null,
      })
      .eq("id", data.id)
      .eq("creator_id", context.userId)
      .select("*")
      .single();
    if (error || !updated)
      throw new Error(error?.message || "Product status could not be changed.");
    return updated;
  });

export const addCommerceProductBlock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ productId: uuidSchema, pageId: pageIdSchema }).parse(input))
  .handler(async ({ data, context }) => {
    const db = commerceDb(context.supabase);
    const { data: product, error } = await db
      .from("commerce_products")
      .select("*")
      .eq("id", data.productId)
      .eq("creator_id", context.userId)
      .single();
    if (error || !product) throw new Error(error?.message || "Product not found.");
    assertGenericCommerceProductMutationAllowed(product.kind);
    const { data: profile, error: profileError } = await db
      .from("profiles")
      .select("username")
      .eq("id", context.userId)
      .single();
    if (profileError || !profile) throw new Error(profileError?.message || "Profile not found.");
    await requireCommerceKind(context.userId, product.kind);
    await requireCreatorStorePaymentSetup(context.userId);
    if (product.kind === "coaching_call") {
      await requireCalendarBlockSetup(db, context.userId);
    }
    let layoutQuery = db.from("blocks").select("y,h").eq("user_id", context.userId);
    layoutQuery = data.pageId
      ? layoutQuery.eq("page_id", data.pageId)
      : layoutQuery.is("page_id", null);
    const { data: existingLayout, error: layoutError } = await layoutQuery;
    if (layoutError) throw new Error(layoutError.message);
    const { data: block, error: blockError } = await db
      .from("blocks")
      .insert({
        user_id: context.userId,
        type: "commerce",
        content: commerceProductBlockContent(product, profile.username),
        cover_url: product.cover_url,
        x: 0,
        y: nextEmptyGridRow(existingLayout ?? []),
        w: 2,
        h: 2,
        position: existingLayout?.length ?? 0,
        page_id: data.pageId ?? null,
      })
      .select("*")
      .single();
    if (blockError) throw new Error(blockError.message);
    return block;
  });

function publicCommerceProduct(product: CommerceProductRow) {
  return {
    id: product.id,
    kind: product.kind,
    status: "published" as const,
    slug: product.slug,
    public_slug: product.public_slug,
    title: product.title,
    subtitle: product.subtitle,
    description: product.description,
    cover_url: product.cover_url,
    pricing_type: product.pricing_type,
    price_amount: product.price_amount,
    currency: product.currency,
    billing_interval: product.billing_interval,
    cta_label: product.cta_label,
    inventory_limit: product.inventory_limit,
    sales_count: product.sales_count,
    noindex: product.noindex,
    published_at: product.published_at,
    settings: sanitizeCommerceSettingsForPublic(product.kind, product.settings),
  };
}

export const getPublicCommerceStore = createServerFn({ method: "GET" })
  .validator((input) => z.object({ username: z.string().min(1).max(64) }).parse(input))
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "commerce-store");
    const db = commerceDb(supabaseAdmin);
    const resolved = await resolvePublicUsername(db, data.username);
    if (!resolved) return null;
    const [{ data: profile, error: profileError }, { data: products, error: productsError }, plan] =
      await Promise.all([
        db
          .from("profiles")
          .select(
            "id, username, display_name, bio, avatar_url, accent_color, store_page_enabled, onboarded, noindex, primary_font, secondary_font",
          )
          .eq("id", resolved.userId)
          .maybeSingle(),
        db
          .from("commerce_products")
          .select("*")
          .eq("creator_id", resolved.userId)
          .eq("status", "published")
          .order("published_at", { ascending: false }),
        getPlan(resolved.userId),
      ]);
    if (profileError) throw new Error(profileError.message);
    if (productsError) throw new Error(productsError.message);
    if (!profile?.store_page_enabled || !planHasEntitlement(plan, "storeCards")) return null;
    return {
      profile,
      products: (products ?? [])
        .filter((product: CommerceProductRow) =>
          planHasEntitlement(plan, commerceEntitlement(product.kind)),
        )
        .map(publicCommerceProduct),
    };
  });

export const getPublicCommerceProduct = createServerFn({ method: "GET" })
  .validator((input) =>
    z
      .union([
        z.object({ slug: z.string().min(3).max(96) }),
        z.object({
          username: z.string().min(1).max(64),
          publicSlug: z.string().min(3).max(64),
        }),
      ])
      .parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "commerce-product");
    const db = commerceDb(supabaseAdmin);
    let productQuery = db.from("commerce_products").select("*").eq("status", "published");
    if ("slug" in data) {
      productQuery = productQuery.eq("slug", data.slug);
    } else {
      const creator = await resolvePublicUsername(db, data.username);
      if (!creator) return null;
      productQuery = productQuery
        .eq("creator_id", creator.userId)
        .eq("public_slug", data.publicSlug);
    }
    const { data: product, error } = await productQuery.maybeSingle();
    if (error) throw new Error(error.message);
    if (!product) return null;
    if (!planHasEntitlement(await getPlan(product.creator_id), commerceEntitlement(product.kind)))
      return null;
    const [
      { data: creatorWithProvider, error: creatorError },
      { data: lessons, error: lessonError },
      { data: bumpRule, error: bumpRuleError },
      { data: bundleProducts, error: bundleProductsError },
    ] = await Promise.all([
      db
        .from("profiles")
        .select(
          "id, username, display_name, bio, avatar_url, accent_color, commerce_payment_provider, onboarded, noindex, primary_font, secondary_font",
        )
        .eq("id", product.creator_id)
        .single(),
      product.kind === "course"
        ? db
            .from("commerce_course_lessons")
            .select("id, module_title, position, title, summary, content_type, content, is_preview")
            .eq("product_id", product.id)
            .order("position", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      product.pricing_type === "one_time"
        ? db
            .from("commerce_order_bumps")
            .select("bump_product_id, headline, description")
            .eq("primary_product_id", product.id)
            .eq("creator_id", product.creator_id)
            .eq("is_active", true)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      product.kind === "bundle" && Array.isArray(product.settings?.bundledProductIds)
        ? db
            .from("commerce_products")
            .select("id, kind, title, subtitle, cover_url, public_slug")
            .eq("creator_id", product.creator_id)
            .eq("status", "published")
            .in("id", product.settings.bundledProductIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (creatorError) throw new Error(creatorError.message);
    if (!creatorWithProvider) throw new Error("Creator not found.");
    if (lessonError) throw new Error(lessonError.message);
    if (bumpRuleError) throw new Error(bumpRuleError.message);
    if (bundleProductsError) throw new Error(bundleProductsError.message);
    const { commerce_payment_provider: configuredProvider, ...creator } = creatorWithProvider;
    const paymentProvider = String(
      configuredProvider || process.env.COMMERCE_PAYMENT_PROVIDER || "disabled",
    );
    let bookingReadiness: CreatorBookingIntegrationReadiness = {
      calendar: true,
      fathom: true,
    };
    let bookingReadinessError: string | null = null;
    if (product.kind === "coaching_call") {
      try {
        bookingReadiness = await creatorBookingIntegrationReadiness(product.creator_id);
      } catch (readinessError) {
        console.error("[commerce] booking integrations could not be verified", readinessError);
        bookingReadiness = { calendar: false, fathom: false };
        bookingReadinessError =
          "This session is temporarily unavailable while its booking setup is verified.";
      }
    }
    let orderBump = null;
    if (bumpRule && creatorPaymentSupportsCheckoutAdjustments(paymentProvider)) {
      const { product: bumpProduct } = await commerceOrderBumpAvailability(db, {
        bumpProductId: bumpRule.bump_product_id,
        creatorId: product.creator_id,
        configuredProvider: paymentProvider,
      });
      if (bumpProduct && bumpProduct.currency === product.currency) {
        orderBump = {
          ...bumpRule,
          product: {
            id: bumpProduct.id,
            slug: bumpProduct.slug,
            kind: bumpProduct.kind,
            title: bumpProduct.title,
            subtitle: bumpProduct.subtitle,
            cover_url: bumpProduct.cover_url,
            pricing_type: bumpProduct.pricing_type,
            price_amount: bumpProduct.price_amount,
            currency: bumpProduct.currency,
            status: bumpProduct.status,
            inventory_limit: bumpProduct.inventory_limit,
            sales_count: bumpProduct.sales_count,
          },
        };
      }
    }
    const publicBundleProductById = new Map(
      (bundleProducts ?? []).map((item: any) => [item.id, item]),
    );
    const publicBundleProducts = (
      Array.isArray(product.settings?.bundledProductIds)
        ? product.settings.bundledProductIds
        : (bundleProducts ?? []).map((item: any) => item.id)
    ).flatMap((id: string) => {
      const item = publicBundleProductById.get(id) as any;
      return item
        ? [
            {
              id: item.id,
              kind: item.kind,
              title: item.title,
              subtitle: item.subtitle,
              cover_url: item.cover_url,
              public_slug: item.public_slug,
            },
          ]
        : [];
    });
    return {
      product: publicCommerceProduct(product),
      creator,
      availabilityError:
        bookingReadinessError ||
        (await commerceRuntimeAvailabilityError(product, paymentProvider, bookingReadiness)),
      recordingAddonReady:
        product.kind !== "coaching_call" ||
        !product.settings?.recordingAddonEnabled ||
        bookingReadiness.fathom,
      lessons: (lessons ?? []).map((lesson: any) => {
        const delivered = deliveredCourseLesson(lesson);
        return delivered.isPreview ? delivered : { ...delivered, body: "", url: "" };
      }),
      bundleProducts: publicBundleProducts,
      orderBump,
      testCheckout:
        (process.env.APP_ENV || process.env.VITE_APP_ENV) === "staging" &&
        process.env.COMMERCE_PAYMENT_PROVIDER === "mock",
    };
  });

export const getCommerceOrderConfirmation = createServerFn({ method: "GET" })
  .validator((input) =>
    z
      .object({
        productId: uuidSchema,
        reference: z.string().trim().min(8).max(200),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "commerce-order-confirmation");
    const db = commerceDb(supabaseAdmin);
    const referenceIsUuid = uuidSchema.safeParse(data.reference).success;

    let order: { id: string; status: string; metadata: Record<string, unknown> | null } | null =
      null;
    if (referenceIsUuid) {
      const { data: orderById, error } = await db
        .from("commerce_orders")
        .select("id,status,metadata")
        .eq("id", data.reference)
        .eq("product_id", data.productId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      order = orderById;
    }
    if (!order) {
      const { data: orderByCheckout, error } = await db
        .from("commerce_orders")
        .select("id,status,metadata")
        .eq("product_id", data.productId)
        .eq("provider_checkout_id", data.reference)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      order = orderByCheckout;
    }

    let session: { status: string; metadata: Record<string, unknown> | null } | null = null;
    if (!order && referenceIsUuid) {
      const { data: sessionById, error } = await db
        .from("commerce_payment_sessions")
        .select("status,metadata")
        .eq("id", data.reference)
        .eq("product_id", data.productId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      session = sessionById;
    }
    if (!order && !session) {
      const { data: sessionByCheckout, error } = await db
        .from("commerce_payment_sessions")
        .select("status,metadata")
        .eq("product_id", data.productId)
        .eq("provider_checkout_id", data.reference)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      session = sessionByCheckout;
    }

    const state = commerceOrderConfirmationState({
      orderStatus: order?.status,
      sessionStatus: session?.status,
    });
    const metadata = order?.metadata || session?.metadata;
    const priorityDmRequestId =
      state === "confirmed" &&
      metadata?.commerce_intent === "priority_dm_followup" &&
      uuidSchema.safeParse(metadata?.priority_dm_request_id).success
        ? String(metadata.priority_dm_request_id)
        : null;
    return {
      state,
      orderId: order?.id || null,
      priorityDmRequestId,
    };
  });

const checkoutAttributionSchema = z
  .object({
    referrer: z.string().trim().max(2_048).optional(),
    utm_source: z.string().trim().max(200).optional(),
    utm_medium: z.string().trim().max(200).optional(),
    utm_campaign: z.string().trim().max(200).optional(),
    utm_content: z.string().trim().max(200).optional(),
  })
  .default({});

export const previewCommerceCheckout = createServerFn({ method: "POST" })
  .validator((input) =>
    z
      .object({
        productId: uuidSchema,
        discountCode: z.string().trim().max(32).optional(),
        bumpProductId: uuidSchema.optional(),
        recordingAddon: z.boolean().default(false),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "commerce-checkout-preview");
    const db = commerceDb(supabaseAdmin);
    const { data: product, error } = await db
      .from("commerce_products")
      .select("*")
      .eq("id", data.productId)
      .eq("status", "published")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!product || !planHasEntitlement(await getPlan(product.creator_id), "oneTapCheckout")) {
      throw new Error("This product is not available.");
    }
    const publishabilityError = commerceProductPublishabilityError(product);
    if (publishabilityError) throw new Error(publishabilityError);
    await requireCommerceDeliveryIntegrations(product);
    const { data: profile, error: profileError } = await db
      .from("profiles")
      .select("commerce_payment_provider,username")
      .eq("id", product.creator_id)
      .single();
    if (profileError) throw new Error(profileError.message);
    const configuredProvider = String(
      profile?.commerce_payment_provider || process.env.COMMERCE_PAYMENT_PROVIDER || "disabled",
    );
    const deployment = process.env.APP_ENV || process.env.VITE_APP_ENV || "production";
    const recordingAddonAmount = data.recordingAddon
      ? Math.max(0, Math.round(Number(product.settings?.recordingAddonPrice || 0)))
      : 0;
    if (
      data.recordingAddon &&
      (product.kind !== "coaching_call" ||
        !product.settings?.recordingAddonEnabled ||
        recordingAddonAmount <= 0)
    ) {
      throw new Error("The recording option is not available for this session.");
    }
    const requiresPayment = product.pricing_type !== "free" || recordingAddonAmount > 0;
    const effectivePricingType =
      product.pricing_type === "free" && requiresPayment ? "one_time" : product.pricing_type;
    if (requiresPayment && !(configuredProvider === "mock" && deployment === "staging")) {
      const compatibility = creatorPaymentCompatibility(
        configuredProvider,
        product.kind,
        effectivePricingType,
      );
      if (!compatibility.supported) {
        throw new Error(compatibility.reason || "This payment gateway cannot sell this offer.");
      }
      await requireReadyCreatorPaymentProvider(
        product.creator_id,
        configuredProvider as CreatorPaymentProvider,
      );
    }
    const growth = await resolveCommerceCheckoutGrowth({
      product,
      provider: configuredProvider,
      discountCode: data.discountCode,
      bumpProductId: data.bumpProductId,
      recordingAddonAmount,
    });
    if (growth.bumpProductId) {
      const bumpAvailability = await commerceOrderBumpAvailability(db, {
        bumpProductId: growth.bumpProductId,
        creatorId: product.creator_id,
        configuredProvider,
      });
      if (!bumpAvailability.product) {
        throw new Error(bumpAvailability.reason || "That order bump is no longer available.");
      }
    }
    return growth;
  });

export const submitCommerceLead = createServerFn({ method: "POST" })
  .validator((input) =>
    z
      .object({
        productId: uuidSchema,
        email: z.string().trim().email().max(254),
        name: z.string().trim().max(120).optional(),
        answers: z
          .record(z.string().max(100), z.string().max(5_000))
          .refine((value) => Object.keys(value).length <= 20, "Too many answers.")
          .refine((value) => JSON.stringify(value).length <= 50_000, "Answers are too large.")
          .default({}),
        marketingConsent: z.boolean().default(false),
        source: z.string().trim().max(200).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "commerce-lead");
    const db = commerceDb(supabaseAdmin);
    const { data: product, error } = await db
      .from("commerce_products")
      .select("id, creator_id, kind, slug, title, status, settings")
      .eq("id", data.productId)
      .eq("kind", "lead_form")
      .eq("status", "published")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!product || !planHasEntitlement(await getPlan(product.creator_id), "emailCollection")) {
      throw new Error("This form is not available.");
    }
    const configuredFields: CommerceFormField[] = Array.isArray(product.settings?.fields)
      ? product.settings.fields
          .filter((field: unknown): field is CommerceFormField =>
            Boolean(
              field &&
              typeof field === "object" &&
              typeof (field as { id?: unknown }).id === "string",
            ),
          )
          .slice(0, 20)
      : [];
    const answerKeys = new Set(Object.keys(data.answers));
    const allowedAnswerKeys = new Set(
      configuredFields
        .filter((field) => field.type !== "email" && field.id !== "email")
        .map((field) => field.id),
    );
    if ([...answerKeys].some((key) => !allowedAnswerKeys.has(key))) {
      throw new Error("This form contains an answer for a field that is no longer available.");
    }
    const missingRequiredField = configuredFields.find(
      (field) =>
        field.required &&
        field.type !== "email" &&
        field.id !== "email" &&
        !String(data.answers[field.id] || "").trim(),
    );
    if (missingRequiredField) {
      throw new Error(`${missingRequiredField.label || "A required field"} is required.`);
    }
    const { data: lead, error: insertError } = await db
      .from("commerce_leads")
      .upsert(
        {
          product_id: product.id,
          creator_id: product.creator_id,
          email: data.email.toLowerCase(),
          name: data.name || null,
          answers: data.answers,
          source: data.source || null,
        },
        { onConflict: "product_id,email" },
      )
      .select("id")
      .single();
    if (insertError) throw new Error(insertError.message);
    if (data.marketingConsent) {
      try {
        const { data: contactId, error: contactError } = await db.rpc(
          "commerce_upsert_audience_contact",
          {
            p_creator_id: product.creator_id,
            p_email: data.email,
            p_name: data.name || null,
            p_source: "lead_form",
            p_occurred_at: new Date().toISOString(),
          },
        );
        if (contactError) throw contactError;
        const { error: consentError } = await db.from("audience_consent_events").insert({
          creator_id: product.creator_id,
          contact_id: contactId,
          status: "subscribed",
          source: "lead_form_checkbox",
          proof: {
            product_id: product.id,
            lead_id: lead.id,
            disclosure: "creator_updates",
          },
        });
        if (consentError) throw consentError;
      } catch (consentError) {
        // The lead itself is already durable (and its insert trigger already
        // creates the audience member). Do not invite a duplicate submission
        // because the optional consent audit write needs operational repair.
        await recordEmailMarketingCapacityBlock({
          creatorId: product.creator_id,
          source: "lead_form_consent",
          error: consentError as { code?: unknown; message?: unknown; details?: unknown },
        });
        console.error("[commerce] lead marketing consent could not be recorded", consentError);
      }
    }
    try {
      await enqueueCreatorLeadEmail({
        leadKey: lead.id,
        creatorId: product.creator_id,
        productTitle: product.title,
        buyerEmail: data.email,
        buyerName: data.name,
      });
    } catch (emailError) {
      console.error("[email] lead notification was deferred", emailError);
    }
    return {
      ok: true,
      message: String(product.settings?.confirmationMessage || "You're in. Thank you."),
    };
  });

function randomAccessToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function tokenHash(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const createCommerceCheckout = createServerFn({ method: "POST" })
  .validator((input) =>
    z
      .object({
        productId: uuidSchema,
        priorityDmRequestId: uuidSchema.optional(),
        email: z.string().trim().email().max(254),
        name: z.string().trim().max(120).optional(),
        recordingAddon: z.boolean().default(false),
        discountCode: z.string().trim().max(32).optional(),
        bumpProductId: uuidSchema.optional(),
        answers: z
          .record(z.string().max(40), z.string().max(10_000))
          .refine((value) => Object.keys(value).length <= 20, "Too many checkout answers.")
          .refine(
            (value) => JSON.stringify(value).length <= 50_000,
            "Checkout answers are too large.",
          )
          .default({}),
        attribution: checkoutAttributionSchema,
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("CHECKOUT_RATE_LIMITER", "commerce-checkout");
    const db = commerceDb(supabaseAdmin);
    const { data: product, error } = await db
      .from("commerce_products")
      .select("*")
      .eq("id", data.productId)
      .eq("status", "published")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!product || !planHasEntitlement(await getPlan(product.creator_id), "oneTapCheckout")) {
      throw new Error("This product is not available.");
    }
    if (
      !data.priorityDmRequestId &&
      product.inventory_limit &&
      product.sales_count >= product.inventory_limit
    ) {
      throw new Error("This product is sold out.");
    }
    const publishabilityError = commerceProductPublishabilityError(product);
    if (publishabilityError) throw new Error(publishabilityError);
    await requireCommerceDeliveryIntegrations(product);
    const message = String(data.answers.priority_message || "").trim();
    let customerIdentity: Awaited<ReturnType<typeof currentCustomerSession>> = null;
    let priorityDmRequest: Awaited<ReturnType<typeof loadPriorityDmPaidFollowUp>> | null = null;
    if (data.priorityDmRequestId) {
      if (product.kind !== "priority_dm") throw new Error("Priority conversation not found.");
      if (data.discountCode || data.bumpProductId || data.recordingAddon) {
        throw new Error("Paid follow-ups do not support discounts or add-ons.");
      }
      customerIdentity = await currentCustomerSession();
      if (!customerIdentity) throw new Error("Sign in to your customer library to continue.");
      priorityDmRequest = await loadPriorityDmPaidFollowUp({
        requestId: data.priorityDmRequestId,
        productId: product.id,
        buyerEmail: customerIdentity.customer.email_normalized,
      });
      if (priorityDmRequest.freeFollowUpsRemaining > 0) {
        throw new Error("Use your included follow-up before paying for another.");
      }
      if (!message) throw new Error("Write your follow-up before continuing.");
    }
    const buyerEmail = customerIdentity
      ? customerIdentity.customer.email_normalized
      : data.email.toLowerCase();
    const buyerName = customerIdentity ? customerIdentity.customer.name : data.name;
    const checkoutSourceProduct = priorityDmRequest
      ? {
          ...product,
          title: `Follow-up · ${product.title}`,
          pricing_type: "one_time" as const,
          price_amount: priorityDmRequest.followUpPriceAmount,
          currency: priorityDmRequest.currency,
        }
      : product;
    const buyerAnswers: CommerceBuyerAnswer[] = priorityDmRequest
      ? [priorityDmFollowUpAnswer(priorityDmRequest.id, message)]
      : product.kind === "custom_product"
        ? (product.settings?.buyerQuestions || []).map((question: string, index: number) => {
            const answer = String(data.answers[`q_${index}`] || "").trim();
            if (!answer) throw new Error(`Answer "${question}" before continuing.`);
            if (answer.length > 5_000) throw new Error(`Answer "${question}" is too long.`);
            return { question: String(question).trim(), answer };
          })
        : product.kind === "priority_dm"
          ? (() => {
              if (!message) throw new Error("Write your message before continuing.");
              return [{ question: "Priority message", answer: message }];
            })()
          : [];

    const recordingAddonAmount = data.recordingAddon
      ? Math.max(0, Math.round(Number(product.settings?.recordingAddonPrice || 0)))
      : 0;
    if (
      data.recordingAddon &&
      (product.kind !== "coaching_call" ||
        !product.settings?.recordingAddonEnabled ||
        recordingAddonAmount <= 0)
    ) {
      throw new Error("The recording option is not available for this session.");
    }
    const recordingAddon = {
      selected: recordingAddonAmount > 0,
      amount: recordingAddonAmount,
    };
    const isFreeClaim =
      checkoutSourceProduct.pricing_type === "free" &&
      isHostedAccessKind(checkoutSourceProduct.kind) &&
      !recordingAddon.selected;
    if (
      checkoutSourceProduct.pricing_type === "free" &&
      !isHostedAccessKind(checkoutSourceProduct.kind)
    ) {
      throw new Error("This product does not use checkout.");
    }

    const { data: profile, error: profileError } = await db
      .from("profiles")
      .select("commerce_payment_provider,username")
      .eq("id", product.creator_id)
      .single();
    if (profileError) throw new Error(profileError.message);
    const feeBps = isFreeClaim ? 0 : commercePlatformFeeBps();
    const deployment = process.env.APP_ENV || process.env.VITE_APP_ENV || "production";
    const configuredProvider = String(
      profile?.commerce_payment_provider || process.env.COMMERCE_PAYMENT_PROVIDER || "disabled",
    );
    const growth = await resolveCommerceCheckoutGrowth({
      product: checkoutSourceProduct,
      provider: isFreeClaim ? "free" : configuredProvider,
      discountCode: data.discountCode,
      bumpProductId: data.bumpProductId,
      recordingAddonAmount,
      attribution: data.attribution,
    });
    if (growth.bumpProductId) {
      const bumpAvailability = await commerceOrderBumpAvailability(db, {
        bumpProductId: growth.bumpProductId,
        creatorId: product.creator_id,
        configuredProvider,
      });
      if (!bumpAvailability.product) {
        throw new Error(bumpAvailability.reason || "That order bump is no longer available.");
      }
    }
    const checkoutProduct = commerceCheckoutProduct(
      { ...checkoutSourceProduct, creator_username: profile.username },
      {
        grossAmount: growth.grossAmount,
        hasAddons: recordingAddon.selected || Boolean(growth.bumpProductId),
      },
    );
    if (!isFreeClaim && !(configuredProvider === "mock" && deployment === "staging")) {
      const compatibility = creatorPaymentCompatibility(
        configuredProvider,
        product.kind,
        checkoutProduct.pricing_type,
      );
      if (!compatibility.supported) {
        throw new Error(compatibility.reason || "This payment gateway cannot sell this offer.");
      }
      await requireReadyCreatorPaymentProvider(
        product.creator_id,
        configuredProvider as CreatorPaymentProvider,
      );
    }
    if (!isFreeClaim && configuredProvider === "stripe") {
      const { createStripeCommerceCheckout } =
        await import("@/integrations/stripe/checkout.server");
      return createStripeCommerceCheckout({
        product: checkoutProduct,
        email: buyerEmail,
        name: buyerName,
        recordingAddon,
        growth,
        buyerAnswers,
      });
    }
    if (!isFreeClaim && configuredProvider === "paypal") {
      const { createPayPalCommerceCheckout } =
        await import("@/integrations/paypal/checkout.server");
      return createPayPalCommerceCheckout({
        product: checkoutProduct,
        email: buyerEmail,
        name: buyerName,
        recordingAddon,
        growth,
        buyerAnswers,
      });
    }
    if (!isFreeClaim && configuredProvider === "razorpay") {
      const { createRazorpayCommerceCheckout } =
        await import("@/integrations/razorpay/checkout.functions");
      return createRazorpayCommerceCheckout({
        product: checkoutProduct,
        email: buyerEmail,
        name: buyerName,
        recordingAddon,
        growth,
        buyerAnswers,
      });
    }
    if (!isFreeClaim && configuredProvider === "polar") {
      const { createPolarCommerceCheckout } = await import("@/integrations/polar/checkout.server");
      return createPolarCommerceCheckout({
        product: checkoutProduct,
        email: buyerEmail,
        name: buyerName,
        growth,
        buyerAnswers,
      });
    }
    if (!isFreeClaim && configuredProvider === "dodo") {
      const { createDodoCommerceCheckout } = await import("@/integrations/dodo/checkout.server");
      return createDodoCommerceCheckout({
        product: checkoutProduct,
        email: buyerEmail,
        name: buyerName,
        growth,
        buyerAnswers,
      });
    }
    if (!isFreeClaim && configuredProvider === "creem") {
      const { createCreemCommerceCheckout } = await import("@/integrations/creem/checkout.server");
      return createCreemCommerceCheckout({
        product: checkoutProduct,
        email: buyerEmail,
        name: buyerName,
        growth,
        buyerAnswers,
      });
    }
    if (!isFreeClaim && (configuredProvider !== "mock" || deployment !== "staging")) {
      if (configuredProvider === "mock")
        throw new Error("Mock checkout is forbidden outside staging.");
      throw new Error("This creator's payment provider is not available.");
    }

    const amounts = calculateCommerceAmounts(
      isFreeClaim ? 0 : checkoutProduct.price_amount,
      feeBps,
      0,
    );
    const provider = isFreeClaim ? "free" : "mock";
    const normalizedBuyerEmail = buyerEmail;
    const checkoutId = isFreeClaim
      ? `free_${await tokenHash(`${product.id}:${normalizedBuyerEmail}`)}`
      : `${provider}_${crypto.randomUUID()}`;
    const accessToken = isHostedAccessKind(product.kind) ? randomAccessToken() : null;
    const fulfillmentMetadata = {
      test: provider === "mock",
      free_claim: isFreeClaim,
      recording_addon_selected: recordingAddon.selected,
      recording_addon_amount: recordingAddon.amount,
      ...(buyerAnswers.length ? { buyer_answers: buyerAnswers } : {}),
      ...(priorityDmRequest
        ? {
            commerce_intent: "priority_dm_followup",
            priority_dm_request_id: priorityDmRequest.id,
          }
        : {}),
    };
    const accessTokenHash = accessToken ? await tokenHash(accessToken) : null;
    const { data: fulfillment, error: fulfillmentError } = isFreeClaim
      ? await db.rpc("claim_free_commerce_offer", {
          p_product_id: product.id,
          p_buyer_email: normalizedBuyerEmail,
          p_buyer_name: buyerName || "",
          p_provider_checkout_id: checkoutId,
          p_metadata: fulfillmentMetadata,
          p_access_token_hash: accessTokenHash,
        })
      : await db.rpc("create_fulfilled_commerce_order", {
          p_product_id: product.id,
          p_buyer_email: normalizedBuyerEmail,
          p_buyer_name: buyerName || "",
          p_provider: provider,
          p_provider_checkout_id: checkoutId,
          p_gross_amount: amounts.grossAmount,
          p_platform_fee_bps: amounts.platformFeeBps,
          p_platform_fee_amount: amounts.platformFeeAmount,
          p_processor_fee_amount: amounts.processorFeeAmount,
          p_net_amount: amounts.netAmount,
          p_currency: checkoutProduct.currency,
          p_metadata: fulfillmentMetadata,
          p_access_token_hash: accessTokenHash,
        });
    if (fulfillmentError || !fulfillment?.order_id) {
      throw new Error(fulfillmentError?.message || "Test order failed.");
    }

    if (fulfillment.created_new_order !== false) {
      try {
        await enqueueCommerceOrderEmails({
          orderId: fulfillment.order_id,
          accessToken,
        });
      } catch (emailError) {
        console.error("[email] commerce order notification was deferred", emailError);
      }
    }

    const query = new URLSearchParams({ order: fulfillment.order_id });
    if (accessToken) query.set("access", accessToken);
    return {
      url: `${appUrl()}${publicProductSuccessPath(profile.username, product.public_slug)}?${query}`,
      test: provider === "mock",
    };
  });

export const getCommerceAccess = createServerFn({ method: "GET" })
  .validator((input) => z.object({ token: z.string().min(1).max(200) }).parse(input))
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "commerce-access");
    if (!isPlausibleCommerceAccessToken(data.token)) return null;
    const db = commerceDb(supabaseAdmin);
    const grant = await resolveCommerceGrantByToken(db, data.token);
    if (!grant) return null;
    const [
      { data: product, error: productError },
      { data: lessons, error: lessonsError },
      { data: posts, error: postsError },
      { data: bookings, error: bookingsError },
      { data: webinarRegistration, error: webinarRegistrationError },
      { data: progress, error: progressError },
      { data: subscription, error: subscriptionError },
      { data: comments, error: commentsError },
      { data: communityNotifications, error: communityNotificationsError },
    ] = await Promise.all([
      db
        .from("commerce_products")
        .select("*")
        .eq("id", grant.product_id)
        .eq("creator_id", grant.creator_id)
        .single(),
      db
        .from("commerce_course_lessons")
        .select("*")
        .eq("product_id", grant.product_id)
        .order("position", { ascending: true }),
      db
        .from("commerce_community_posts")
        .select(
          "id, author_kind, author_name, body, is_pinned, resources, moderation_status, created_at",
        )
        .eq("product_id", grant.product_id)
        .eq("moderation_status", "published")
        .order("is_pinned", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(100),
      grant.order_id
        ? db
            .from("commerce_bookings")
            .select("*")
            .eq("order_id", grant.order_id)
            .order("starts_at", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      db
        .from("commerce_webinar_registrations")
        .select("*")
        .eq("access_grant_id", grant.id)
        .maybeSingle(),
      db
        .from("commerce_course_progress")
        .select("lesson_id, completed_at")
        .eq("access_grant_id", grant.id),
      db
        .from("commerce_subscription_access")
        .select(
          "status, current_period_start, current_period_end, grace_expires_at, cancel_at_period_end",
        )
        .eq("access_grant_id", grant.id)
        .maybeSingle(),
      db
        .from("commerce_community_comments")
        .select("id, post_id, author_kind, author_name, body, moderation_status, created_at")
        .eq("product_id", grant.product_id)
        .eq("moderation_status", "published")
        .order("created_at", { ascending: true })
        .limit(1_000),
      db
        .from("commerce_community_notifications")
        .select("id, post_id, comment_id, kind, title, body, is_read, created_at")
        .eq("access_grant_id", grant.id)
        .order("created_at", { ascending: false })
        .limit(30),
    ]);
    if (productError) throw new Error(productError.message);
    if (lessonsError) throw new Error(lessonsError.message);
    if (postsError) throw new Error(postsError.message);
    if (bookingsError) throw new Error(bookingsError.message);
    if (webinarRegistrationError) throw new Error(webinarRegistrationError.message);
    if (progressError) throw new Error(progressError.message);
    if (subscriptionError) throw new Error(subscriptionError.message);
    if (commentsError) throw new Error(commentsError.message);
    if (communityNotificationsError) throw new Error(communityNotificationsError.message);
    const { error: accessTouchError } = await db
      .from("commerce_access_grants")
      .update({ last_accessed_at: new Date().toISOString() })
      .eq("id", grant.id);
    if (accessTouchError) {
      console.error("[commerce] access timestamp could not be updated", accessTouchError);
    }
    const { data: creator, error: creatorError } = await db
      .from("profiles")
      .select("username, display_name, avatar_url, primary_font, secondary_font")
      .eq("id", grant.creator_id)
      .single();
    if (creatorError) throw new Error(creatorError.message);
    const deliveredLessons = (lessons ?? []).map(deliveredCourseLesson);
    const bundleProductIds =
      product.kind === "bundle"
        ? resolveBundleDeliveryProductIds(grant.delivery_snapshot, product.settings)
        : [];
    let bundleProducts: Array<{
      product: CommerceProductRecord;
      lessons: ReturnType<typeof deliveredCourseLesson>[];
    }> = [];
    if (bundleProductIds.length) {
      const { data: includedProducts, error: includedProductsError } = await db
        .from("commerce_products")
        .select("*")
        .eq("creator_id", grant.creator_id)
        .in("id", bundleProductIds);
      if (includedProductsError) throw new Error(includedProductsError.message);

      const eligibleProducts = (includedProducts ?? []).filter((item: any) =>
        ["digital_product", "course", "custom_product"].includes(item.kind),
      );
      const courseIds = eligibleProducts
        .filter((item: any) => item.kind === "course")
        .map((item: any) => item.id);
      const { data: includedLessons, error: includedLessonsError } = courseIds.length
        ? await db
            .from("commerce_course_lessons")
            .select("*")
            .in("product_id", courseIds)
            .order("position", { ascending: true })
        : { data: [], error: null };
      if (includedLessonsError) throw new Error(includedLessonsError.message);

      const productById = new Map<string, any>(
        eligibleProducts.map((item: any) => [item.id, item]),
      );
      bundleProducts = bundleProductIds.flatMap((productId) => {
        const included = productById.get(productId);
        if (!included) return [];
        const productLessons = (includedLessons ?? [])
          .filter((item: any) => item.product_id === productId)
          .map(deliveredCourseLesson);
        const settings =
          included.kind === "digital_product"
            ? {
                ...(included.settings || {}),
                files: resolveBundleDigitalDeliveryFiles(
                  grant.delivery_snapshot,
                  productId,
                  included.settings,
                ),
              }
            : included.kind === "course"
              ? { ...(included.settings || {}), lessons: productLessons }
              : included.settings || {};
        return [{ product: { ...included, settings }, lessons: productLessons }];
      });
    }
    const deliveredProduct =
      product.kind === "digital_product"
        ? {
            ...product,
            settings: {
              ...(product.settings || {}),
              files: resolveDigitalDeliveryFiles(grant.delivery_snapshot, product.settings),
            },
          }
        : product.kind === "course"
          ? {
              ...product,
              settings: {
                ...(product.settings || {}),
                lessons: deliveredLessons,
              },
            }
          : product;
    return {
      grant,
      product: deliveredProduct,
      bundleProducts,
      creator,
      lessons: deliveredLessons,
      progress: progress ?? [],
      posts: posts ?? [],
      bookings: bookings ?? [],
      webinarRegistration: webinarRegistration ?? null,
      subscription: subscription ?? null,
      comments: comments ?? [],
      communityNotifications: communityNotifications ?? [],
      serverNow: new Date().toISOString(),
    };
  });

export const setCommerceCourseLessonProgress = createServerFn({ method: "POST" })
  .validator((input) =>
    z
      .object({
        token: z.string().min(20).max(200),
        lessonId: uuidSchema,
        completed: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "commerce-course-progress");
    if (!isPlausibleCommerceAccessToken(data.token)) {
      throw new Error("Course access is not active.");
    }
    const db = commerceDb(supabaseAdmin);
    const grant = await resolveCommerceGrantByToken(db, data.token, "id, product_id");
    if (!grant) throw new Error("Course access is not active.");
    const { data: progress, error } = await db.rpc("set_commerce_course_lesson_progress", {
      p_access_grant_id: grant.id,
      p_lesson_id: data.lessonId,
      p_completed: data.completed,
    });
    if (error || !progress) {
      throw new Error(error?.message || "Lesson progress could not be saved.");
    }
    return progress as {
      access_grant_id: string;
      lesson_id: string;
      completed: boolean;
      completed_at: string | null;
    };
  });

export const createCommerceBooking = createServerFn({ method: "POST" })
  .validator((input) =>
    z
      .object({
        token: z.string().min(20).max(200),
        startsAt: z.string().datetime(),
        timezone: z.string().trim().min(1).max(100),
        name: z.string().trim().min(1).max(120),
        notes: z.string().trim().max(3_000).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("CHECKOUT_RATE_LIMITER", "commerce-booking");
    const context = await bookingContextForAccessToken(data.token);
    const { client: db, grant, product } = context;
    const startsAt = new Date(data.startsAt);
    if (!Number.isFinite(startsAt.getTime()) || startsAt <= new Date()) {
      throw new Error("Choose a future date and time.");
    }
    const relatedOrder = Array.isArray(grant.commerce_orders)
      ? grant.commerce_orders[0]
      : grant.commerce_orders;
    const { data: existingBooking, error: existingBookingError } = await db
      .from("commerce_bookings")
      .select("*")
      .eq("order_id", grant.order_id)
      .neq("status", "canceled")
      .maybeSingle();
    if (existingBookingError) throw new Error(existingBookingError.message);
    if (
      existingBooking &&
      (!context.calendar || (existingBooking.google_event_id && existingBooking.meeting_url))
    ) {
      return existingBooking;
    }

    let booking = existingBooking;
    if (!booking) {
      const availability = await availableSlotsForAccessToken(data.token);
      const selected = availability.slots.find((slot) => slot.startsAt === startsAt.toISOString());
      if (!selected) throw new Error("That time is no longer available. Choose another slot.");
      const endsAt = new Date(selected.endsAt);
      const orderMetadata = relatedOrder?.metadata || {};
      const recordingRequested = Boolean(orderMetadata.recording_addon_selected);
      const blockedWindow = bookingBlockedWindow({
        startsAt,
        endsAt,
        bufferBeforeMinutes: context.availability.bufferBeforeMinutes,
        bufferAfterMinutes: context.availability.bufferAfterMinutes,
      });
      const { data: insertedBooking, error: bookingError } = await db
        .from("commerce_bookings")
        .insert({
          order_id: grant.order_id,
          product_id: product.id,
          creator_id: product.creator_id,
          buyer_email: grant.buyer_email,
          buyer_name: data.name,
          starts_at: startsAt.toISOString(),
          ends_at: endsAt.toISOString(),
          blocked_starts_at: blockedWindow.blockedStartsAt,
          blocked_ends_at: blockedWindow.blockedEndsAt,
          timezone: context.availability.timezone,
          status: "confirmed",
          meeting_url: context.calendar ? null : product.settings?.meetingUrl || null,
          calendar_connection_id: context.calendar?.id || null,
          fathom_connection_id: recordingRequested ? context.fathom?.id || null : null,
          recording_requested: recordingRequested,
          recording_status: recordingRequested ? "pending" : "not_requested",
          notes: data.notes || null,
        })
        .select("*")
        .single();
      if (bookingError?.code === "23P01") {
        throw new Error("That time is no longer available. Choose another slot.");
      }
      if (bookingError?.code === "23505") {
        const { data: activeBooking, error: activeBookingError } = await db
          .from("commerce_bookings")
          .select("*")
          .eq("order_id", grant.order_id)
          .neq("status", "canceled")
          .maybeSingle();
        if (activeBookingError) throw new Error(activeBookingError.message);
        if (
          activeBooking &&
          (!context.calendar || (activeBooking.google_event_id && activeBooking.meeting_url))
        ) {
          return activeBooking;
        }
        if (activeBooking) {
          booking = activeBooking;
        } else {
          throw new Error("This purchase already has an active booking.");
        }
      } else if (bookingError) {
        throw new Error(bookingError.message);
      } else {
        booking = insertedBooking;
      }
    }
    if (!booking) throw new Error("The booking could not be created.");
    let completedBooking = booking;
    if (context.calendar) {
      try {
        const event = await createGoogleMeetEvent({
          connection: context.calendar,
          title: `${product.title} · ${data.name}`,
          description: `Booked through bento.surf. Buyer: ${grant.buyer_email}${data.notes ? `\n\nNotes: ${data.notes}` : ""}`,
          startsAt: booking.starts_at,
          endsAt: booking.ends_at,
          timeZone: context.availability.timezone,
          buyerEmail: grant.buyer_email,
          buyerName: booking.buyer_name || data.name,
        });
        const calendarFields = {
          google_event_id: event.eventId,
          google_event_url: event.eventUrl,
          meeting_url: event.meetUrl,
        };
        let { data: updated, error: updateError } = await db
          .from("commerce_bookings")
          .update(calendarFields)
          .eq("id", booking.id)
          .select("*")
          .single();
        // A transient database response must not create a duplicate Meet on retry.
        if (updateError) {
          const retry = await db
            .from("commerce_bookings")
            .update(calendarFields)
            .eq("id", booking.id)
            .select("*")
            .single();
          updated = retry.data;
          updateError = retry.error;
        }
        if (updateError) {
          try {
            await deleteGoogleCalendarEvent({
              connection: context.calendar,
              eventId: event.eventId,
            });
          } catch (cleanupError) {
            console.error("[booking] orphaned Google event cleanup deferred", cleanupError);
          }
        }
        if (updateError) throw new Error(updateError.message);
        completedBooking = updated;
      } catch (eventError) {
        throw new Error(
          eventError instanceof Error
            ? `Google Meet could not be created: ${eventError.message}. Your slot is saved; retry to finish connecting the meeting.`
            : "Google Meet could not be created. Your slot is saved; retry to finish connecting the meeting.",
        );
      }
    }
    try {
      await enqueueBookingConfirmationEmails({ bookingId: completedBooking.id });
    } catch (emailError) {
      console.error("[booking] confirmation email deferred", emailError);
    }
    return completedBooking;
  });

export const cancelCommerceBooking = createServerFn({ method: "POST" })
  .validator((input) =>
    z
      .object({
        token: z.string().min(20).max(200),
        bookingId: uuidSchema,
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "commerce-booking-cancel");
    const context = await bookingContextForAccessToken(data.token);
    const { client: db, grant } = context;
    const { data: booking, error: bookingError } = await db
      .from("commerce_bookings")
      .select("*")
      .eq("id", data.bookingId)
      .eq("order_id", grant.order_id)
      .maybeSingle();
    if (bookingError) throw new Error(bookingError.message);
    if (!booking) throw new Error("This booking could not be found.");
    if (booking.status === "canceled") return booking;
    if (!bookingCanBeCanceled(booking)) {
      throw new Error("Only a future confirmed booking can be canceled.");
    }

    const needsCalendarCleanup = Boolean(booking.google_event_id && booking.calendar_connection_id);
    const canceledAt = new Date().toISOString();
    const { data: canceled, error: cancelError } = await db
      .from("commerce_bookings")
      .update({
        status: "canceled",
        canceled_at: canceledAt,
        canceled_by: "customer",
        calendar_cancel_status: needsCalendarCleanup ? "pending" : "not_required",
        calendar_cancel_error: null,
      })
      .eq("id", booking.id)
      .in("status", ["pending", "confirmed"])
      .select("*")
      .maybeSingle();
    if (cancelError) throw new Error(cancelError.message);
    if (!canceled) {
      const { data: latest, error: latestError } = await db
        .from("commerce_bookings")
        .select("*")
        .eq("id", booking.id)
        .single();
      if (latestError) throw new Error(latestError.message);
      if (latest.status === "canceled") return latest;
      throw new Error("This booking changed while it was being canceled. Refresh and try again.");
    }

    let result = canceled;
    if (needsCalendarCleanup) {
      try {
        const { data: connection, error: connectionError } = await db
          .from("booking_calendar_connections")
          .select("*")
          .eq("id", booking.calendar_connection_id)
          .maybeSingle();
        if (connectionError) throw new Error(connectionError.message);
        if (!connection) throw new Error("The connected Google Calendar is unavailable.");
        await deleteGoogleCalendarEvent({
          connection,
          eventId: booking.google_event_id,
        });
        const { data: cleaned, error: cleanupError } = await db
          .from("commerce_bookings")
          .update({
            calendar_cancel_status: "succeeded",
            calendar_cancel_error: null,
          })
          .eq("id", booking.id)
          .select("*")
          .single();
        if (cleanupError) throw new Error(cleanupError.message);
        result = cleaned;
      } catch (cleanupError) {
        const message =
          cleanupError instanceof Error
            ? cleanupError.message.slice(0, 500)
            : "Google Calendar cleanup is waiting to retry.";
        const { error: cleanupStateError } = await db
          .from("commerce_bookings")
          .update({ calendar_cancel_error: message })
          .eq("id", booking.id);
        if (cleanupStateError) {
          console.error(
            "[booking] Google Calendar cancellation retry state could not be saved",
            cleanupStateError,
          );
        }
        console.error("[booking] Google Calendar cancellation deferred", cleanupError);
      }
    }

    try {
      await enqueueBookingCancellationEmails({
        bookingId: booking.id,
        accessToken: data.token,
      });
    } catch (emailError) {
      console.error("[booking] cancellation email deferred", emailError);
    }
    return result;
  });

export const createCommerceCommunityPost = createServerFn({ method: "POST" })
  .validator((input) =>
    z
      .object({
        token: z.string().min(20).max(200),
        name: z.string().trim().max(120).optional(),
        body: z.string().trim().min(1).max(10_000),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "commerce-community-post");
    const db = commerceDb(supabaseAdmin);
    const grant = await resolveCommerceGrantByToken(db, data.token);
    if (!grant) {
      throw new Error("This access link is not active.");
    }
    const { data: product, error: productError } = await db
      .from("commerce_products")
      .select("id, creator_id, kind, settings")
      .eq("id", grant.product_id)
      .in("kind", ["paid_community", "membership"])
      .single();
    if (productError || !product) throw new Error("This product does not include a community.");
    if (product.settings?.allowMemberPosts === false) {
      throw new Error("Only the creator can publish in this community.");
    }
    const { data: post, error: postError } = await db
      .from("commerce_community_posts")
      .insert({
        product_id: product.id,
        creator_id: product.creator_id,
        access_grant_id: grant.id,
        author_kind: "member",
        author_name: communityMemberName(grant),
        body: data.body,
      })
      .select(
        "id, author_kind, author_name, body, is_pinned, resources, moderation_status, created_at",
      )
      .single();
    if (postError) throw new Error(postError.message);
    return post;
  });

export const createCommerceCommunityComment = createServerFn({ method: "POST" })
  .validator((input) =>
    z
      .object({
        token: z.string().min(20).max(200),
        postId: uuidSchema,
        body: z.string().trim().min(1).max(3_000),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "commerce-community-comment");
    const db = commerceDb(supabaseAdmin);
    const grant = await resolveCommerceGrantByToken(db, data.token);
    if (!grant) throw new Error("This access link is not active.");
    const { data: product, error: productError } = await db
      .from("commerce_products")
      .select("id, creator_id, kind")
      .eq("id", grant.product_id)
      .in("kind", ["paid_community", "membership"])
      .single();
    if (productError || !product) throw new Error("This product does not include a community.");
    const { data: parentPost, error: postError } = await db
      .from("commerce_community_posts")
      .select("id, access_grant_id, author_name")
      .eq("id", data.postId)
      .eq("product_id", product.id)
      .eq("moderation_status", "published")
      .maybeSingle();
    if (postError) throw new Error(postError.message);
    if (!parentPost) throw new Error("This post is no longer available.");
    const authorName = communityMemberName(grant);
    const { data: comment, error } = await db
      .from("commerce_community_comments")
      .insert({
        post_id: parentPost.id,
        product_id: product.id,
        creator_id: product.creator_id,
        access_grant_id: grant.id,
        author_kind: "member",
        author_name: authorName,
        body: data.body,
      })
      .select("id, post_id, author_kind, author_name, body, moderation_status, created_at")
      .single();
    if (error || !comment) throw new Error(error?.message || "Comment could not be published.");

    if (parentPost.access_grant_id && parentPost.access_grant_id !== grant.id) {
      const { error: notificationError } = await db
        .from("commerce_community_notifications")
        .insert({
          product_id: product.id,
          creator_id: product.creator_id,
          access_grant_id: parentPost.access_grant_id,
          post_id: parentPost.id,
          comment_id: comment.id,
          kind: "comment",
          title: `${authorName} commented on your post`,
          body: data.body.slice(0, 500),
        });
      if (notificationError) {
        console.error("[commerce] community comment notification was deferred", notificationError);
      }
    }
    return comment;
  });

export const moderateCommerceCommunityContent = createServerFn({ method: "POST" })
  .validator((input) =>
    z
      .object({
        token: z.string().min(20).max(200),
        contentId: uuidSchema,
        kind: z.enum(["post", "comment"]),
        status: z.enum(["published", "hidden"]),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "commerce-community-moderation");
    const db = commerceDb(supabaseAdmin);
    const grant = await resolveCommerceGrantByToken(
      db,
      data.token,
      "id, product_id, creator_id, community_role",
    );
    if (!grant) throw new Error("This access link is not active.");
    if (grant.community_role !== "moderator") {
      throw new Error("Only community moderators can moderate member content.");
    }
    const table = data.kind === "post" ? "commerce_community_posts" : "commerce_community_comments";
    const { data: content, error: contentError } = await db
      .from(table)
      .select("id, access_grant_id, author_kind, body")
      .eq("id", data.contentId)
      .eq("product_id", grant.product_id)
      .eq("creator_id", grant.creator_id)
      .maybeSingle();
    if (contentError) throw new Error(contentError.message);
    if (!content || content.author_kind !== "member") {
      throw new Error(`${data.kind === "post" ? "Post" : "Comment"} is not available.`);
    }
    const { data: updated, error } = await db
      .from(table)
      .update({
        moderation_status: data.status,
        moderation_reason: data.status === "hidden" ? "Community moderator" : null,
        moderated_at: data.status === "hidden" ? new Date().toISOString() : null,
        moderated_by: null,
      })
      .eq("id", content.id)
      .eq("product_id", grant.product_id)
      .eq("author_kind", "member")
      .select("id, moderation_status")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) throw new Error("Community content could not be updated.");

    if (
      data.status === "hidden" &&
      content.access_grant_id &&
      content.access_grant_id !== grant.id
    ) {
      const { error: notificationError } = await db
        .from("commerce_community_notifications")
        .insert({
          product_id: grant.product_id,
          creator_id: grant.creator_id,
          access_grant_id: content.access_grant_id,
          post_id: data.kind === "post" ? content.id : null,
          comment_id: data.kind === "comment" ? content.id : null,
          kind: "moderation",
          title: `Your community ${data.kind} was hidden`,
          body: String(content.body || "").slice(0, 500),
        });
      if (notificationError) {
        console.error("[commerce] moderation notification was deferred", notificationError);
      }
    }
    return { id: updated.id, kind: data.kind, status: updated.moderation_status };
  });

export const saveCommerceCommunityPreferences = createServerFn({ method: "POST" })
  .validator((input) =>
    z
      .object({
        token: z.string().min(20).max(200),
        displayName: z.string().trim().min(1).max(120),
        notificationsEnabled: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "commerce-community-preferences");
    const db = commerceDb(supabaseAdmin);
    const grant = await resolveCommerceGrantByToken(db, data.token, "id, product_id");
    if (!grant) throw new Error("This access link is not active.");
    const { data: updated, error } = await db
      .from("commerce_access_grants")
      .update({
        member_name: data.displayName,
        community_notifications_enabled: data.notificationsEnabled,
      })
      .eq("id", grant.id)
      .select("id, member_name, community_notifications_enabled")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) throw new Error("Member preferences could not be saved.");
    return updated;
  });

export const markCommerceCommunityNotificationsRead = createServerFn({ method: "POST" })
  .validator((input) =>
    z
      .object({ token: z.string().min(20).max(200), notificationIds: z.array(uuidSchema).max(30) })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "commerce-community-notifications");
    const db = commerceDb(supabaseAdmin);
    const grant = await resolveCommerceGrantByToken(db, data.token, "id");
    if (!grant) throw new Error("This access link is not active.");
    if (!data.notificationIds.length) return { marked: 0 };
    const { data: updated, error } = await db
      .from("commerce_community_notifications")
      .update({ is_read: true })
      .eq("access_grant_id", grant.id)
      .in("id", data.notificationIds)
      .select("id");
    if (error) throw new Error(error.message);
    const { error: readMarkerError } = await db
      .from("commerce_access_grants")
      .update({ community_last_read_at: new Date().toISOString() })
      .eq("id", grant.id);
    if (readMarkerError) {
      console.error("[commerce] community read marker could not be updated", readMarkerError);
    }
    return { marked: updated?.length ?? 0 };
  });

export const recordCommerceAffiliateClick = createServerFn({ method: "POST" })
  .validator((input) =>
    z.object({ productId: uuidSchema, referrer: z.string().max(2_000).optional() }).parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "commerce-affiliate-click");
    const db = commerceDb(supabaseAdmin);
    const { data: product, error } = await db
      .from("commerce_products")
      .select("id, creator_id, kind, status, settings")
      .eq("id", data.productId)
      .eq("kind", "bento_affiliate")
      .eq("status", "published")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (
      !product ||
      !planHasEntitlement(await getPlan(product.creator_id), commerceEntitlement(product.kind))
    ) {
      throw new Error("This affiliate link is not available.");
    }
    const { error: clickError } = await db.from("commerce_affiliate_clicks").insert({
      product_id: product.id,
      creator_id: product.creator_id,
      referrer: data.referrer || null,
    });
    if (clickError) throw new Error(clickError.message);
    const { data: referralAccount, error: referralError } = await db
      .from("referral_accounts")
      .select("code")
      .eq("user_id", product.creator_id)
      .eq("status", "active")
      .maybeSingle();
    if (referralError || !referralAccount) throw new Error("This referral link is not available.");
    return { url: `${publicAppUrl()}/r/${encodeURIComponent(referralAccount.code)}` };
  });

export const commerceProductDefaults = createServerFn({ method: "GET" })
  .validator((input) => z.object({ kind: commerceProductKindSchema }).parse(input))
  .handler(({ data }) => {
    const definition = commerceKind(data.kind);
    return {
      kind: definition.kind,
      title: "",
      subtitle: "",
      description: "",
      cover_url: null,
      pricing_type: definition.defaultPricing,
      price_amount: definition.defaultPricing === "free" ? 0 : 1900,
      currency: "usd",
      billing_interval: definition.defaultPricing === "subscription" ? "month" : null,
      cta_label: definition.defaultCta,
      settings: {},
      inventory_limit: null,
    };
  });
