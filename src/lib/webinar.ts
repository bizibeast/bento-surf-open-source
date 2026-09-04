export type WebinarRegistrationStatus = "registered" | "attended" | "no_show" | "canceled";

export type WebinarRegistrationRecord = {
  id: string;
  access_grant_id: string;
  order_id: string;
  product_id: string;
  creator_id: string;
  buyer_email: string;
  buyer_name: string | null;
  starts_at: string;
  ends_at: string;
  timezone: string;
  join_url: string | null;
  replay_url: string | null;
  status: WebinarRegistrationStatus;
  reminder_24h_sent_at: string | null;
  reminder_1h_sent_at: string | null;
  replay_ready_notified_at: string | null;
  attended_at: string | null;
  created_at: string;
  updated_at: string;
};

export type WebinarReminderStage = "24h" | "1h";
export type WebinarAccessState = "upcoming" | "live" | "ended";

function time(value: string) {
  return new Date(value).getTime();
}

export function webinarReminderStage(
  registration: Pick<
    WebinarRegistrationRecord,
    "starts_at" | "status" | "reminder_24h_sent_at" | "reminder_1h_sent_at"
  >,
  now = new Date(),
): WebinarReminderStage | null {
  if (registration.status === "canceled") return null;
  const untilStart = time(registration.starts_at) - now.getTime();
  if (!Number.isFinite(untilStart) || untilStart <= 0) return null;
  if (untilStart <= 60 * 60_000) return registration.reminder_1h_sent_at ? null : "1h";
  if (untilStart <= 24 * 60 * 60_000 && !registration.reminder_24h_sent_at) return "24h";
  return null;
}

export function webinarAccessState(
  registration: Pick<WebinarRegistrationRecord, "starts_at" | "ends_at">,
  now = new Date(),
): WebinarAccessState {
  const current = now.getTime();
  const startsAt = time(registration.starts_at);
  const endsAt = time(registration.ends_at);
  if (current < startsAt) return "upcoming";
  if (current <= endsAt) return "live";
  return "ended";
}

export function canOpenWebinarJoinLink(
  registration: Pick<WebinarRegistrationRecord, "starts_at" | "ends_at" | "status">,
  now = new Date(),
) {
  if (registration.status === "canceled") return false;
  const current = now.getTime();
  const opensAt = time(registration.starts_at) - 15 * 60_000;
  return current >= opensAt && current <= time(registration.ends_at);
}

export function canOpenWebinarReplay(
  registration: Pick<WebinarRegistrationRecord, "ends_at" | "status" | "replay_url">,
  now = new Date(),
) {
  return (
    registration.status !== "canceled" &&
    Boolean(registration.replay_url) &&
    now.getTime() > time(registration.ends_at)
  );
}
