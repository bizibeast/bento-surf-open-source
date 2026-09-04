import { configuredAppOrigin } from "@/lib/application-urls";
/* eslint-disable @typescript-eslint/no-explicit-any -- Booking tables ship through the matching migration. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enqueueEmail } from "./email.server";
import { listFathomMeetings } from "./booking-fathom.server";
import { deleteGoogleCalendarEvent } from "./booking-google.server";
import { matchFathomMeetingsToBookings } from "./booking-recording-match";
import { bookingReminderStage } from "./booking";
import { webinarReminderStage } from "./webinar";

const db = () => supabaseAdmin as any;

function appUrl() {
  return configuredAppOrigin(process.env.VITE_APP_URL);
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatEventDate(value: string, timezone: string) {
  const options: Intl.DateTimeFormatOptions = { dateStyle: "full", timeStyle: "short" };
  try {
    return new Intl.DateTimeFormat("en", { ...options, timeZone: timezone || "UTC" }).format(
      new Date(value),
    );
  } catch {
    return new Intl.DateTimeFormat("en", { ...options, timeZone: "UTC" }).format(new Date(value));
  }
}

async function queueBookingReminders(now: Date) {
  const client = db();
  const { data: bookings, error } = await client
    .from("commerce_bookings")
    .select(
      "id,product_id,buyer_email,buyer_name,starts_at,timezone,meeting_url,status,reminder_24h_sent_at,reminder_1h_sent_at",
    )
    .eq("status", "confirmed")
    .gt("starts_at", now.toISOString())
    .lte("starts_at", new Date(now.getTime() + 24 * 60 * 60_000).toISOString())
    .order("starts_at", { ascending: true })
    .limit(250);
  if (error) throw new Error(error.message);
  if (!bookings?.length) return 0;
  const { data: products, error: productError } = await client
    .from("commerce_products")
    .select("id,title")
    .in("id", [...new Set(bookings.map((row: any) => row.product_id))]);
  if (productError) throw new Error(productError.message);
  const titles = new Map((products || []).map((row: any) => [row.id, row.title]));
  let queued = 0;

  for (const booking of bookings) {
    const stage = bookingReminderStage(booking, now);
    if (!stage) continue;
    const field = stage === "1h" ? "reminder_1h_sent_at" : "reminder_24h_sent_at";
    await enqueueEmail({
      eventKey: `booking-reminder:${booking.id}:${stage}`,
      eventType: "booking_reminder",
      recipientEmail: booking.buyer_email,
      recipientName: booking.buyer_name,
      payload: {
        productTitle: titles.get(booking.product_id) || "Your call",
        reminderLabel: stage === "1h" ? "Starts in 1 hour" : "Starts in 24 hours",
        startsIn: stage === "1h" ? "in 1 hour" : "in 24 hours",
        bookingDate: formatEventDate(booking.starts_at, booking.timezone),
        meetingUrl: booking.meeting_url,
      },
      immediate: true,
    });
    const { error: updateError } = await client
      .from("commerce_bookings")
      .update({ [field]: now.toISOString() })
      .eq("id", booking.id)
      .eq("status", "confirmed")
      .is(field, null);
    if (updateError) throw new Error(updateError.message);
    queued += 1;
  }
  return queued;
}

async function syncFathomRecordings(now: Date) {
  const client = db();
  const { data: bookings, error } = await client
    .from("commerce_bookings")
    .select(
      "id,product_id,creator_id,buyer_email,buyer_name,starts_at,ends_at,fathom_connection_id",
    )
    .in("status", ["confirmed", "completed"])
    .eq("recording_requested", true)
    .eq("recording_status", "pending")
    .not("fathom_connection_id", "is", null)
    .lte("ends_at", now.toISOString())
    .gte("ends_at", new Date(now.getTime() - 45 * 86_400_000).toISOString())
    .limit(100);
  if (error) throw new Error(error.message);
  if (!bookings?.length) return 0;

  const connectionIds = [...new Set(bookings.map((booking: any) => booking.fathom_connection_id))];
  const [{ data: connections, error: connectionError }, { data: products, error: productError }] =
    await Promise.all([
      client.from("booking_fathom_connections").select("*").in("id", connectionIds),
      client
        .from("commerce_products")
        .select("id,title")
        .in("id", [...new Set(bookings.map((booking: any) => booking.product_id))]),
    ]);
  if (connectionError) throw new Error(connectionError.message);
  if (productError) throw new Error(productError.message);
  const productTitles = new Map(
    (products || []).map((product: any) => [product.id, product.title]),
  );
  let ready = 0;

  for (const connection of connections || []) {
    const related = bookings.filter(
      (booking: any) => booking.fathom_connection_id === connection.id,
    );
    const earliest = Math.min(
      ...related.map((booking: any) => new Date(booking.starts_at).getTime()),
    );
    try {
      const meetings = await listFathomMeetings(connection, {
        createdAfter: new Date(earliest - 86_400_000),
        createdBefore: new Date(now.getTime() + 86_400_000),
      });
      const matches = matchFathomMeetingsToBookings(meetings, related);
      for (const booking of related) {
        const meeting = matches.get(booking.id);
        if (!meeting?.shareUrl) continue;
        const { data: claimed, error: recordingError } = await client.rpc(
          "queue_booking_recording_ready",
          {
            p_booking_id: booking.id,
            p_recording_share_url: meeting.shareUrl,
            p_product_title: productTitles.get(booking.product_id) || "session",
            p_recorded_at: now.toISOString(),
          },
        );
        if (recordingError) throw new Error(recordingError.message);
        if (claimed) ready += 1;
      }
      await client
        .from("booking_fathom_connections")
        .update({ last_synced_at: now.toISOString(), last_error: null })
        .eq("id", connection.id);
    } catch (syncError) {
      await client
        .from("booking_fathom_connections")
        .update({
          last_error: syncError instanceof Error ? syncError.message.slice(0, 500) : "Sync failed",
        })
        .eq("id", connection.id);
    }
  }
  return ready;
}

async function queueReviewRequests(now: Date) {
  const client = db();
  const { data: bookings, error } = await client
    .from("commerce_bookings")
    .select("id,product_id,creator_id,buyer_email,buyer_name,ends_at")
    .eq("status", "confirmed")
    .is("review_requested_at", null)
    .lte("ends_at", new Date(now.getTime() - 15 * 60_000).toISOString())
    .gte("ends_at", new Date(now.getTime() - 45 * 86_400_000).toISOString())
    .limit(100);
  if (error) throw new Error(error.message);
  if (!bookings?.length) return 0;
  const { data: products, error: productError } = await client
    .from("commerce_products")
    .select("id,title")
    .in("id", [...new Set(bookings.map((booking: any) => booking.product_id))]);
  if (productError) throw new Error(productError.message);
  const productTitles = new Map(
    (products || []).map((product: any) => [product.id, product.title]),
  );
  let queued = 0;

  for (const booking of bookings) {
    const token = randomToken();
    const { data: claimed, error: reviewError } = await client.rpc("queue_booking_review_request", {
      p_booking_id: booking.id,
      p_token_hash: await sha256(token),
      p_review_url: `${appUrl()}/review/${token}`,
      p_product_title: productTitles.get(booking.product_id) || "session",
      p_requested_at: now.toISOString(),
    });
    if (reviewError) throw new Error(reviewError.message);
    if (claimed) queued += 1;
  }
  return queued;
}

async function syncGoogleCalendarCancellations() {
  const client = db();
  const { data: bookings, error } = await client
    .from("commerce_bookings")
    .select("id,google_event_id,calendar_connection_id")
    .eq("status", "canceled")
    .eq("calendar_cancel_status", "pending")
    .not("google_event_id", "is", null)
    .not("calendar_connection_id", "is", null)
    .order("updated_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(error.message);
  if (!bookings?.length) return 0;

  const connectionIds = [
    ...new Set(bookings.map((booking: any) => booking.calendar_connection_id)),
  ];
  const { data: connections, error: connectionError } = await client
    .from("booking_calendar_connections")
    .select("*")
    .in("id", connectionIds);
  if (connectionError) throw new Error(connectionError.message);
  const byId = new Map((connections || []).map((connection: any) => [connection.id, connection]));
  let cleaned = 0;

  for (const booking of bookings) {
    try {
      const connection = byId.get(booking.calendar_connection_id);
      if (!connection) throw new Error("The connected Google Calendar is unavailable.");
      await deleteGoogleCalendarEvent({
        connection,
        eventId: booking.google_event_id,
      });
      const { error: updateError } = await client
        .from("commerce_bookings")
        .update({
          calendar_cancel_status: "succeeded",
          calendar_cancel_error: null,
        })
        .eq("id", booking.id)
        .eq("calendar_cancel_status", "pending");
      if (updateError) throw new Error(updateError.message);
      cleaned += 1;
    } catch (cleanupError) {
      await client
        .from("commerce_bookings")
        .update({
          calendar_cancel_error:
            cleanupError instanceof Error
              ? cleanupError.message.slice(0, 500)
              : "Google Calendar cleanup failed.",
        })
        .eq("id", booking.id);
    }
  }
  return cleaned;
}

async function queueWebinarReminders(now: Date) {
  const client = db();
  const { data: registrations, error } = await client
    .from("commerce_webinar_registrations")
    .select(
      "id,product_id,buyer_email,buyer_name,starts_at,ends_at,timezone,join_url,status,reminder_24h_sent_at,reminder_1h_sent_at",
    )
    .neq("status", "canceled")
    .gt("starts_at", now.toISOString())
    .lte("starts_at", new Date(now.getTime() + 24 * 60 * 60_000).toISOString())
    .order("starts_at", { ascending: true })
    .limit(250);
  if (error) throw new Error(error.message);
  if (!registrations?.length) return 0;
  const { data: products, error: productError } = await client
    .from("commerce_products")
    .select("id,title")
    .in("id", [...new Set(registrations.map((row: any) => row.product_id))]);
  if (productError) throw new Error(productError.message);
  const titles = new Map((products || []).map((row: any) => [row.id, row.title]));
  let queued = 0;

  for (const registration of registrations) {
    const stage = webinarReminderStage(registration, now);
    if (!stage) continue;
    const start = new Date(registration.starts_at);
    await enqueueEmail({
      eventKey: `webinar-reminder:${registration.id}:${stage}`,
      eventType: "webinar_reminder",
      recipientEmail: registration.buyer_email,
      recipientName: registration.buyer_name,
      payload: {
        productTitle: titles.get(registration.product_id) || "Your webinar",
        reminderLabel: stage === "1h" ? "Starts in 1 hour" : "Starts in 24 hours",
        startsIn: stage === "1h" ? "in 1 hour" : "in 24 hours",
        eventDate: formatEventDate(start.toISOString(), registration.timezone),
        joinUrl: registration.join_url,
      },
      immediate: true,
    });
    const field = stage === "1h" ? "reminder_1h_sent_at" : "reminder_24h_sent_at";
    const { error: updateError } = await client
      .from("commerce_webinar_registrations")
      .update({ [field]: now.toISOString() })
      .eq("id", registration.id)
      .is(field, null);
    if (updateError) throw new Error(updateError.message);
    queued += 1;
  }
  return queued;
}

async function queueWebinarReplays(now: Date) {
  const client = db();
  const { data: registrations, error } = await client
    .from("commerce_webinar_registrations")
    .select("id,product_id,buyer_email,buyer_name,replay_url,status")
    .neq("status", "canceled")
    .not("replay_url", "is", null)
    .is("replay_ready_notified_at", null)
    .lte("ends_at", now.toISOString())
    .order("ends_at", { ascending: true })
    .limit(250);
  if (error) throw new Error(error.message);
  if (!registrations?.length) return 0;
  const { data: products, error: productError } = await client
    .from("commerce_products")
    .select("id,title")
    .in("id", [...new Set(registrations.map((row: any) => row.product_id))]);
  if (productError) throw new Error(productError.message);
  const titles = new Map((products || []).map((row: any) => [row.id, row.title]));
  let queued = 0;

  for (const registration of registrations) {
    await enqueueEmail({
      eventKey: `webinar-replay:${registration.id}`,
      eventType: "webinar_replay_ready",
      recipientEmail: registration.buyer_email,
      recipientName: registration.buyer_name,
      payload: {
        productTitle: titles.get(registration.product_id) || "Your webinar",
        replayUrl: registration.replay_url,
      },
      immediate: true,
    });
    const { error: updateError } = await client
      .from("commerce_webinar_registrations")
      .update({ replay_ready_notified_at: now.toISOString() })
      .eq("id", registration.id)
      .is("replay_ready_notified_at", null);
    if (updateError) throw new Error(updateError.message);
    queued += 1;
  }
  return queued;
}

export async function processBookingFollowups(now = new Date()) {
  const [
    recordingsReady,
    reviewsQueued,
    calendarCancellationsCleaned,
    bookingRemindersQueued,
    webinarRemindersQueued,
    webinarReplaysQueued,
  ] = await Promise.all([
    syncFathomRecordings(now),
    queueReviewRequests(now),
    syncGoogleCalendarCancellations(),
    queueBookingReminders(now),
    queueWebinarReminders(now),
    queueWebinarReplays(now),
  ]);
  return {
    recordingsReady,
    reviewsQueued,
    calendarCancellationsCleaned,
    bookingRemindersQueued,
    webinarRemindersQueued,
    webinarReplaysQueued,
  };
}
