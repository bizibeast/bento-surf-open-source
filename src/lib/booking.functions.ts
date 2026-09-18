import { loadPublicCreatorPage } from "./profile.functions";
/* eslint-disable @typescript-eslint/no-explicit-any -- Booking tables are added by the accompanying migration. */
import { createServerFn } from "@tanstack/react-start";
import { getRequestHost } from "@tanstack/react-start/server";
import { hostnameFromRequestHost } from "./custom-domain";
import {
  normalizeOrigin,
  PRODUCTION_APP_ORIGIN,
  PRODUCTION_PUBLIC_ORIGIN,
} from "./application-urls";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  availabilityFromRow,
  availabilitySchema,
  bookingAvailabilityForSession,
  DEFAULT_AVAILABILITY,
  generateBookingSlots,
  shouldAutoAddCalendarPage,
  type Availability,
} from "./booking";
import {
  exchangeGoogleCalendarCode,
  getGoogleIdentity,
  googleCalendarAuthorizationUrl,
  googleCalendarReady,
  googleCalendarRedirectUri,
  googleFreeBusy,
} from "./booking-google.server";
import {
  exchangeFathomCode,
  fathomAuthorizationUrl,
  fathomReady,
  fathomRedirectUri,
} from "./booking-fathom.server";
import { encryptServerSecret } from "./secret-crypto.server";
import { enforceRequestRateLimit } from "./request-security.server";
import { requirePlanEntitlement } from "./plan.server";
import {
  clearPublicBookingCalendarCache,
  publicBookingCalendarCacheKey,
  readPublicBookingCalendarCache,
  writePublicBookingCalendarCache,
} from "./public-booking-calendar-cache.server";
import { usernameSchema } from "./username";
import { resolveCommerceGrantByToken } from "./commerce-access.server";
import { setSystemPageVisibility } from "./pages.functions";

const db = () => supabaseAdmin as any;
const uuidSchema = z.string().uuid();
const pageNameSchema = z.string().trim().min(1).max(40);

async function requireBookings(userId: string) {
  return requirePlanEntitlement(
    userId,
    "calendarBookings",
    "Calendar bookings and Google Meet are included with the Store plan. Upgrade to continue.",
  );
}

function publicConnection(row: any) {
  return {
    id: row.id,
    provider: row.provider || "fathom",
    email: row.email,
    displayName: row.display_name,
    calendarId: row.calendar_id,
    status: row.status,
    isDefault: row.is_default,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

export const getBookingWorkspace = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const client = db();
    const [availability, calendars, fathom, products, bookings, reviews, profile] =
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
          .select("id,slug,title,subtitle,status,price_amount,currency,settings,sales_count")
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
          .select("id,booking_id,reviewer_name,rating,body,is_public,submitted_at,created_at")
          .eq("creator_id", context.userId)
          .order("submitted_at", { ascending: false, nullsFirst: false })
          .limit(100),
        client
          .from("profiles")
          .select("username,calendar_page_enabled,booking_onboarded_at")
          .eq("id", context.userId)
          .single(),
      ]);
    for (const result of [availability, calendars, fathom, products, bookings, reviews, profile]) {
      if (result.error) throw new Error(result.error.message);
    }
    const plan = await requireBookings(context.userId).then(
      () => ({ locked: false as const }),
      () => ({ locked: true as const }),
    );
    const availabilityConfigured = Boolean(availability.data);
    const hasActiveGoogleCalendar = (calendars.data || []).some(
      (connection: any) => connection.status === "active",
    );
    let calendarEnabled = Boolean(profile.data?.calendar_page_enabled);
    let bookingOnboardedAt = profile.data?.booking_onboarded_at || null;

    // The first completed setup automatically adds Calendar to the creator's Bento.
    // The marker deliberately remains set if they later delete the page, so a refresh
    // never overrides that explicit choice.
    if (
      shouldAutoAddCalendarPage({
        locked: plan.locked,
        availabilityConfigured,
        hasActiveGoogleCalendar,
        sessionCount: (products.data || []).length,
        bookingOnboardedAt,
      })
    ) {
      const completedAt = new Date().toISOString();
      const { data: completedProfile, error: completionError } = await client
        .from("profiles")
        .update({
          booking_onboarded_at: completedAt,
          calendar_page_enabled: true,
        })
        .eq("id", context.userId)
        .is("booking_onboarded_at", null)
        .select("booking_onboarded_at,calendar_page_enabled")
        .maybeSingle();
      if (completionError) throw new Error(completionError.message);
      if (completedProfile) {
        bookingOnboardedAt = completedProfile.booking_onboarded_at;
        calendarEnabled = Boolean(completedProfile.calendar_page_enabled);
      }
    }

    if (calendarEnabled) {
      await setSystemPageVisibility(context.supabase, context.userId, "calendar", true);
    }
    return {
      ...plan,
      availabilityConfigured,
      bookingOnboarded: Boolean(bookingOnboardedAt),
      availability: availability.data
        ? availabilityFromRow(availability.data)
        : DEFAULT_AVAILABILITY,
      calendarConnections: (calendars.data || []).map(publicConnection),
      fathomConnections: (fathom.data || []).map((row: any) =>
        publicConnection({ ...row, provider: "fathom" }),
      ),
      products: products.data || [],
      bookings: bookings.data || [],
      reviews: reviews.data || [],
      publicCalendar: {
        enabled: calendarEnabled,
        username: profile.data?.username || "",
      },
      readiness: { google: googleCalendarReady(), fathom: fathomReady() },
      callbackUrls: {
        google: googleCalendarRedirectUri(),
        fathom: fathomRedirectUri(),
      },
    };
  });

