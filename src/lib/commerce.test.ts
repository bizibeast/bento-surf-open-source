import { describe, expect, it } from "vitest";
import { productDraftSchema } from "./commerce.functions";
import {
  calculateCommerceAmounts,
  commerceBookingSlotError,
  commerceCheckoutProduct,
  commerceDeliveryIntegrationError,
  commerceKind,
  commerceProductPublishabilityError,
  commerceOrderConfirmationState,
  hydratePublicCommerceBlocks,
  commercePlatformFeeBps,
  formatCommerceMoney,
  isCommerceGrowthKind,
  isCompletedCommerceCheckoutStatus,
  isStartedCommerceCheckoutStatus,
  isCommerceOfferKind,
  isHostedAccessKind,
  isPlausibleCommerceAccessToken,
  pricingLabel,
  sanitizeCommerceSettingsForPublic,
  slugifyCommerceProduct,
} from "./commerce";
import { commerceEntitlement } from "./plans";

describe("creator commerce primitives", () => {
  it("calculates creator net after Bento and processor fees", () => {
    expect(calculateCommerceAmounts(10_000, 800, 320)).toEqual({
      grossAmount: 10_000,
      platformFeeBps: 800,
      platformFeeAmount: 800,
      processorFeeAmount: 320,
      netAmount: 8_880,
    });
  });

  it("keeps Bento's platform fee at zero for every plan and deployment", () => {
    expect(commercePlatformFeeBps()).toBe(0);
  });

  it("creates stable product slugs and labels", () => {
    expect(slugifyCommerceProduct("  Creator's Launch Kit! ")).toBe("creator-s-launch-kit");
    expect(commerceKind("course").defaultCta).toBe("Start learning");
    expect(formatCommerceMoney(19700, "usd")).toBe("$197");
    expect(pricingLabel("subscription", 1900, "usd", "month")).toBe("$19 / month");
  });

  it("treats newsletters as subscription commerce offers", () => {
    expect(commerceKind("newsletter")).toMatchObject({
      family: "sell",
      defaultPricing: "subscription",
    });
    expect(isCommerceOfferKind("newsletter")).toBe(true);
    expect(isHostedAccessKind("newsletter")).toBe(true);
    expect(commerceEntitlement("newsletter")).toBe("emailMarketing");
  });

  it("publishes only paid recurring newsletters linked to a publication", () => {
    const product = {
      kind: "newsletter" as const,
      description: "Paid Studio Notes.",
      pricing_type: "subscription" as const,
      price_amount: 900,
      billing_interval: "month" as const,
      settings: { newsletterPublicationId: "11111111-1111-4111-8111-111111111111" },
    };

    expect(commerceProductPublishabilityError(product)).toBeNull();
    expect(commerceProductPublishabilityError({ ...product, pricing_type: "one_time" })).toBe(
      "Newsletters require recurring pricing.",
    );
    expect(commerceProductPublishabilityError({ ...product, price_amount: 0 })).toBe(
      "Newsletters require a positive price.",
    );
    expect(commerceProductPublishabilityError({ ...product, settings: {} })).toBe(
      "Link this offer to a newsletter publication.",
    );
    expect(commerceProductPublishabilityError({ ...product, billing_interval: "day" })).toBe(
      "Newsletters bill monthly or yearly.",
    );
    expect(commerceProductPublishabilityError({ ...product, billing_interval: "week" })).toBe(
      "Newsletters bill monthly or yearly.",
    );
  });

  it("hands every payment adapter the final quoted amount", () => {
    const product = {
      id: "product-1",
      title: "Creator session",
      pricing_type: "one_time" as const,
      price_amount: 5_000,
    };

    expect(
      commerceCheckoutProduct(product, {
        grossAmount: 4_500,
        hasAddons: true,
      }),
    ).toEqual({
      ...product,
      title: "Creator session + add-ons",
      price_amount: 4_500,
    });
  });

  it("turns a free session with a paid recording into a one-time checkout", () => {
    const product = {
      title: "Free creator session",
      pricing_type: "free" as const,
      price_amount: 0,
    };

    expect(
      commerceCheckoutProduct(product, {
        grossAmount: 1_000,
        hasAddons: true,
      }),
    ).toMatchObject({
      pricing_type: "one_time",
      price_amount: 1_000,
      title: "Free creator session + add-ons",
    });
  });

  it("keeps a genuinely free checkout free", () => {
    const product = {
      title: "Free guide",
      pricing_type: "free" as const,
      price_amount: 0,
    };

    expect(
      commerceCheckoutProduct(product, {
        grossAmount: 0,
        hasAddons: false,
      }),
    ).toEqual(product);
  });

  it("keeps sellable offers separate from growth actions", () => {
    expect(isCommerceOfferKind("digital_product")).toBe(true);
    expect(isCommerceOfferKind("lead_form")).toBe(false);
    expect(isCommerceGrowthKind("lead_form")).toBe(true);
    expect(isCommerceGrowthKind("bento_affiliate")).toBe(true);
    expect(isCommerceGrowthKind("course")).toBe(false);
  });

  it("uses the persisted payment-session statuses for checkout conversion", () => {
    for (const status of ["pending", "approved", "paid", "expired", "canceled", "failed"]) {
      expect(isStartedCommerceCheckoutStatus(status)).toBe(true);
    }
    expect(isStartedCommerceCheckoutStatus("completed")).toBe(false);
    expect(isStartedCommerceCheckoutStatus(undefined)).toBe(false);
    expect(isCompletedCommerceCheckoutStatus("paid")).toBe(true);
    expect(isCompletedCommerceCheckoutStatus("completed")).toBe(false);
  });

  it("only confirms checkout success from durable paid state", () => {
    expect(commerceOrderConfirmationState({ orderStatus: "paid" })).toBe("confirmed");
    expect(commerceOrderConfirmationState({ orderStatus: "partially_refunded" })).toBe("confirmed");
    expect(commerceOrderConfirmationState({ sessionStatus: "paid" })).toBe("confirmed");
    expect(commerceOrderConfirmationState({ sessionStatus: "pending" })).toBe("processing");
    expect(commerceOrderConfirmationState({ orderStatus: "refunded" })).toBe("unavailable");
    expect(commerceOrderConfirmationState({ sessionStatus: "failed" })).toBe("unavailable");
    expect(commerceOrderConfirmationState({})).toBe("not_found");
  });

  it("rejects malformed private-access tokens without treating them as server errors", () => {
    expect(isPlausibleCommerceAccessToken("nonexistent-token")).toBe(false);
    expect(isPlausibleCommerceAccessToken("a".repeat(20))).toBe(true);
    expect(isPlausibleCommerceAccessToken("x".repeat(201))).toBe(false);
    expect(isPlausibleCommerceAccessToken("valid length but has spaces")).toBe(false);
  });

  it("enforces coaching availability in the creator timezone", () => {
    const settings = {
      timezone: "Asia/Kolkata",
      availabilityDays: [1, 2, 3, 4, 5],
      availabilityStart: "09:00",
      availabilityEnd: "17:00",
      slotIntervalMinutes: 30,
    };
    const now = new Date("2026-07-17T00:00:00.000Z");
    expect(
      commerceBookingSlotError(new Date("2026-07-20T04:00:00.000Z"), 60, settings, now),
    ).toBeNull();
    expect(commerceBookingSlotError(new Date("2026-07-19T04:00:00.000Z"), 60, settings, now)).toBe(
      "That day is outside the creator's availability.",
    );
    expect(commerceBookingSlotError(new Date("2026-07-20T04:15:00.000Z"), 60, settings, now)).toBe(
      "That time is outside the creator's available slots.",
    );
  });

  it("prevents publishing coaching offers that cannot produce valid slots", () => {
    const base = {
      kind: "coaching_call" as const,
      description: "A useful session.",
      settings: {
        durationMinutes: 60,
        timezone: "Asia/Kolkata",
        availabilityDays: [1, 2, 3],
        availabilityStart: "09:00",
        availabilityEnd: "17:00",
        slotIntervalMinutes: 30,
      },
    };
    expect(commerceProductPublishabilityError(base)).toBeNull();
    expect(
      commerceProductPublishabilityError({
        ...base,
        settings: {
          durationMinutes: 60,
          timezone: "Asia/Kolkata",
          weeklyRules: [
            { day: 1, start: "09:00", end: "17:00" },
            { day: 3, start: "10:30", end: "15:00" },
          ],
          slotIntervalMinutes: 30,
        },
      }),
    ).toBeNull();
    expect(
      commerceProductPublishabilityError({
        ...base,
        settings: {
          durationMinutes: 60,
          timezone: "Asia/Kolkata",
          weeklyRules: [{ day: 1, start: "17:00", end: "09:00" }],
          slotIntervalMinutes: 30,
        },
      }),
    ).toBe("Choose valid coaching hours with the end time after the start time.");
    expect(
      commerceProductPublishabilityError({
        ...base,
        settings: { ...base.settings, timezone: "Not/A_Timezone" },
      }),
    ).toBe("Choose a valid timezone before publishing.");
    expect(
      commerceProductPublishabilityError({
        ...base,
        settings: { ...base.settings, availabilityStart: "17:00", availabilityEnd: "09:00" },
      }),
    ).toBe("Choose valid coaching hours with the end time after the start time.");
    expect(
      commerceProductPublishabilityError({
        ...base,
        settings: {
          ...base.settings,
          recordingAddonEnabled: true,
          recordingAddonPrice: 0,
        },
      }),
    ).toBe("Set a valid recording add-on price before publishing.");
  });

  it("requires valid Priority DM follow-up rules and unique bundle products", () => {
    expect(
      commerceProductPublishabilityError({
        kind: "priority_dm",
        description: "Ask me anything.",
        settings: { responseTimeHours: 48 },
      }),
    ).toBeNull();
    expect(
      commerceProductPublishabilityError({
        kind: "priority_dm",
        description: "Ask me anything.",
        settings: { responseTimeHours: 0 },
      }),
    ).toBe("Choose a response time between 1 hour and 30 days.");

    for (const settings of [
      { responseTimeHours: 48, freeFollowUpLimit: -1 },
      { responseTimeHours: 48, freeFollowUpLimit: 1.5 },
      { responseTimeHours: 48, followUpPriceAmount: 0 },
      { responseTimeHours: 48, followUpPriceAmount: 100_000_001 },
    ]) {
      expect(
        commerceProductPublishabilityError({
          kind: "priority_dm",
          description: "Ask me anything.",
          settings,
        }),
      ).toBe("Choose 0 to 100 free follow-ups and a valid paid follow-up price.");
    }

    expect(
      productDraftSchema.safeParse({
        kind: "priority_dm",
        title: "Ask me anything",
        description: "Priority answer.",
        pricing_type: "one_time",
        price_amount: 1900,
        currency: "usd",
        cta_label: "Send priority message",
        settings: { responseTimeHours: 48, freeFollowUpLimit: -1 },
      }).success,
    ).toBe(false);

    const first = "00000000-0000-4000-8000-000000000010";
    const second = "00000000-0000-4000-8000-000000000011";
    expect(
      commerceProductPublishabilityError({
        kind: "bundle",
        description: "Two useful products.",
        settings: { bundledProductIds: [first, second] },
      }),
    ).toBeNull();
    expect(
      commerceProductPublishabilityError({
        kind: "bundle",
        description: "Two useful products.",
        settings: { bundledProductIds: [first, first] },
      }),
    ).toBe("Choose between 2 and 20 unique products for this bundle.");
  });

  it("requires a deliverable meeting and recording setup for coaching offers", () => {
    const session = {
      kind: "coaching_call" as const,
      settings: {
        meetingUrl: "",
        recordingAddonEnabled: true,
        recordingAddonPrice: 1_900,
      },
    };

    expect(commerceDeliveryIntegrationError(session, { calendar: false, fathom: false })).toBe(
      "Connect Google Calendar or add a fallback meeting link before selling this session.",
    );
    expect(
      commerceDeliveryIntegrationError(
        { ...session, settings: { ...session.settings, meetingUrl: "https://meet.example.com/a" } },
        { calendar: false, fathom: false },
      ),
    ).toBe("Connect Fathom before selling a recording add-on.");
    expect(commerceDeliveryIntegrationError(session, { calendar: true, fathom: true })).toBeNull();
    expect(
      commerceDeliveryIntegrationError(
        { ...session, settings: { ...session.settings, recordingAddonEnabled: false } },
        { calendar: true, fathom: false },
      ),
    ).toBeNull();
  });

  it("requires a future, deliverable webinar before publishing", () => {
    const product = {
      kind: "webinar" as const,
      description: "A live workshop.",
      settings: {
        startsAt: "2026-08-20T10:00:00.000Z",
        timezone: "UTC",
        durationMinutes: 60,
        joinUrl: "https://meet.example/live",
      },
    };
    expect(
      commerceProductPublishabilityError(product, new Date("2026-08-01T00:00:00.000Z").getTime()),
    ).toBeNull();
    expect(
      commerceProductPublishabilityError(
        { ...product, settings: { ...product.settings, joinUrl: "" } },
        new Date("2026-08-01T00:00:00.000Z").getTime(),
      ),
    ).toBe("Add the private webinar join link before publishing.");
    expect(
      commerceProductPublishabilityError(
        { ...product, settings: { ...product.settings, joinUrl: "javascript:alert(1)" } },
        new Date("2026-08-01T00:00:00.000Z").getTime(),
      ),
    ).toBe("Add the private webinar join link before publishing.");
    expect(
      commerceProductPublishabilityError(product, new Date("2026-09-01T00:00:00.000Z").getTime()),
    ).toBe("Choose a future webinar date before publishing.");
    expect(
      commerceProductPublishabilityError(
        { ...product, settings: { ...product.settings, durationMinutes: 481 } },
        new Date("2026-08-01T00:00:00.000Z").getTime(),
      ),
    ).toBe("Choose a webinar duration between 10 minutes and 8 hours.");
  });

  it("rejects malformed course, membership, and lead-form delivery settings", () => {
    expect(
      commerceProductPublishabilityError({
        kind: "course",
        description: "Learn the complete workflow.",
        settings: {
          lessons: [
            { id: "lesson-1", title: "Start", body: "Welcome" },
            { id: "lesson-1", title: "Finish", body: "Done" },
          ],
        },
      }),
    ).toBe("Every course lesson needs a unique identifier.");

    expect(
      commerceProductPublishabilityError({
        kind: "membership",
        description: "Join the membership.",
        settings: { benefits: ["Office hours", "office hours"] },
      }),
    ).toBe("Add up to 100 unique membership benefits of 500 characters or fewer.");

    expect(
      commerceProductPublishabilityError({
        kind: "lead_form",
        description: "Join the list.",
        settings: {
          fields: [{ id: "name", label: "Name", type: "text", required: true }],
        },
      }),
    ).toBe("Add an email field before publishing the form.");
  });
});

