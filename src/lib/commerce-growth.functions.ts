/* eslint-disable @typescript-eslint/no-explicit-any -- Growth tables are added by the pending migration. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { normalizeCommerceDiscountCode } from "./commerce-growth";
import {
  enqueueEmailBatch,
  getCreatorEmailCapacity,
  recordEmailMarketingCapacityBlock,
  scheduleAudienceCampaignForCreator,
} from "./email.server";
import { newsletterContentSchema, newsletterPlainText } from "./newsletter";
import { creatorPaymentSupportsCheckoutAdjustments } from "./payment-providers";
import type {
  CommerceAudienceCampaignRecord,
  CommerceAudienceContactRecord,
  CommerceAudienceEventRecord,
  CommerceAudienceListRecord,
} from "./commerce";
import { entitlementUpgradeMessage, planHasEntitlement, type PlanId } from "./plans";
import { getPlan, requirePlanEntitlement } from "./plan.server";
import { enforceRequestRateLimit } from "./request-security.server";
import { configuredPublicOrigin, publicProductUrl, publicProfileUrl } from "./application-urls";

const uuid = z.string().uuid();
const newsletterCaptureResultSchema = z.object({
  confirmation_required: z.boolean(),
});
const optionalDate = z.string().datetime({ offset: true }).nullable().optional();

export const capturePublicEmailCapture = createServerFn({ method: "POST" })
  .validator((input) =>
    z
      .object({
        blockId: uuid,
        email: z.string().trim().email().max(254),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const unavailable = "This form is not available.";
    const failed = "Could not subscribe. Please try again.";
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "email-capture");
    const db = supabaseAdmin as any;
    const { data: block, error: blockError } = await db
      .from("blocks")
      .select("id, user_id, type, content")
      .eq("id", data.blockId)
      .maybeSingle();
    if (blockError) {
      console.error("[email-capture] block lookup failed", blockError);
      throw new Error(failed);
    }

    if (!block || block.type !== "email_capture") throw new Error(unavailable);
    try {
      await requirePlanEntitlement(block.user_id, "emailCollection", unavailable);
    } catch (cause) {
      if (cause instanceof Error && cause.message === unavailable) throw new Error(unavailable);
      console.error("[email-capture] plan lookup failed", cause);
      throw new Error(failed);
    }

    const publicationId =
      block.content && typeof block.content === "object" && !Array.isArray(block.content)
        ? (block.content as Record<string, unknown>).newsletterPublicationId
        : null;
    const hasLinkedPublication =
      typeof publicationId === "string" && uuid.safeParse(publicationId).success;
    let error: { code?: string; message?: string; details?: unknown } | null = null;
    let confirmationRequired = false;
    try {
      if (hasLinkedPublication) {
        const result = await db.rpc("capture_public_newsletter_subscription", {
          p_block_id: block.id,
          p_email: data.email,
        });
        error = result.error;
        if (!error) {
          const capture = newsletterCaptureResultSchema.safeParse(result.data);
          if (!capture.success) throw new Error("Invalid newsletter capture result");
          confirmationRequired = capture.data.confirmation_required;
        }
      } else {
        ({ error } = await db.rpc("capture_public_email_audience", {
          p_block_id: block.id,
          p_email: data.email,
        }));
      }
    } catch (cause) {
      await recordEmailMarketingCapacityBlock({
        creatorId: block.user_id,
        source: "public_capture",
        error: cause instanceof Error ? cause : (cause as Record<string, unknown>),
      });
      console.error("[email-capture] persistence failed", cause);
      throw new Error(failed);
    }
    if (error) {
      console.error("[email-capture] persistence failed", error);
      if (error.message?.includes("Email capture block not found")) {
        throw new Error(unavailable);
      }
      await recordEmailMarketingCapacityBlock({
        creatorId: block.user_id,
        source: "public_capture",
        error,
      });
      throw new Error(failed);
    }

    return { ok: true as const, confirmationRequired };
  });

async function requireGrowthEntitlement(
  userId: string,
  entitlement: "discountCodes" | "orderBumps" | "emailListBuilder" | "emailMarketing",
) {
  return requirePlanEntitlement(userId, entitlement, entitlementUpgradeMessage(entitlement));
}

export type EmailMarketingWorkspace = {
  locked: boolean;
  plan: PlanId;
  products: Array<{ id: string; title: string }>;
  audienceContacts: CommerceAudienceContactRecord[];
  audienceEvents: CommerceAudienceEventRecord[];
  audienceLists: CommerceAudienceListRecord[];
  audienceListMembers: Array<{ list_id: string; contact_id: string }>;
  audienceCampaigns: CommerceAudienceCampaignRecord[];
  newsletterSubscriptions: Array<{
    id: string;
    contact_id: string;
    publication_title: string;
    status: "pending" | "subscribed" | "unsubscribed";
    email_enabled: boolean;
  }>;
  contactUsage: Awaited<ReturnType<typeof getCreatorEmailCapacity>>;
};

export const getPublicationRecipientCounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ publicationId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    await requireGrowthEntitlement(context.userId, "emailMarketing");
    const db = supabaseAdmin as any;
    await requireOwnedNewsletterPublication(db, context.userId, data.publicationId);
    const { data: rows, error } = await db.rpc("get_newsletter_publication_recipient_counts", {
      p_creator_id: context.userId,
      p_publication_id: data.publicationId,
    });
    if (error) throw new Error(error.message);
    const counts: Record<string, number> = {};
    for (const row of rows ?? []) counts[row.list_id ?? "all"] = Number(row.recipient_count) || 0;
    return counts;
  });

const audiencePageInput = z
  .object({
    cursor: z.object({ lastSeenAt: z.string().datetime({ offset: true }), id: uuid }).optional(),
    query: z.string().trim().max(120).default(""),
    status: z.enum(["all", "subscribed", "unsubscribed", "unknown"]).default("all"),
  })
  .default({});

const AUDIENCE_PAGE_SIZE = 50;

async function requireOwnedNewsletterPublication(
  db: any,
  creatorId: string,
  publicationId: string,
) {
  const { data: publication, error } = await db
    .from("newsletter_publications")
    .select("id,paid_product_id")
    .eq("id", publicationId)
    .eq("creator_id", creatorId)
    .neq("status", "archived")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!publication) throw new Error("Publication not found.");
  return publication;
}

function literalIlikePattern(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export function audienceContactsCursorPredicate(cursor: { lastSeenAt: string; id: string }) {
  return `last_seen_at.lt.${cursor.lastSeenAt},and(last_seen_at.eq.${cursor.lastSeenAt},id.lt.${cursor.id})`;
}

const publicationAudienceInput = z.object({
  publicationId: uuid,
  cursor: z.object({ joinedAt: z.string().datetime({ offset: true }), id: uuid }).optional(),
  query: z.string().trim().max(120).default(""),
  status: z.enum(["all", "pending", "subscribed", "unsubscribed"]).default("all"),
  listId: uuid.optional(),
  joinedFrom: z.string().date().optional(),
  joinedTo: z.string().date().optional(),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
});

function nextUtcDay(date: string) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString();
}

export const getPublicationAudience = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => publicationAudienceInput.parse(input))
  .handler(async ({ data, context }) => {
    const db = supabaseAdmin as any;
    const publication = await requireOwnedNewsletterPublication(
      db,
      context.userId,
      data.publicationId,
    );

    if (data.listId) {
      const { data: list, error: listError } = await db
        .from("audience_lists")
        .select("id")
        .eq("id", data.listId)
        .eq("creator_id", context.userId)
        .eq("publication_id", data.publicationId)
        .maybeSingle();
      if (listError) throw new Error(listError.message);
      if (!list) throw new Error("Audience list not found.");
    }

    const contactUsage = getCreatorEmailCapacity(context.userId);
    if (data.status === "all") {
      let contactsQuery = db
        .from("audience_contacts")
        .select(`*${data.listId ? ",audience_list_members!inner(list_id)" : ""}`)
        .eq("creator_id", context.userId)
        .order("created_at", { ascending: data.sortDirection === "asc" })
        .order("id", { ascending: data.sortDirection === "asc" })
        .limit(AUDIENCE_PAGE_SIZE + 1);
      if (data.listId)
        contactsQuery = contactsQuery.eq("audience_list_members.list_id", data.listId);
      if (data.query)
        contactsQuery = contactsQuery.ilike("email", `%${literalIlikePattern(data.query)}%`);
      if (data.joinedFrom)
        contactsQuery = contactsQuery.gte("created_at", `${data.joinedFrom}T00:00:00.000Z`);
      if (data.joinedTo) contactsQuery = contactsQuery.lt("created_at", nextUtcDay(data.joinedTo));
      if (data.cursor) {
        const comparison = data.sortDirection === "asc" ? "gt" : "lt";
        contactsQuery = contactsQuery.or(
          `created_at.${comparison}.${data.cursor.joinedAt},and(created_at.eq.${data.cursor.joinedAt},id.${comparison}.${data.cursor.id})`,
        );
      }
      const { data: contactRows, error: contactsError } = await contactsQuery;
      if (contactsError) throw new Error(contactsError.message);
      const rows = contactRows ?? [];
      const contacts = rows.slice(0, AUDIENCE_PAGE_SIZE);
      const contactIds = contacts.map((contact: any) => contact.id);
      const { data: subscriptions, error: subscriptionsError } = contactIds.length
        ? await db
            .from("newsletter_subscriptions")
            .select("id,contact_id,status,email_enabled,source,created_at")
            .eq("publication_id", data.publicationId)
            .in("contact_id", contactIds)
        : { data: [], error: null };
      if (subscriptionsError) throw new Error(subscriptionsError.message);
      const byContact = new Map((subscriptions ?? []).map((row: any) => [row.contact_id, row]));
      const paidContacts = new Set<string>();
      if (publication.paid_product_id && contactIds.length) {
        const { data: paidRows, error: paidRowsError } = await db.rpc(
          "get_publication_audience_paid_access",
          {
            p_creator_id: context.userId,
            p_publication_id: data.publicationId,
            p_contact_ids: contactIds,
          },
        );
        if (paidRowsError) throw new Error(paidRowsError.message);
        for (const row of paidRows ?? []) paidContacts.add(row.contact_id);
      }
      const last = contacts.at(-1);
      return {
        subscribers: contacts.map(({ audience_list_members: _members, ...contact }: any) => {
          const subscription = byContact.get(contact.id) as any;
          return {
            ...contact,
            subscription_id: subscription?.id ?? null,
            subscription_status: subscription?.status ?? "not_subscribed",
            email_enabled: Boolean(subscription?.email_enabled),
            source: subscription?.source ?? contact.last_source,
            joined_at: subscription?.created_at ?? contact.created_at,
            paid_access: paidContacts.has(contact.id),
          };
        }),
        contactUsage: await contactUsage,
        nextCursor:
          rows.length > AUDIENCE_PAGE_SIZE && last
            ? { joinedAt: last.created_at, id: last.id }
            : null,
      };
    }

    let subscriptionsQuery = db
      .from("newsletter_subscriptions")
      .select(
        `id,publication_id,contact_id,status,email_enabled,source,subscribed_at,created_at,audience_contacts!inner(*${data.listId ? ",audience_list_members!inner(list_id)" : ""})`,
      )
      .eq("publication_id", data.publicationId)
      .order("created_at", { ascending: data.sortDirection === "asc" })
      .order("id", { ascending: data.sortDirection === "asc" })
      .limit(AUDIENCE_PAGE_SIZE + 1);
    subscriptionsQuery = subscriptionsQuery.eq("status", data.status);
    if (data.listId) {
      subscriptionsQuery = subscriptionsQuery.eq(
        "audience_contacts.audience_list_members.list_id",
        data.listId,
      );
    }
    if (data.query) {
      subscriptionsQuery = subscriptionsQuery.ilike(
        "audience_contacts.email",
        `%${literalIlikePattern(data.query)}%`,
      );
    }
    if (data.joinedFrom)
      subscriptionsQuery = subscriptionsQuery.gte("created_at", `${data.joinedFrom}T00:00:00.000Z`);
    if (data.joinedTo)
      subscriptionsQuery = subscriptionsQuery.lt("created_at", nextUtcDay(data.joinedTo));
    if (data.cursor) {
      const comparison = data.sortDirection === "asc" ? "gt" : "lt";
      subscriptionsQuery = subscriptionsQuery.or(
        `created_at.${comparison}.${data.cursor.joinedAt},and(created_at.eq.${data.cursor.joinedAt},id.${comparison}.${data.cursor.id})`,
      );
    }

    const { data: rows, error } = await subscriptionsQuery;
    if (error) throw new Error(error.message);
    const subscriptions = rows ?? [];
    const page = subscriptions.slice(0, AUDIENCE_PAGE_SIZE);
    const last = page.at(-1);
    const paidContacts = new Set<string>();
    if (publication.paid_product_id && page.length) {
      const { data: paidRows, error: paidRowsError } = await db.rpc(
        "get_publication_audience_paid_access",
        {
          p_creator_id: context.userId,
          p_publication_id: data.publicationId,
          p_contact_ids: page.map((row: any) => row.contact_id),
        },
      );
      if (paidRowsError) throw new Error(paidRowsError.message);
      for (const row of paidRows ?? []) paidContacts.add(row.contact_id);
    }
    return {
      subscribers: page.map(({ audience_contacts: contact, ...subscription }: any) => {
        const { audience_list_members: _members, ...canonicalContact } = contact;
        return {
          ...canonicalContact,
          subscription_id: subscription.id,
          subscription_status: subscription.status,
          email_enabled: subscription.email_enabled,
          source: subscription.source,
          joined_at: subscription.created_at,
          paid_access: paidContacts.has(subscription.contact_id),
        };
      }),
      contactUsage: await contactUsage,
      nextCursor:
        subscriptions.length > AUDIENCE_PAGE_SIZE && last
          ? { joinedAt: last.created_at, id: last.id }
          : null,
    };
  });

export const getMyAudienceContacts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => audiencePageInput.parse(input))
  .handler(async ({ data, context }) => {
    const db = supabaseAdmin as any;
    let contactsQuery = db
      .from("audience_contacts")
      .select("*")
      .eq("creator_id", context.userId)
      .order("last_seen_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(AUDIENCE_PAGE_SIZE + 1);
    if (data.status !== "all") contactsQuery = contactsQuery.eq("marketing_status", data.status);
    if (data.query) {
      contactsQuery = contactsQuery.ilike("email", `%${literalIlikePattern(data.query)}%`);
    }
    if (data.cursor) {
      contactsQuery = contactsQuery.or(audienceContactsCursorPredicate(data.cursor));
    }

    const [contactsResult, contactUsage] = await Promise.all([
      contactsQuery,
      getCreatorEmailCapacity(context.userId),
    ]);
    if (contactsResult.error) throw new Error(contactsResult.error.message);
    const rows = (contactsResult.data ?? []) as CommerceAudienceContactRecord[];
    const contacts = rows.slice(0, AUDIENCE_PAGE_SIZE);
    const contactIds = contacts.map((contact) => contact.id);
    const [eventsResult, subscriptionsResult] = contactIds.length
      ? await Promise.all([
          db
            .from("audience_events")
            .select("*")
            .eq("creator_id", context.userId)
            .in("contact_id", contactIds)
            .order("occurred_at", { ascending: false })
            .limit(1_000),
          db
            .from("newsletter_subscriptions")
            .select(
              "id,contact_id,status,email_enabled,newsletter_publications!inner(title,creator_id)",
            )
            .eq("newsletter_publications.creator_id", context.userId)
            .in("contact_id", contactIds)
            .limit(1_000),
        ])
      : [
          { data: [], error: null },
          { data: [], error: null },
        ];
    if (eventsResult.error) throw new Error(eventsResult.error.message);
    if (subscriptionsResult.error) throw new Error(subscriptionsResult.error.message);

    const last = contacts.at(-1);
    return {
      contacts,
      events: eventsResult.data ?? [],
      newsletterSubscriptions: (subscriptionsResult.data ?? []).map(
        ({ newsletter_publications: publication, ...subscription }: any) => ({
          ...subscription,
          publication_title: publication.title,
        }),
      ),
      contactUsage,
      nextCursor:
        rows.length > AUDIENCE_PAGE_SIZE && last
          ? { lastSeenAt: last.last_seen_at, id: last.id }
          : null,
    };
  });

export const archiveAudienceContacts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        contactIds: z
          .array(uuid)
          .min(1)
          .max(100)
          .refine((ids) => new Set(ids).size === ids.length, "Contact IDs must be unique."),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireGrowthEntitlement(context.userId, "emailMarketing");
    const { data: transitioned, error } = await (supabaseAdmin as any).rpc(
      "archive_audience_contacts",
      {
        p_creator_id: context.userId,
        p_contact_ids: data.contactIds,
      },
    );
    if (error) throw new Error(error.message);
    if (
      !Number.isSafeInteger(transitioned) ||
      transitioned < 0 ||
      transitioned > data.contactIds.length
    ) {
      throw new Error("Audience archive result is invalid.");
    }
    return { transitioned };
  });

export const unsubscribePublicationSubscribers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        publicationId: uuid,
        subscribers: z
          .array(
            z.object({
              subscriptionId: uuid,
              email: z.string().trim().email().max(254),
            }),
          )
          .min(1)
          .max(100)
          .refine(
            (subscribers) =>
              new Set(subscribers.map((subscriber) => subscriber.subscriptionId)).size ===
              subscribers.length,
            "Subscription IDs must be unique.",
          ),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireGrowthEntitlement(context.userId, "emailMarketing");
    const { data: unsubscribed, error } = await (supabaseAdmin as any).rpc(
      "unsubscribe_public_newsletter_subscriptions",
      {
        p_creator_id: context.userId,
        p_publication_id: data.publicationId,
        p_subscribers: data.subscribers.map((subscriber) => ({
          subscription_id: subscriber.subscriptionId,
          email: subscriber.email,
        })),
      },
    );
    if (error) throw new Error(error.message);
    if (!Number.isSafeInteger(unsubscribed) || unsubscribed !== data.subscribers.length) {
      throw new Error("Publication subscribers could not be unsubscribed.");
    }
    return { unsubscribed };
  });

export const getMyEmailMarketing = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = supabaseAdmin as any;
    const [
      plan,
      productsResult,
      contactUsageResult,
      listsResult,
      listMembersResult,
      campaignsResult,
      subscriptionsResult,
    ] = await Promise.all([
      getPlan(context.userId),
      db
        .from("commerce_products")
        .select("id, title")
        .eq("creator_id", context.userId)
        .order("created_at", { ascending: false }),
      getCreatorEmailCapacity(context.userId),
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
        .eq("kind", "broadcast")
        .order("created_at", { ascending: false })
        .limit(500),
      db
        .from("newsletter_subscriptions")
        .select(
          "id,contact_id,status,email_enabled,newsletter_publications!inner(title,creator_id)",
        )
        .eq("newsletter_publications.creator_id", context.userId)
        .limit(1_000),
    ]);

    const failed = [
      productsResult,
      listsResult,
      listMembersResult,
      campaignsResult,
      subscriptionsResult,
    ].find((result) => result.error);
    if (failed?.error) throw new Error(failed.error.message);

    const workspace = {
      locked: !planHasEntitlement(plan, "emailMarketing"),
      plan,
      products: productsResult.data ?? [],
      audienceContacts: [],
      audienceEvents: [],
      audienceLists: listsResult.data ?? [],
      audienceListMembers: (listMembersResult.data ?? []).map(
        ({ audience_lists: _audienceLists, ...member }: any) => member,
      ),
      audienceCampaigns: campaignsResult.data ?? [],
      newsletterSubscriptions: (subscriptionsResult.data ?? []).map(
        ({ newsletter_publications: publication, ...subscription }: any) => ({
          ...subscription,
          publication_title: publication.title,
        }),
      ),
      contactUsage: contactUsageResult,
    } satisfies EmailMarketingWorkspace;
    return workspace as any;
  });

async function requireCheckoutAdjustmentsProvider(userId: string) {
  const { data: profile, error } = await (supabaseAdmin as any)
    .from("profiles")
    .select("commerce_payment_provider")
    .eq("id", userId)
    .single();
  if (error) throw new Error(error.message);
  const provider = String(
    profile?.commerce_payment_provider || process.env.COMMERCE_PAYMENT_PROVIDER || "disabled",
  );
  const deployment = process.env.APP_ENV || process.env.VITE_APP_ENV || "production";
  if (
    !creatorPaymentSupportsCheckoutAdjustments(provider) &&
    !(provider === "mock" && deployment === "staging")
  ) {
    throw new Error(
      "Discounts and order bumps require Stripe, PayPal, or Razorpay. Connect one of those gateways before activating this offer.",
    );
  }
}

export const saveCommerceDiscountCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        id: uuid.optional(),
        productId: uuid.nullable().optional(),
        code: z.string().trim().min(2).max(32),
        discountType: z.enum(["percent", "fixed"]),
        discountValue: z.number().int().positive().max(100_000_000),
        currency: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z]{3}$/)
          .nullable()
          .optional(),
        startsAt: optionalDate,
        expiresAt: optionalDate,
        maxRedemptions: z.number().int().positive().max(1_000_000).nullable().optional(),
        maxRedemptionsPerEmail: z.number().int().min(1).max(100).default(1),
        isActive: z.boolean().default(true),
      })
      .superRefine((value, context) => {
        if (value.discountType === "percent" && value.discountValue > 10_000) {
          context.addIssue({
            code: "custom",
            path: ["discountValue"],
            message: "Percentage discounts cannot exceed 100%.",
          });
        }
        if (value.discountType === "fixed" && !value.currency) {
          context.addIssue({
            code: "custom",
            path: ["currency"],
            message: "Choose a currency for a fixed discount.",
          });
        }
        if (
          value.startsAt &&
          value.expiresAt &&
          new Date(value.expiresAt) <= new Date(value.startsAt)
        ) {
          context.addIssue({
            code: "custom",
            path: ["expiresAt"],
            message: "The expiry must be after the start time.",
          });
        }
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireGrowthEntitlement(context.userId, "discountCodes");
    const db = supabaseAdmin as any;
    if (data.productId) {
      const { data: ownedProduct, error: productError } = await db
        .from("commerce_products")
        .select("id, pricing_type, price_amount, currency")
        .eq("id", data.productId)
        .eq("creator_id", context.userId)
        .maybeSingle();
      if (productError) throw new Error(productError.message);
      if (!ownedProduct) throw new Error("Product not found.");
      if (ownedProduct.pricing_type !== "one_time") {
        throw new Error("Discount codes can only be used with one-time products.");
      }
      if (data.discountType === "fixed" && data.currency !== ownedProduct.currency) {
        throw new Error(
          `Use ${ownedProduct.currency.toUpperCase()} for this product's fixed discount.`,
        );
      }
      if (data.discountType === "fixed" && data.discountValue >= ownedProduct.price_amount) {
        throw new Error("The discount must leave a positive checkout total.");
      }
    }
    if (data.isActive) {
      if (data.discountType === "percent" && data.discountValue >= 10_000) {
        throw new Error("The discount must leave a positive checkout total.");
      }
      await requireCheckoutAdjustmentsProvider(context.userId);
    }
    const row = {
      creator_id: context.userId,
      product_id: data.productId || null,
      code: normalizeCommerceDiscountCode(data.code),
      discount_type: data.discountType,
      discount_value: data.discountValue,
      currency: data.discountType === "fixed" ? data.currency : null,
      starts_at: data.startsAt || null,
      expires_at: data.expiresAt || null,
      max_redemptions: data.maxRedemptions || null,
      max_redemptions_per_email: data.maxRedemptionsPerEmail,
      is_active: data.isActive,
    };
    if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(row.code)) {
      throw new Error("Use 2–32 letters, numbers, underscores, or dashes.");
    }
    const query = data.id
      ? db
          .from("commerce_discount_codes")
          .update(row)
          .eq("id", data.id)
          .eq("creator_id", context.userId)
      : db.from("commerce_discount_codes").insert(row);
    const { data: saved, error } = await query.select("*").maybeSingle();
    if (error) {
      if (error.code === "23505") throw new Error("That discount code already exists.");
      throw new Error(error.message);
    }
    if (!saved) throw new Error("Discount code not found.");
    return saved;
  });

export const deleteCommerceDiscountCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    await requireGrowthEntitlement(context.userId, "discountCodes");
    const { data: removed, error } = await (supabaseAdmin as any)
      .from("commerce_discount_codes")
      .delete()
      .eq("id", data.id)
      .eq("creator_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!removed) throw new Error("Discount code not found.");
    return { ok: true };
  });

export const saveCommerceOrderBump = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        id: uuid.optional(),
        primaryProductId: uuid,
        bumpProductId: uuid,
        headline: z.string().trim().min(1).max(120),
        description: z.string().trim().max(500).default(""),
        isActive: z.boolean().default(true),
      })
      .refine((value) => value.primaryProductId !== value.bumpProductId, {
        message: "Choose a different product for the order bump.",
        path: ["bumpProductId"],
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireGrowthEntitlement(context.userId, "orderBumps");
    const db = supabaseAdmin as any;
    const [primaryResult, bumpResult] = await Promise.all([
      db
        .from("commerce_products")
        .select("id, status, pricing_type, price_amount, currency, inventory_limit, sales_count")
        .eq("id", data.primaryProductId)
        .eq("creator_id", context.userId)
        .maybeSingle(),
      db
        .from("commerce_products")
        .select("id, status, pricing_type, price_amount, currency, inventory_limit, sales_count")
        .eq("id", data.bumpProductId)
        .eq("creator_id", context.userId)
        .maybeSingle(),
    ]);
    if (primaryResult.error) throw new Error(primaryResult.error.message);
    if (bumpResult.error) throw new Error(bumpResult.error.message);
    const primary = primaryResult.data;
    const bump = bumpResult.data;
    if (!primary || !bump) throw new Error("Product not found.");
    if (primary.pricing_type !== "one_time" || bump.pricing_type !== "one_time") {
      throw new Error("Order bumps require two one-time products.");
    }
    if (primary.currency !== bump.currency) {
      throw new Error("The main product and order bump must use the same currency.");
    }
    if (data.isActive) {
      if (primary.status !== "published" || bump.status !== "published") {
        throw new Error("Publish both products before activating this order bump.");
      }
      if (
        (primary.inventory_limit && primary.sales_count >= primary.inventory_limit) ||
        (bump.inventory_limit && bump.sales_count >= bump.inventory_limit)
      ) {
        throw new Error("A sold-out product cannot be used in an active order bump.");
      }
      await requireCheckoutAdjustmentsProvider(context.userId);
    }
    const row = {
      creator_id: context.userId,
      primary_product_id: data.primaryProductId,
      bump_product_id: data.bumpProductId,
      headline: data.headline,
      description: data.description,
      is_active: data.isActive,
    };
    const query = data.id
      ? db
          .from("commerce_order_bumps")
          .update(row)
          .eq("id", data.id)
          .eq("creator_id", context.userId)
      : db.from("commerce_order_bumps").insert(row);
    const { data: saved, error } = await query.select("*").maybeSingle();
    if (error) {
      if (error.code === "23505") {
        throw new Error("This product already has that order bump.");
      }
      throw new Error(error.message);
    }
    if (!saved) throw new Error("Order bump not found.");
    return saved;
  });

export const deleteCommerceOrderBump = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    await requireGrowthEntitlement(context.userId, "orderBumps");
    const { data: removed, error } = await (supabaseAdmin as any)
      .from("commerce_order_bumps")
      .delete()
      .eq("id", data.id)
      .eq("creator_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!removed) throw new Error("Order bump not found.");
    return { ok: true };
  });

export const createAudienceList = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        publicationId: uuid,
        name: z.string().trim().min(1).max(80),
        description: z.string().trim().max(500).default(""),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireGrowthEntitlement(context.userId, "emailListBuilder");
    const db = supabaseAdmin as any;
    await requireOwnedNewsletterPublication(db, context.userId, data.publicationId);
    const { data: saved, error } = await db
      .from("audience_lists")
      .insert({
        creator_id: context.userId,
        publication_id: data.publicationId,
        name: data.name,
        description: data.description,
      })
      .select("*")
      .single();
    if (error) {
      if (error.code === "23505") throw new Error("A list with that name already exists.");
      throw new Error(error.message);
    }
    return saved;
  });

export const deleteAudienceList = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ publicationId: uuid, id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    await requireGrowthEntitlement(context.userId, "emailListBuilder");
    const db = supabaseAdmin as any;
    await requireOwnedNewsletterPublication(db, context.userId, data.publicationId);
    const { data: removed, error } = await db
      .from("audience_lists")
      .delete()
      .eq("id", data.id)
      .eq("creator_id", context.userId)
      .eq("publication_id", data.publicationId)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!removed) throw new Error("Audience list not found.");
    return { ok: true };
  });

export const setAudienceListMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({ publicationId: uuid, listId: uuid, contactId: uuid, included: z.boolean() })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireGrowthEntitlement(context.userId, "emailListBuilder");
    const db = supabaseAdmin as any;
    await requireOwnedNewsletterPublication(db, context.userId, data.publicationId);
    const [listResult, subscriptionResult] = await Promise.all([
      db
        .from("audience_lists")
        .select("id")
        .eq("id", data.listId)
        .eq("creator_id", context.userId)
        .eq("publication_id", data.publicationId)
        .maybeSingle(),
      db
        .from("newsletter_subscriptions")
        .select("id")
        .eq("publication_id", data.publicationId)
        .eq("contact_id", data.contactId)
        .maybeSingle(),
    ]);
    if (listResult.error) throw new Error(listResult.error.message);
    if (subscriptionResult.error) throw new Error(subscriptionResult.error.message);
    const list = listResult.data;
    const subscription = subscriptionResult.data;
    if (!list || !subscription) throw new Error("List or publication subscriber not found.");
    const query = data.included
      ? db
          .from("audience_list_members")
          .upsert({ list_id: data.listId, contact_id: data.contactId })
      : db
          .from("audience_list_members")
          .delete()
          .eq("list_id", data.listId)
          .eq("contact_id", data.contactId);
    const { error } = await query;
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const saveAudienceCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        publicationId: uuid,
        id: uuid.optional(),
        listId: uuid.nullable().optional(),
        name: z.string().trim().min(1).max(120),
        subject: z.string().trim().min(1).max(180),
        previewText: z.string().trim().max(240).default(""),
        body: z.string().trim().min(1).max(50_000).optional(),
        content: newsletterContentSchema.optional(),
        postalAddress: z.string().trim().min(1).max(500),
      })
      .refine((value) => value.content || value.body, { message: "Broadcast content is required." })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireGrowthEntitlement(context.userId, "emailMarketing");
    const db = supabaseAdmin as any;
    await requireOwnedNewsletterPublication(db, context.userId, data.publicationId);
    if (data.listId) {
      const { data: list, error: listError } = await db
        .from("audience_lists")
        .select("id")
        .eq("id", data.listId)
        .eq("creator_id", context.userId)
        .eq("publication_id", data.publicationId)
        .maybeSingle();
      if (listError) throw new Error(listError.message);
      if (!list) throw new Error("Audience list not found.");
    }
    const content = data.content ?? [
      { id: crypto.randomUUID(), type: "paragraph" as const, text: data.body || "" },
    ];
    const row = {
      creator_id: context.userId,
      publication_id: data.publicationId,
      list_id: data.listId || null,
      name: data.name,
      subject: data.subject,
      preview_text: data.previewText,
      body_markdown: newsletterPlainText(content),
      content,
      sender_postal_address: data.postalAddress,
      status: "draft",
      kind: "broadcast",
      scheduled_at: null,
      sent_at: null,
    };
    const query = data.id
      ? db
          .from("audience_campaigns")
          .update(row)
          .eq("id", data.id)
          .eq("creator_id", context.userId)
          .eq("publication_id", data.publicationId)
          .eq("status", "draft")
          .eq("kind", "broadcast")
      : db.from("audience_campaigns").insert(row);
    const { data: campaign, error } = await query.select("*").maybeSingle();
    if (error) throw new Error(error.message);
    if (!campaign) throw new Error("Only draft campaigns can be edited.");
    return campaign;
  });

export const deleteAudienceCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ publicationId: uuid, id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    await requireGrowthEntitlement(context.userId, "emailMarketing");
    const db = supabaseAdmin as any;
    await requireOwnedNewsletterPublication(db, context.userId, data.publicationId);
    const { data: removed, error } = await db
      .from("audience_campaigns")
      .delete()
      .eq("id", data.id)
      .eq("creator_id", context.userId)
      .eq("publication_id", data.publicationId)
      .eq("status", "draft")
      .eq("kind", "broadcast")
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!removed) throw new Error("Only draft campaigns can be deleted.");
    return { ok: true };
  });

export const sendAudienceCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        publicationId: uuid,
        id: uuid,
        scheduledAt: z.string().datetime({ offset: true }).nullable().default(null),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireGrowthEntitlement(context.userId, "emailMarketing");
    const db = supabaseAdmin as any;
    await requireOwnedNewsletterPublication(db, context.userId, data.publicationId);
    const { data: campaign, error } = await db
      .from("audience_campaigns")
      .select("id")
      .eq("id", data.id)
      .eq("creator_id", context.userId)
      .eq("publication_id", data.publicationId)
      .eq("kind", "broadcast")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!campaign) throw new Error("Broadcast not found.");
    return scheduleAudienceCampaignForCreator({
      creatorId: context.userId,
      campaignId: data.id,
      publicationId: data.publicationId,
      kind: "broadcast",
      scheduledAt: data.scheduledAt,
    });
  });

export const sendAudienceCampaignTest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        publicationId: uuid,
        id: uuid,
        kind: z.enum(["broadcast", "newsletter"]).default("broadcast"),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireGrowthEntitlement(context.userId, "emailMarketing");
    const db = supabaseAdmin as any;
    await requireOwnedNewsletterPublication(db, context.userId, data.publicationId);
    const [
      { data: campaign, error: campaignError },
      { data: authUser, error: authError },
      { data: profile, error: profileError },
    ] = await Promise.all([
      db
        .from("audience_campaigns")
        .select("id,subject,preview_text,body_markdown,content,sender_postal_address")
        .eq("id", data.id)
        .eq("creator_id", context.userId)
        .eq("publication_id", data.publicationId)
        .eq("kind", data.kind)
        .eq("status", "draft")
        .maybeSingle(),
      db.auth.admin.getUserById(context.userId),
      db.from("profiles").select("username,display_name").eq("id", context.userId).maybeSingle(),
    ]);
    if (campaignError) throw new Error(campaignError.message);
    if (authError) throw new Error(authError.message);
    if (profileError) throw new Error(profileError.message);
    if (!campaign) throw new Error("Broadcast draft not found.");
    const recipientEmail = authUser.user?.email?.trim();
    if (!recipientEmail) throw new Error("Your authenticated account has no email address.");
    if (!campaign.sender_postal_address?.trim()) {
      throw new Error("Add a sender postal address before sending.");
    }
    const parsed = newsletterContentSchema.parse(campaign.content);
    const productIds = parsed.flatMap((block) =>
      block.type === "product" ? [block.productId] : [],
    );
    const { data: products, error: productsError } = productIds.length
      ? await db
          .from("commerce_products")
          .select("id,title,description,public_slug,price_amount,currency,billing_interval")
          .eq("creator_id", context.userId)
          .eq("status", "published")
          .in("id", productIds)
      : { data: [], error: null };
    if (productsError) throw new Error(productsError.message);
    const newsletterProducts = (products ?? []).flatMap((product: any) =>
      profile?.username && product.public_slug
        ? [
            {
              id: product.id,
              title: product.title,
              description: product.description,
              url: publicProductUrl(
                profile.username,
                product.public_slug,
                process.env.VITE_PUBLIC_URL,
              ),
              priceAmount: product.price_amount,
              currency: product.currency,
              billingInterval: product.billing_interval,
            },
          ]
        : [],
    );
    const batch = await enqueueEmailBatch([
      {
        eventKey: `audience-campaign-test:${campaign.id}:${crypto.randomUUID()}`,
        eventType: "creator_campaign",
        category: "transactional",
        recipientEmail,
        userId: context.userId,
        payload: {
          creatorName: profile?.display_name || profile?.username || "Broadcast test",
          creatorUrl: profile?.username
            ? publicProfileUrl(profile.username, null, process.env.VITE_PUBLIC_URL)
            : configuredPublicOrigin(process.env.VITE_PUBLIC_URL),
          subject: `[Test] ${campaign.subject}`,
          previewText: campaign.preview_text,
          body: campaign.body_markdown,
          newsletterContent: parsed,
          newsletterProducts,
          postalAddress: campaign.sender_postal_address,
        },
      },
    ]);
    return { queued: batch.rows.length === 1 };
  });

export const scheduleNewsletterIssue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        id: uuid,
        publicationId: uuid.optional(),
        publish: z.boolean().default(false),
        scheduledAt: z.string().datetime({ offset: true }).nullable().default(null),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requireGrowthEntitlement(context.userId, "emailMarketing");
    if (data.publish && !data.publicationId) throw new Error("Newsletter publication is required.");
    if (data.publicationId)
      await requireOwnedNewsletterPublication(
        supabaseAdmin as any,
        context.userId,
        data.publicationId,
      );
    return scheduleAudienceCampaignForCreator({
      creatorId: context.userId,
      campaignId: data.id,
      publicationId: data.publicationId,
      kind: "newsletter",
      scheduledAt: data.scheduledAt,
      publish: data.publish,
    });
  });