export const getBookingAvailabilityDefaults = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await db()
      .from("booking_availability")
      .select("*")
      .eq("creator_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? availabilityFromRow(data) : DEFAULT_AVAILABILITY;
  });

export const setPublicCalendarPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ enabled: z.boolean() }).parse(input))
  .handler(async ({ context, data }) => {
    await requireBookings(context.userId);
    const { data: profile, error } = await db()
      .from("profiles")
      .update({ calendar_page_enabled: data.enabled })
      .eq("id", context.userId)
      .select("username,calendar_page_enabled")
      .single();
    if (error) throw new Error(error.message);
    await setSystemPageVisibility(context.supabase, context.userId, "calendar", data.enabled);
    return {
      enabled: Boolean(profile.calendar_page_enabled),
      username: profile.username,
    };
  });

export const renamePublicCalendarPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ name: pageNameSchema }).parse(input))
  .handler(async ({ context, data }) => {
    await requireBookings(context.userId);
    const { data: profile, error } = await db()
      .from("profiles")
      .update({ calendar_page_name: data.name })
      .eq("id", context.userId)
      .select("calendar_page_name,calendar_page_enabled")
      .single();
    if (error) throw new Error(error.message);
    await setSystemPageVisibility(
      context.supabase,
      context.userId,
      "calendar",
      Boolean(profile.calendar_page_enabled),
      profile.calendar_page_name,
    );
    return { name: profile.calendar_page_name };
  });

export const setBookingReviewVisibility = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ reviewId: uuidSchema, isPublic: z.boolean() }).parse(input))
  .handler(async ({ context, data }) => {
    const client = db();
    const [reviewResult, profileResult] = await Promise.all([
      client
        .from("booking_reviews")
        .update({ is_public: data.isPublic })
        .eq("id", data.reviewId)
        .eq("creator_id", context.userId)
        .select("id,is_public")
        .maybeSingle(),
      client.from("profiles").select("username").eq("id", context.userId).single(),
    ]);
    if (reviewResult.error) throw new Error(reviewResult.error.message);
    if (profileResult.error) throw new Error(profileResult.error.message);
    if (!reviewResult.data) throw new Error("Review not found.");
    await clearPublicBookingCalendarCache(profileResult.data.username);
    return { id: reviewResult.data.id, isPublic: Boolean(reviewResult.data.is_public) };
  });

