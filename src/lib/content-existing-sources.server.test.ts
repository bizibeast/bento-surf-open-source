import { describe, expect, it, vi } from "vitest";
import { loadExistingContentSources } from "./content-existing-sources.server";

describe("existing Content source compatibility", () => {
  it("normalizes connected Google Calendar and Fathom context", async () => {
    const result = await loadExistingContentSources("owner", {
      loadCalendarConnections: vi.fn(async () => [{ id: "calendar", calendar_id: "primary" }]),
      loadFathomConnections: vi.fn(async () => [{ id: "fathom" }]),
      listCalendarEvents: vi.fn(async () => [
        {
          id: "event-1",
          summary: "Creator launch",
          description: "Prepare the launch post",
          htmlLink: "https://calendar.google.com/event?eid=1",
          start: { dateTime: "2026-09-19T10:00:00.000Z" },
        },
      ]),
      listFathomMeetings: vi.fn(async () => [
        {
          title: "Weekly review",
          meetingTitle: "Weekly review",
          shareUrl: "https://fathom.video/share/meeting-1",
          scheduledStartTime: new Date("2026-09-19T09:00:00.000Z"),
          defaultSummary: { markdownFormatted: "We decided to launch next week." },
          transcript: [{ speaker: { displayName: "Sam" }, text: "Ship it", timestamp: "00:01" }],
          actionItems: [{ description: "Draft launch post" }],
        },
      ]),
      now: () => new Date("2026-09-19T12:00:00.000Z"),
    });
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "google_calendar", externalItemId: "event-1" }),
        expect.objectContaining({ provider: "fathom", title: "Weekly review" }),
      ]),
    );
    expect(result.find((item) => item.provider === "fathom")?.text).toContain(
      "We decided to launch next week.",
    );
    expect(result.find((item) => item.provider === "fathom")?.text).toContain("Sam: Ship it");
  });

  it("keeps one existing source failure from blocking the other", async () => {
    const result = await loadExistingContentSources("owner", {
      loadCalendarConnections: vi.fn(async () => [{ id: "calendar", calendar_id: "primary" }]),
      loadFathomConnections: vi.fn(async () => [{ id: "fathom" }]),
      listCalendarEvents: vi.fn(async () => [
        { id: "event-1", summary: "Launch", start: { dateTime: "2026-09-19T10:00:00.000Z" } },
      ]),
      listFathomMeetings: vi.fn(async () => {
        throw new Error("Fathom unavailable");
      }),
      now: () => new Date("2026-09-19T12:00:00.000Z"),
    });
    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe("google_calendar");
  });
});
