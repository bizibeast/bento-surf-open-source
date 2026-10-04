/* eslint-disable @typescript-eslint/no-explicit-any -- Existing booking provider payloads are normalized here. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { googleAccessToken } from "./booking-google.server";
import { listFathomMeetings } from "./booking-fathom.server";
import { normalizeContentSource, type NormalizedContentSource } from "./content-connections";
import { readResponseText } from "./request-security.server";

type ExistingContentDependencies = {
  loadCalendarConnections(userId: string): Promise<any[]>;
  loadFathomConnections(userId: string): Promise<any[]>;
  listCalendarEvents(connection: any, now: Date): Promise<any[]>;
  listFathomMeetings(connection: any, now: Date): Promise<any[]>;
  now(): Date;
};

async function googleCalendarEvents(connection: any, now: Date) {
  const token = await googleAccessToken(connection);
  const calendarId = encodeURIComponent(connection.calendar_id || "primary");
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`);
  url.search = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
    timeMin: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
    timeMax: new Date(now.getTime() + 14 * 86_400_000).toISOString(),
  }).toString();
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await readResponseText(response, 1024 * 1024);
  if (!response.ok) throw new Error("Google Calendar context could not be loaded.");
  const value = JSON.parse(text) as { items?: unknown[] };
  return Array.isArray(value.items) ? value.items.slice(0, 50) : [];
}

const defaultDependencies: ExistingContentDependencies = {
  async loadCalendarConnections(userId) {
    const { data, error } = await (supabaseAdmin as any)
      .from("booking_calendar_connections")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "active")
      .order("is_default", { ascending: false })
      .limit(3);
    if (error) throw new Error("Google Calendar connections could not be loaded.");
    return data || [];
  },
  async loadFathomConnections(userId) {
    const { data, error } = await (supabaseAdmin as any)
      .from("booking_fathom_connections")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "active")
      .order("is_default", { ascending: false })
      .limit(3);
    if (error) throw new Error("Fathom connections could not be loaded.");
    return data || [];
  },
  listCalendarEvents: googleCalendarEvents,
  listFathomMeetings(connection, now) {
    return listFathomMeetings(connection, {
      createdAfter: new Date(now.getTime() - 14 * 86_400_000),
      createdBefore: new Date(now.getTime() + 86_400_000),
    });
  },
  now: () => new Date(),
};

function dateValue(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function calendarSource(event: any) {
  const startsAt = dateValue(event.start?.dateTime || event.start?.date);
  return normalizeContentSource({
    provider: "google_calendar",
    externalItemId: String(
      event.id || `${startsAt || "event"}:${event.summary || "Untitled"}`,
    ).slice(0, 500),
    type: "calendar_event",
    title: String(event.summary || "Calendar event"),
    text: [event.summary, event.description]
      .filter((value) => typeof value === "string")
      .join("\n"),
    sourceUrl: typeof event.htmlLink === "string" ? event.htmlLink : null,
    occurredAt: startsAt,
    metadata: {},
  });
}

function fathomSource(meeting: any) {
  const startsAt = dateValue(meeting.scheduledStartTime || meeting.recordingStartTime);
  const summary = meeting.defaultSummary?.markdownFormatted;
  const actions = Array.isArray(meeting.actionItems)
    ? meeting.actionItems
        .slice(0, 30)
        .map((item: any) => item?.description)
        .filter((value: unknown): value is string => typeof value === "string")
    : [];
  const transcript = Array.isArray(meeting.transcript)
    ? meeting.transcript
        .slice(0, 200)
        .map((item: any) => {
          const speaker = item?.speaker?.displayName || item?.speaker?.name || "Speaker";
          return typeof item?.text === "string" ? `${speaker}: ${item.text}` : "";
        })
        .filter(Boolean)
        .join("\n")
    : "";
  return normalizeContentSource({
    provider: "fathom",
    externalItemId: String(
      meeting.shareUrl || `${startsAt || "meeting"}:${meeting.meetingTitle || meeting.title}`,
    ).slice(0, 500),
    type: "meeting",
    title: String(meeting.meetingTitle || meeting.title || "Fathom meeting"),
    text: [
      typeof summary === "string" ? summary : "",
      actions.length
        ? `Action items:\n${actions.map((item: string) => `- ${item}`).join("\n")}`
        : "",
      transcript,
    ]
      .filter(Boolean)
      .join("\n\n"),
    sourceUrl: typeof meeting.shareUrl === "string" ? meeting.shareUrl : null,
    occurredAt: startsAt,
    metadata: {},
  });
}

export async function loadExistingContentSources(
  userId: string,
  dependencies: ExistingContentDependencies = defaultDependencies,
): Promise<NormalizedContentSource[]> {
  const now = dependencies.now();
  const [calendarConnections, fathomConnections] = await Promise.all([
    dependencies.loadCalendarConnections(userId).catch(() => []),
    dependencies.loadFathomConnections(userId).catch(() => []),
  ]);
  const tasks: Array<Promise<NormalizedContentSource[]>> = [
    ...calendarConnections.map((connection) =>
      dependencies
        .listCalendarEvents(connection, now)
        .then((events) => events.slice(0, 50).map(calendarSource)),
    ),
    ...fathomConnections.map((connection) =>
      dependencies
        .listFathomMeetings(connection, now)
        .then((meetings) => meetings.slice(0, 30).map(fathomSource)),
    ),
  ];
  const settled = await Promise.allSettled(tasks);
  return settled
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .sort((left, right) =>
      String(right.occurredAt || "").localeCompare(String(left.occurredAt || "")),
    )
    .slice(0, 30);
}
