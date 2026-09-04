import {
  createFileRoute,
  notFound,
  Link,
  redirect,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { getPublicProfileForRequest } from "@/lib/profile.functions";
import { trackPublicEvent } from "@/lib/analytics";
import { BlockRenderer, type Block, type BlockContent } from "@/components/blocks/BlockRenderer";
import { FontApplier } from "@/components/FontApplier";
import { DecodedImage } from "@/components/DecodedImage";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { PageTabs } from "@/components/PageTabs";
import { PatternBackdrop } from "@/components/patterns/PatternBackdrop";
import {
  ACCENT_PALETTE,
  DEFAULT_SETTINGS,
  type PatternId,
  type PatternSettings,
} from "@/lib/patterns/registry";
import { safeMediaUrl, safeNavigationHref } from "@/lib/safe-url";
import { roundedGridRect } from "@/lib/grid-geometry";
import { publicPageHead } from "@/lib/open-graph";
import { normalizePlan, planHasEntitlement } from "@/lib/plans";
import {
  configuredPublicOrigin,
  normalizePublicUsername,
  publicNewslettersPath,
  publicProfilePath,
} from "@/lib/application-urls";
import {
  socialInsightsDisplayPeriodLabel,
  type SocialAnalyticsAccount,
  type SocialInsightsDisplayPeriodDays,
} from "@/lib/social-analytics.functions";
import { BentoIcon } from "@/components/BentoBrand";
import { openPublicCreatorPageFromWebMcp, useWebMcpTools, webMcpResult } from "@/lib/webmcp";

const profileQuery = (username: string, pageSlug: string | null) =>
  queryOptions({
    queryKey: ["public-profile", username, pageSlug],
    queryFn: () =>
      getPublicProfileForRequest({
        data: { segments: pageSlug ? [username, pageSlug] : [username] },
      }),
  });

export const Route = createFileRoute("/$username")({
  validateSearch: z.object({
    __bento_preview: z.string().optional(),
  }),
  loader: async ({ context, params, location }) => {
    const data = await context.queryClient.ensureQueryData(
      profileQuery(normalizePublicUsername(params.username), null),
    );
    if (!data) throw notFound();
    if (!data.customDomain && data.profile.username !== normalizePublicUsername(params.username)) {
      throw redirect({
        href: `${publicProfilePath(data.profile.username)}${location.searchStr}`,
        statusCode: 307,
      });
    }
    return data;
  },
  head: ({ loaderData }) => {
    if (!loaderData) return { meta: [{ title: "Not found" }] };
    return publicPageHead(loaderData, import.meta.env.VITE_PUBLIC_URL);
  },
  component: PublicProfileHome,
});

function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="text-center">
        <div className="font-display text-6xl">404</div>
        <p className="mt-2 text-muted-foreground">That bento doesn't exist.</p>
        <Link
          to="/"
          className="mt-4 inline-block rounded-lg bg-foreground px-4 py-2 text-sm text-background"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}

function PublicProfileHome() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const { data } = useSuspenseQuery(profileQuery(normalizePublicUsername(params.username), null));
  if (!data) return <NotFound />;
  return (
    <PublicProfileView
      data={data}
      username={data.profile.username}
      activeSlug={data.customDomain ? params.username : null}
      previewMode={Boolean(search.__bento_preview)}
    />
  );
}