export const getPublicBookingCalendar = createServerFn({ method: "GET" })
  .validator((input) => z.object({ username: usernameSchema }).parse(input))
  .handler(async ({ data }) => {
    const username = data.username.toLowerCase();
    const hostname = hostnameFromRequestHost(getRequestHost());
    const cacheable =
      !hostname ||
      [
        normalizeOrigin(import.meta.env.VITE_PUBLIC_URL, PRODUCTION_PUBLIC_ORIGIN),
        normalizeOrigin(import.meta.env.VITE_APP_URL, PRODUCTION_APP_ORIGIN),
      ].some((origin) => new URL(origin).hostname === hostname);
    const cacheKey = publicBookingCalendarCacheKey(username);
    const cached = cacheable
      ? await readPublicBookingCalendarCache<Awaited<ReturnType<typeof loadPublicBookingCalendar>>>(
          cacheKey,
        )
      : { hit: false as const, value: null };
    if (cached.hit) return cached.value;

    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "public-booking-calendar");
    const result = await loadPublicBookingCalendar(username);
    if (cacheable) await writePublicBookingCalendarCache(cacheKey, result);
    return result;
  });

async function loadPublicBookingCalendar(username: string) {
  const canvas = await loadPublicCreatorPage({ username }, "calendar", null);
  if (!canvas || canvas.notFound || !canvas.page) return null;
  const creator = canvas.profile;
  const sessions = canvas.systemItems
    .filter((item) => item.kind === "session")
    .map(({ data }) => ({
      id: String(data.id),
      slug: String(data.slug),
      title: String(data.title),
      subtitle: String(data.subtitle ?? ""),
      coverUrl: typeof data.coverUrl === "string" ? data.coverUrl : null,
      ctaLabel: String(data.ctaLabel ?? ""),
      durationMinutes: Number(data.durationMinutes),
      priceLabel: String(data.priceLabel),
      soldOut: data.soldOut === true,
    }));
  const reviews = canvas.systemItems
    .filter((item) => item.kind === "review")
    .map(({ data }) => ({
      id: String(data.id),
      reviewerName: typeof data.reviewerName === "string" ? data.reviewerName : null,
      rating: typeof data.rating === "number" ? data.rating : null,
      body: typeof data.body === "string" ? data.body : null,
    }));
  return {
    ...canvas,
    page: canvas.page,
    profile: {
      username: creator.username,
      displayName: creator.display_name,
      bio: creator.bio,
      avatarUrl: creator.avatar_url,
      theme: creator.theme,
      accentColor: creator.accent_color,
      primaryFont: creator.primary_font,
      secondaryFont: creator.secondary_font,
      headerMode: creator.header_mode,
      pattern: creator.pattern,
      patternSettings: creator.pattern_settings,
      isPro: Boolean(creator.is_pro),
      badgeHidden: Boolean(creator.badge_hidden),
      onboarded: creator.onboarded,
      noindex: creator.noindex,
    },
    sessions,
    reviews,
    domainData: { sessions, reviews },
  };
}

