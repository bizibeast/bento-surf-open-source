import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound, redirect, useNavigate } from "@tanstack/react-router";
import { ArrowRight, CalendarDays, Clock3, Star } from "lucide-react";
import { useMemo } from "react";
import { FontApplier } from "@/components/FontApplier";
import { DecodedImage } from "@/components/DecodedImage";
import { PageTabs } from "@/components/PageTabs";
import { BookingReviewCard } from "@/components/bookings/BookingReviewCard";
import { PatternBackdrop } from "@/components/patterns/PatternBackdrop";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { getPublicBookingCalendar } from "@/lib/booking.functions";
import {
  ACCENT_PALETTE,
  DEFAULT_SETTINGS,
  type PatternId,
  type PatternSettings,
} from "@/lib/patterns/registry";
import { safeMediaUrl } from "@/lib/safe-url";
import {
  normalizePublicUsername,
  publicProductPath,
  publicProfilePath,
} from "@/lib/application-urls";
import { BentoBrand } from "@/components/BentoBrand";
import { publicCalendarHead } from "@/lib/public-calendar-seo";
import { useWebMcpTools, webMcpResult } from "@/lib/webmcp";

type PublicCalendarSession = {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  coverUrl: string | null;
  ctaLabel: string;
  durationMinutes: number;
  priceLabel: string;
  soldOut: boolean;
};

type PublicCalendarReview = {
  id: string;
  reviewerName: string | null;
  rating: number | null;
  body: string | null;
};

const calendarQuery = (username: string) =>
  queryOptions({
    queryKey: ["public-booking-calendar", username],
    queryFn: () => getPublicBookingCalendar({ data: { username } }),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });

export const Route = createFileRoute("/$username_/calendar")({
  loader: async ({ context, params, location }) => {
    const data = await context.queryClient.ensureQueryData(
      calendarQuery(normalizePublicUsername(params.username)),
    );
    if (!data) throw notFound();
    if (data.profile.username !== normalizePublicUsername(params.username)) {
      throw redirect({
        href: `${publicProfilePath(data.profile.username, "calendar")}${location.searchStr}`,
        statusCode: 307,
      });
    }
    return data;
  },
  head: ({ loaderData }) =>
    loaderData
      ? publicCalendarHead(loaderData, import.meta.env.VITE_PUBLIC_URL)
      : { meta: [{ title: "Calendar not found | bento.surf" }] },
  component: PublicBookingCalendar,
});

