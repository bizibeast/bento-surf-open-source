const MAX_RECORDING_MATCH_DISTANCE_MS = 4 * 60 * 60_000;

export type RecordingBookingCandidate = {
  id: string;
  buyer_email: string | null;
  starts_at: string;
};

export type FathomMeetingCandidate = {
  scheduledStartTime?: string | null;
  recordingStartTime?: string | null;
  calendarInvitees?: Array<{ email?: string | null }> | null;
  shareUrl?: string | null;
};

type CandidatePair<TMeeting extends FathomMeetingCandidate> = {
  bookingId: string;
  bookingIndex: number;
  distance: number;
  meeting: TMeeting;
  meetingIndex: number;
};

function normalizedEmail(value: string | null | undefined) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function meetingTimestamp(meeting: FathomMeetingCandidate) {
  const value = meeting.scheduledStartTime || meeting.recordingStartTime;
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isSecureRecordingUrl(value: string | null | undefined) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Match recordings globally so a single Fathom meeting cannot be attached to
 * multiple bookings. Closest start time wins; stable tie-breakers make every
 * scheduler run deterministic.
 */
export function matchFathomMeetingsToBookings<TMeeting extends FathomMeetingCandidate>(
  meetings: TMeeting[],
  bookings: RecordingBookingCandidate[],
) {
  const candidates: Array<CandidatePair<TMeeting>> = [];

  bookings.forEach((booking, bookingIndex) => {
    const buyerEmail = normalizedEmail(booking.buyer_email);
    const bookingStart = new Date(booking.starts_at).getTime();
    if (!buyerEmail || !Number.isFinite(bookingStart)) return;

    meetings.forEach((meeting, meetingIndex) => {
      if (!isSecureRecordingUrl(meeting.shareUrl)) return;
      const meetingStart = meetingTimestamp(meeting);
      if (meetingStart === null) return;
      const invited = (meeting.calendarInvitees || []).some(
        (invitee) => normalizedEmail(invitee.email) === buyerEmail,
      );
      if (!invited) return;
      const distance = Math.abs(meetingStart - bookingStart);
      if (distance > MAX_RECORDING_MATCH_DISTANCE_MS) return;
      candidates.push({
        bookingId: booking.id,
        bookingIndex,
        distance,
        meeting,
        meetingIndex,
      });
    });
  });

  candidates.sort(
    (left, right) =>
      left.distance - right.distance ||
      left.bookingId.localeCompare(right.bookingId) ||
      left.bookingIndex - right.bookingIndex ||
      left.meetingIndex - right.meetingIndex,
  );

  const matches = new Map<string, TMeeting>();
  const assignedMeetings = new Set<number>();
  for (const candidate of candidates) {
    if (matches.has(candidate.bookingId) || assignedMeetings.has(candidate.meetingIndex)) continue;
    matches.set(candidate.bookingId, candidate.meeting);
    assignedMeetings.add(candidate.meetingIndex);
  }
  return matches;
}