export const saveBookingAvailability = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => availabilitySchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireBookings(context.userId);
    const { error } = await db().from("booking_availability").upsert(
      {
        creator_id: context.userId,
        timezone: data.timezone,
        weekly_rules: data.weeklyRules,
        date_overrides: data.dateOverrides,
        minimum_notice_minutes: data.minimumNoticeMinutes,
        maximum_days_ahead: data.maximumDaysAhead,
        buffer_before_minutes: data.bufferBeforeMinutes,
        buffer_after_minutes: data.bufferAfterMinutes,
        slot_interval_minutes: data.slotIntervalMinutes,
      },
      { onConflict: "creator_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

async function insertOAuthState(table: string, userId: string, redirectUri: string) {
  const state = crypto.randomUUID();
  const client = db();
  await client
    .from(table)
    .delete()
    .eq("user_id", userId)
    .lt("expires_at", new Date().toISOString());
  const { error } = await client.from(table).insert({
    state,
    user_id: userId,
    redirect_uri: redirectUri,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  if (error) throw new Error("The connection could not be started.");
  return state;
}

export const beginGoogleCalendarConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireBookings(context.userId);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "google-calendar-oauth",
      context.userId,
    );
    const state = await insertOAuthState(
      "booking_calendar_oauth_states",
      context.userId,
      googleCalendarRedirectUri(),
    );
    return { url: googleCalendarAuthorizationUrl(state) };
  });

export const completeGoogleCalendarConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ code: z.string().min(1).max(4_000), state: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireBookings(context.userId);
    const client = db();
    const { data: state, error } = await client
      .from("booking_calendar_oauth_states")
      .select("*")
      .eq("state", data.state)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error || !state || new Date(state.expires_at).getTime() <= Date.now()) {
      throw new Error("This Google connection expired. Start again.");
    }
    if (state.redirect_uri !== googleCalendarRedirectUri())
      throw new Error("Invalid redirect URI.");
    const tokens = await exchangeGoogleCalendarCode(data.code, state.redirect_uri);
    const identity = await getGoogleIdentity(tokens.access_token);
    const { data: existing } = await client
      .from("booking_calendar_connections")
      .select("id,refresh_token_ciphertext,is_default")
      .eq("user_id", context.userId)
      .eq("provider", "google")
      .eq("provider_user_id", identity.id)
      .maybeSingle();
    if (!tokens.refresh_token && !existing?.refresh_token_ciphertext) {
      throw new Error(
        "Google did not grant offline access. Remove Bento from Google permissions and reconnect.",
      );
    }
    const { count } = await client
      .from("booking_calendar_connections")
      .select("id", { count: "exact", head: true })
      .eq("user_id", context.userId)
      .eq("status", "active");
    const connection = {
      user_id: context.userId,
      provider: "google",
      provider_user_id: identity.id,
      email: identity.email.toLowerCase(),
      display_name: identity.name || null,
      calendar_id: "primary",
      access_token_ciphertext: await encryptServerSecret(tokens.access_token, "booking"),
      refresh_token_ciphertext: tokens.refresh_token
        ? await encryptServerSecret(tokens.refresh_token, "booking")
        : existing.refresh_token_ciphertext,
      token_expires_at: new Date(
        Date.now() + Math.max(60, tokens.expires_in) * 1_000,
      ).toISOString(),
      scopes: (tokens.scope || "").split(" ").filter(Boolean),
      status: "active",
      is_default: existing?.is_default || count === 0,
      last_error: null,
    };
    const { error: upsertError } = await client
      .from("booking_calendar_connections")
      .upsert(connection, { onConflict: "user_id,provider,provider_user_id" });
    await client.from("booking_calendar_oauth_states").delete().eq("state", data.state);
    if (upsertError) throw new Error("Google Calendar could not be saved.");
    return { email: identity.email };
  });

export const beginFathomConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireBookings(context.userId);
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "fathom-oauth", context.userId);
    const state = await insertOAuthState(
      "booking_fathom_oauth_states",
      context.userId,
      fathomRedirectUri(),
    );
    return { url: fathomAuthorizationUrl(state) };
  });

export const completeFathomConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ code: z.string().min(1).max(4_000), state: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireBookings(context.userId);
    const client = db();
    const { data: state, error } = await client
      .from("booking_fathom_oauth_states")
      .select("*")
      .eq("state", data.state)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error || !state || new Date(state.expires_at).getTime() <= Date.now()) {
      throw new Error("This Fathom connection expired. Start again.");
    }
    if (state.redirect_uri !== fathomRedirectUri()) throw new Error("Invalid redirect URI.");
    const result = await exchangeFathomCode(data.code);
    const { count } = await client
      .from("booking_fathom_connections")
      .select("id", { count: "exact", head: true })
      .eq("user_id", context.userId)
      .eq("status", "active");
    const { error: upsertError } = await client.from("booking_fathom_connections").upsert(
      {
        user_id: context.userId,
        provider_user_id: result.providerUserId,
        email: result.email,
        display_name: result.displayName,
        access_token_ciphertext: await encryptServerSecret(result.tokens.token, "booking"),
        refresh_token_ciphertext: await encryptServerSecret(result.tokens.refresh_token, "booking"),
        token_expires_at: new Date(result.tokens.expires).toISOString(),
        scopes: ["public_api"],
        status: "active",
        is_default: count === 0,
        last_error: null,
      },
      { onConflict: "user_id,provider_user_id" },
    );
    await client.from("booking_fathom_oauth_states").delete().eq("state", data.state);
    if (upsertError) throw new Error("Fathom could not be saved.");
    return { email: result.email };
  });

