import { createServerFn } from "@tanstack/react-start";
import { getRequestHost } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { readPublicProfileResult, updateProfileWithRls } from "@/lib/profile-query";
import { checkUsernameAvailability } from "@/lib/username-availability";
import { getPlan } from "@/lib/plan.server";
import {
  entitlementUpgradeMessage,
  isPremiumPattern,
  normalizePlan,
  planHasEntitlement,
} from "@/lib/plans";
import { usernameSchema } from "@/lib/username";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { hostnameFromRequestHost } from "@/lib/custom-domain";
import {
  publicProfileCacheKey,
  readPublicProfileCache,
  writePublicProfileCache,
} from "@/lib/public-profile-cache.server";
import { enforceRequestRateLimit } from "@/lib/request-security.server";
import { safeMediaUrl } from "@/lib/safe-url";
import { isGoogleFont } from "@/lib/google-fonts";
import { PATTERN_BY_ID } from "@/lib/patterns/registry";
import { hydratePublicCommerceBlocks, type CommerceProductBlockSource } from "@/lib/commerce";
import { exploreCategorySchema } from "@/lib/explore";
import { loadPublicSocialAnalytics } from "@/lib/social-analytics.functions";
import type { Database, Json } from "@/integrations/supabase/types";
import { isValidTimeZone } from "@/lib/timezones";
import { resolvePublicUsername } from "@/lib/username-alias.server";

type PublicProfileBlock = Pick<
  Database["public"]["Tables"]["blocks"]["Row"],
  "id" | "type" | "content" | "cover_url" | "x" | "y" | "w" | "h" | "position" | "updated_at"
>;

export function sanitizePublicProfileBlocks(blocks: PublicProfileBlock[]) {
  return blocks.map((block) => {
    if (
      block.type !== "email_capture" ||
      !block.content ||
      typeof block.content !== "object" ||
      Array.isArray(block.content)
    )
      return block;
    const content = { ...block.content } as Record<string, Json | undefined>;
    delete content.newsletterPublicationId;
    return { ...block, content };
  });
}

export const editableProfileColumns =
  "id, username, display_name, bio, avatar_url, cover_url, theme, accent_color, is_pro, plan_id, badge_hidden, calendar_page_enabled, calendar_page_name, social_insights_enabled, store_page_enabled, account_timezone, onboarded, created_at, updated_at, noindex, font, meta_title, meta_description, primary_font, secondary_font, header_mode, pattern, pattern_settings, show_in_explore, explore_category, explore_review_status";
const fontSchema = z.string().max(60).refine(isGoogleFont, "Choose a supported font.").nullable();
const patternSettingsSchema = z
  .object({
    intensity: z.number().finite().min(0).max(100).optional(),
    opacity: z.number().finite().min(0).max(100).optional(),
    blur: z.number().finite().min(0).max(40).optional(),
    overlay: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
    overlay_strength: z.number().finite().min(0).max(100).optional(),
    image_url: z
      .string()
      .max(2_048)
      .refine((value) => Boolean(safeMediaUrl(value)), "Use a public image URL.")
      .optional(),
    parallax: z.boolean().optional(),
  })
  .strict();

export const getMyProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [profileResult, cardsResult] = await Promise.all([
      supabase.from("profiles").select(editableProfileColumns).eq("id", userId).maybeSingle(),
      supabase
        .from("blocks")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .is("page_id", null),
    ]);
    if (profileResult.error) throw new Error(profileResult.error.message);
    if (cardsResult.error) throw new Error(cardsResult.error.message);
    if (!profileResult.data) return profileResult.data;
    return { ...profileResult.data, explore_card_count: cardsResult.count ?? 0 };
  });

