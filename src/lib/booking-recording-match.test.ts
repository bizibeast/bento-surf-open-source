import { describe, expect, it } from "vitest";
import { matchFathomMeetingsToBookings } from "./booking-recording-match";

const booking = (id: string, startsAt: string, email = "buyer@example.com") => ({
  id,
  starts_at: startsAt,
  buyer_email: email,
});

const meeting = (startsAt: string, shareUrl: string, email = "buyer@example.com") => ({
  scheduledStartTime: startsAt,
  shareUrl,
  calendarInvitees: [{ email }],
});

describe("Fathom recording matching", () => {
  it("chooses the closest meeting when the same buyer has adjacent calls", () => {
    const bookings = [
      booking("booking-a", "2026-07-30T10:00:00.000Z"),
      booking("booking-b", "2026-07-30T12:00:00.000Z"),
    ];
    const meetings = [
      meeting("2026-07-30T12:05:00.000Z", "https://fathom.video/share/b"),
      meeting("2026-07-30T10:03:00.000Z", "https://fathom.video/share/a"),
    ];

    const matches = matchFathomMeetingsToBookings(meetings, bookings);

    expect(matches.get("booking-a")?.shareUrl).toBe("https://fathom.video/share/a");
    expect(matches.get("booking-b")?.shareUrl).toBe("https://fathom.video/share/b");
  });

  it("never assigns one meeting to two bookings", () => {
    const meetings = [meeting("2026-07-30T10:02:00.000Z", "https://fathom.video/share/only")];
    const matches = matchFathomMeetingsToBookings(meetings, [
      booking("booking-a", "2026-07-30T10:00:00.000Z"),
      booking("booking-b", "2026-07-30T10:05:00.000Z"),
    ]);

    expect(matches.size).toBe(1);
    expect(matches.get("booking-a")?.shareUrl).toBe("https://fathom.video/share/only");
  });

  it("requires the exact buyer email among the calendar invitees", () => {
    const matches = matchFathomMeetingsToBookings(
      [
        meeting(
          "2026-07-30T10:00:00.000Z",
          "https://fathom.video/share/wrong",
          "other@example.com",
        ),
      ],
      [booking("booking-a", "2026-07-30T10:00:00.000Z")],
    );

    expect(matches.size).toBe(0);
  });

  it("ignores invalid times, insecure URLs, and meetings outside the time window", () => {
    const meetings = [
      meeting("not-a-date", "https://fathom.video/share/bad-time"),
      meeting("2026-07-30T10:00:00.000Z", "http://fathom.video/share/insecure"),
      meeting("2026-07-30T15:00:00.001Z", "https://fathom.video/share/too-late"),
    ];
    const matches = matchFathomMeetingsToBookings(meetings, [
      booking("booking-a", "2026-07-30T10:00:00.000Z"),
    ]);

    expect(matches.size).toBe(0);
  });

  it("uses recording start time when the scheduled time is unavailable", () => {
    const meetings = [
      {
        recordingStartTime: "2026-07-30T10:02:00.000Z",
        shareUrl: "https://fathom.video/share/recorded",
        calendarInvitees: [{ email: "BUYER@example.com" }],
      },
    ];
    const matches = matchFathomMeetingsToBookings(meetings, [
      booking("booking-a", "2026-07-30T10:00:00.000Z"),
    ]);

    expect(matches.get("booking-a")?.shareUrl).toBe("https://fathom.video/share/recorded");
  });
});
