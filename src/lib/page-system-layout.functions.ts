/* eslint-disable @typescript-eslint/no-explicit-any -- Booking and commerce tables are not fully generated in Database. */
import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import {
  commerceProductKindPricingError,
  pricingLabel,
  sanitizeCommerceSettingsForPublic,
} from "./commerce";
import { getPlan } from "./plan.server";
import { commerceEntitlement, planHasEntitlement } from "./plans";
import { invalidateCreatorPageCaches, pageSystemSchema } from "./pages.functions";
import { loadPublicSocialAnalytics, summarizeSocialAnalytics } from "./social-analytics.functions";
import {
  mergeSystemItemLayout,
  MAX_SYSTEM_PAGE_ITEMS,
  SYSTEM_PAGE_CAPACITY_ERROR,
  systemItemLayoutSchema,
  type SystemPageItem,
} from "./page-system-layout";

const pageInput = z.object({ pageId: z.string().uuid() });
type SystemPage = { id: string; name: string; system: SystemPageItem["system"] };

async function ownedSystemPage(
  supabase: SupabaseClient<Database>,
  userId: string,
  pageId: string,
): Promise<SystemPage> {
  const { data: page, error } = await supabase
    .from("pages")
    .select("id,name,system,url")
    .eq("id", pageId)
    .eq("user_id", userId)
    .eq("is_visible", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!page || page.url || !pageSystemSchema.safeParse(page.system).success)
    throw new Error("System page not found.");
  return { id: page.id, name: page.name, system: pageSystemSchema.parse(page.system) };
}

/** Shared by the owner canvas and public surfaces after resolving their visible page. */
export async function loadSystemPageItems(
  supabase: SupabaseClient<Database>,
  userId: string,
  page: SystemPage,
  socialInsights?: Awaited<ReturnType<typeof loadPublicSocialAnalytics>>,
): Promise<SystemPageItem[]> {
  const db = supabase as any;
  const { data: profile, error } = await db
    .from("profiles")
    .select("calendar_page_enabled,store_page_enabled,social_insights_enabled")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!profile) throw new Error("Profile not found.");
  const tile = (
    key: string,
    kind: SystemPageItem["kind"],
    title: string,
    data: SystemPageItem["data"],
    defaultW = 4,
  ): SystemPageItem => ({
    key,
    pageId: page.id,
    system: page.system,
    kind,
    title,
    data,
    defaultW,
    defaultH: 2,
  });
  const items: SystemPageItem[] = [];

  if (page.system === "calendar" && profile.calendar_page_enabled) {
    const [sessions, reviews] = await Promise.all([
      db
        .from("commerce_products")
        .select(
          "id,public_slug,title,subtitle,cover_url,pricing_type,price_amount,currency,billing_interval,cta_label,inventory_limit,sales_count,settings",
        )
        .eq("creator_id", userId)
        .eq("kind", "coaching_call")
        .eq("status", "published")
        .order("published_at", { ascending: false }),
      db
        .from("booking_reviews")
        .select("id,reviewer_name,rating,body,submitted_at")
        .eq("creator_id", userId)
        .eq("is_public", true)
        .not("submitted_at", "is", null)
        .order("submitted_at", { ascending: false })
        .limit(6),
    ]);
    if (sessions.error || reviews.error)
      throw new Error(sessions.error?.message || reviews.error.message);
    items.push(
      ...(sessions.data ?? []).map((product: any) =>
        tile(`session:${product.id}`, "session", product.title, {
          id: product.id,
          slug: product.public_slug,
          title: product.title,
          subtitle: product.subtitle,
          coverUrl: product.cover_url,
          ctaLabel: product.cta_label,
          durationMinutes: Number(
            sanitizeCommerceSettingsForPublic("coaching_call", product.settings).durationMinutes ||
              60,
          ),
          priceLabel: pricingLabel(
            product.pricing_type,
            product.price_amount,
            product.currency,
            product.billing_interval,
          ),
          soldOut: Boolean(
            product.inventory_limit && product.sales_count >= product.inventory_limit,
          ),
        }),
      ),
    );
    items.push(
      ...(reviews.data ?? []).map((review: any) =>
        tile(`review:${review.id}`, "review", review.reviewer_name, {
          id: review.id,
          reviewerName: review.reviewer_name,
          rating: review.rating,
          body: review.body,
        }),
      ),
    );
  }
  if (page.system === "store" && profile.store_page_enabled) {
    const plan = await getPlan(userId);
    if (planHasEntitlement(plan, "storeCards")) {
      const { data: products, error } = await db
        .from("commerce_products")
        .select(
          "id,kind,status,slug,public_slug,title,subtitle,description,cover_url,pricing_type,price_amount,currency,billing_interval,cta_label,inventory_limit,sales_count,noindex,published_at,settings",
        )
        .eq("creator_id", userId)
        .eq("status", "published")
        .order("published_at", { ascending: false });
      if (error) throw new Error(error.message);
      items.push(
        ...(products ?? [])
          .filter(
            (product: any) =>
              planHasEntitlement(plan, commerceEntitlement(product.kind)) &&
              !commerceProductKindPricingError(product.kind, product.pricing_type),
          )
          .map((product: any) =>
            tile(`product:${product.id}`, "product", product.title, {
              ...product,
              settings: sanitizeCommerceSettingsForPublic(product.kind, product.settings),
            }),
          ),
      );
    }
  }
  if (page.system === "newsletter") {
    const query = db
      .from("newsletter_publications")
      .select("id,title,slug,description,logo_url,accent_color,is_default")
      .eq("creator_id", userId)
      .eq("status", "published");
    const { data: publications, error } = await query
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    items.push(
      ...(publications ?? []).map((publication: any) =>
        tile(`publication:${publication.id}`, "publication", publication.title, {
          id: publication.id,
          title: publication.title,
          slug: publication.slug,
          description: publication.description ?? "",
          logoUrl: publication.logo_url ?? null,
          accentColor: publication.accent_color ?? null,
        }),
      ),
    );
  }
  if (
    page.system === "insights" &&
    profile.social_insights_enabled &&
    planHasEntitlement(await getPlan(userId), "socialAnalytics")
  ) {
    const [analytics, connections] = await Promise.all([
      socialInsights ?? loadPublicSocialAnalytics(userId),
      db.from("social_connections").select("id").eq("user_id", userId).eq("status", "active"),
    ]);
    if (connections.error) throw new Error(connections.error.message);
    const activeIds = new Set(
      (connections.data ?? []).map((connection: { id: string }) => connection.id),
    );
    const accounts = analytics.accounts.filter((account) => activeIds.has(account.connectionId));
    const summary = summarizeSocialAnalytics(accounts);
    const metrics = {
      followers: summary.totalFollowers,
      views: summary.totalViews,
      posts: summary.totalPosts,
      engagements: summary.totalEngagements,
    };
    items.push(
      ...Object.entries(metrics).map(([metric, value]) =>
        tile(
          `summary:${metric}`,
          "summary",
          metric === "engagements" ? "Engagement" : metric[0].toUpperCase() + metric.slice(1),
          { metric, value, displayPeriodDays: analytics.displayPeriodDays },
          2,
        ),
      ),
    );
    items.push(
      ...accounts.map((account) => ({
        ...tile(
          `account:${account.connectionId}`,
          "account",
          account.displayName || account.handle,
          { ...account },
        ),
        defaultH: 2,
      })),
    );
  }
  if (items.length > MAX_SYSTEM_PAGE_ITEMS) throw new Error(SYSTEM_PAGE_CAPACITY_ERROR);
  if (new Set(items.map((item) => item.key)).size !== items.length)
    throw new Error("System item keys must be unique.");
  return items;
}

