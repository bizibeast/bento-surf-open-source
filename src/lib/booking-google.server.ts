import { configuredAppOrigin } from "@/lib/application-urls";
/* eslint-disable @typescript-eslint/no-explicit-any -- Google payloads are normalized at this boundary. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptServerSecret, encryptServerSecret } from "./secret-crypto.server";
import { readResponseText } from "./request-security.server";

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
];

function appOrigin() {
  return configuredAppOrigin(process.env.VITE_APP_URL);
}

export function googleCalendarRedirectUri() {
  return `${appOrigin()}/integrations/calendar/google/callback`;
}

function credentials() {
  const clientId = (
    process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_YOUTUBE_CLIENT_ID
  )?.trim();
  const clientSecret = (
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_YOUTUBE_CLIENT_SECRET
  )?.trim();
  if (!clientId || !clientSecret || !process.env.BOOKING_CONNECTION_ENCRYPTION_KEY) {
    throw new Error("Google Calendar is awaiting Bento's secure app configuration.");
  }
  return { clientId, clientSecret };
}

export function googleCalendarReady() {
  try {
    credentials();
    return true;
  } catch {
    return false;
  }
}

export function googleCalendarAuthorizationUrl(state: string) {
  const { clientId } = credentials();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", googleCalendarRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent select_account");
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await readResponseText(response, 1024 * 1024);
  let body: any = {};
  try {
    body = JSON.parse(text);
  } catch {
    // Error below contains a stable user-facing message without leaking response bodies.
  }
  if (!response.ok || body.error) {
    throw new Error(
      body.error_description || body.error?.message || body.error || "Google rejected the request.",
    );
  }
  return body as T;
}

export type GoogleTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
};

export async function exchangeGoogleCalendarCode(code: string, redirectUri: string) {
  const { clientId, clientSecret } = credentials();
  return fetchJson<GoogleTokenResponse>("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
}

export async function getGoogleIdentity(accessToken: string) {
  return fetchJson<{ id: string; email: string; name?: string }>(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
}

async function refreshConnection(connection: any) {
  if (!connection.refresh_token_ciphertext) {
    throw new Error("Reconnect Google Calendar to renew access.");
  }
  const { clientId, clientSecret } = credentials();
  const refreshToken = await decryptServerSecret(connection.refresh_token_ciphertext, "booking");
  const token = await fetchJson<GoogleTokenResponse>("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  const update = {
    access_token_ciphertext: await encryptServerSecret(token.access_token, "booking"),
    ...(token.refresh_token
      ? { refresh_token_ciphertext: await encryptServerSecret(token.refresh_token, "booking") }
      : {}),
    token_expires_at: new Date(Date.now() + Math.max(60, token.expires_in) * 1000).toISOString(),
    status: "active",
    last_error: null,
  };
  const { error } = await (supabaseAdmin as any)
    .from("booking_calendar_connections")
    .update(update)
    .eq("id", connection.id);
  if (error) throw new Error("Google Calendar access could not be renewed.");
  return token.access_token;
}

export async function googleAccessToken(connection: any) {
  const expiresAt = new Date(connection.token_expires_at || 0).getTime();
  if (expiresAt > Date.now() + 90_000) {
    return decryptServerSecret(connection.access_token_ciphertext, "booking");
  }
  try {
    return await refreshConnection(connection);
  } catch (error) {
    await (supabaseAdmin as any)
      .from("booking_calendar_connections")
      .update({ status: "error", last_error: "Reconnect Google Calendar to renew access." })
      .eq("id", connection.id);
    throw error;
  }
}

export async function googleFreeBusy(input: {
  connection: any;
  timeMin: string;
  timeMax: string;
  timeZone: string;
}) {
  const token = await googleAccessToken(input.connection);
  const data = await fetchJson<{
    calendars: Record<string, { busy?: Array<{ start: string; end: string }> }>;
  }>("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      timeZone: input.timeZone,
      items: [{ id: input.connection.calendar_id || "primary" }],
    }),
  });
  return data.calendars?.[input.connection.calendar_id || "primary"]?.busy ?? [];
}

export async function createGoogleMeetEvent(input: {
  connection: any;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  buyerEmail: string;
  buyerName?: string | null;
}) {
  const token = await googleAccessToken(input.connection);
  const calendarId = encodeURIComponent(input.connection.calendar_id || "primary");
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`);
  url.searchParams.set("conferenceDataVersion", "1");
  url.searchParams.set("sendUpdates", "all");
  const event = await fetchJson<any>(url.toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: input.title,
      description: input.description,
      start: { dateTime: input.startsAt, timeZone: input.timeZone },
      end: { dateTime: input.endsAt, timeZone: input.timeZone },
      attendees: [{ email: input.buyerEmail, displayName: input.buyerName || undefined }],
      guestsCanInviteOthers: false,
      guestsCanModify: false,
      conferenceData: {
        createRequest: {
          requestId: crypto.randomUUID(),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
      extendedProperties: { private: { bento_booking: "true" } },
    }),
  });
  const meetUrl =
    event.hangoutLink ||
    event.conferenceData?.entryPoints?.find((point: any) => point.entryPointType === "video")
      ?.uri ||
    null;
  return { eventId: String(event.id), eventUrl: event.htmlLink || null, meetUrl };
}

export async function deleteGoogleCalendarEvent(input: { connection: any; eventId: string }) {
  const token = await googleAccessToken(input.connection);
  const calendarId = encodeURIComponent(input.connection.calendar_id || "primary");
  const eventId = encodeURIComponent(input.eventId);
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${eventId}`,
  );
  url.searchParams.set("sendUpdates", "all");
  const response = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.ok || response.status === 404 || response.status === 410) return;
  const text = await readResponseText(response, 64 * 1024);
  let message = "Google Calendar could not remove the event.";
  try {
    const body = JSON.parse(text);
    message = body.error?.message || message;
  } catch {
    // Keep the stable message and never expose an untrusted response body.
  }
  throw new Error(message);
}
