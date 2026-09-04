import { describe, expect, it } from "vitest";
import {
  buildInstagramInsightsUrl,
  INSTAGRAM_ACCOUNT_INSIGHT_METRICS,
  normalizeInstagramInsights,
} from "./instagram-insights";

describe("Instagram account insights", () => {
  it("builds the official Instagram Login endpoint without putting the token in the URL", () => {
    const url = buildInstagramInsightsUrl({
      accountId: "17841400000000000",
      apiVersion: "v25.0",
      rangeDays: 7,
      now: new Date("2026-08-01T00:00:00.000Z"),
    });
    expect(url.origin).toBe("https://graph.instagram.com");
    expect(url.pathname).toBe("/v25.0/17841400000000000/insights");
    expect(url.searchParams.get("metric")).toBe(INSTAGRAM_ACCOUNT_INSIGHT_METRICS.join(","));
    expect(url.searchParams.get("period")).toBe("day");
    expect(url.searchParams.get("metric_type")).toBe("total_value");
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(Number(url.searchParams.get("until")) - Number(url.searchParams.get("since"))).toBe(
      7 * 24 * 60 * 60,
    );
  });

  it("normalizes returned metrics and preserves unavailable values as null", () => {
    expect(
      normalizeInstagramInsights({
        data: [
          { name: "views", total_value: { value: 1200 } },
          { name: "reach", total_value: { value: 400 } },
          { name: "total_interactions", total_value: { value: 85 } },
        ],
      }),
    ).toEqual({
      views: 1200,
      reach: 400,
      accounts_engaged: null,
      total_interactions: 85,
    });
  });
});