function PublicBookingCalendar() {
  const navigate = useNavigate();
  const username = normalizePublicUsername(Route.useParams().username);
  const { data } = useSuspenseQuery(calendarQuery(username));
  const webMcpTools = useMemo(() => {
    if (!data) return [];
    const { profile, sessions, reviews = [] } = data;
    return [
      {
        name: "bento_get_public_calendar",
        title: "Get public Bento calendar",
        description:
          "Returns the public creator identity, bookable sessions, prices, durations, sold-out state, and published reviews.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: () =>
          webMcpResult("Loaded the public booking calendar.", {
            creator: {
              username: profile.username,
              displayName: profile.displayName,
              bio: profile.bio,
            },
            sessions: sessions.map((session: PublicCalendarSession) => ({
              id: session.id,
              slug: session.slug,
              title: session.title,
              subtitle: session.subtitle,
              durationMinutes: session.durationMinutes,
              priceLabel: session.priceLabel,
              soldOut: session.soldOut,
              url: publicProductPath(profile.username, session.slug),
            })),
            reviews: reviews.map((review: PublicCalendarReview) => ({
              reviewerName: review.reviewerName,
              rating: review.rating,
              body: review.body,
            })),
          }),
      },
    ];
  }, [data]);
  useWebMcpTools(webMcpTools);
  if (!data) return <CalendarNotFound />;

  const { profile, pages, sessions, reviews = [] } = data;
  const calendarPageName = pages.find((page) => page.system === "calendar")?.name || "Calendar";
  const themeMode = profile.theme === "dark" ? "dark" : "light";
  const accentId = profile.accentColor || "indigo";
  const accentHex =
    ACCENT_PALETTE.find((accent) => accent.id === accentId)?.hex ||
    (typeof accentId === "string" && /^#[0-9a-f]{6}$/i.test(accentId) ? accentId : "#6366f1");
  const patternSettings: PatternSettings = {
    ...DEFAULT_SETTINGS,
    ...(profile.patternSettings &&
    typeof profile.patternSettings === "object" &&
    !Array.isArray(profile.patternSettings)
      ? (profile.patternSettings as Partial<PatternSettings>)
      : {}),
  };
  const accentVars =
    themeMode === "dark"
      ? {
          "--background": `color-mix(in oklab, ${accentHex} 14%, #0b0b14)`,
          "--foreground": `color-mix(in oklab, ${accentHex} 35%, #ffffff)`,
          "--card": `color-mix(in oklab, ${accentHex} 10%, #11111b)`,
          "--muted": `color-mix(in oklab, ${accentHex} 18%, #1a1a22)`,
          "--muted-foreground": `color-mix(in oklab, ${accentHex} 40%, #ffffff)`,
          "--accent": `color-mix(in oklab, ${accentHex} 28%, #1f1f29)`,
          "--primary": accentHex,
          "--primary-foreground": "#ffffff",
          "--border": `color-mix(in oklab, ${accentHex} 22%, #1f1f29)`,
        }
      : {
          "--background": `color-mix(in oklab, ${accentHex} 8%, #ffffff)`,
          "--foreground": `color-mix(in oklab, ${accentHex} 75%, #000000)`,
          "--card": `color-mix(in oklab, ${accentHex} 4%, #ffffff)`,
          "--muted": `color-mix(in oklab, ${accentHex} 14%, #ffffff)`,
          "--muted-foreground": `color-mix(in oklab, ${accentHex} 55%, #000000)`,
          "--accent": `color-mix(in oklab, ${accentHex} 18%, #ffffff)`,
          "--primary": accentHex,
          "--primary-foreground": "#ffffff",
          "--border": `color-mix(in oklab, ${accentHex} 20%, #ffffff)`,
        };
  const creatorName = profile.displayName || profile.username;
  const initial = creatorName.slice(0, 1).toUpperCase();
  const showHeader = profile.headerMode !== "no_banner";

  return (
    <main
      data-bento-public-page="true"
      data-theme={themeMode}
      style={accentVars as React.CSSProperties}
      className={`relative isolate min-h-screen text-foreground ${themeMode === "dark" ? "dark" : ""}`}
    >
      <div
        className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
        style={{ background: "var(--background)" }}
      >
        <PatternBackdrop
          pattern={(profile.pattern as PatternId) || "none"}
          settings={patternSettings}
          accentHex="#9ca3af"
          theme={themeMode}
        />
      </div>
      <FontApplier headline={profile.secondaryFont} body={profile.primaryFont} />

      <div className="mx-auto w-full max-w-6xl px-3 pt-8 lg:min-h-[calc(100vh-4rem)] lg:px-6 lg:pb-0 lg:pt-0">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[380px_1fr] lg:gap-11 lg:overflow-visible">
          {showHeader && (
            <aside className="flex w-full flex-col items-center text-center text-foreground lg:sticky lg:top-0 lg:min-h-[calc(100vh-4rem)] lg:self-start lg:items-start lg:overflow-visible lg:py-8 lg:pl-1 lg:pr-2 lg:text-left">
              {safeMediaUrl(profile.avatarUrl) ? (
                <DecodedImage
                  src={safeMediaUrl(profile.avatarUrl)!}
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
                  {creatorName}
                  <VerifiedBadge className="size-[1.1em]" active={profile.isPro} />
                </span>
              </h1>
              <span
                className="text-sm text-muted-foreground"
                style={{ fontFamily: "var(--font-user-body, inherit)" }}
              >
                bento.surf/@{profile.username}
              </span>
              {profile.bio ? (
                <p
                  className="mt-3 max-w-[16rem] text-sm leading-relaxed text-muted-foreground"
                  style={{ fontFamily: "var(--font-user-body, inherit)" }}
                >
                  {profile.bio}
                </p>
              ) : null}
              <div className="mt-4 w-full lg:flex lg:justify-start">
                <PageTabs
                  pages={pages.map((page) =>
                    page.url
                      ? page
                      : { ...page, href: publicProfilePath(profile.username, page.slug) },
                  )}
                  activeId="__calendar"
                  homeHref={publicProfilePath(profile.username)}
                  mode="public"
                  onSelect={(id) => {
                    if (id === "__calendar") return;
                    if (id === null) {
                      void navigate({
                        to: "/$username",
                        params: { username: `@${profile.username}` },
                      });
                      return;
                    }
                    const page = pages.find((candidate) => candidate.id === id);
                    if (page) {
                      void navigate({
                        to: "/$username/$pageSlug",
                        params: { username: `@${profile.username}`, pageSlug: page.slug },
                      });
                    }
                  }}
                />
              </div>
            </aside>
          )}

          <section className={`pb-32 lg:pt-8 ${showHeader ? "" : "lg:col-span-2"}`}>
            <div className="flex items-end justify-between gap-4">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  {calendarPageName}
                </div>
                <h2
                  className="mt-2 font-display text-3xl"
                  style={{ fontFamily: "var(--font-user-headline, var(--font-display))" }}
                >
                  Choose a session
                </h2>
              </div>
              <span className="hidden rounded-full bg-accent px-3 py-1.5 text-[10px] font-semibold sm:inline-flex">
                {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
              </span>
            </div>

            <div className="mt-6 space-y-3">
              {sessions.length ? (
                sessions.map((session: PublicCalendarSession) => (
                  <article
                    key={session.id}
                    className="group overflow-hidden rounded-[28px] border border-border/75 bg-card shadow-[0_26px_70px_-52px_rgba(23,33,58,.55)]"
                  >
                    <Link
                      to={publicProductPath(profile.username, session.slug)}
                      preload="intent"
                      className="grid min-h-36 gap-4 p-4 sm:grid-cols-[112px_1fr_auto] sm:items-center sm:p-5"
                    >
                      {safeMediaUrl(session.coverUrl) ? (
                        <DecodedImage
                          src={safeMediaUrl(session.coverUrl)!}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="h-36 w-full rounded-[20px] object-cover sm:size-28"
                        />
                      ) : (
                        <div className="flex h-28 w-full items-center justify-center rounded-[20px] bg-accent sm:size-28">
                          <CalendarDays className="size-7 text-primary" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-display text-2xl leading-tight">{session.title}</h3>
                          {session.soldOut ? (
                            <span className="rounded-full bg-muted px-2.5 py-1 text-[9px] font-semibold text-muted-foreground">
                              Sold out
                            </span>
                          ) : null}
                        </div>
                        {session.subtitle ? (
                          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                            {session.subtitle}
                          </p>
                        ) : null}
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1.5">
                            <Clock3 className="size-3.5" /> {session.durationMinutes} min
                          </span>
                          <span className="rounded-full bg-accent px-2.5 py-1.5 font-semibold">
                            {session.priceLabel}
                          </span>
                        </div>
                      </div>
                      <span className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-xs font-semibold text-primary-foreground sm:w-auto">
                        {session.soldOut ? "View session" : session.ctaLabel || "Book"}
                        <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
                      </span>
                    </Link>
                  </article>
                ))
              ) : (
                <div className="rounded-[30px] border border-border/75 bg-card p-8 text-center sm:p-12">
                  <div className="mx-auto flex size-14 items-center justify-center rounded-[20px] bg-accent">
                    <CalendarDays className="size-6 text-primary" />
                  </div>
                  <h3 className="mt-5 font-display text-2xl">No sessions are live yet</h3>
                  <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                    {creatorName} is still preparing this calendar. Check back soon.
                  </p>
                </div>
              )}
            </div>

            {reviews.length ? (
              <section className="mt-10" aria-labelledby="calendar-reviews-title">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Latest reviews
                </div>
                <h2
                  id="calendar-reviews-title"
                  className="mt-2 flex items-center gap-2 font-display text-3xl"
                  style={{ fontFamily: "var(--font-user-headline, var(--font-display))" }}
                >
                  <Star className="size-6 fill-amber-400 text-amber-400" aria-hidden="true" />
                  What clients say
                </h2>
                <div className="mt-5 grid gap-3 md:grid-cols-2">
                  {reviews.map((review: PublicCalendarReview) => (
                    <BookingReviewCard key={review.id} review={review} />
                  ))}
                </div>
              </section>
            ) : null}
          </section>
        </div>
      </div>
    </main>
  );
}

function CalendarNotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="max-w-sm text-center">
        <div className="mx-auto flex size-14 items-center justify-center rounded-[20px] bg-accent">
          <CalendarDays className="size-6" />
        </div>
        <h1 className="mt-5 font-display text-3xl">Calendar unavailable</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          This creator has not published a booking calendar.
        </p>
        <Link
          to="/"
          className="mt-5 inline-flex rounded-2xl bg-primary px-4 py-3 text-xs font-semibold text-primary-foreground"
        >
          <BentoBrand iconClassName="size-5" />
        </Link>
      </div>
    </main>
  );
}
