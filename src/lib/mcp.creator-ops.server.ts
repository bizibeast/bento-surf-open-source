import { configuredPublicOrigin } from "@/lib/application-urls";
/* eslint-disable @typescript-eslint/no-explicit-any -- Creator tables can be ahead of generated database types. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import {
  blockContentSchema,
  blockMediaUrlSchema,
  blockTypeSchema,
  pageIdInputSchema,
} from "./blocks.functions";
import { pageNameSchema, pageUrlSchema, slugifyPageName, uniquePageSlug } from "./pages.functions";
import {
  productDraftSchema,
  resolveProductNoindex,
  requireCalendarBlockSetup,
  requireCommerceKind,
  uniqueProductSlug,
  uniquePublicProductSlug,
  validateCommerceProductPublication,
} from "./commerce.functions";
import { privateProductAssetKeys } from "./commerce-delete.functions";
import {
  assertGenericCommerceProductMutationAllowed,
  commerceProductBlockContent,
  isCommerceOfferKind,
  type CommerceProductRecord,
} from "./commerce";
import { verifyDigitalProductAssets } from "./commerce-assets.server";
import { requireCreatorStorePaymentSetup } from "./payment-connection-policy.server";
import { getMediaBucket } from "./r2-storage.server";
import { nextEmptyGridRow } from "./grid-geometry";
import {
  blockEntitlement,
  entitlementUpgradeMessage,
  planHasEntitlement,
  planLimits,
  planName,
} from "./plans";
import { getPlan, requirePlanEntitlement } from "./plan.server";
import { availabilityFromRow, availabilitySchema, DEFAULT_AVAILABILITY } from "./booking";
import { clearPublicBookingCalendarCache } from "./public-booking-calendar-cache.server";
import { normalizeCommerceDiscountCode } from "./commerce-growth";
import { creatorPaymentSupportsCheckoutAdjustments } from "./payment-providers";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { scheduleAudienceCampaignForCreator } from "./email.server";
import {
  communityTokenHash,
  creatorCommunityIdentity,
  creatorCommunityProduct,
  notifyCommunityMembers,
  queueCommunityInvite,
  randomCommunityAccessToken,
} from "./community.functions";
import { normalizeCommunityResources } from "./community-member";
import { editableProfileColumns, profileUpdateSchema } from "./profile.functions";
import { updateProfileWithRls } from "./profile-query";
import { isPremiumPattern } from "./plans";
import { analyticsDays } from "./plans";
import { historyStart, rangeStart } from "./analytics.functions";
import { enforceRequestRateLimit } from "./request-security.server";
import { ensureReferralAccount } from "./referral.functions";
import { isReferralCode } from "./referrals";

export type CreatorMcpContext = {
  userId: string;
  supabase: SupabaseClient<Database>;
};

const uuid = z.string().uuid();

export const pageMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    name: pageNameSchema,
    url: pageUrlSchema.nullable().optional(),
  }),
  z.object({ action: z.literal("rename"), id: uuid, name: pageNameSchema }),
  z.object({ action: z.literal("delete"), id: uuid }),
]);

export async function mutatePage(context: CreatorMcpContext, input: unknown) {
  const data = pageMutationSchema.parse(input);
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "mcp-page", context.userId);
  const client = context.supabase;
  if (data.action === "delete") {
    const { data: deleted, error } = await client
      .from("pages")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error || !deleted) throw new Error("Page not found.");
    return { id: deleted.id, deleted: true };
  }
  if (data.action === "rename") {
    const slug = await uniquePageSlug(client, context.userId, slugifyPageName(data.name), data.id);
    const { data: page, error } = await client
      .from("pages")
      .update({ name: data.name.trim(), slug })
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("*")
      .maybeSingle();
    if (error || !page) throw new Error("Page not found.");
    return page;
  }

  const { count, error: countError } = await client
    .from("pages")
    .select("id", { count: "exact", head: true })
    .eq("user_id", context.userId);
  if (countError) throw new Error("Pages could not be counted.");
  const plan = await getPlan(context.userId);
  const limit = planLimits(plan).maxPages;
  if (limit !== null && (count || 0) + 1 >= limit) {
    throw new Error(`${planName(plan)} includes ${limit} pages. Delete a page or upgrade.`);
  }
  const slug = await uniquePageSlug(client, context.userId, slugifyPageName(data.name));
  const { data: page, error } = await client
    .from("pages")
    .insert({
      user_id: context.userId,
      name: data.name.trim(),
      slug,
      position: count || 0,
      url: data.url ?? null,
    })
    .select("*")
    .single();
  if (error || !page) throw new Error("Page could not be created.");
  return page;
}

export const blockMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    type: blockTypeSchema,
    content: blockContentSchema.default({}),
    coverUrl: blockMediaUrlSchema.nullable().optional(),
    width: z.number().int().min(1).max(4).default(2),
    height: z.number().int().min(1).max(6).default(2),
    x: z.number().int().min(0).optional(),
    y: z.number().int().min(0).optional(),
    pageId: pageIdInputSchema,
  }),
  z.object({
    action: z.literal("update"),
    id: uuid,
    content: blockContentSchema.optional(),
    coverUrl: blockMediaUrlSchema.nullable().optional(),
    width: z.number().int().min(1).max(4).optional(),
    height: z.number().int().min(1).max(6).optional(),
  }),
  z.object({
    action: z.literal("layout"),
    items: z
      .array(
        z.object({
          id: uuid,
          x: z.number().int().min(0),
          y: z.number().int().min(0),
          width: z.number().int().min(1).max(4),
          height: z.number().int().min(1).max(6),
          position: z.number().int().min(0),
        }),
      )
      .max(200),
  }),
  z.object({ action: z.literal("delete"), id: uuid }),
]);

export function mergeMcpBlockContent(
  current: unknown,
  patch: Record<string, unknown>,
): Database["public"]["Tables"]["blocks"]["Update"]["content"] {
  const existing = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  return { ...(existing as Record<string, any>), ...patch };
}

async function requireBlockEntitlement(userId: string, type: string) {
  const entitlement = blockEntitlement(type);
  if (entitlement && !planHasEntitlement(await getPlan(userId), entitlement)) {
    throw new Error(entitlementUpgradeMessage(entitlement));
  }
}

export async function mutateBlock(context: CreatorMcpContext, input: unknown) {
  const data = blockMutationSchema.parse(input);
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "mcp-block", context.userId);
  const client = context.supabase;
  if (data.action === "delete") {
    const { data: deleted, error } = await client
      .from("blocks")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error || !deleted) throw new Error("Block not found.");
    return { id: deleted.id, deleted: true };
  }
  if (data.action === "layout") {
    const owned = await client
      .from("blocks")
      .select("id")
      .eq("user_id", context.userId)
      .in(
        "id",
        data.items.map((item) => item.id),
      );
    if (owned.error || owned.data?.length !== new Set(data.items.map((item) => item.id)).size) {
      throw new Error("One or more blocks are unavailable.");
    }
    await Promise.all(
      data.items.map((item) =>
        client
          .from("blocks")
          .update({
            x: item.x,
            y: item.y,
            w: item.width,
            h: item.height,
            position: item.position,
          })
          .eq("id", item.id)
          .eq("user_id", context.userId),
      ),
    );
    return { updated: data.items.length };
  }
  if (data.action === "update") {
    const { data: existing, error: existingError } = await client
      .from("blocks")
      .select("type,content")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (existingError || !existing) throw new Error("Block not found.");
    await requireBlockEntitlement(context.userId, existing.type);
    const patch = {
      ...(data.content !== undefined
        ? { content: mergeMcpBlockContent(existing.content, data.content) }
        : {}),
      ...(data.coverUrl !== undefined ? { cover_url: data.coverUrl } : {}),
      ...(data.width !== undefined ? { w: data.width } : {}),
      ...(data.height !== undefined ? { h: data.height } : {}),
    };
    const { data: block, error } = await client
      .from("blocks")
      .update(patch)
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("*")
      .single();
    if (error) throw new Error("Block could not be updated.");
    return block;
  }

  await requireBlockEntitlement(context.userId, data.type);
  if (data.pageId) {
    const { data: page } = await client
      .from("pages")
      .select("id")
      .eq("id", data.pageId)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!page) throw new Error("Page not found.");
  }
  let layoutQuery = client.from("blocks").select("y,h").eq("user_id", context.userId);
  layoutQuery = data.pageId
    ? layoutQuery.eq("page_id", data.pageId)
    : layoutQuery.is("page_id", null);
  const { data: layout, error: layoutError } = await layoutQuery;
  if (layoutError) throw new Error("Page layout could not be loaded.");
  const { data: block, error } = await client
    .from("blocks")
    .insert({
      user_id: context.userId,
      type: data.type,
      content: data.content,
      cover_url: data.coverUrl ?? null,
      w: data.width,
      h: data.height,
      x: data.x ?? 0,
      y: data.y ?? nextEmptyGridRow(layout || []),
      position: layout?.length || 0,
      page_id: data.pageId ?? null,
    })
    .select("*")
    .single();
  if (error || !block) throw new Error("Block could not be created.");
  return block;
}

const productMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    product: productDraftSchema,
    addToBento: z.boolean().default(true),
    pageId: uuid.nullable().optional(),
  }),
  z.object({ action: z.literal("update"), id: uuid, product: productDraftSchema }),
  z.object({
    action: z.literal("set_status"),
    id: uuid,
    status: z.enum(["published", "archived"]),
  }),
  z.object({
    action: z.literal("add_to_page"),
    productId: uuid,
    pageId: uuid.nullable().optional(),
  }),
  z.object({ action: z.literal("delete"), productId: uuid }),
]);

type ProductDraft = z.infer<typeof productDraftSchema>;

export function mergeMcpProductDraft(
  current: Record<string, any>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const patchSettings =
    patch.settings && typeof patch.settings === "object" && !Array.isArray(patch.settings)
      ? (patch.settings as Record<string, unknown>)
      : null;
  const currentSettings =
    current.settings && typeof current.settings === "object" && !Array.isArray(current.settings)
      ? (current.settings as Record<string, unknown>)
      : {};
  return {
    kind: current.kind,
    title: current.title,
    subtitle: current.subtitle ?? "",
    description: current.description ?? "",
    cover_url: current.cover_url ?? null,
    pricing_type: current.pricing_type,
    price_amount: current.price_amount,
    currency: current.currency,
    billing_interval: current.billing_interval ?? null,
    cta_label: current.cta_label,
    settings: currentSettings,
    inventory_limit: current.inventory_limit ?? null,
    noindex: Boolean(current.noindex),
    ...patch,
    ...(Object.hasOwn(patch, "settings") && patchSettings
      ? { settings: { ...currentSettings, ...patchSettings } }
      : {}),
  };
}

function productPatch(product: ProductDraft, existingNoindex = true) {
  return {
    ...product,
    noindex: resolveProductNoindex(product.noindex, existingNoindex),
    cover_url: product.cover_url || null,
    billing_interval: product.pricing_type === "subscription" ? product.billing_interval : null,
    inventory_limit: product.inventory_limit ?? null,
  };
}

async function createProductBlock(
  context: CreatorMcpContext,
  product: CommerceProductRecord,
  pageId?: string | null,
) {
  assertGenericCommerceProductMutationAllowed(product.kind);
  const client = context.supabase as any;
  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("username")
    .eq("id", context.userId)
    .single();
  if (profileError || !profile) throw new Error("Profile not found.");
  if (pageId) {
    const { data: page } = await client
      .from("pages")
      .select("id")
      .eq("id", pageId)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!page) throw new Error("Page not found.");
  }
  if (product.kind === "coaching_call") {
    await requireCalendarBlockSetup(client, context.userId);
  }
  let query = client.from("blocks").select("y,h").eq("user_id", context.userId);
  query = pageId ? query.eq("page_id", pageId) : query.is("page_id", null);
  const { data: layout, error: layoutError } = await query;
  if (layoutError) throw new Error("Page layout could not be loaded.");
  const { data: block, error } = await client
    .from("blocks")
    .insert({
      user_id: context.userId,
      type: "commerce",
      content: commerceProductBlockContent(product, profile.username),
      cover_url: product.cover_url,
      x: 0,
      y: nextEmptyGridRow(layout || []),
      w: 2,
      h: 2,
      position: layout?.length || 0,
      page_id: pageId ?? null,
    })
    .select("*")
    .single();
  if (error || !block) throw new Error("The Bento product block could not be created.");
  return block;
}

export async function mutateProduct(context: CreatorMcpContext, input: unknown) {
  const client = context.supabase as any;
  let candidate = input;
  let ownedUpdate: Record<string, any> | null = null;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const supplied = input as Record<string, unknown>;
    if (
      supplied.action === "create" &&
      supplied.product &&
      typeof supplied.product === "object" &&
      !Array.isArray(supplied.product) &&
      (supplied.product as Record<string, unknown>).kind === "newsletter"
    ) {
      assertGenericCommerceProductMutationAllowed("newsletter");
    }
    if (supplied.action === "update") {
      const id = z.string().uuid().parse(supplied.id);
      const { data: current, error } = await client
        .from("commerce_products")
        .select("*")
        .eq("id", id)
        .eq("creator_id", context.userId)
        .maybeSingle();
      if (error || !current) throw new Error("Product not found.");
      assertGenericCommerceProductMutationAllowed(current.kind);
      const patch =
        supplied.product && typeof supplied.product === "object" && !Array.isArray(supplied.product)
          ? (supplied.product as Record<string, unknown>)
          : {};
      ownedUpdate = current;
      candidate = { ...supplied, id, product: mergeMcpProductDraft(current, patch) };
    }
  }
  const data = productMutationSchema.parse(candidate);
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "mcp-product", context.userId);
  if (data.action === "delete") {
    const { data: product, error: productError } = await client
      .from("commerce_products")
      .select("id,kind,settings")
      .eq("id", data.productId)
      .eq("creator_id", context.userId)
      .maybeSingle();
    if (productError || !product) throw new Error("Product not found.");
    assertGenericCommerceProductMutationAllowed(product.kind);
    const { data: result, error } = await client.rpc("delete_unused_commerce_product", {
      p_product_id: product.id,
    });
    if (error || !result || typeof result !== "object") {
      throw new Error("Product could not be deleted.");
    }
    if (result.deleted === true) {
      const keys = privateProductAssetKeys(product.settings, context.userId);
      if (keys.length)
        await getMediaBucket()
          .delete(keys)
          .catch(() => undefined);
    }
    return {
      deleted: result.deleted === true,
      archived: result.archived === true,
      removedBlocks: Math.max(0, Number(result.removedBlocks || 0)),
    };
  }
  if (data.action === "add_to_page") {
    const { data: product, error } = await client
      .from("commerce_products")
      .select("*")
      .eq("id", data.productId)
      .eq("creator_id", context.userId)
      .single();
    if (error || !product) throw new Error("Product not found.");
    assertGenericCommerceProductMutationAllowed(product.kind);
    await requireCommerceKind(context.userId, product.kind);
    if (isCommerceOfferKind(product.kind)) await requireCreatorStorePaymentSetup(context.userId);
    return createProductBlock(context, product, data.pageId);
  }
  if (data.action === "set_status") {
    const { data: current, error: loadError } = await client
      .from("commerce_products")
      .select("*")
      .eq("id", data.id)
      .eq("creator_id", context.userId)
      .maybeSingle();
    if (loadError || !current) throw new Error("Product not found.");
    assertGenericCommerceProductMutationAllowed(current.kind);
    if (data.status === "published") {
      await validateCommerceProductPublication(context.userId, current);
    }
    const { data: product, error } = await client
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
    if (error || !product) throw new Error("Product status could not be changed.");
    return product;
  }
  if (data.action === "update") {
    const current = ownedUpdate;
    if (!current) throw new Error("Product not found.");
    if (current.kind !== data.product.kind) {
      throw new Error("An existing product cannot be changed into a different type.");
    }
    await requireCommerceKind(context.userId, current.kind);
    await verifyDigitalProductAssets(context.userId, data.product.kind, data.product.settings);
    const patch = productPatch(data.product, current.noindex);
    if (current.status === "published") {
      await validateCommerceProductPublication(context.userId, {
        ...current,
        ...patch,
      } as Parameters<typeof validateCommerceProductPublication>[1]);
    }
    const { data: product, error } = await client
      .from("commerce_products")
      .update(patch)
      .eq("id", data.id)
      .eq("creator_id", context.userId)
      .select("*")
      .single();
    if (error || !product) throw new Error("Product could not be updated.");
    return product;
  }

  await requireCommerceKind(context.userId, data.product.kind);
  if (
    isCommerceOfferKind(data.product.kind) &&
    (data.product.kind !== "coaching_call" || data.addToBento)
  ) {
    await requireCreatorStorePaymentSetup(context.userId);
  }
  await verifyDigitalProductAssets(context.userId, data.product.kind, data.product.settings);
  if (data.product.kind === "coaching_call" && data.addToBento) {
    await requireCalendarBlockSetup(client, context.userId);
  }
  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("username")
    .eq("id", context.userId)
    .single();
  if (profileError || !profile) throw new Error("Profile not found.");
  const [slug, publicSlug] = await Promise.all([
    uniqueProductSlug(client, profile.username, data.product.title),
    uniquePublicProductSlug(client, context.userId, data.product.title),
  ]);
  const { data: product, error } = await client
    .from("commerce_products")
    .insert({
      ...productPatch(data.product),
      creator_id: context.userId,
      slug,
      public_slug: publicSlug,
    })
    .select("*")
    .single();
  if (error || !product) throw new Error("Product could not be created.");
  try {
    await validateCommerceProductPublication(context.userId, product);
    const published = await client
      .from("commerce_products")
      .update({ status: "published", published_at: new Date().toISOString() })
      .eq("id", product.id)
      .eq("creator_id", context.userId)
      .select("*")
      .single();
    if (published.error || !published.data) throw new Error("Product could not be published.");
    const block = data.addToBento
      ? await createProductBlock(context, published.data, data.pageId)
      : null;
    return { product: published.data, block };
  } catch (error) {
    await client
      .from("commerce_products")
      .delete()
      .eq("id", product.id)
      .eq("creator_id", context.userId);
    throw error;
  }
}

export const calendarMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save_availability"), availability: availabilitySchema }),
  z.object({ action: z.literal("set_public_page"), enabled: z.boolean() }),
  z.object({ action: z.literal("rename_public_page"), name: z.string().trim().min(1).max(40) }),
  z.object({
    action: z.literal("set_review_visibility"),
    reviewId: uuid,
    isPublic: z.boolean(),
  }),
  z.object({
    action: z.literal("set_default_connection"),
    type: z.enum(["google", "fathom"]),
    id: uuid,
  }),
  z.object({
    action: z.literal("disconnect_connection"),
    type: z.enum(["google", "fathom"]),
    id: uuid,
  }),
]);

export async function getCalendarWorkspace(context: CreatorMcpContext) {
  const client = supabaseAdmin as any;
  const [availability, connections, fathom, sessions, bookings, reviews, profile] =
    await Promise.all([
      client
        .from("booking_availability")
        .select("*")
        .eq("creator_id", context.userId)
        .maybeSingle(),
      client
        .from("booking_calendar_connections")
        .select(
          "id,provider,email,display_name,calendar_id,status,is_default,last_error,created_at",
        )
        .eq("user_id", context.userId)
        .order("created_at"),
      client
        .from("booking_fathom_connections")
        .select("id,email,display_name,status,is_default,last_error,created_at")
        .eq("user_id", context.userId)
        .order("created_at"),
      client
        .from("commerce_products")
        .select("*")
        .eq("creator_id", context.userId)
        .eq("kind", "coaching_call")
        .neq("status", "archived")
        .order("created_at", { ascending: false }),
      client
        .from("commerce_bookings")
        .select("*")
        .eq("creator_id", context.userId)
        .order("starts_at", { ascending: false })
        .limit(200),
      client
        .from("booking_reviews")
        .select("*")
        .eq("creator_id", context.userId)
        .order("created_at", { ascending: false })
        .limit(100),
      client
        .from("profiles")
        .select("username,calendar_page_enabled,calendar_page_name")
        .eq("id", context.userId)
        .single(),
    ]);
  for (const result of [availability, connections, fathom, sessions, bookings, reviews, profile]) {
    if (result.error) throw new Error("Calendar workspace could not be loaded.");
  }
  return {
    availability: availability.data ? availabilityFromRow(availability.data) : DEFAULT_AVAILABILITY,
    calendarConnections: connections.data || [],
    fathomConnections: fathom.data || [],
    sessions: sessions.data || [],
    bookings: bookings.data || [],
    reviews: reviews.data || [],
    publicPage: {
      enabled: Boolean(profile.data.calendar_page_enabled),
      name: profile.data.calendar_page_name || "Calendar",
      username: profile.data.username,
    },
  };
}

export async function mutateCalendar(context: CreatorMcpContext, input: unknown) {
  const data = calendarMutationSchema.parse(input);
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "mcp-calendar", context.userId);
  await requirePlanEntitlement(
    context.userId,
    "calendarBookings",
    "Calendar bookings are included with the Store plan.",
  );
  const client = supabaseAdmin as any;
  if (data.action === "save_availability") {
    const availability = data.availability;
    const { error } = await client.from("booking_availability").upsert(
      {
        creator_id: context.userId,
        timezone: availability.timezone,
        weekly_rules: availability.weeklyRules,
        date_overrides: availability.dateOverrides,
        minimum_notice_minutes: availability.minimumNoticeMinutes,
        maximum_days_ahead: availability.maximumDaysAhead,
        buffer_before_minutes: availability.bufferBeforeMinutes,
        buffer_after_minutes: availability.bufferAfterMinutes,
        slot_interval_minutes: availability.slotIntervalMinutes,
      },
      { onConflict: "creator_id" },
    );
    if (error) throw new Error("Availability could not be saved.");
    return { ok: true };
  }
  if (data.action === "set_public_page" || data.action === "rename_public_page") {
    const patch =
      data.action === "set_public_page"
        ? { calendar_page_enabled: data.enabled }
        : { calendar_page_name: data.name };
    const { data: profile, error } = await client
      .from("profiles")
      .update(patch)
      .eq("id", context.userId)
      .select("username,calendar_page_enabled,calendar_page_name")
      .single();
    if (error) throw new Error("Calendar page could not be updated.");
    await clearPublicBookingCalendarCache(profile.username);
    return profile;
  }
  if (data.action === "set_review_visibility") {
    const { data: review, error } = await client
      .from("booking_reviews")
      .update({ is_public: data.isPublic })
      .eq("id", data.reviewId)
      .eq("creator_id", context.userId)
      .select("id,is_public")
      .maybeSingle();
    if (error || !review) throw new Error("Review not found.");
    const { data: profile } = await client
      .from("profiles")
      .select("username")
      .eq("id", context.userId)
      .single();
    if (profile) await clearPublicBookingCalendarCache(profile.username);
    return review;
  }
  const table =
    data.type === "google" ? "booking_calendar_connections" : "booking_fathom_connections";
  if (data.action === "disconnect_connection") {
    const { data: connection, error } = await client
      .from(table)
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error || !connection) throw new Error("Connection not found.");
    return { id: connection.id, disconnected: true };
  }
  const { data: owned } = await client
    .from(table)
    .select("id")
    .eq("id", data.id)
    .eq("user_id", context.userId)
    .eq("status", "active")
    .maybeSingle();
  if (!owned) throw new Error("Connection not found.");
  await client.from(table).update({ is_default: false }).eq("user_id", context.userId);
  const { error } = await client
    .from(table)
    .update({ is_default: true })
    .eq("id", data.id)
    .eq("user_id", context.userId);
  if (error) throw new Error("Default connection could not be changed.");
  return { id: data.id, isDefault: true };
}

const discountMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
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
    startsAt: z.string().datetime({ offset: true }).nullable().optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    maxRedemptions: z.number().int().positive().max(1_000_000).nullable().optional(),
    maxRedemptionsPerEmail: z.number().int().min(1).max(100).default(1),
    isActive: z.boolean().default(true),
  }),
  z.object({ action: z.literal("delete"), id: uuid }),
]);

async function requireCheckoutAdjustmentProvider(userId: string) {
  const { data: profile, error } = await (supabaseAdmin as any)
    .from("profiles")
    .select("commerce_payment_provider")
    .eq("id", userId)
    .single();
  if (error) throw new Error("Payment provider could not be checked.");
  const provider = String(
    profile?.commerce_payment_provider || process.env.COMMERCE_PAYMENT_PROVIDER || "disabled",
  );
  const deployment = process.env.APP_ENV || process.env.VITE_APP_ENV || "production";
  if (
    !creatorPaymentSupportsCheckoutAdjustments(provider) &&
    !(provider === "mock" && deployment === "staging")
  ) {
    throw new Error("Discounts require Stripe, PayPal, or Razorpay.");
  }
}

export async function mutateDiscount(context: CreatorMcpContext, input: unknown) {
  const data = discountMutationSchema.parse(input);
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "mcp-discount", context.userId);
  await requirePlanEntitlement(
    context.userId,
    "discountCodes",
    entitlementUpgradeMessage("discountCodes"),
  );
  const client = supabaseAdmin as any;
  if (data.action === "delete") {
    const { data: removed, error } = await client
      .from("commerce_discount_codes")
      .delete()
      .eq("id", data.id)
      .eq("creator_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error || !removed) throw new Error("Discount code not found.");
    return { id: data.id, deleted: true };
  }
  if (data.discountType === "percent" && data.discountValue >= 10_000) {
    throw new Error("The discount must leave a positive checkout total.");
  }
  if (data.discountType === "fixed" && !data.currency) {
    throw new Error("Choose a currency for a fixed discount.");
  }
  if (data.startsAt && data.expiresAt && new Date(data.expiresAt) <= new Date(data.startsAt)) {
    throw new Error("The expiry must be after the start time.");
  }
  if (data.productId) {
    const { data: product } = await client
      .from("commerce_products")
      .select("pricing_type,price_amount,currency")
      .eq("id", data.productId)
      .eq("creator_id", context.userId)
      .maybeSingle();
    if (!product) throw new Error("Product not found.");
    if (product.pricing_type !== "one_time") {
      throw new Error("Discount codes can only be used with one-time products.");
    }
    if (data.discountType === "fixed" && data.currency !== product.currency) {
      throw new Error(`Use ${product.currency.toUpperCase()} for this fixed discount.`);
    }
    if (data.discountType === "fixed" && data.discountValue >= product.price_amount) {
      throw new Error("The discount must leave a positive checkout total.");
    }
  }
  if (data.isActive) await requireCheckoutAdjustmentProvider(context.userId);
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
    ? client
        .from("commerce_discount_codes")
        .update(row)
        .eq("id", data.id)
        .eq("creator_id", context.userId)
    : client.from("commerce_discount_codes").insert(row);
  const { data: discount, error } = await query.select("*").maybeSingle();
  if (error?.code === "23505") throw new Error("That discount code already exists.");
  if (error || !discount) throw new Error("Discount code could not be saved.");
  return discount;
}

async function requireOwnedNewsletterPublication(
  client: any,
  creatorId: string,
  publicationId: string,
) {
  const { data, error } = await client
    .from("newsletter_publications")
    .select("id")
    .eq("id", publicationId)
    .eq("creator_id", creatorId)
    .neq("status", "archived")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Publication not found.");
}

export async function getStoreWorkspace(context: CreatorMcpContext, publicationId?: string) {
  const client = supabaseAdmin as any;
  const { data: publications, error: publicationsError } = await client
    .from("newsletter_publications")
    .select("id,title,slug,status,is_default")
    .eq("creator_id", context.userId)
    .neq("status", "archived")
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true });
  if (publicationsError) throw new Error("Store workspace could not be loaded.");
  if (publicationId && !publications?.some((publication: any) => publication.id === publicationId))
    throw new Error("Publication not found.");

  let audienceLists = client.from("audience_lists").select("*").eq("creator_id", context.userId);
  let audienceCampaigns = client
    .from("audience_campaigns")
    .select("*")
    .eq("creator_id", context.userId);
  if (publicationId) {
    audienceLists = audienceLists.eq("publication_id", publicationId);
    audienceCampaigns = audienceCampaigns.eq("publication_id", publicationId);
  } else {
    audienceCampaigns = audienceCampaigns.eq("kind", "broadcast");
  }
  const results = await Promise.all([
    client
      .from("commerce_products")
      .select("*")
      .eq("creator_id", context.userId)
      .order("created_at", { ascending: false }),
    client
      .from("commerce_orders")
      .select("*")
      .eq("creator_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(100),
    client
      .from("commerce_leads")
      .select("*")
      .eq("creator_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(100),
    client
      .from("audience_contacts")
      .select("*")
      .eq("creator_id", context.userId)
      .order("last_seen_at", { ascending: false })
      .limit(500),
    client
      .from("commerce_discount_codes")
      .select("*")
      .eq("creator_id", context.userId)
      .order("created_at", { ascending: false }),
    client
      .from("commerce_order_bumps")
      .select("*")
      .eq("creator_id", context.userId)
      .order("created_at", { ascending: false }),
    audienceLists.order("created_at", { ascending: false }),
    audienceCampaigns.order("created_at", { ascending: false }).limit(500),
  ]);
  if (results.some((result) => result.error))
    throw new Error("Store workspace could not be loaded.");
  const [products, orders, leads, contacts, discounts, bumps, lists, campaigns] = results;
  return {
    publications: publications || [],
    selectedPublicationId: publicationId ?? null,
    products: products.data || [],
    orders: orders.data || [],
    leads: leads.data || [],
    audienceContacts: contacts.data || [],
    discountCodes: discounts.data || [],
    orderBumps: bumps.data || [],
    audienceLists: lists.data || [],
    audienceCampaigns: campaigns.data || [],
  };
}

const orderBumpMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    id: uuid.optional(),
    primaryProductId: uuid,
    bumpProductId: uuid,
    headline: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).default(""),
    isActive: z.boolean().default(true),
  }),
  z.object({ action: z.literal("delete"), id: uuid }),
]);

export async function mutateOrderBump(context: CreatorMcpContext, input: unknown) {
  const data = orderBumpMutationSchema.parse(input);
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "mcp-order-bump", context.userId);
  await requirePlanEntitlement(
    context.userId,
    "orderBumps",
    entitlementUpgradeMessage("orderBumps"),
  );
  const client = supabaseAdmin as any;
  if (data.action === "delete") {
    const { data: deleted, error } = await client
      .from("commerce_order_bumps")
      .delete()
      .eq("id", data.id)
      .eq("creator_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error || !deleted) throw new Error("Order bump not found.");
    return { id: data.id, deleted: true };
  }
  if (data.primaryProductId === data.bumpProductId) {
    throw new Error("Choose two different products.");
  }
  const [primaryResult, bumpResult] = await Promise.all([
    client
      .from("commerce_products")
      .select("id,status,pricing_type,currency,inventory_limit,sales_count")
      .eq("id", data.primaryProductId)
      .eq("creator_id", context.userId)
      .maybeSingle(),
    client
      .from("commerce_products")
      .select("id,status,pricing_type,currency,inventory_limit,sales_count")
      .eq("id", data.bumpProductId)
      .eq("creator_id", context.userId)
      .maybeSingle(),
  ]);
  const primary = primaryResult.data;
  const bump = bumpResult.data;
  if (!primary || !bump) throw new Error("One or both products were not found.");
  if (primary.pricing_type !== "one_time" || bump.pricing_type !== "one_time") {
    throw new Error("Order bumps require two one-time products.");
  }
  if (primary.currency !== bump.currency) {
    throw new Error("The main product and order bump must use the same currency.");
  }
  if (data.isActive) {
    if (primary.status !== "published" || bump.status !== "published") {
      throw new Error("Publish both products before activating an order bump.");
    }
    if (
      (primary.inventory_limit && primary.sales_count >= primary.inventory_limit) ||
      (bump.inventory_limit && bump.sales_count >= bump.inventory_limit)
    ) {
      throw new Error("A sold-out product cannot be used in an active order bump.");
    }
    await requireCheckoutAdjustmentProvider(context.userId);
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
    ? client
        .from("commerce_order_bumps")
        .update(row)
        .eq("id", data.id)
        .eq("creator_id", context.userId)
    : client.from("commerce_order_bumps").insert(row);
  const { data: saved, error } = await query.select("*").maybeSingle();
  if (error?.code === "23505") throw new Error("This product already has that order bump.");
  if (error || !saved) throw new Error("Order bump could not be saved.");
  return saved;
}

const audienceMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_list"),
    publicationId: uuid,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).default(""),
  }),
  z.object({ action: z.literal("delete_list"), id: uuid, publicationId: uuid.optional() }),
  z.object({
    action: z.literal("set_list_member"),
    listId: uuid,
    publicationId: uuid.optional(),
    contactId: uuid,
    included: z.boolean(),
  }),
  z.object({
    action: z.literal("save_campaign"),
    publicationId: uuid,
    id: uuid.optional(),
    listId: uuid.nullable().optional(),
    name: z.string().trim().min(1).max(120),
    subject: z.string().trim().min(1).max(180),
    previewText: z.string().trim().max(240).default(""),
    body: z.string().trim().min(1).max(50_000),
  }),
  z.object({ action: z.literal("delete_campaign"), id: uuid, publicationId: uuid.optional() }),
  z.object({ action: z.literal("send_campaign"), id: uuid, publicationId: uuid.optional() }),
]);

export async function mutateAudience(context: CreatorMcpContext, input: unknown) {
  const data = audienceMutationSchema.parse(input);
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "mcp-audience", context.userId);
  const client = supabaseAdmin as any;
  if (data.publicationId)
    await requireOwnedNewsletterPublication(client, context.userId, data.publicationId);
  if (
    data.action === "create_list" ||
    data.action === "delete_list" ||
    data.action === "set_list_member"
  ) {
    await requirePlanEntitlement(
      context.userId,
      "emailListBuilder",
      entitlementUpgradeMessage("emailListBuilder"),
    );
  } else {
    await requirePlanEntitlement(
      context.userId,
      "emailMarketing",
      entitlementUpgradeMessage("emailMarketing"),
    );
  }
  if (data.action === "create_list") {
    const { data: list, error } = await client
      .from("audience_lists")
      .insert({
        creator_id: context.userId,
        publication_id: data.publicationId,
        name: data.name,
        description: data.description,
      })
      .select("*")
      .single();
    if (error?.code === "23505") throw new Error("That audience-list name already exists.");
    if (error || !list) throw new Error("Audience list could not be created.");
    return list;
  }
  if (data.action === "delete_list") {
    let query = client
      .from("audience_lists")
      .delete()
      .eq("id", data.id)
      .eq("creator_id", context.userId);
    if (data.publicationId) query = query.eq("publication_id", data.publicationId);
    const { data: deleted, error } = await query.select("id,publication_id").maybeSingle();
    if (error || !deleted) throw new Error("Audience list not found.");
    return { id: data.id, publicationId: deleted.publication_id ?? null, deleted: true };
  }
  if (data.action === "set_list_member") {
    let listQuery = client
      .from("audience_lists")
      .select("id,publication_id")
      .eq("id", data.listId)
      .eq("creator_id", context.userId);
    if (data.publicationId) listQuery = listQuery.eq("publication_id", data.publicationId);
    const [list, contact] = await Promise.all([
      listQuery.maybeSingle(),
      client
        .from("audience_contacts")
        .select("id")
        .eq("id", data.contactId)
        .eq("creator_id", context.userId)
        .maybeSingle(),
    ]);
    if (!list.data || !contact.data) throw new Error("List or audience member not found.");
    const query = data.included
      ? client
          .from("audience_list_members")
          .upsert({ list_id: data.listId, contact_id: data.contactId })
      : client
          .from("audience_list_members")
          .delete()
          .eq("list_id", data.listId)
          .eq("contact_id", data.contactId);
    const { error } = await query;
    if (error) throw new Error("Audience membership could not be updated.");
    return { ok: true };
  }
  if (data.action === "delete_campaign") {
    let query = client
      .from("audience_campaigns")
      .delete()
      .eq("id", data.id)
      .eq("creator_id", context.userId)
      .eq("status", "draft")
      .eq("kind", "broadcast");
    if (data.publicationId) query = query.eq("publication_id", data.publicationId);
    const { data: removed, error } = await query.select("id,publication_id").maybeSingle();
    if (error || !removed) throw new Error("Only draft campaigns can be deleted.");
    return { id: data.id, publicationId: removed.publication_id ?? null, deleted: true };
  }
  if (data.action === "save_campaign") {
    if (data.listId) {
      const { data: list } = await client
        .from("audience_lists")
        .select("id,publication_id")
        .eq("id", data.listId)
        .eq("creator_id", context.userId)
        .maybeSingle();
      if (!list || (list.publication_id && list.publication_id !== data.publicationId))
        throw new Error("Audience list not found.");
    }
    const row = {
      creator_id: context.userId,
      publication_id: data.publicationId,
      list_id: data.listId || null,
      name: data.name,
      subject: data.subject,
      preview_text: data.previewText,
      body_markdown: data.body,
      kind: "broadcast",
    };
    let query = data.id
      ? client
          .from("audience_campaigns")
          .update(row)
          .eq("id", data.id)
          .eq("creator_id", context.userId)
          .eq("status", "draft")
          .eq("kind", "broadcast")
      : client.from("audience_campaigns").insert(row);
    if (data.id) query = query.eq("publication_id", data.publicationId);
    const { data: campaign, error } = await query.select("*").maybeSingle();
    if (error || !campaign) throw new Error("Draft campaign could not be saved.");
    return campaign;
  }

  if (data.action === "send_campaign") {
    const result = await scheduleAudienceCampaignForCreator({
      creatorId: context.userId,
      campaignId: data.id,
      publicationId: data.publicationId,
      kind: "broadcast",
      scheduledAt: null,
    });
    return {
      campaignId: data.id,
      publicationId: data.publicationId ?? null,
      queued: result.queued,
      skipped: 0,
    };
  }
}

export async function getCommunityWorkspace(context: CreatorMcpContext, productId?: string) {
  const client = supabaseAdmin as any;
  const { data: products, error: productsError } = await client
    .from("commerce_products")
    .select("*")
    .eq("creator_id", context.userId)
    .in("kind", ["paid_community", "membership"])
    .neq("status", "archived")
    .order("created_at", { ascending: false });
  if (productsError) throw new Error("Communities could not be loaded.");
  const selected =
    products?.find((product: any) => product.id === productId) || products?.[0] || null;
  if (!selected)
    return { products: products || [], selected: null, members: [], posts: [], comments: [] };
  const [members, posts, comments] = await Promise.all([
    client
      .from("commerce_access_grants")
      .select("*")
      .eq("creator_id", context.userId)
      .eq("product_id", selected.id)
      .order("created_at", { ascending: false }),
    client
      .from("commerce_community_posts")
      .select("*")
      .eq("creator_id", context.userId)
      .eq("product_id", selected.id)
      .order("created_at", { ascending: false })
      .limit(200),
    client
      .from("commerce_community_comments")
      .select("*")
      .eq("creator_id", context.userId)
      .eq("product_id", selected.id)
      .order("created_at", { ascending: true })
      .limit(500),
  ]);
  if (members.error || posts.error || comments.error) {
    throw new Error("Community workspace could not be loaded.");
  }
  return {
    products: products || [],
    selected,
    members: members.data || [],
    posts: posts.data || [],
    comments: comments.data || [],
  };
}

const communityMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("invite_member"),
    productId: uuid,
    email: z.string().trim().email().max(254),
    name: z.string().trim().max(120).optional(),
    role: z.enum(["member", "moderator"]).default("member"),
    notificationsEnabled: z.boolean().default(true),
  }),
  z.object({
    action: z.literal("set_member_status"),
    grantId: uuid,
    status: z.enum(["active", "revoked"]),
  }),
  z.object({
    action: z.literal("update_member"),
    grantId: uuid,
    role: z.enum(["member", "moderator"]),
    notificationsEnabled: z.boolean(),
  }),
  z.object({
    action: z.literal("create_post"),
    productId: uuid,
    body: z.string().trim().min(1).max(10_000),
    pinned: z.boolean().default(false),
    resources: z
      .array(z.object({ label: z.string().trim().max(80), url: z.string().trim().max(2_000) }))
      .max(5)
      .default([]),
  }),
  z.object({ action: z.literal("pin_post"), productId: uuid, postId: uuid, pinned: z.boolean() }),
  z.object({ action: z.literal("delete_post"), productId: uuid, postId: uuid }),
  z.object({
    action: z.literal("create_comment"),
    productId: uuid,
    postId: uuid,
    body: z.string().trim().min(1).max(3_000),
  }),
  z.object({
    action: z.literal("moderate"),
    productId: uuid,
    contentId: uuid,
    kind: z.enum(["post", "comment"]),
    status: z.enum(["published", "hidden", "removed"]),
    reason: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal("update_settings"),
    productId: uuid,
    welcomeMessage: z.string().trim().min(1).max(2_000),
    rules: z.string().trim().max(5_000),
    allowMemberPosts: z.boolean(),
  }),
  z.object({ action: z.literal("delete_community"), productId: uuid }),
]);

export async function mutateCommunity(context: CreatorMcpContext, input: unknown) {
  const data = communityMutationSchema.parse(input);
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "mcp-community", context.userId);
  await requirePlanEntitlement(
    context.userId,
    "communities",
    "Community management is included with the Store plan.",
  );
  const client = supabaseAdmin as any;
  if (data.action === "delete_community") {
    return mutateProduct(context, { action: "delete", productId: data.productId });
  }
  if (data.action === "invite_member") {
    const product = await creatorCommunityProduct(context.userId, data.productId);
    const identity = await creatorCommunityIdentity(context.userId);
    const email = data.email.toLowerCase();
    const token = randomCommunityAccessToken();
    const values = {
      creator_id: context.userId,
      product_id: product.id,
      order_id: null,
      buyer_email: email,
      member_name: data.name || null,
      source: "manual",
      status: "active",
      token_hash: await communityTokenHash(token),
      expires_at: null,
      community_role: data.role,
      community_notifications_enabled: data.notificationsEnabled,
    };
    const existing = await client
      .from("commerce_access_grants")
      .select("id")
      .eq("creator_id", context.userId)
      .eq("product_id", product.id)
      .is("order_id", null)
      .eq("buyer_email", email)
      .maybeSingle();
    const saved = existing.data
      ? await client
          .from("commerce_access_grants")
          .update(values)
          .eq("id", existing.data.id)
          .eq("creator_id", context.userId)
          .select("id")
          .single()
      : await client.from("commerce_access_grants").insert(values).select("id").single();
    if (saved.error || !saved.data) throw new Error("Community member could not be invited.");
    const emailResult = await queueCommunityInvite({
      grantId: saved.data.id,
      token,
      email,
      memberName: data.name,
      productTitle: product.title,
      creatorName: identity.name,
    });
    return { grantId: saved.data.id, emailQueued: emailResult.queued };
  }
  if (data.action === "set_member_status") {
    const { data: grant } = await client
      .from("commerce_access_grants")
      .select("id,product_id,buyer_email,member_name")
      .eq("id", data.grantId)
      .eq("creator_id", context.userId)
      .maybeSingle();
    if (!grant) throw new Error("Community member not found.");
    if (data.status === "revoked") {
      await client
        .from("commerce_access_grants")
        .update({ status: "revoked" })
        .eq("id", grant.id)
        .eq("creator_id", context.userId);
      return { status: "revoked", emailQueued: false };
    }
    const product = await creatorCommunityProduct(context.userId, grant.product_id);
    const identity = await creatorCommunityIdentity(context.userId);
    const token = randomCommunityAccessToken();
    await client
      .from("commerce_access_grants")
      .update({
        status: "active",
        token_hash: await communityTokenHash(token),
        expires_at: null,
        last_accessed_at: null,
      })
      .eq("id", grant.id)
      .eq("creator_id", context.userId);
    const emailResult = await queueCommunityInvite({
      grantId: grant.id,
      token,
      email: grant.buyer_email,
      memberName: grant.member_name,
      productTitle: product.title,
      creatorName: identity.name,
    });
    return { status: "active", emailQueued: emailResult.queued };
  }
  if (data.action === "update_member") {
    const { data: grant, error } = await client
      .from("commerce_access_grants")
      .update({
        community_role: data.role,
        community_notifications_enabled: data.notificationsEnabled,
      })
      .eq("id", data.grantId)
      .eq("creator_id", context.userId)
      .select("id,community_role,community_notifications_enabled")
      .maybeSingle();
    if (error || !grant) throw new Error("Community member not found.");
    return grant;
  }

  const product = await creatorCommunityProduct(context.userId, data.productId);
  if (data.action === "create_post") {
    const identity = await creatorCommunityIdentity(context.userId);
    const resources = normalizeCommunityResources(data.resources);
    if (
      resources.length !==
      data.resources.filter((resource) => resource.label && resource.url).length
    ) {
      throw new Error("Every resource needs a label and a public HTTPS URL.");
    }
    const { data: post, error } = await client
      .from("commerce_community_posts")
      .insert({
        product_id: product.id,
        creator_id: context.userId,
        access_grant_id: null,
        author_kind: "creator",
        author_name: identity.name,
        body: data.body,
        is_pinned: data.pinned,
        resources,
      })
      .select("*")
      .single();
    if (error || !post) throw new Error("Community post could not be published.");
    const notifications = await notifyCommunityMembers({
      product,
      creatorName: identity.name,
      postId: post.id,
      body: data.body,
    });
    return { ...post, notifications };
  }
  if (data.action === "pin_post") {
    const { data: post, error } = await client
      .from("commerce_community_posts")
      .update({ is_pinned: data.pinned })
      .eq("id", data.postId)
      .eq("product_id", product.id)
      .eq("creator_id", context.userId)
      .select("id,is_pinned")
      .maybeSingle();
    if (error || !post) throw new Error("Community post not found.");
    return post;
  }
  if (data.action === "delete_post") {
    const { data: post, error } = await client
      .from("commerce_community_posts")
      .delete()
      .eq("id", data.postId)
      .eq("product_id", product.id)
      .eq("creator_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error || !post) throw new Error("Community post not found.");
    return { id: post.id, deleted: true };
  }
  if (data.action === "create_comment") {
    const identity = await creatorCommunityIdentity(context.userId);
    const { data: post } = await client
      .from("commerce_community_posts")
      .select("id,access_grant_id")
      .eq("id", data.postId)
      .eq("product_id", product.id)
      .eq("creator_id", context.userId)
      .neq("moderation_status", "removed")
      .maybeSingle();
    if (!post) throw new Error("Community post not found.");
    const { data: comment, error } = await client
      .from("commerce_community_comments")
      .insert({
        post_id: post.id,
        product_id: product.id,
        creator_id: context.userId,
        access_grant_id: null,
        author_kind: "creator",
        author_name: identity.name,
        body: data.body,
      })
      .select("*")
      .single();
    if (error || !comment) throw new Error("Community comment could not be published.");
    return comment;
  }
  if (data.action === "moderate") {
    const table = data.kind === "post" ? "commerce_community_posts" : "commerce_community_comments";
    const { data: content, error } = await client
      .from(table)
      .update({
        moderation_status: data.status,
        moderation_reason: data.status === "published" ? null : data.reason || null,
        moderated_at: data.status === "published" ? null : new Date().toISOString(),
        moderated_by: data.status === "published" ? null : context.userId,
      })
      .eq("id", data.contentId)
      .eq("product_id", product.id)
      .eq("creator_id", context.userId)
      .select("id,moderation_status")
      .maybeSingle();
    if (error || !content) throw new Error(`Community ${data.kind} not found.`);
    return content;
  }
  const settings =
    product.settings && typeof product.settings === "object" && !Array.isArray(product.settings)
      ? product.settings
      : {};
  const { data: updated, error } = await client
    .from("commerce_products")
    .update({
      settings: {
        ...settings,
        welcomeMessage: data.welcomeMessage,
        rules: data.rules,
        allowMemberPosts: data.allowMemberPosts,
      },
    })
    .eq("id", product.id)
    .eq("creator_id", context.userId)
    .select("*")
    .single();
  if (error || !updated) throw new Error("Community settings could not be updated.");
  return updated;
}

export async function getProfileWorkspace(context: CreatorMcpContext) {
  const [profile, usage, paymentAccounts] = await Promise.all([
    context.supabase
      .from("profiles")
      .select(editableProfileColumns)
      .eq("id", context.userId)
      .single(),
    Promise.all([
      context.supabase
        .from("pages")
        .select("id", { count: "exact", head: true })
        .eq("user_id", context.userId),
      context.supabase
        .from("blocks")
        .select("id", { count: "exact", head: true })
        .eq("user_id", context.userId),
    ]),
    (supabaseAdmin as any)
      .from("creator_payment_accounts")
      .select(
        "id,provider,credential_mode,onboarding_status,charges_enabled,payouts_enabled,created_at",
      )
      .eq("creator_id", context.userId),
  ]);
  if (profile.error || paymentAccounts.error || usage.some((result) => result.error)) {
    throw new Error("Profile workspace could not be loaded.");
  }
  const plan = await getPlan(context.userId);
  return {
    profile: profile.data,
    plan,
    limits: planLimits(plan),
    usage: { pages: (usage[0].count || 0) + 1, blocks: usage[1].count || 0 },
    paymentAccounts: paymentAccounts.data || [],
  };
}

export async function updateCreatorProfile(context: CreatorMcpContext, input: unknown) {
  const data = profileUpdateSchema.parse(input);
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "mcp-profile", context.userId);
  const settingFont = Boolean(data.primary_font) || Boolean(data.secondary_font);
  const settingPremiumPattern = typeof data.pattern === "string" && isPremiumPattern(data.pattern);
  if (settingFont || settingPremiumPattern) {
    const plan = await getPlan(context.userId);
    const entitlement = settingFont ? "customFonts" : "allThemes";
    if (!planHasEntitlement(plan, entitlement)) {
      throw new Error(entitlementUpgradeMessage(entitlement));
    }
  }
  return updateProfileWithRls(context.userId, data, (userId, updates) =>
    context.supabase
      .from("profiles")
      .update(updates)
      .eq("id", userId)
      .select(editableProfileColumns)
      .single(),
  );
}

export async function getAnalyticsWorkspace(
  context: CreatorMcpContext,
  input: { range: "today" | "3d" | "7d" | "30d" | "90d" | "all" },
) {
  const { data: profile, error: profileError } = await context.supabase
    .from("profiles")
    .select("account_timezone,analytics_timezone")
    .eq("id", context.userId)
    .single();
  if (profileError) throw new Error("Analytics timezone could not be loaded.");
  const timeZone = profile.account_timezone || profile.analytics_timezone || "UTC";
  let start = rangeStart(input.range, timeZone);
  const plan = await getPlan(context.userId);
  const days = analyticsDays(plan);
  if (days !== null) {
    const floor = historyStart(days, timeZone);
    if (!start || start < floor) start = floor;
  }
  const admin = supabaseAdmin as any;
  const [analytics, social, content] = await Promise.all([
    (context.supabase as any).rpc("get_creator_analytics", {
      p_start_date: start,
      p_timezone: timeZone,
    }),
    admin
      .from("social_analytics_snapshots")
      .select("*")
      .eq("user_id", context.userId)
      .order("captured_at", { ascending: false })
      .limit(100),
    admin
      .from("social_content_insights")
      .select("*")
      .eq("user_id", context.userId)
      .order("published_at", { ascending: false })
      .limit(100),
  ]);
  if (analytics.error || social.error || content.error) {
    throw new Error("Analytics workspace could not be loaded.");
  }
  return {
    range: input.range,
    timeZone,
    site: analytics.data || {},
    socialSnapshots: social.data || [],
    socialContent: content.data || [],
  };
}

export async function getIntegrationWorkspace(context: CreatorMcpContext) {
  const client = supabaseAdmin as any;
  const [social, calendar, fathom, payment] = await Promise.all([
    client
      .from("social_connections")
      .select(
        "id,provider,provider_handle,provider_display_name,status,scopes,connection_health,last_error",
      )
      .eq("user_id", context.userId)
      .order("created_at"),
    client
      .from("booking_calendar_connections")
      .select("id,provider,email,display_name,status,is_default,last_error")
      .eq("user_id", context.userId)
      .order("created_at"),
    client
      .from("booking_fathom_connections")
      .select("id,email,display_name,status,is_default,last_error")
      .eq("user_id", context.userId)
      .order("created_at"),
    client
      .from("creator_payment_accounts")
      .select(
        "id,provider,credential_mode,onboarding_status,charges_enabled,payouts_enabled,created_at",
      )
      .eq("creator_id", context.userId)
      .order("created_at"),
  ]);
  if (social.error || calendar.error || fathom.error || payment.error) {
    throw new Error("Integration workspace could not be loaded.");
  }
  return {
    social: social.data || [],
    calendars: calendar.data || [],
    fathom: fathom.data || [],
    paymentAccounts: payment.data || [],
  };
}

export async function getEarnWorkspace(context: CreatorMcpContext) {
  const account = await ensureReferralAccount(context.userId);
  const client = supabaseAdmin as any;
  const [clicks, referrals, commissions, payouts, reach, settings] = await Promise.all([
    client
      .from("referral_clicks")
      .select("id", { count: "exact", head: true })
      .eq("account_id", account.id),
    client
      .from("referral_attributions")
      .select("*")
      .eq("account_id", account.id)
      .order("created_at", { ascending: false })
      .limit(500),
    client
      .from("referral_commissions")
      .select("*,attribution:referral_attributions!inner(account_id)")
      .eq("attribution.account_id", account.id)
      .order("created_at", { ascending: false })
      .limit(1000),
    client
      .from("referral_payouts")
      .select("*")
      .eq("account_id", account.id)
      .order("created_at", { ascending: false })
      .limit(50),
    client
      .from("referral_reach_submissions")
      .select("*")
      .eq("account_id", account.id)
      .order("created_at", { ascending: false })
      .limit(50),
    client
      .from("referral_program_settings")
      .select("commission_rate_bps,payout_minimums,reach_rates,reach_cap")
      .eq("id", true)
      .single(),
  ]);
  if ([clicks, referrals, commissions, payouts, reach, settings].some((result) => result.error)) {
    throw new Error("Earn workspace could not be loaded.");
  }
  return {
    account,
    referralUrl: `${configuredPublicOrigin(process.env.VITE_PUBLIC_URL)}/r/${account.code}`,
    clicks: clicks.count || 0,
    referrals: referrals.data || [],
    commissions: commissions.data || [],
    payouts: payouts.data || [],
    reach: reach.data || [],
    settings: settings.data,
  };
}

const earnMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update_code"),
    code: z
      .string()
      .trim()
      .max(32)
      .refine(isReferralCode, "Use 3–32 lowercase letters, numbers, or hyphens."),
  }),
  z.object({
    action: z.literal("request_payout"),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/),
  }),
]);

export async function mutateEarn(context: CreatorMcpContext, input: unknown) {
  const data = earnMutationSchema.parse(input);
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "mcp-earn", context.userId);
  const client = supabaseAdmin as any;
  if (data.action === "update_code") {
    await ensureReferralAccount(context.userId);
    const { data: account, error } = await client
      .from("referral_accounts")
      .update({ code: data.code })
      .eq("user_id", context.userId)
      .eq("status", "active")
      .select("code")
      .maybeSingle();
    if (error?.code === "23505") throw new Error("That referral code is already taken.");
    if (error || !account) throw new Error("Referral code could not be updated.");
    return {
      code: account.code,
      referralUrl: `${configuredPublicOrigin(process.env.VITE_PUBLIC_URL)}/r/${account.code}`,
    };
  }
  const { data: payoutId, error } = await client.rpc("request_referral_payout", {
    p_user_id: context.userId,
    p_currency: data.currency,
  });
  if (error?.message?.includes("Minimum payout")) {
    throw new Error("The available balance has not reached the payout minimum.");
  }
  if (error) throw new Error("Payout request could not be created.");
  return { payoutId };
}
