import { describe, expect, it } from "vitest";
import { parseBentoWebMcpReadInput, sanitizeBentoWebMcpReadResult } from "./webmcp.functions";

describe("WebMCP read input validation", () => {
  it.each([
    ["list_social_accounts", { provider: "myspace" }],
    ["list_social_posts", { status: "queued" }],
    ["get_analytics_workspace", { range: "365d" }],
    ["get_community_workspace", { productId: "not-a-uuid" }],
    ["list_products", { limit: 0 }],
    ["list_bookings", { limit: 101 }],
    ["list_pages", { unexpected: true }],
  ] as const)("rejects invalid %s input", (operation, input) => {
    expect(() => parseBentoWebMcpReadInput(operation, input)).toThrow();
  });

  it("applies bounded read defaults", () => {
    expect(parseBentoWebMcpReadInput("list_products", {})).toEqual({ limit: 30 });
    expect(parseBentoWebMcpReadInput("get_analytics_workspace", {})).toEqual({ range: "30d" });
  });

  it("accepts an optional owned publication when loading the legacy Store tool", () => {
    expect(
      parseBentoWebMcpReadInput("get_store_workspace", {
        publicationId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({ publicationId: "11111111-1111-4111-8111-111111111111" });
  });
});

describe("WebMCP read result projection", () => {
  it("keeps useful Store fields while dropping customer and provider data", () => {
    const result = sanitizeBentoWebMcpReadResult("get_store_workspace", {
      publications: [
        { id: "pub-1", title: "Studio Notes", slug: "studio-notes", is_default: true },
        { id: "pub-2", title: "Product Notes", slug: "product-notes", is_default: false },
      ],
      selectedPublicationId: "pub-2",
      products: [{ id: "product", title: "Guide", private_url: "https://private.example" }],
      orders: [
        {
          id: "order",
          product_id: "product",
          status: "paid",
          gross_amount: 2500,
          net_amount: 2400,
          refunded_amount: 0,
          currency: "usd",
          paid_at: "2026-08-30T00:00:00Z",
          buyer_email: "buyer@example.com",
          provider_reference: "secret-provider-reference",
          metadata: { secret: true },
        },
      ],
      leads: [{ email: "lead@example.com" }],
      audienceContacts: [
        {
          id: "contact",
          name: "Audience member",
          marketing_status: "subscribed",
          source: "lead_form",
          email: "audience@example.com",
        },
      ],
      discountCodes: [
        {
          id: "discount",
          code: "SAVE10",
          discount_type: "percent",
          discount_value: 1000,
          max_redemptions: 50,
          max_redemptions_per_email: 1,
        },
      ],
    });

    expect(result).toMatchObject({
      publications: [
        { id: "pub-1", title: "Studio Notes" },
        { id: "pub-2", title: "Product Notes" },
      ],
      selectedPublicationId: "pub-2",
      orders: [
        {
          id: "order",
          gross_amount: 2500,
          net_amount: 2400,
          refunded_amount: 0,
        },
      ],
      loadedLeadCount: 1,
      loadedAudienceContactCount: 1,
      audienceContacts: [
        {
          id: "contact",
          name: "Audience member",
          marketing_status: "subscribed",
          source: "lead_form",
        },
      ],
      discountCodes: [
        {
          discount_value: 1000,
          max_redemptions: 50,
          max_redemptions_per_email: 1,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /buyer@example|lead@example|audience@example|secret-provider|metadata|private\.example/,
    );
  });

  it("drops booking emails, meeting URLs, review tokens, and connection emails", () => {
    const result = sanitizeBentoWebMcpReadResult("get_calendar_workspace", {
      calendarConnections: [
        { id: "calendar", provider: "google", status: "active", email: "owner@example.com" },
      ],
      fathomConnections: [{ id: "fathom", status: "active", email: "meeting@example.com" }],
      sessions: [{ id: "session", title: "Strategy call" }],
      bookings: [
        {
          id: "booking",
          product_id: "session",
          buyer_name: "Buyer",
          buyer_email: "buyer@example.com",
          meeting_url: "https://meet.example/secret",
          status: "confirmed",
        },
      ],
      reviews: [
        {
          id: "review",
          booking_id: "booking",
          reviewer_name: "Buyer",
          reviewer_email: "buyer@example.com",
          token_hash: "secret-token-hash",
          rating: 5,
        },
      ],
      publicPage: { enabled: true, name: "Calendar", username: "creator", internal: true },
    });

    expect(result).toMatchObject({
      bookings: [{ id: "booking", buyer_name: "Buyer", status: "confirmed" }],
      reviews: [{ id: "review", booking_id: "booking", rating: 5 }],
      publicPage: { enabled: true, name: "Calendar", username: "creator" },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /owner@example|meeting@example|buyer@example|meet\.example|secret-token|internal/,
    );
  });

  it("retains current analytics fields without internal or provider IDs", () => {
    const result = sanitizeBentoWebMcpReadResult("get_analytics_workspace", {
      range: "30d",
      timeZone: "Asia/Kolkata",
      site: {
        totalViews: 10,
        totalClicks: 3,
        uniqueVisitors: 8,
        daily: [{ date: "2026-08-30", views: 10, clicks: 3, visitor_hash: "secret" }],
        hourly: Array.from({ length: 30 }, (_, index) => index),
      },
      socialSnapshots: [
        {
          connection_id: "internal-connection",
          provider: "instagram",
          provider_handle: "creator",
          followers: 100,
          views: 200,
          reach: 150,
          engagements: 20,
          fetched_at: "2026-08-30T00:00:00Z",
          metadata: { secret: true },
        },
      ],
      socialContent: [
        {
          id: "internal-row",
          connection_id: "internal-connection",
          remote_post_id: "provider-post-id",
          provider: "instagram",
          remote_post_url: "https://instagram.com/p/public",
          content_type: "video",
          views: 50,
          likes: 5,
          fetched_at: "2026-08-30T00:00:00Z",
        },
      ],
    });

    expect(result).toMatchObject({
      site: { totalViews: 10 },
      socialSnapshots: [{ provider: "instagram", followers: 100, reach: 150 }],
      socialContent: [{ provider: "instagram", content_type: "video", views: 50, likes: 5 }],
    });
    expect((result as { site: { hourly: unknown[] } }).site.hourly).toHaveLength(24);
    expect(JSON.stringify(result)).not.toMatch(
      /visitor_hash|internal-connection|internal-row|provider-post-id|metadata/,
    );
  });
});
