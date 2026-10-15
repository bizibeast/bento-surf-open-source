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

  it("bounds Content Agent conversations and omits private media and provider payloads", () => {
    const messages = Array.from({ length: 35 }, (_, index) => ({
      id: `message-${index}`,
      role: "assistant",
      content: "A draft is ready.",
      created_at: "2026-10-14T00:00:00Z",
      payload: {
        action: "draft",
        message: "A draft is ready.",
        mediaAssets: [{ url: "https://private.example/media", providerToken: "secret" }],
        cards: [
          {
            type: "draft",
            cardId: "draft-1",
            platform: "instagram",
            format: "carousel",
            body: "Useful draft copy",
            slides: [{ heading: "Slide one", body: "A useful point", mediaId: "media-1" }],
            editorial: { angle: "A useful angle", sourceIds: ["private-source-id"] },
            sourceUrls: ["https://private.example/source"],
          },
        ],
      },
      provider_reference: "private-provider-reference",
    }));
    const result = sanitizeBentoWebMcpReadResult("get_content_agent", {
      thread: { id: "thread-1", title: "Draft ideas", private_note: "secret" },
      messages,
    }) as { messages: unknown[] };

    expect(result.messages).toHaveLength(30);
    expect(result.messages[0]).toMatchObject({ id: "message-5" });
    expect(result.messages[0]).toMatchObject({
      result: {
        cards: [
          {
            cardId: "draft-1",
            body: "Useful draft copy",
            slides: [{ heading: "Slide one", mediaId: "media-1" }],
          },
        ],
        mediaAssetCount: 1,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private\.example|private-provider-reference|private-source-id|providerToken|private_note/,
    );
  });

  it("projects Brain, Media, Routines, and Discover without private connection details", () => {
    const brain = sanitizeBentoWebMcpReadResult("get_content_brain", {
      profile: { goal: "reach_growth", nicheKeywords: ["design"], privateField: "secret" },
      items: [
        {
          id: "brain-1",
          title: "Voice",
          content: "Be clear",
          sourceUrl: "https://private.example",
        },
      ],
      sources: [
        {
          id: "source-1",
          provider: "google_calendar",
          displayName: "owner@example.com",
          status: "active",
        },
      ],
      indexing: { status: "ready", sourceCount: 3, error: "private-provider-error" },
    });
    const media = sanitizeBentoWebMcpReadResult("get_content_media", {
      photos: [
        {
          id: "photo-1",
          title: "Portrait",
          url: "https://private.example/image",
          sourceUrl: "https://private.example/post",
          tags: ["portrait"],
        },
      ],
      mediaPending: 1,
      limits: { manualItems: 50, bytes: 1000 },
    });
    const routines = sanitizeBentoWebMcpReadResult("get_content_routines", {
      routines: [{ id: "routine-1", template: "weekly", enabled: true, webhookSecret: "secret" }],
      activity: [{ id: "run-1", status: "failed", error_message: "private-provider-error" }],
    });
    const discover = sanitizeBentoWebMcpReadResult("get_content_discover", {
      discover: {
        status: "fresh",
        trends: [
          {
            id: "trend-1",
            title: "A trend",
            summary: "Worth reviewing",
            sourceUrl: "https://private.example/source",
            metadata: { secret: true },
          },
        ],
        creators: [
          { id: "creator-1", name: "Creator", profileUrl: "https://private.example/profile" },
        ],
      },
      preferences: { language: "en", region: "global", internalId: "secret" },
    });

    expect(brain).toMatchObject({ items: [{ id: "brain-1", content: "Be clear" }] });
    expect(media).toMatchObject({ photos: [{ id: "photo-1", tags: ["portrait"] }] });
    expect(routines).toMatchObject({ activity: [{ id: "run-1", status: "failed" }] });
    expect(discover).toMatchObject({ discover: { trends: [{ id: "trend-1" }] } });
    expect(JSON.stringify({ brain, media, routines, discover })).not.toMatch(
      /private\.example|owner@example|private-provider-error|webhookSecret|internalId|metadata/,
    );
  });

  it("projects one self-hosted Discover recommendation without its source URL or metadata", () => {
    const result = sanitizeBentoWebMcpReadResult("get_content_discover", {
      recommendation: {
        id: "recommendation-1",
        kind: "trend",
        title: "A useful trend",
        source_name: "Public source",
        source_published_at: "2026-10-15T00:00:00Z",
        metric_name: "views",
        metric_value: 100,
        source_url: "https://private.example/source",
        metadata: { providerToken: "secret" },
      },
    }) as { recommendation: Record<string, unknown> };
    expect(result.recommendation).toMatchObject({
      id: "recommendation-1",
      sourceName: "Public source",
      metricValue: 100,
    });
    expect(JSON.stringify(result)).not.toMatch(/private\.example|providerToken|metadata/);
  });
});
