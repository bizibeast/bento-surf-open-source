import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";
import { CalendarDays } from "lucide-react";
import { useMemo } from "react";
import { PublicCreatorShell } from "@/components/public/PublicCreatorShell";
import { PublicSystemPageCanvas } from "@/components/public/PublicSystemPageCanvas";
import { getPublicBookingCalendar } from "@/lib/booking.functions";
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

  return (
    <PublicCreatorShell chrome={data.chrome} activePageId={data.page.id}>
      <PublicSystemPageCanvas
        username={data.profile.username}
        blocks={data.blocks}
        systemItems={data.systemItems}
        systemLayout={data.systemLayout}
      />
    </PublicCreatorShell>
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