export async function loadSystemPageCanvas(
  supabase: SupabaseClient<Database>,
  userId: string,
  page: SystemPage,
  socialInsights?: Awaited<ReturnType<typeof loadPublicSocialAnalytics>>,
) {
  const [items, saved] = await Promise.all([
    loadSystemPageItems(supabase, userId, page, socialInsights),
    supabase
      .from("page_system_item_layouts")
      .select("item_key,x,y,w,h,position")
      .eq("page_id", page.id)
      .order("position", { ascending: true }),
  ]);
  if (saved.error) throw new Error(saved.error.message);
  const layout = mergeSystemItemLayout(
    items,
    (saved.data ?? []).map(({ item_key, ...geometry }) => ({ itemKey: item_key, ...geometry })),
  );
  return { page, items, layout };
}

export const getMySystemPageCanvas = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => pageInput.parse(input))
  .handler(async ({ context, data }) => {
    const page = await ownedSystemPage(context.supabase, context.userId, data.pageId);
    return loadSystemPageCanvas(supabaseAdmin, context.userId, page);
  });

export const saveMySystemPageLayout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    pageInput
      .extend({
        items: z
          .array(systemItemLayoutSchema)
          .max(MAX_SYSTEM_PAGE_ITEMS, SYSTEM_PAGE_CAPACITY_ERROR)
          .refine(
            (items) => new Set(items.map((item) => item.itemKey)).size === items.length,
            "System item keys must be unique.",
          ),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const page = await ownedSystemPage(context.supabase, context.userId, data.pageId);
    const sourceItems = await loadSystemPageItems(supabaseAdmin, context.userId, page);
    const allowed = new Set(sourceItems.map((item) => item.key));
    if (data.items.some((item) => !allowed.has(item.itemKey)))
      throw new Error("Unknown or unpublished system item.");
    const { error } = await context.supabase.rpc("replace_page_system_item_layout", {
      target_page_id: page.id,
      layout_items: data.items.map(({ itemKey, ...geometry }) => ({
        item_key: itemKey,
        ...geometry,
      })),
    });
    if (error) throw new Error(error.message);
    await invalidateCreatorPageCaches(context.supabase, context.userId);
    return { ok: true as const };
  });
