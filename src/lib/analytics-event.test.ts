import { describe, expect, it } from "vitest";

import {
  analyticsEventInputSchema,
  enrichAnalyticsEvent,
  parseBrowser,
  parseDevice,
  parseSource,
} from "./analytics-event";

const eventId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

describe("analytics event validation and enrichment", () => {
  it("requires a block ID for clicks", () => {
    expect(
      analyticsEventInputSchema.safeParse({ event_id: eventId, kind: "click", user_id: userId })
        .success,
    ).toBe(false);
  });

  it("classifies common devices, browsers and sources", () => {
    expect(parseDevice("Mozilla/5.0 (iPhone) Mobile Safari/604.1")).toBe("mobile");
    expect(parseBrowser("Mozilla/5.0 Chrome/120.0 Safari/537.36")).toBe("Chrome");
    expect(parseSource("https://l.instagram.com/some-path")).toBe("Instagram");
  });

  it("reads Cloudflare geography without trusting client payload fields", () => {
    const request = new Request("https://bento.surf/api/events", {
      headers: {
        "user-agent": "Mozilla/5.0 Firefox/130.0",
        "cf-ipcountry": "IN",
        "cf-ipcity": "Mumbai",
      },
    });
    const enriched = enrichAnalyticsEvent(request, {
      event_id: eventId,
      kind: "view",
      user_id: userId,
      referrer: "https://google.com/search",
    });
    expect(enriched).toMatchObject({
      event_id: eventId,
      country: "IN",
      city: "Mumbai",
      browser: "Firefox",
      source: "Google",
    });
  });
});