describe("public commerce settings", () => {
  it("hydrates published blocks from product rows and hides drafts", () => {
    const blocks = [
      { id: "text", type: "heading", content: { text: "Hello" }, cover_url: null },
      {
        id: "live-block",
        type: "commerce",
        content: { productId: "live", status: "draft", title: "Stale title" },
        cover_url: null,
      },
      {
        id: "draft-block",
        type: "commerce",
        content: { productId: "draft", status: "published" },
        cover_url: null,
      },
    ];
    const product = {
      id: "live",
      slug: "creator-guide",
      public_slug: "creator-guide",
      kind: "digital_product" as const,
      status: "published" as const,
      title: "Creator Guide",
      subtitle: "Ship it",
      cover_url: "https://cdn.example/cover.jpg",
      pricing_type: "one_time" as const,
      price_amount: 1900,
      currency: "usd",
      billing_interval: null,
      cta_label: "Get it",
    };

    expect(hydratePublicCommerceBlocks(blocks, [product], true)).toEqual([
      blocks[0],
      {
        ...blocks[1],
        cover_url: product.cover_url,
        content: {
          productId: "live",
          slug: "creator-guide",
          publicSlug: "creator-guide",
          kind: "digital_product",
          title: "Creator Guide",
          subtitle: "Ship it",
          coverUrl: product.cover_url,
          pricingType: "one_time",
          priceAmount: 1900,
          currency: "usd",
          billingInterval: null,
          ctaLabel: "Get it",
          status: "published",
          href: "/p/creator-guide",
        },
      },
    ]);
    expect(hydratePublicCommerceBlocks(blocks, [product], false)).toEqual([blocks[0]]);
  });

  it("removes private delivery keys and links", () => {
    expect(
      sanitizeCommerceSettingsForPublic("digital_product", {
        files: [
          {
            id: "asset-1",
            key: "private/users/creator/store/secret.pdf",
            name: "Guide.pdf",
            size: 42,
            mimeType: "application/pdf",
          },
        ],
      }),
    ).toEqual({
      files: [
        {
          id: "asset-1",
          name: "Guide.pdf",
          size: 42,
          mimeType: "application/pdf",
        },
      ],
    });

    expect(
      sanitizeCommerceSettingsForPublic("webinar", {
        startsAt: "2026-08-01T10:00:00Z",
        joinUrl: "https://private.example/join",
        replayUrl: "https://private.example/replay",
      }),
    ).toEqual({
      startsAt: "2026-08-01T10:00:00Z",
      durationMinutes: 60,
      replayAvailable: true,
    });

    expect(
      sanitizeCommerceSettingsForPublic("coaching_call", {
        durationMinutes: 45,
        meetingUrl: "https://private.example/meeting",
      }),
    ).toEqual({
      durationMinutes: 45,
      timezone: "",
      availabilitySummary: "",
      availabilityDays: [],
      availabilityStart: "09:00",
      availabilityEnd: "17:00",
      slotIntervalMinutes: 30,
      recordingAddonEnabled: false,
      recordingAddonPrice: 0,
    });

    expect(
      sanitizeCommerceSettingsForPublic("priority_dm", {
        priorityPrompt: "Ask me anything",
        responseTimeHours: 48,
        freeFollowUpLimit: 2,
        followUpPriceAmount: 900,
      }),
    ).toEqual({
      priorityPrompt: "Ask me anything",
      responseTimeHours: 48,
      freeFollowUpLimit: 2,
      followUpPriceAmount: 900,
    });

    expect(
      sanitizeCommerceSettingsForPublic("newsletter", {
        newsletterPublicationId: "11111111-1111-4111-8111-111111111111",
        providerProductId: "private-provider-id",
      }),
    ).toEqual({});

    expect(
      sanitizeCommerceSettingsForPublic("bento_affiliate", {
        targetUrl: "https://private.example/target",
      }),
    ).toEqual({});
  });
});
