import { describe, expect, it } from "vitest";
import {
  canOpenWebinarJoinLink,
  canOpenWebinarReplay,
  webinarAccessState,
  webinarReminderStage,
} from "./webinar";

const base = {
  starts_at: "2026-08-02T12:00:00.000Z",
  ends_at: "2026-08-02T13:00:00.000Z",
  status: "registered" as const,
  reminder_24h_sent_at: null,
  reminder_1h_sent_at: null,
};

describe("webinar lifecycle", () => {
  it("queues the closest unsent reminder without sending after the event starts", () => {
    expect(webinarReminderStage(base, new Date("2026-08-01T13:00:00.000Z"))).toBe("24h");
    expect(webinarReminderStage(base, new Date("2026-08-02T11:30:00.000Z"))).toBe("1h");
    expect(webinarReminderStage(base, new Date("2026-08-02T12:01:00.000Z"))).toBeNull();
    expect(
      webinarReminderStage(
        { ...base, reminder_1h_sent_at: "2026-08-02T11:00:00.000Z" },
        new Date("2026-08-02T11:30:00.000Z"),
      ),
    ).toBeNull();
  });

  it("never reminds canceled attendees", () => {
    expect(
      webinarReminderStage({ ...base, status: "canceled" }, new Date("2026-08-02T11:30:00.000Z")),
    ).toBeNull();
  });

  it("gates the live link and replay around the immutable event window", () => {
    expect(webinarAccessState(base, new Date("2026-08-02T11:30:00.000Z"))).toBe("upcoming");
    expect(webinarAccessState(base, new Date("2026-08-02T12:30:00.000Z"))).toBe("live");
    expect(webinarAccessState(base, new Date("2026-08-02T13:01:00.000Z"))).toBe("ended");
    expect(canOpenWebinarJoinLink(base, new Date("2026-08-02T11:44:00.000Z"))).toBe(false);
    expect(canOpenWebinarJoinLink(base, new Date("2026-08-02T11:45:00.000Z"))).toBe(true);
    expect(
      canOpenWebinarReplay(
        { ...base, replay_url: "https://video.example/replay" },
        new Date("2026-08-02T13:01:00.000Z"),
      ),
    ).toBe(true);
  });
});