const connectionTypeSchema = z.enum(["google", "fathom"]);

export const setDefaultBookingConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ type: connectionTypeSchema, id: uuidSchema }).parse(input))
  .handler(async ({ context, data }) => {
    await requireBookings(context.userId);
    const table =
      data.type === "google" ? "booking_calendar_connections" : "booking_fathom_connections";
    const client = db();
    const { data: owned } = await client
      .from(table)
      .select("id")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .eq("status", "active")
      .maybeSingle();
    if (!owned) throw new Error("Connection not found.");
    const { error: clearError } = await client
      .from(table)
      .update({ is_default: false })
      .eq("user_id", context.userId);
    if (clearError) throw new Error(clearError.message);
    const { error } = await client
      .from(table)
      .update({ is_default: true })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const disconnectBookingConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ type: connectionTypeSchema, id: uuidSchema }).parse(input))
  .handler(async ({ context, data }) => {
    const table =
      data.type === "google" ? "booking_calendar_connections" : "booking_fathom_connections";
    const { error } = await db()
      .from(table)
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

function productAvailability(settings: Record<string, any>, row: any): Availability {
  return bookingAvailabilityForSession(
    settings,
    row ? availabilityFromRow(row) : DEFAULT_AVAILABILITY,
  );
}

export async function bookingContextForAccessToken(token: string) {
  const client = db();
  const grant = await resolveCommerceGrantByToken(client, token, "*, commerce_orders(metadata)");
  if (!grant) {
    throw new Error("This access link is not active.");
  }
  const [{ data: product }, { data: availability }, { data: calendar }, { data: fathom }] =
    await Promise.all([
      client
        .from("commerce_products")
        .select("id,creator_id,kind,title,settings")
        .eq("id", grant.product_id)
        .eq("kind", "coaching_call")
        .single(),
      client
        .from("booking_availability")
        .select("*")
        .eq("creator_id", grant.creator_id)
        .maybeSingle(),
      client
        .from("booking_calendar_connections")
        .select("*")
        .eq("user_id", grant.creator_id)
        .eq("status", "active")
        .eq("is_default", true)
        .maybeSingle(),
      client
        .from("booking_fathom_connections")
        .select("*")
        .eq("user_id", grant.creator_id)
        .eq("status", "active")
        .eq("is_default", true)
        .maybeSingle(),
    ]);
  if (!product) throw new Error("This product is not a coaching call.");
  return {
    client,
    grant,
    product,
    availability: productAvailability(product.settings || {}, availability),
    calendar,
    fathom,
  };
}

export async function availableSlotsForAccessToken(token: string) {
  const context = await bookingContextForAccessToken(token);
  const duration = Math.min(
    480,
    Math.max(10, Number(context.product.settings?.durationMinutes || 60)),
  );
  const now = new Date();
  const through = new Date(now.getTime() + context.availability.maximumDaysAhead * 86_400_000);
  const { data: existing, error } = await context.client
    .from("commerce_bookings")
    .select("starts_at,ends_at")
    .eq("creator_id", context.product.creator_id)
    .neq("status", "canceled")
    .gte("ends_at", now.toISOString())
    .lte("starts_at", through.toISOString());
  if (error) throw new Error(error.message);
  let googleBusy: Array<{ start: string; end: string }> = [];
  if (context.calendar) {
    googleBusy = await googleFreeBusy({
      connection: context.calendar,
      timeMin: now.toISOString(),
      timeMax: through.toISOString(),
      timeZone: context.availability.timezone,
    });
  }
  return {
    slots: generateBookingSlots({
      availability: context.availability,
      durationMinutes: duration,
      busy: [
        ...(existing || []).map((row: any) => ({ start: row.starts_at, end: row.ends_at })),
        ...googleBusy,
      ],
      now,
    }).slice(0, 240),
    timezone: context.availability.timezone,
    durationMinutes: duration,
  };
}

export const getAvailableCommerceBookingSlots = createServerFn({ method: "POST" })
  .validator((input) => z.object({ token: z.string().min(20).max(200) }).parse(input))
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "commerce-booking-slots");
    return availableSlotsForAccessToken(data.token);
  });