export const profileUpdateSchema = z.object({
  username: usernameSchema.optional(),
  display_name: z.string().max(60).optional(),
  bio: z.string().max(280).optional(),
  avatar_url: z
    .string()
    .max(2_048)
    .refine((value) => value === "" || Boolean(safeMediaUrl(value)), "Use a public image URL.")
    .optional(),
  theme: z.enum(["light", "dark", "system"]).optional(),
  accent_color: z
    .string()
    .max(20)
    .regex(/^(?:[a-z0-9_-]{1,20}|#[0-9a-f]{6})$/i)
    .optional(),
  primary_font: fontSchema.optional(),
  secondary_font: fontSchema.optional(),
  onboarded: z.boolean().optional(),
  noindex: z.boolean().optional(),
  show_in_explore: z.boolean().optional(),
  store_page_enabled: z.boolean().optional(),
  explore_category: exploreCategorySchema.optional(),
  header_mode: z.enum(["with_photo", "no_banner"]).optional(),
  pattern: z
    .string()
    .max(40)
    .refine((value) => Boolean(PATTERN_BY_ID[value]), "Choose a supported pattern.")
    .optional(),
  pattern_settings: patternSettingsSchema.optional(),
});

export const updateProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => profileUpdateSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const settingFont = Boolean(data.primary_font) || Boolean(data.secondary_font);
    const settingPremiumPattern =
      typeof data.pattern === "string" && isPremiumPattern(data.pattern);
    const enablingStorePage = data.store_page_enabled === true;
    if (settingFont || settingPremiumPattern || enablingStorePage) {
      const plan = await getPlan(userId);
      const entitlement = settingFont
        ? "customFonts"
        : settingPremiumPattern
          ? "allThemes"
          : "storeCards";
      if (!planHasEntitlement(plan, entitlement)) {
        throw new Error(entitlementUpgradeMessage(entitlement));
      }
    }

    return updateProfileWithRls(userId, data, (authenticatedUserId, updates) =>
      supabase
        .from("profiles")
        .update(updates)
        .eq("id", authenticatedUserId)
        .select(editableProfileColumns)
        .single(),
    );
  });

const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(isValidTimeZone, "Choose a valid timezone.");

export const setAccountTimeZone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        manualTimeZone: timeZoneSchema.nullable(),
        detectedTimeZone: timeZoneSchema,
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: effectiveTimeZone, error } = await context.supabase.rpc(
      "set_creator_account_timezone",
      {
        p_manual_timezone: data.manualTimeZone,
        p_detected_timezone: data.detectedTimeZone,
      },
    );
    if (error) throw new Error(`Unable to save account timezone: ${error.message}`);
    return {
      manualTimeZone: data.manualTimeZone,
      effectiveTimeZone,
    };
  });

export const checkUsername = createServerFn({ method: "POST" })
  .validator((input) => z.object({ username: usernameSchema }).parse(input))
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "username-availability");
    return checkUsernameAvailability(data.username, async (username) => {
      const resolved = await resolvePublicUsername(supabaseAdmin, username);
      return resolved ? { id: resolved.userId } : null;
    });
  });

export const getPublicProfile = createServerFn({ method: "GET" })
  .validator((input) =>
    z
      .object({
        username: z.string().min(1).max(64),
        pageSlug: z.string().min(1).max(64).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "public-profile");
    return loadPublicProfile(
      { username: data.username.toLowerCase() },
      data.pageSlug ?? null,
      null,
    );
  });

const publicProfileColumns =
  "id, username, display_name, bio, avatar_url, cover_url, theme, accent_color, primary_font, secondary_font, header_mode, pattern, pattern_settings, is_pro, onboarded, noindex, plan_id, badge_hidden, calendar_page_enabled, calendar_page_name, social_insights_enabled, store_page_enabled, meta_title, meta_description, updated_at";