export function PublicProfileView({
  data,
  username,
  activeSlug,
  previewMode = false,
}: {
  data: NonNullable<Awaited<ReturnType<typeof getPublicProfileForRequest>>>;
  username: string;
  activeSlug: string | null;
  previewMode?: boolean;
}) {
  const navigate = useNavigate();
  const router = useRouter();
  const { profile, blocks, pages, customDomain } = data;
  const visitorPageHref = useCallback(
    (slug?: string | null) =>
      customDomain
        ? slug
          ? `/${encodeURIComponent(slug)}`
          : "/"
        : publicProfilePath(profile.username, slug),
    [customDomain, profile.username],
  );
  const visiblePages = useMemo(
    () => [
      ...pages.map((page) => (page.url ? page : { ...page, href: visitorPageHref(page.slug) })),
      ...(profile.calendar_page_enabled
        ? [
            {
              id: "__calendar",
              name: profile.calendar_page_name || "Calendar",
              slug: "calendar",
              url: null,
              href: visitorPageHref("calendar"),
              system: "calendar" as const,
            },
          ]
        : []),
      ...(profile.social_insights_enabled &&
      planHasEntitlement(normalizePlan(profile.plan_id, Boolean(profile.is_pro)), "socialAnalytics")
        ? [
            {
              id: "__insights",
              name: "Insights",
              slug: "insights",
              url: null,
              href: visitorPageHref("insights"),
              system: "insights" as const,
            },
          ]
        : []),
      ...(profile.store_page_enabled
        ? [
            {
              id: "__store",
              name: "Store",
              slug: "store",
              url: null,
              href: visitorPageHref("store"),
              system: "store" as const,
            },
          ]
        : []),
      ...(data.newsletterPageEnabled
        ? [
            {
              id: "__newsletter",
              name: "Newsletters",
              slug: "newsletters",
              url: null,
              href: customDomain
                ? visitorPageHref("newsletters")
                : publicNewslettersPath(profile.username),
              system: "newsletter" as const,
            },
          ]
        : []),
    ],
    [
      pages,
      profile.calendar_page_enabled,
      profile.calendar_page_name,
      profile.is_pro,
      profile.plan_id,
      profile.social_insights_enabled,
      profile.store_page_enabled,
      data.newsletterPageEnabled,
      customDomain,
      profile.username,
      visitorPageHref,
    ],
  );
  const webMcpTools = useMemo(
    () => [
      {
        name: "bento_get_creator_page",
        title: "Get public Bento creator page",
        description:
          "Returns the public creator identity, active page, available pages, public blocks, and published social-insight summary visible in this tab.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: () =>
          webMcpResult("Loaded the public creator page.", {
            creator: {
              username: profile.username,
              displayName: profile.display_name,
              bio: profile.bio,
              verified: Boolean(profile.is_pro),
            },
            activePage: activeSlug || "home",
            totalPages: visiblePages.length,
            pages: visiblePages.slice(0, 50).map((page) => ({
              id: page.id,
              name: page.name,
              slug: page.slug,
              href: "href" in page ? page.href : page.url,
            })),
            totalBlocks: blocks.length,
            blocks: blocks.slice(0, 100).map(publicBlockSummary),
            socialInsights: data.socialInsights?.summary || null,
          }),
      },
      {
        name: "bento_open_creator_page",
        title: "Open public Bento page",
        description:
          "Opens one of the creator's visible internal Bento pages in this tab. External links are excluded.",
        inputSchema: {
          type: "object",
          properties: {
            slug: {
              type: "string",
              enum: [
                "home",
                ...visiblePages
                  .filter((page) => !page.url)
                  .map((page) => page.slug)
                  .filter((slug): slug is string => Boolean(slug)),
              ],
              description: "Visible Bento page slug, or home.",
            },
          },
          required: ["slug"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: (input: Record<string, unknown>, { signal }: { signal: AbortSignal }) =>
          openPublicCreatorPageFromWebMcp(input, visiblePages, signal, async (page) => {
            if (customDomain) {
              window.location.assign(page ? `/${page.slug}` : "/");
            } else if (page && "system" in page && page.system === "newsletter") {
              window.location.assign(publicNewslettersPath(profile.username));
            } else if (page) {
              await navigate({
                to: "/$username/$pageSlug",
                params: {
                  username: `@${normalizePublicUsername(username)}`,
                  pageSlug: page.slug,
                },
              });
            } else {
              await navigate({
                to: "/$username",
                params: { username: `@${normalizePublicUsername(username)}` },
              });
            }
          }),
      },
    ],
    [
      activeSlug,
      blocks,
      customDomain,
      data.socialInsights,
      navigate,
      profile,
      username,
      visiblePages,
    ],
  );
  useWebMcpTools(webMcpTools);
  useEffect(() => {
    if (!profile?.id) return;
    if (new URLSearchParams(window.location.search).has("__bento_preview")) return;
    let visitor_hash: string | undefined;
    try {
      const recentViewKey = `bs_recent_view:${profile.id}`;
      const recentView = Number(sessionStorage.getItem(recentViewKey));
      if (Number.isFinite(recentView) && Date.now() - recentView < 30_000) return;
      sessionStorage.setItem(recentViewKey, String(Date.now()));
      visitor_hash = localStorage.getItem("bs_vid") ?? undefined;
      if (!visitor_hash) {
        visitor_hash = crypto.randomUUID();
        localStorage.setItem("bs_vid", visitor_hash);
      }
    } catch {
      // Storage can be blocked by privacy settings; anonymous analytics still works.
    }
    trackPublicEvent({
      kind: "view",
      user_id: profile.id,
      visitor_hash,
      referrer: document.referrer.slice(0, 512),
    }).catch(() => {});
  }, [profile?.id]);

  const activeId = activeSlug
    ? (visiblePages.find((page) => page.slug === activeSlug)?.id ?? null)
    : null;

  const headerMode: "with_photo" | "no_banner" =
    (profile.header_mode as "with_photo" | "no_banner") ?? "with_photo";
  const themeMode: "light" | "dark" = profile.theme === "dark" ? "dark" : "light";
  const patternId: PatternId = (profile.pattern as PatternId) ?? "none";
  const patternSettings: PatternSettings = {
    ...DEFAULT_SETTINGS,
    ...(profile.pattern_settings &&
    typeof profile.pattern_settings === "object" &&
    !Array.isArray(profile.pattern_settings)
      ? (profile.pattern_settings as Partial<PatternSettings>)
      : {}),
  };
  const accentId = profile.accent_color ?? "indigo";
  const accentHex =
    ACCENT_PALETTE.find((a) => a.id === accentId)?.hex ??
    (typeof accentId === "string" && /^#[0-9a-f]{6}$/i.test(accentId) ? accentId : "#6366f1");

  const showHeader = headerMode === "with_photo";

  const accentVars =
    themeMode === "dark"
      ? {
          "--background": `color-mix(in oklab, ${accentHex} 14%, #0b0b14)`,
          "--foreground": `color-mix(in oklab, ${accentHex} 35%, #ffffff)`,
          "--card": `color-mix(in oklab, ${accentHex} 10%, #11111b)`,
          "--muted": `color-mix(in oklab, ${accentHex} 18%, #1a1a22)`,
          "--muted-foreground": `color-mix(in oklab, ${accentHex} 40%, #ffffff)`,
          "--accent": `color-mix(in oklab, ${accentHex} 28%, #1f1f29)`,
          "--accent-foreground": `color-mix(in oklab, ${accentHex} 60%, #ffffff)`,
          "--primary": accentHex,
          "--primary-foreground": `color-mix(in oklab, ${accentHex} 0%, #ffffff)`,
          "--ring": accentHex,
          "--border": `color-mix(in oklab, ${accentHex} 22%, #1f1f29)`,
        }
      : {
          "--background": `color-mix(in oklab, ${accentHex} 8%, #ffffff)`,
          "--foreground": `color-mix(in oklab, ${accentHex} 75%, #000000)`,
          "--card": `color-mix(in oklab, ${accentHex} 4%, #ffffff)`,
          "--muted": `color-mix(in oklab, ${accentHex} 14%, #ffffff)`,
          "--muted-foreground": `color-mix(in oklab, ${accentHex} 55%, #000000)`,
          "--accent": `color-mix(in oklab, ${accentHex} 18%, #ffffff)`,
          "--accent-foreground": `color-mix(in oklab, ${accentHex} 70%, #000000)`,
          "--primary": accentHex,
          "--primary-foreground": `color-mix(in oklab, ${accentHex} 0%, #ffffff)`,
          "--ring": accentHex,
          "--border": `color-mix(in oklab, ${accentHex} 20%, #ffffff)`,
        };

  const initial = (profile.display_name || profile.username || "?")[0]?.toUpperCase();

  return (
    <div
      data-bento-public-page="true"
      data-theme={themeMode}
      style={accentVars as React.CSSProperties}
      className={`relative isolate ${themeMode === "dark" ? "dark" : ""} min-h-screen w-full text-foreground`}
    >
      <div
        className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
        style={{ background: "var(--background)" }}
      >
        <PatternBackdrop
          pattern={patternId}
          settings={patternSettings}
          accentHex="#9ca3af"
          theme={themeMode}
        />
      </div>
      <FontApplier headline={profile.secondary_font} body={profile.primary_font} />
      <div className="mx-auto w-full max-w-6xl px-3 pt-8 lg:px-6 lg:pt-0 lg:pb-0 lg:min-h-[calc(100vh-4rem)]">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[380px_1fr] lg:gap-11 lg:overflow-visible">
          {showHeader && (
            <aside className="flex w-full flex-col items-center text-center text-foreground lg:sticky lg:top-0 lg:self-start lg:items-start lg:text-left lg:overflow-visible lg:min-h-[calc(100vh-4rem)] lg:py-8 lg:pl-1 lg:pr-2">
              {safeMediaUrl(profile.avatar_url) ? (
                <DecodedImage
                  src={safeMediaUrl(profile.avatar_url)!}
                  alt=""
                  width={640}
                  height={640}
                  loading="eager"
                  fetchPriority="high"
                  className="size-32 rounded-full object-cover ring-1 ring-border lg:size-40"
                />
              ) : (
                <div className="flex size-32 items-center justify-center rounded-full bg-foreground font-display text-5xl text-background lg:size-40">
                  {initial}
                </div>
              )}
              <h1
                className="mt-4 font-display text-2xl text-foreground"
                style={{ fontFamily: "var(--font-user-headline, var(--font-display))" }}
              >
                <span className="inline-flex items-center gap-1.5">
                  {profile.display_name || profile.username}
                  <VerifiedBadge className="size-[1.1em]" active={Boolean(profile.is_pro)} />
                </span>
              </h1>
              {profile.username && (
                <span
                  className="text-sm text-muted-foreground"
                  style={{ fontFamily: "var(--font-user-body, inherit)" }}
                >
                  {customDomain ?? `bento.surf/@${profile.username}`}
                </span>
              )}
              {profile.bio && (
                <p
                  className="mt-3 max-w-[16rem] text-sm leading-relaxed text-muted-foreground"
                  style={{ fontFamily: "var(--font-user-body, inherit)" }}
                >
                  {profile.bio}
                </p>
              )}
              {visiblePages.length > 0 && (
                <div className="mt-4 w-full lg:flex lg:justify-start">
                  <PageTabs
                    pages={visiblePages}
                    activeId={activeId}
                    homeHref={visitorPageHref()}
                    mode="public"
                    onIntent={(id) => {
                      if (customDomain || id !== "__calendar") return;
                      void router.preloadRoute({
                        to: "/$username/calendar",
                        params: { username: `@${normalizePublicUsername(username)}` },
                      });
                    }}
                    onSelect={(id) => {
                      if (customDomain) {
                        const page =
                          id === null
                            ? null
                            : visiblePages.find((candidate) => candidate.id === id);
                        window.location.assign(page ? `/${page.slug}` : "/");
                      } else if (id === null)
                        navigate({
                          to: "/$username",
                          params: { username: `@${normalizePublicUsername(username)}` },
                        });
                      else {
                        const pg = visiblePages.find((candidate) => candidate.id === id);
                        if (pg && "system" in pg && pg.system === "newsletter")
                          window.location.assign(pg.href);
                        else if (pg)
                          navigate({
                            to: "/$username/$pageSlug",
                            params: {
                              username: `@${normalizePublicUsername(username)}`,
                              pageSlug: pg.slug,
                            },
                          });
                      }
                    }}
                  />
                </div>
              )}
              {!profile.badge_hidden && (
                <a
                  href={
                    customDomain
                      ? safeNavigationHref(import.meta.env.VITE_PUBLIC_URL) ||
                        configuredPublicOrigin(import.meta.env.VITE_PUBLIC_URL)
                      : "/"
                  }
                  className="mt-6 inline-flex items-center gap-1 self-center rounded-lg border border-border bg-card px-2.5 py-1 text-[10px] text-muted-foreground hover:bg-accent lg:mt-auto lg:self-start"
                >
                  Made with <BentoIcon className="ml-0.5 size-3" />
                  <span className="font-semibold text-foreground">bento.surf</span>
                </a>
              )}
            </aside>
          )}

          <div className="lg:pb-32 lg:pt-8">
            {activeSlug === "insights" && data.socialInsights ? (
              <PublicSocialInsights data={data.socialInsights} />
            ) : (
              <PublicBlockGrid
                liveSocialEnabled={planHasEntitlement(
                  normalizePlan(profile.plan_id, Boolean(profile.is_pro)),
                  "liveSocialPreviews",
                )}
                blocks={blocks.map((block) => ({
                  ...block,
                  content:
                    block.content &&
                    typeof block.content === "object" &&
                    !Array.isArray(block.content)
                      ? (block.content as BlockContent)
                      : {},
                }))}
                previewMode={previewMode}
                onBlockClick={(blockId) => {
                  let visitor_hash: string | undefined;
                  try {
                    visitor_hash = localStorage.getItem("bs_vid") ?? undefined;
                  } catch {
                    // Storage can be blocked by privacy settings; omit the visitor identifier.
                  }
                  trackPublicEvent({
                    kind: "click",
                    user_id: profile.id,
                    block_id: blockId,
                    visitor_hash,
                    referrer: document.referrer.slice(0, 512),
                  }).catch(() => {});
                }}
              />
            )}

            {!showHeader && !profile.badge_hidden && (
              <div className="mt-16 flex justify-center">
                <a
                  href={
                    customDomain
                      ? safeNavigationHref(import.meta.env.VITE_PUBLIC_URL) ||
                        configuredPublicOrigin(import.meta.env.VITE_PUBLIC_URL)
                      : "/"
                  }
                  className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-[10px] text-muted-foreground hover:bg-accent"
                >
                  Made with <BentoIcon className="size-3" />
                  <span className="font-semibold text-foreground">bento.surf</span>
                </a>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function publicBlockSummary(block: { id: string; type: string; content: unknown }) {
  const content =
    block.content && typeof block.content === "object" && !Array.isArray(block.content)
      ? (block.content as Record<string, unknown>)
      : {};
  const firstText = [
    content.title,
    content.text,
    content.label,
    content.name,
    content.description,
  ].find((value) => typeof value === "string" && value.trim());
  return {
    id: block.id,
    type: block.type,
    title: typeof firstText === "string" ? firstText : null,
    url:
      typeof content.url === "string"
        ? safeNavigationHref(content.url, { allowRelative: true }) || null
        : null,
    productId: typeof content.productId === "string" ? content.productId : null,
  };
}

function PublicSocialInsights({
  data,
}: {
  data: {
    accounts: SocialAnalyticsAccount[];
    summary: {
      totalFollowers: number | null;
      totalViews: number | null;
      totalReach: number | null;
      totalEngagements: number | null;
      totalPosts: number | null;
      followerCoverage: number;
    };
    generatedAt: string;
    displayPeriodDays: SocialInsightsDisplayPeriodDays;
  };
}) {
  const compact = (value: number | null) =>
    value === null ? "-" : new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
  const periodLabel = socialInsightsDisplayPeriodLabel(data.displayPeriodDays);
  return (
    <section aria-labelledby="social-insights-title">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {periodLabel}
      </p>
      <h2 id="social-insights-title" className="mt-2 font-display text-3xl">
        Audience across every channel
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Followers are current. Views, reach, engagements, and posts cover content published in the{" "}
        {periodLabel.toLowerCase()}.
      </p>
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {[
          ["Current followers", data.summary.totalFollowers],
          ["Post views", data.summary.totalViews],
          ["Post reach", data.summary.totalReach],
          ["Post engagements", data.summary.totalEngagements],
          ["Posts", data.summary.totalPosts],
        ].map(([label, value]) => (
          <div
            key={String(label)}
            className="min-w-0 rounded-[20px] border border-border/70 bg-card p-4"
          >
            <div className="font-display text-2xl tabular-nums">
              {compact(value as number | null)}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {data.accounts.map((account) => (
          <article
            key={account.connectionId}
            className="min-w-0 rounded-[22px] border border-border/70 bg-card p-4"
          >
            <div className="flex items-center gap-3">
              {safeMediaUrl(account.avatarUrl) ? (
                <DecodedImage
                  src={safeMediaUrl(account.avatarUrl)!}
                  alt=""
                  loading="eager"
                  className="size-11 rounded-full object-cover"
                />
              ) : (
                <div className="flex size-11 items-center justify-center rounded-full bg-accent font-semibold">
                  {account.displayName.slice(0, 1).toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold">{account.displayName}</h3>
                <p className="truncate text-xs text-muted-foreground">
                  {SOCIAL_PROVIDER_LABELS[account.provider]} · @{account.handle}
                </p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-center sm:grid-cols-3">
              {[
                ["Followers", account.followers],
                ["Views", account.views],
                ["Reach", account.reach],
                ["Engagements", account.engagements],
                ["Posts", account.posts],
              ].map(([label, value]) => (
                <div key={String(label)} className="min-w-0 rounded-2xl bg-accent/65 px-1.5 py-2.5">
                  <div className="font-semibold tabular-nums">
                    {compact(value as number | null)}
                  </div>
                  <div className="mt-1 break-words text-[10px] leading-tight text-muted-foreground">
                    {label}
                  </div>
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>
      {!data.accounts.length && (
        <div className="mt-6 rounded-[26px] border border-border/70 bg-card p-8 text-center text-sm text-muted-foreground">
          Social accounts are being connected. Check back soon.
        </div>
      )}
    </section>
  );
}

const SOCIAL_PROVIDER_LABELS: Record<SocialAnalyticsAccount["provider"], string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  threads: "Threads",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  twitter: "X",
  youtube: "YouTube",
  reddit: "Reddit",
};

// --- Grid identical to editor (read-only) ---
const GRID_MARGIN = 12;
const GRID_COLS_DESKTOP = 8;
const GRID_COLS_PHONE = 4;
const PREVIEW_GRID_WIDTH = 680;

type PackItem = { i: string; x: number; y: number; w: number; h: number };

function packLayout(items: Array<{ i: string; w: number; h: number }>, cols: number): PackItem[] {
  const occupied = new Set<string>();
  const key = (x: number, y: number) => `${x},${y}`;
  const isFree = (x: number, y: number, w: number, h: number) => {
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++) if (occupied.has(key(x + dx, y + dy))) return false;
    return true;
  };
  const occupy = (x: number, y: number, w: number, h: number) => {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) occupied.add(key(x + dx, y + dy));
  };
  const placed: PackItem[] = [];
  for (const it of items) {
    const w = Math.min(Math.max(it.w, 1), cols);
    const h = Math.max(it.h, 1);
    let done = false;
    for (let y = 0; !done; y++) {
      for (let x = 0; x <= cols - w; x++) {
        if (isFree(x, y, w, h)) {
          placed.push({ i: it.i, x, y, w, h });
          occupy(x, y, w, h);
          done = true;
          break;
        }
      }
    }
  }
  return placed;
}

function PublicBlockGrid({
  blocks,
  onBlockClick,
  liveSocialEnabled,
  previewMode,
}: {
  blocks: (Block & { x: number; y: number; w: number; h: number; position?: number })[];
  onBlockClick: (id: string) => void;
  liveSocialEnabled: boolean;
  previewMode: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Browser Rendering can capture the server-rendered shell before hydration.
  // The preview route always uses the 1200 px OG viewport, whose desktop grid
  // is exactly 680 px wide. Rendering at that width immediately keeps both the
  // Explore card and social share image complete even when JavaScript is slow.
  const [width, setWidth] = useState(previewMode ? PREVIEW_GRID_WIDTH : 0);
  const [captureReady, setCaptureReady] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    const update = () => {
      if (ref.current) setWidth(ref.current.clientWidth);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!previewMode || width <= 0 || !ref.current) return;
    let cancelled = false;
    const root = ref.current;

    const waitForImage = async (image: HTMLImageElement) => {
      if (!image.complete) {
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          image.addEventListener("load", done, { once: true });
          image.addEventListener("error", done, { once: true });
          window.setTimeout(done, 3_000);
        });
      }
      await image.decode?.().catch(() => undefined);
    };

    const markCaptureReady = async () => {
      await document.fonts?.ready.catch(() => undefined);
      await Promise.all(Array.from(root.querySelectorAll("img")).map(waitForImage));
      // Two frames ensure layout and paint have both observed the hydrated grid.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (cancelled) return;

      const items = Array.from(root.querySelectorAll<HTMLElement>("[data-bento-public-grid-item]"));
      const allItemsVisible =
        items.length === blocks.length &&
        items.every((item) => {
          const rect = item.getBoundingClientRect();
          const style = getComputedStyle(item);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.right > 0 &&
            rect.left < window.innerWidth &&
            rect.bottom > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0"
          );
        });
      setCaptureReady(allItemsVisible);
    };

    void markCaptureReady();
    return () => {
      cancelled = true;
    };
  }, [blocks, previewMode, width]);

  const isPhone = width > 0 && width < 640;
  const cols = isPhone ? GRID_COLS_PHONE : GRID_COLS_DESKTOP;
  const cellW = width > 0 ? Math.max(40, (width - GRID_MARGIN * (cols + 1)) / cols) : 0;
  const hasUnplacedBlocks = blocks.some((block) => !Number.isFinite(block.y) || block.y >= 9_999);

  const layout: PackItem[] =
    isPhone || hasUnplacedBlocks
      ? packLayout(
          [...blocks]
            .sort(
              (a, b) =>
                (a.position ?? 0) - (b.position ?? 0) ||
                a.y - b.y ||
                a.x - b.x ||
                a.id.localeCompare(b.id),
            )
            .map((b) => ({ i: b.id, w: Math.min(b.w, cols), h: b.h })),
          cols,
        )
      : blocks.map((b) => ({
          i: b.id,
          x: Math.min(b.x, Math.max(0, cols - Math.min(b.w, cols))),
          y: b.y,
          w: Math.min(b.w, cols),
          h: b.h,
        }));

  const posById = new Map(layout.map((l) => [l.i, l]));
  const maxRow = layout.reduce((m, l) => Math.max(m, l.y + l.h), 0);
  const totalH = maxRow * cellW + (maxRow + 1) * GRID_MARGIN;

  return (
    <div
      ref={ref}
      data-bento-public-block-grid-ready={
        previewMode ? (captureReady ? "true" : "false") : width > 0 ? "true" : "false"
      }
      data-bento-public-block-count={blocks.length}
      className="relative w-full"
      style={{ height: width > 0 ? totalH : undefined }}
    >
      {width > 0 &&
        blocks.map((b) => {
          const l = posById.get(b.id);
          if (!l) return null;
          const rect = roundedGridRect({
            x: l.x,
            y: l.y,
            w: l.w,
            h: l.h,
            cellSize: cellW,
            gap: GRID_MARGIN,
          });
          return (
            <div
              key={b.id}
              data-bento-public-grid-item={b.id}
              className="absolute overflow-hidden rounded-[28px]"
              style={rect}
              onClickCapture={() => onBlockClick(b.id)}
            >
              <BlockRenderer
                block={{ ...b, w: l.w, h: l.h } as Block}
                liveSocialEnabled={liveSocialEnabled}
                emailCaptureInteractive={!previewMode}
              />
            </div>
          );
        })}
    </div>
  );
}
