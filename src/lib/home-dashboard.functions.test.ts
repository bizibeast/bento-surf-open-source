import { describe, expect, it } from "vitest";
import { homeDashboardFromRows } from "./home-dashboard.functions";

describe("homeDashboardFromRows", () => {
  it("normalizes the four home activity feeds", () => {
    const dashboard = homeDashboardFromRows(
      [
        {
          id: "insight",
          provider: "youtube",
          caption: "Launch",
          content_type: "video",
          published_at: "2026-08-17T10:00:00Z",
          views: "1200",
          impressions: null,
          engagements: "45",
        },
      ],
      [
        {
          id: "post",
          title: null,
          body: "New post",
          status: "published",
          scheduled_at: null,
          published_at: "2026-08-17T09:00:00Z",
          created_at: "2026-08-17T09:00:00Z",
          social_post_targets: [{ provider: "instagram" }],
        },
      ],
      [
        {
          id: "call",
          buyer_name: "Ari",
          buyer_email: "ari@example.com",
          starts_at: "2026-08-19T09:00:00Z",
          meeting_url: null,
        },
      ],
      [
        {
          id: "sale",
          buyer_name: "Ari",
          buyer_email: "ari@example.com",
          status: "partially_refunded",
          gross_amount: 5000,
          refunded_amount: 1000,
          currency: "usd",
          paid_at: "2026-08-17T08:00:00Z",
          created_at: "2026-08-17T07:00:00Z",
          commerce_products: { title: "Course" },
        },
      ],
      { now: new Date("2026-08-18T12:00:00Z").getTime(), upcomingCalls: 3 },
    );

    expect(dashboard.pulse).toMatchObject({
      sales: { current: 1, previous: 0 },
      impressions: { current: 1200, previous: 0 },
      posts: { current: 1, previous: 0 },
      upcomingCalls: 3,
    });
    expect(dashboard.attention[0]?.title).toBe("Call coming up");
    expect(dashboard.suggestion?.title).toBe("Repost what worked");
    expect(dashboard.insights[0]?.impressions).toBe(1200);
    expect(dashboard.insights[0]?.exposureLabel).toBe("views");
    expect(dashboard.posts[0]?.providers).toEqual(["instagram"]);
    expect(dashboard.calls[0]?.buyerName).toBe("Ari");
    expect(dashboard.sales[0]).toMatchObject({
      productTitle: "Course",
      refundedAmount: 1000,
      occurredAt: "2026-08-17T08:00:00Z",
    });
  });
});