async function loadPublicProfile(
  selector: { username: string } | { userId: string },
  pageSlug: string | null,
  customDomain: string | null,
) {
  const resolvedSelector =
    "username" in selector
      ? await resolvePublicUsername(supabaseAdmin, selector.username)
      : { userId: selector.userId };
  if (!resolvedSelector) return null;
  const profileResult = await supabaseAdmin
    .from("profiles")
    .select(publicProfileColumns)
    .eq("id", resolvedSelector.userId)
    .maybeSingle();
  const profile = readPublicProfileResult("profile", profileResult);
  if (!profile) return null;
  const profilePlan = normalizePlan(profile.plan_id, Boolean(profile.is_pro));
  profile.store_page_enabled =
    profile.store_page_enabled && planHasEntitlement(profilePlan, "storeCards");
  // Newsletter tables are introduced by the pending migration.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: publishedNewsletter, error: newsletterError } = await (supabaseAdmin as any)
    .from("newsletter_publications")
    .select("id")
    .eq("creator_id", profile.id)
    .eq("status", "published")
    .limit(1)
    .maybeSingle();
  if (newsletterError) throw new Error("Unable to load public profile");
  const newsletterPageEnabled = Boolean(publishedNewsletter);

  const pagesResult = await supabaseAdmin
    .from("pages")
    .select("id, name, slug, position, url, updated_at")
    .eq("user_id", profile.id)
    .order("position", { ascending: true });
  const pages = readPublicProfileResult("pages", pagesResult) ?? [];

  let activePageId: string | null = null;
  let activePageSlug: string | null = null;
  let activePageName: string | null = null;
  let activeSystemPage: "insights" | null = null;
  if (pageSlug) {
    const match = pages.find((page) => page.slug === pageSlug && !page.url);
    const insightsAvailable =
      pageSlug === "insights" &&
      profile.social_insights_enabled &&
      planHasEntitlement(profilePlan, "socialAnalytics");
    if (!match && !insightsAvailable) {
      return {
        profile,
        pages,
        blocks: [],
        activePageId: null,
        activePageSlug: null,
        activePageName: null,
        socialInsights: null,
        newsletterPageEnabled,
        notFound: true as const,
        customDomain,
      };
    }
    if (match) {
      activePageId = match.id;
      activePageSlug = match.slug;
      activePageName = match.name;
    } else {
      activeSystemPage = "insights";
      activePageSlug = "insights";
      activePageName = "Social media insights";
    }
  }

  let allBlocks: PublicProfileBlock[] = [];
  if (!activeSystemPage) {
    let blocksQuery = supabaseAdmin
      .from("blocks")
      .select("id, type, content, cover_url, x, y, w, h, position, updated_at")
      .eq("user_id", profile.id)
      .order("position", { ascending: true });
    if (activePageId) blocksQuery = blocksQuery.eq("page_id", activePageId);
    else blocksQuery = blocksQuery.is("page_id", null);
    const blocksResult = await blocksQuery;
    allBlocks = readPublicProfileResult("blocks", blocksResult) ?? [];
  }
  const commerceProductIds = [
    ...new Set(
      allBlocks.flatMap((block) => {
        if (block.type !== "commerce" || !block.content || typeof block.content !== "object") {
          return [];
        }
        const productId = (block.content as Record<string, unknown>).productId;
        return typeof productId === "string" ? [productId] : [];
      }),
    ),
  ];
  let commerceProducts: CommerceProductBlockSource[] = [];
  if (commerceProductIds.length > 0) {
    const commerceResult = await supabaseAdmin
      .from("commerce_products")
      .select(
        "id, slug, public_slug, kind, title, subtitle, cover_url, pricing_type, price_amount, currency, billing_interval, cta_label, status",
      )
      .eq("creator_id", profile.id)
      .in("id", commerceProductIds);
    if (commerceResult.error) {
      console.error("Public profile commerce products query failed", commerceResult.error);
      throw new Error("Unable to load public profile");
    }
    commerceProducts = (commerceResult.data ?? []) as CommerceProductBlockSource[];
  }
  const blocks = sanitizePublicProfileBlocks(
    hydratePublicCommerceBlocks(
      allBlocks,
      commerceProducts,
      planHasEntitlement(profilePlan, "storeCards"),
      profile.username,
    ),
  );
  const socialInsights =
    activeSystemPage === "insights" ? await loadPublicSocialAnalytics(profile.id) : null;

  return {
    profile,
    pages,
    blocks,
    activePageId,
    activePageSlug,
    activePageName,
    socialInsights,
    newsletterPageEnabled,
    notFound: false as const,
    customDomain,
  };
}

export function loadPublicProfileByUsername(username: string, pageSlug: string | null) {
  return loadPublicProfile(
    { username: username.toLowerCase() },
    pageSlug?.toLowerCase() ?? null,
    null,
  );
}

/**
 * Host-aware public resolver. On bento.surf, path segments mean
 * /:username/:pageSlug. On a connected hostname they mean /:pageSlug.
 */
export const getPublicProfileForRequest = createServerFn({ method: "GET" })
  .validator((input) =>
    z.object({ segments: z.array(z.string().min(1).max(64)).max(2) }).parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "public-profile-request");
    const requestHostname = hostnameFromRequestHost(getRequestHost());
    const cacheKey = publicProfileCacheKey(requestHostname, data.segments);
    const cached =
      await readPublicProfileCache<Awaited<ReturnType<typeof loadPublicProfile>>>(cacheKey);
    if (cached.hit) return cached.value;

    const result = await (async () => {
      if (requestHostname) {
        const { data: domain, error } = await supabaseAdmin
          .from("custom_domains")
          .select("user_id, hostname, status, ssl_status")
          .eq("hostname", requestHostname)
          .maybeSingle();
        if (error) throw new Error("Unable to resolve custom domain.");
        if (domain) {
          if (data.segments.length > 1) return null;
          if (domain.status !== "active" || domain.ssl_status !== "active") return null;

          const profileResult = await loadPublicProfile(
            { userId: domain.user_id },
            data.segments[0]?.toLowerCase() ?? null,
            domain.hostname,
          );
          // Entitlement is checked at request time as well as at setup time.
          if (profileResult && !profileResult.profile.is_pro) return null;
          return profileResult;
        }
      }

      const username = data.segments[0]?.toLowerCase();
      if (!username) return null;
      return loadPublicProfile({ username }, data.segments[1]?.toLowerCase() ?? null, null);
    })();

    await writePublicProfileCache(cacheKey, result);
    return result;
  });
