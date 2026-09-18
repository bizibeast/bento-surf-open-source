import { createServerOnlyFn } from "@tanstack/react-start";
import { getRequestHost } from "@tanstack/react-start/server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { hostnameFromRequestHost } from "./custom-domain";
import { publicProfilePath } from "./application-urls";
import { COMMERCE_KINDS } from "./commerce";
import { commerceEntitlement, normalizePlan, planHasEntitlement } from "./plans";
import { safeNavigationHref } from "./safe-url";
import type { PageSystem } from "./pages.functions";

const publicCreatorColumns =
  "id, username, display_name, bio, avatar_url, cover_url, theme, accent_color, primary_font, secondary_font, header_mode, pattern, pattern_settings, is_pro, onboarded, noindex, plan_id, badge_hidden, calendar_page_enabled, calendar_page_name, social_insights_enabled, store_page_enabled, meta_title, meta_description, updated_at";

export const loadPublicCreatorChrome = createServerOnlyFn(
  async (
    userId: string,
    _requestedUsername?: string,
    activeSystem?: PageSystem,
    requestHost?: string,
  ) => {
    const hostname = hostnameFromRequestHost(requestHost ?? getRequestHost());
    const [profileResult, pagesResult, domainResult] = await Promise.all([
      supabaseAdmin.from("profiles").select(publicCreatorColumns).eq("id", userId).maybeSingle(),
      supabaseAdmin
        .from("pages")
        .select("id, name, slug, position, url, system, updated_at")
        .eq("user_id", userId)
        .eq("is_visible", true)
        .order("position", { ascending: true }),
      hostname
        ? supabaseAdmin
            .from("custom_domains")
            .select("hostname")
            .eq("user_id", userId)
            .eq("hostname", hostname)
            .eq("status", "active")
            .eq("ssl_status", "active")
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (profileResult.error || pagesResult.error || domainResult.error) {
      throw new Error("Unable to load public creator");
    }
    if (!profileResult.data) return null;
    const creator = profileResult.data;
    const plan = normalizePlan(creator.plan_id, Boolean(creator.is_pro));
    const available: Record<PageSystem, boolean> = {
      calendar:
        Boolean(creator.calendar_page_enabled) && planHasEntitlement(plan, "calendarBookings"),
      store: Boolean(creator.store_page_enabled) && planHasEntitlement(plan, "storeCards"),
      insights:
        Boolean(creator.social_insights_enabled) && planHasEntitlement(plan, "socialAnalytics"),
      newsletter: planHasEntitlement(plan, "emailMarketing"),
    };
    const customDomain = planHasEntitlement(plan, "customDomain")
      ? (domainResult.data?.hostname ?? null)
      : null;
    const pages = (pagesResult.data ?? []).flatMap((page) => {
      if (page.system && !available[page.system as PageSystem]) return [];
      const url = page.url ? safeNavigationHref(page.url) : null;
      if (page.url && !url) return [];
      const slug = page.system === "newsletter" ? "newsletters" : page.system || page.slug;
      return [
        {
          ...page,
          slug,
          url,
          href:
            url ??
            (customDomain
              ? `/${encodeURIComponent(slug)}`
              : publicProfilePath(creator.username, slug)),
        },
      ];
    });
    if (
      !creator.store_page_enabled &&
      planHasEntitlement(plan, "storeCards") &&
      !pages.some((page) => page.system === "store")
    ) {
      const supportedKinds = COMMERCE_KINDS.filter((kind) =>
        planHasEntitlement(plan, commerceEntitlement(kind.kind)),
      ).map((kind) => kind.kind);
      const dedicatedPage = await supabaseAdmin
        .from("pages")
        .select("id")
        .eq("user_id", userId)
        .eq("system", "store")
        .maybeSingle();
      if (dedicatedPage.error) throw new Error("Unable to load public store");
      const offers = await supabaseAdmin
        .from("commerce_products")
        .select("id")
        .eq("creator_id", userId)
        .eq("status", "published")
        .in("kind", supportedKinds)
        .limit(1);
      if (offers.error) throw new Error("Unable to load public store");
      if (!dedicatedPage.data && offers.data?.length) {
        const href = customDomain ? "/store" : publicProfilePath(creator.username, "store");
        pages.push({
          id: "store-catalog",
          name: "Store",
          slug: "store",
          position: pages.length,
          system: "store",
          url: href,
          href,
          updated_at: creator.updated_at,
        });
      }
    }
    if (activeSystem && !pages.some((page) => page.system === activeSystem)) return null;
    return { creator, pages, customDomain };
  },
);

export type PublicCreatorChrome = NonNullable<Awaited<ReturnType<typeof loadPublicCreatorChrome>>>;
