import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  emailSend: vi.fn(),
  billingSend: vi.fn(),
  outboxUpsert: vi.fn(),
  captureServerEvent: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: mocks.from,
    rpc: mocks.rpc,
    auth: { admin: { getUserById: vi.fn() } },
  },
}));

vi.mock("./customer-library-magic-link.server", () => ({
  issueCustomerLibraryMagicLinkForEmail: vi.fn(),
}));
vi.mock("./posthog.server", () => ({ captureServerEvent: mocks.captureServerEvent }));

import {
  enqueueDueAudienceCampaigns,
  enqueueEmailBatch,
  getCreatorEmailCapacity,
  processAudienceCampaignDelivery,
  recordEmailMarketingCapacityBlock,
  scheduleAudienceCampaignForCreator,
  validateCampaignDeliveryAccounting,
} from "./email.server";
import emailServerSource from "./email.server.ts?raw";

type TestRuntime = {
  __env__?: {
    EMAIL_QUEUE?: { send: typeof mocks.emailSend };
    BILLING_QUEUE?: { send: typeof mocks.billingSend };
  };
};

describe("email campaign delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const outboxRows = [
      { id: "11111111-1111-4111-8111-111111111111", event_key: "campaign:one" },
      { id: "22222222-2222-4222-8222-222222222222", event_key: "campaign:two" },
    ];
    mocks.from.mockImplementation((table: string) => {
      if (table !== "email_outbox") throw new Error(`Unexpected table ${table}`);
      return {
        upsert: vi.fn(() => ({
          select: vi.fn().mockResolvedValue({ data: [outboxRows[1]], error: null }),
        })),
        select: vi.fn(() => ({
          in: vi.fn().mockResolvedValue({ data: outboxRows, error: null }),
        })),
      };
    });
    (globalThis as unknown as TestRuntime).__env__ = {
      EMAIL_QUEUE: { send: mocks.emailSend },
      BILLING_QUEUE: { send: mocks.billingSend },
    };
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "__env__");
  });

  it("returns inserted and pre-existing outbox IDs and kicks only the email queue", async () => {
    const result = await enqueueEmailBatch([
      {
        eventKey: "campaign:one",
        eventType: "creator_campaign",
        recipientEmail: "one@example.com",
        immediate: true,
      },
      {
        eventKey: "campaign:two",
        eventType: "creator_campaign",
        recipientEmail: "two@example.com",
        immediate: true,
      },
    ]);

    expect(result).toEqual({
      rows: [
        { id: "11111111-1111-4111-8111-111111111111", eventKey: "campaign:one" },
        { id: "22222222-2222-4222-8222-222222222222", eventKey: "campaign:two" },
      ],
      skipped: 0,
    });
    expect(mocks.emailSend).toHaveBeenCalledWith({
      kind: "email_outbox_kick",
      outboxId: "11111111-1111-4111-8111-111111111111",
    });
    expect(mocks.billingSend).not.toHaveBeenCalled();
  });

  it("claims due campaigns before queueing their stable IDs", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ id: "33333333-3333-4333-8333-333333333333" }],
      error: null,
    });
    const queue = { send: mocks.emailSend } as unknown as Queue;

    await expect(enqueueDueAudienceCampaigns(queue)).resolves.toEqual({
      claimed: 1,
      queued: 1,
      configured: true,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("claim_due_audience_campaigns", {
      p_limit: 25,
      p_campaign_id: null,
    });
    expect(mocks.emailSend).toHaveBeenCalledWith({
      kind: "audience_campaign",
      campaignId: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("does not dispatch or roll back when a second claim finds a stuck publish-on-delivery Post", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    mocks.from.mockImplementation(() => {
      throw new Error("A refused second claim must not reconcile the original worker.");
    });

    await expect(
      enqueueDueAudienceCampaigns({ send: mocks.emailSend } as unknown as Queue),
    ).resolves.toEqual({ claimed: 0, queued: 0, configured: true });
    expect(mocks.emailSend).not.toHaveBeenCalled();
  });

  it("reverts a claim-published newsletter when queue dispatch rejects", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const filters: Array<[string, unknown]> = [];
    const campaign = {
      id: "33333333-3333-4333-8333-333333333333",
      creator_id: "44444444-4444-4444-8444-444444444444",
      publication_id: "55555555-5555-4555-8555-555555555555",
      kind: "newsletter",
      publish_on_delivery: true,
    };
    mocks.rpc.mockResolvedValue({ data: [campaign], error: null });
    mocks.emailSend.mockRejectedValueOnce(new Error("Queue unavailable"));
    mocks.from.mockImplementation((table: string) => {
      expect(table).toBe("audience_campaigns");
      const builder: Record<string, unknown> = {
        update: vi.fn((patch: Record<string, unknown>) => {
          updates.push(patch);
          return builder;
        }),
        eq: vi.fn((column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        }),
        is: vi.fn((column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        }),
        select: vi.fn(() => builder),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: campaign.id }, error: null }),
      };
      return builder;
    });

    await expect(
      enqueueDueAudienceCampaigns({ send: mocks.emailSend } as unknown as Queue),
    ).rejects.toThrow("Queue unavailable");
    expect(updates).toContainEqual({
      delivery_status: "failed",
      delivery_error: "Queue unavailable",
      status: "draft",
      published_at: null,
    });
    expect(filters).toEqual(
      expect.arrayContaining([
        ["id", campaign.id],
        ["creator_id", campaign.creator_id],
        ["publication_id", campaign.publication_id],
        ["kind", "newsletter"],
        ["delivery_status", "sending"],
      ]),
    );
  });

  it("reads a service-only creator contact capacity snapshot", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        plan: "creator",
        limit: 5_000,
        subscribed: 4_200,
        remaining: 800,
        over_limit: false,
      },
      error: null,
    });

    await expect(getCreatorEmailCapacity("44444444-4444-4444-8444-444444444444")).resolves.toEqual({
      plan: "creator",
      limit: 5_000,
      subscribed: 4_200,
      remaining: 800,
      overLimit: false,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("email_marketing_capacity", {
      p_creator_id: "44444444-4444-4444-8444-444444444444",
    });
  });

  it("records only privacy-safe capacity properties from a database rejection", async () => {
    const error = {
      code: "P0001",
      message:
        "Email marketing contact allowance reached. Upgrade capacity or archive subscribed contacts.",
      details: JSON.stringify({
        creator_id: "44444444-4444-4444-8444-444444444444",
        subscribed: 501,
        limit: 500,
        contact_id: "55555555-5555-4555-8555-555555555555",
        email: "reader@example.com",
        provider_id: "provider-secret",
      }),
    };

    await expect(recordEmailMarketingCapacityBlock({ source: "delivery", error })).resolves.toBe(
      true,
    );
    expect(mocks.captureServerEvent).toHaveBeenCalledWith(
      "44444444-4444-4444-8444-444444444444",
      "email_marketing_contact_capacity_blocked",
      { source: "delivery", subscribed_contacts: 501, contact_limit: 500 },
    );
  });

  it("bounds every idempotency lookup to 50 event keys", async () => {
    const lookupSizes: number[] = [];
    mocks.from.mockImplementation((table: string) => {
      if (table !== "email_outbox") throw new Error(`Unexpected table ${table}`);
      return {
        upsert: vi.fn(() => ({
          select: vi.fn().mockResolvedValue({ data: [], error: null }),
        })),
        select: vi.fn(() => ({
          in: vi.fn((_column: string, eventKeys: string[]) => {
            lookupSizes.push(eventKeys.length);
            return Promise.resolve({
              data: eventKeys.map((eventKey, index) => ({
                id: `${eventKey}-${index}`,
                event_key: eventKey,
              })),
              error: null,
            });
          }),
        })),
      };
    });

    const result = await enqueueEmailBatch(
      Array.from({ length: 101 }, (_, index) => ({
        eventKey: `campaign:${index}`,
        eventType: "creator_campaign" as const,
        recipientEmail: `reader-${index}@example.com`,
      })),
    );

    expect(result.rows).toHaveLength(101);
    expect(lookupSizes).toEqual([50, 50, 1]);
  });

  it("requires every prepared recipient to be linked or explicitly skipped", () => {
    expect(() =>
      validateCampaignDeliveryAccounting({ prepared: 2, rows: 1, skipped: 0, linked: 1 }),
    ).toThrow("Every prepared recipient");
    expect(
      validateCampaignDeliveryAccounting({ prepared: 2, rows: 1, skipped: 1, linked: 1 }),
    ).toEqual({ prepared: 2, rows: 1, skipped: 1, linked: 1 });
  });

  it("accepts a stale retry already completed by terminal recipient aggregation", async () => {
    const campaign = {
      id: "33333333-3333-4333-8333-333333333333",
      creator_id: "44444444-4444-4444-8444-444444444444",
      kind: "newsletter",
      status: "published",
      delivery_status: "sending",
    };
    mocks.from.mockImplementation(() => {
      const builder: Record<string, unknown> = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        maybeSingle: vi.fn().mockResolvedValue({ data: campaign, error: null }),
      };
      return builder;
    });
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "prepare_audience_campaign_recipients_with_capacity") {
        return Promise.resolve({ data: [], error: null });
      }
      if (name === "refresh_audience_campaign_delivery") {
        return Promise.resolve({ data: "sent", error: null });
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    await expect(processAudienceCampaignDelivery(campaign.id)).resolves.toEqual({
      recipients: 0,
      linked: 0,
    });
  });

  it("rejects a sending newsletter that is not published before recipient preparation", async () => {
    const campaign = {
      id: "33333333-3333-4333-8333-333333333333",
      creator_id: "44444444-4444-4444-8444-444444444444",
      kind: "newsletter",
      status: "draft",
      delivery_status: "sending",
    };
    mocks.from.mockImplementation(() => {
      const builder: Record<string, unknown> = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        maybeSingle: vi.fn().mockResolvedValue({ data: campaign, error: null }),
      };
      return builder;
    });

    await expect(processAudienceCampaignDelivery(campaign.id)).rejects.toMatchObject({
      message: "Newsletter campaign is not published.",
      retryable: false,
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("keeps a failed campaign non-retryable so the queue can dead-letter it", async () => {
    let reads = 0;
    mocks.from.mockImplementation(() => {
      const builder: Record<string, unknown> = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        maybeSingle: vi.fn().mockImplementation(() => {
          reads += 1;
          return Promise.resolve({
            data:
              reads === 1
                ? null
                : { delivery_status: "failed", delivery_error: "invalid newsletter" },
            error: null,
          });
        }),
      };
      return builder;
    });

    await expect(processAudienceCampaignDelivery("campaign-1")).rejects.toMatchObject({
      message: "invalid newsletter",
      retryable: false,
    });
  });

  it("stores a future ISO schedule without claiming delivery early", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const filters: Array<[string, unknown]> = [];
    const campaign = { id: "33333333-3333-4333-8333-333333333333" };
    mocks.from.mockImplementation(() => {
      const builder: Record<string, unknown> = {
        update: vi.fn((patch: Record<string, unknown>) => {
          updates.push(patch);
          return builder;
        }),
        eq: vi.fn((column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        }),
        in: vi.fn(() => builder),
        select: vi.fn(() => builder),
        maybeSingle: vi.fn().mockResolvedValue({ data: campaign, error: null }),
      };
      return builder;
    });
    const scheduledAt = "2030-01-02T03:04:00.000Z";
    mocks.rpc.mockResolvedValueOnce({
      data: {
        plan: "creator",
        limit: 500,
        subscribed: 500,
        remaining: 0,
        over_limit: false,
      },
      error: null,
    });

    await expect(
      scheduleAudienceCampaignForCreator({
        creatorId: "44444444-4444-4444-8444-444444444444",
        campaignId: campaign.id,
        publicationId: "55555555-5555-4555-8555-555555555555",
        kind: "newsletter",
        scheduledAt,
        publish: true,
      }),
    ).resolves.toEqual({ queued: 0, scheduledAt });
    expect(updates).toContainEqual(
      expect.objectContaining({
        delivery_status: "scheduled",
        scheduled_at: scheduledAt,
        publish_on_delivery: true,
      }),
    );
    expect(updates).not.toContainEqual(expect.objectContaining({ status: "published" }));
    expect(filters).toContainEqual(["kind", "newsletter"]);
    expect(filters).toContainEqual(["status", "draft"]);
    expect(mocks.rpc).toHaveBeenCalledWith("email_marketing_capacity", {
      p_creator_id: "44444444-4444-4444-8444-444444444444",
    });
  });

  it("keeps a newsletter draft unpublished when immediate queueing rejects", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const campaign = {
      id: "33333333-3333-4333-8333-333333333333",
      creator_id: "44444444-4444-4444-8444-444444444444",
      publication_id: "55555555-5555-4555-8555-555555555555",
      kind: "newsletter",
      publish_on_delivery: true,
    };
    mocks.from.mockImplementation(() => {
      const builder: Record<string, unknown> = {
        update: vi.fn((patch: Record<string, unknown>) => {
          updates.push(patch);
          return builder;
        }),
        eq: vi.fn(() => builder),
        is: vi.fn(() => builder),
        in: vi.fn(() => builder),
        select: vi.fn(() => builder),
        maybeSingle: vi.fn().mockResolvedValue({ data: campaign, error: null }),
      };
      return builder;
    });
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          plan: "creator",
          limit: 500,
          subscribed: 5,
          remaining: 495,
          over_limit: false,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: [campaign], error: null });
    mocks.emailSend.mockRejectedValueOnce(new Error("Queue unavailable"));

    await expect(
      scheduleAudienceCampaignForCreator({
        creatorId: "44444444-4444-4444-8444-444444444444",
        campaignId: campaign.id,
        publicationId: "55555555-5555-4555-8555-555555555555",
        kind: "newsletter",
        scheduledAt: null,
        publish: true,
      }),
    ).rejects.toThrow("Queue unavailable");

    expect(updates).not.toContainEqual(expect.objectContaining({ status: "published" }));
    expect(updates).toContainEqual(
      expect.objectContaining({ delivery_status: "failed", delivery_error: "Queue unavailable" }),
    );
  });

  it("queues an immediate newsletter after the publishing claim without eager publish", async () => {
    const order: string[] = [];
    const campaign = { id: "33333333-3333-4333-8333-333333333333" };
    mocks.from.mockImplementation(() => {
      const builder: Record<string, unknown> = {
        update: vi.fn((patch: Record<string, unknown>) => {
          order.push(patch.status === "published" ? "publish" : "schedule");
          return builder;
        }),
        eq: vi.fn(() => builder),
        in: vi.fn(() => builder),
        select: vi.fn(() => builder),
        maybeSingle: vi.fn().mockResolvedValue({ data: campaign, error: null }),
      };
      return builder;
    });
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          plan: "creator",
          limit: 500,
          subscribed: 5,
          remaining: 495,
          over_limit: false,
        },
        error: null,
      })
      .mockImplementationOnce(async () => {
        order.push("claim");
        return { data: [campaign], error: null };
      });
    mocks.emailSend.mockImplementationOnce(async () => {
      order.push("queue");
    });

    await expect(
      scheduleAudienceCampaignForCreator({
        creatorId: "44444444-4444-4444-8444-444444444444",
        campaignId: campaign.id,
        publicationId: "55555555-5555-4555-8555-555555555555",
        kind: "newsletter",
        scheduledAt: null,
        publish: true,
      }),
    ).resolves.toEqual({ queued: 1, scheduledAt: null });

    expect(order).toEqual(["schedule", "claim", "queue"]);
  });

  it("rejects scheduling while a creator is over the contact allowance", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        plan: "creator",
        limit: 500,
        subscribed: 501,
        remaining: 0,
        over_limit: true,
      },
      error: null,
    });

    await expect(
      scheduleAudienceCampaignForCreator({
        creatorId: "44444444-4444-4444-8444-444444444444",
        campaignId: "33333333-3333-4333-8333-333333333333",
        kind: "newsletter",
        scheduledAt: "2030-01-02T03:04:00.000Z",
      }),
    ).rejects.toThrow("contact allowance");
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("rejects scheduling for a non-Creator before campaign mutation", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { plan: "store", limit: 500, subscribed: 100, remaining: 400, over_limit: false },
      error: null,
    });

    await expect(
      scheduleAudienceCampaignForCreator({
        creatorId: "44444444-4444-4444-8444-444444444444",
        campaignId: "33333333-3333-4333-8333-333333333333",
        kind: "newsletter",
        scheduledAt: "2030-01-02T03:04:00.000Z",
      }),
    ).rejects.toThrow("Creator plan");
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("rejects an over-limit creator immediately before recipient snapshotting", async () => {
    const campaign = {
      id: "33333333-3333-4333-8333-333333333333",
      creator_id: "44444444-4444-4444-8444-444444444444",
      kind: "broadcast",
      delivery_status: "sending",
    };
    const builder: Record<string, unknown> = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      maybeSingle: vi.fn().mockResolvedValue({ data: campaign, error: null }),
    };
    mocks.from.mockReturnValue(builder);
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "prepare_audience_campaign_recipients_with_capacity") {
        return Promise.resolve({
          data: null,
          error: {
            code: "P0001",
            message:
              "Email marketing contact allowance reached. Upgrade capacity or archive subscribed contacts.",
            details: JSON.stringify({
              creator_id: campaign.creator_id,
              subscribed: 501,
              limit: 500,
            }),
          },
        });
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    await expect(processAudienceCampaignDelivery(campaign.id)).rejects.toThrow("contact allowance");
    expect(mocks.rpc).toHaveBeenCalledWith("prepare_audience_campaign_recipients_with_capacity", {
      p_campaign_id: campaign.id,
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith("email_marketing_capacity", expect.anything());
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "prepare_audience_campaign_recipients",
      expect.anything(),
    );
  });

  it("rejects a non-Creator from the atomic final recipient snapshot", async () => {
    const campaign = {
      id: "33333333-3333-4333-8333-333333333333",
      creator_id: "44444444-4444-4444-8444-444444444444",
      kind: "broadcast",
      delivery_status: "sending",
    };
    const builder: Record<string, unknown> = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      maybeSingle: vi.fn().mockResolvedValue({ data: campaign, error: null }),
    };
    mocks.from.mockReturnValue(builder);
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "P0001", message: "Email Marketing requires the Creator plan." },
    });

    await expect(processAudienceCampaignDelivery(campaign.id)).rejects.toMatchObject({
      message: "Email Marketing requires the Creator plan.",
      retryable: false,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("prepare_audience_campaign_recipients_with_capacity", {
      p_campaign_id: campaign.id,
    });
  });

  it("uses unlimited sends, resolves owner-published products, and links exact recipient outbox IDs", async () => {
    const creatorId = "44444444-4444-4444-8444-444444444444";
    const campaignId = "33333333-3333-4333-8333-333333333333";
    const contactId = "55555555-5555-4555-8555-555555555555";
    const productId = "66666666-6666-4666-8666-666666666666";
    const campaign = {
      id: campaignId,
      creator_id: creatorId,
      name: "A week inside the studio",
      kind: "newsletter",
      status: "published",
      delivery_status: "sending",
      publication_id: "77777777-7777-4777-8777-777777777777",
      subject: "Studio Notes",
      preview_text: "Issue preview",
      body_markdown: "Issue body",
      content: [
        { id: "1", type: "heading", text: "Launch" },
        { id: "2", type: "product", productId },
      ],
      web_visibility: "paid",
      template_id: "product-launch",
    };
    const filters: Array<[string, unknown]> = [];
    const updates: Array<Record<string, unknown>> = [];
    const resultFor = (table: string) => {
      if (table === "audience_campaigns") return campaign;
      if (table === "profiles") return { username: "ari", display_name: "Ari" };
      if (table === "newsletter_publications") {
        return {
          sender_name: "Ari",
          reply_to_email: "ari@example.com",
          accent_color: "#3478f6",
          logo_url: "https://cdn.example.com/studio-notes.png",
          paid_product_id: productId,
          postal_address: "123 Studio Road, Bengaluru",
        };
      }
      return null;
    };
    mocks.outboxUpsert.mockReturnValue({
      select: vi.fn().mockResolvedValue({
        data: [
          {
            id: "88888888-8888-4888-8888-888888888888",
            event_key: `audience-campaign:${campaignId}:${contactId}`,
          },
        ],
        error: null,
      }),
    });
    mocks.from.mockImplementation((table: string) => {
      if (table === "email_outbox") {
        return {
          upsert: mocks.outboxUpsert,
          select: vi.fn(() => ({
            in: vi.fn().mockResolvedValue({
              data: [
                {
                  id: "88888888-8888-4888-8888-888888888888",
                  event_key: `audience-campaign:${campaignId}:${contactId}`,
                },
              ],
              error: null,
            }),
          })),
        };
      }
      const final =
        table === "newsletter_subscriptions"
          ? {
              data: [{ id: "99999999-9999-4999-8999-999999999999", contact_id: contactId }],
              error: null,
            }
          : table === "commerce_products"
            ? {
                data: [
                  {
                    id: productId,
                    title: "Creator Kit",
                    description: "Published kit",
                    public_slug: "creator-kit",
                  },
                ],
                error: null,
              }
            : { data: resultFor(table), error: null };
      const builder: Record<string, unknown> = {
        select: vi.fn(() => builder),
        update: vi.fn((patch: Record<string, unknown>) => {
          updates.push(patch);
          return builder;
        }),
        eq: vi.fn((column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        }),
        in: vi.fn(() => builder),
        maybeSingle: vi.fn().mockResolvedValue(final),
        then: (resolve: (value: unknown) => void) => resolve(final),
      };
      return builder;
    });
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "prepare_audience_campaign_recipients_with_capacity") {
        return Promise.resolve({
          data: [{ contact_id: contactId, email: "reader@example.com", name: "Reader" }],
          error: null,
        });
      }
      if (name === "link_audience_campaign_outbox") {
        expect(mocks.emailSend).not.toHaveBeenCalled();
        return Promise.resolve({ data: 1, error: null });
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    await expect(processAudienceCampaignDelivery(campaignId)).resolves.toEqual({
      recipients: 1,
      linked: 1,
    });
    expect(filters).toContainEqual(["creator_id", creatorId]);
    expect(filters).toContainEqual(["status", "published"]);
    expect(mocks.outboxUpsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          event_key: `audience-campaign:${campaignId}:${contactId}`,
          payload: expect.objectContaining({
            newsletterProducts: [expect.objectContaining({ id: productId, title: "Creator Kit" })],
            newsletterPublicationId: campaign.publication_id,
            newsletterTemplateId: "product-launch",
            newsletterLogoUrl: "https://cdn.example.com/studio-notes.png",
            postTitle: campaign.name,
            newsletterVisibility: "paid",
            newsletterPaidProductId: productId,
          }),
        }),
      ],
      { onConflict: "event_key", ignoreDuplicates: true },
    );
    expect(emailServerSource).not.toContain('rpc("reserve_email_marketing_sends"');
    expect(mocks.rpc).toHaveBeenCalledWith("prepare_audience_campaign_recipients_with_capacity", {
      p_campaign_id: campaignId,
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith("email_marketing_capacity", expect.anything());
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "prepare_audience_campaign_recipients",
      expect.anything(),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("link_audience_campaign_outbox", {
      p_campaign_id: campaignId,
      p_links: [
        {
          contact_id: contactId,
          event_key: `audience-campaign:${campaignId}:${contactId}`,
          outbox_id: "88888888-8888-4888-8888-888888888888",
        },
      ],
    });
    expect(mocks.emailSend).toHaveBeenCalledTimes(1);
    expect(mocks.emailSend).toHaveBeenCalledWith({
      kind: "email_outbox_kick",
      outboxId: "88888888-8888-4888-8888-888888888888",
    });
    expect(updates).not.toContainEqual(expect.objectContaining({ delivery_status: "sent" }));
  });
});
