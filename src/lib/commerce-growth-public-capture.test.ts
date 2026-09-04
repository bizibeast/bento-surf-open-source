import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const creatorId = "00000000-0000-4000-8000-000000000002";
  const publicationId = "00000000-0000-4000-8000-000000000003";
  const listId = "00000000-0000-4000-8000-000000000004";
  const contactId = "00000000-0000-4000-8000-000000000005";
  const state = {
    block: {
      id: "00000000-0000-4000-8000-000000000001",
      user_id: "00000000-0000-4000-8000-000000000002",
      type: "email_capture",
      content: {} as Record<string, unknown>,
    },
    publication: { id: publicationId, paid_product_id: null as string | null },
    list: { id: listId },
    campaign: { id: "00000000-0000-4000-8000-000000000006" },
    accessGrants: [] as Array<{ buyer_email: string; expires_at: string | null }>,
  };
  const blockQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  blockQuery.select = vi.fn(() => blockQuery);
  blockQuery.eq = vi.fn(() => blockQuery);
  blockQuery.maybeSingle = vi.fn(async () => ({ data: state.block, error: null }));
  const queries: Array<{
    table: string;
    action: string;
    value?: Record<string, unknown>;
    selection?: string;
    filters: Array<[string, unknown]>;
  }> = [];
  const subscriber = {
    id: "00000000-0000-4000-8000-000000000007",
    publication_id: publicationId,
    contact_id: contactId,
    status: "subscribed",
    email_enabled: true,
    source: "csv_import",
    subscribed_at: "2026-09-01T10:00:00.000Z",
    created_at: "2026-09-01T09:00:00.000Z",
    audience_contacts: {
      id: contactId,
      creator_id: creatorId,
      email: "reader@example.com",
      name: "Reader",
      last_seen_at: "2026-09-01T10:00:00.000Z",
    },
  };
  const from = vi.fn((table: string) => {
    if (table === "blocks") return blockQuery;
    const query = {
      table,
      action: "select",
      filters: [] as Array<[string, unknown]>,
      value: undefined as Record<string, unknown> | undefined,
      selection: undefined as string | undefined,
    };
    queries.push(query);
    const result = () => {
      if (table === "newsletter_publications") {
        return { data: state.publication, error: null };
      }
      if (table === "audience_lists") {
        return {
          data: query.action === "insert" ? { ...query.value, id: listId } : state.list,
          error: null,
        };
      }
      if (table === "audience_list_members") {
        if (query.action === "select") return { data: [{ contact_id: contactId }], error: null };
        return { data: null, error: null };
      }
      if (table === "newsletter_subscriptions") {
        const single = query.filters.some(
          ([column, value]) => column === "contact_id" && !Array.isArray(value),
        );
        return { data: single ? { id: subscriber.id } : [subscriber], error: null };
      }
      if (table === "audience_campaigns") {
        return {
          data:
            query.action === "insert" || query.action === "update"
              ? { ...query.value, id: state.campaign.id }
              : state.campaign,
          error: null,
        };
      }
      if (table === "audience_contacts") {
        return {
          data: query.selection?.startsWith("*")
            ? [
                {
                  ...subscriber.audience_contacts,
                  created_at: "2026-09-01T09:00:00.000Z",
                  last_source: "purchase",
                },
              ]
            : { id: contactId },
          error: null,
        };
      }
      if (table === "commerce_access_grants") return { data: state.accessGrants, error: null };
      return { data: null, error: null };
    };
    const builder = {
      select: vi.fn((selection?: string) => {
        query.selection = selection;
        return builder;
      }),
      eq: vi.fn((column: string, value: unknown) => {
        query.filters.push([column, value]);
        return builder;
      }),
      neq: vi.fn((column: string, value: unknown) => {
        query.filters.push([column, value]);
        return builder;
      }),
      in: vi.fn((column: string, value: unknown) => {
        query.filters.push([column, value]);
        return builder;
      }),
      gte: vi.fn((column: string, value: unknown) => {
        query.filters.push([column, value]);
        return builder;
      }),
      lt: vi.fn((column: string, value: unknown) => {
        query.filters.push([column, value]);
        return builder;
      }),
      ilike: vi.fn((column: string, value: unknown) => {
        query.filters.push([column, value]);
        return builder;
      }),
      or: vi.fn((value: string) => {
        query.filters.push(["or", value]);
        return builder;
      }),
      order: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      insert: vi.fn((value: Record<string, unknown>) => {
        query.action = "insert";
        query.value = value;
        return builder;
      }),
      update: vi.fn((value: Record<string, unknown>) => {
        query.action = "update";
        query.value = value;
        return builder;
      }),
      delete: vi.fn(() => {
        query.action = "delete";
        return builder;
      }),
      upsert: vi.fn((value: Record<string, unknown>) => {
        query.action = "upsert";
        query.value = value;
        return builder;
      }),
      maybeSingle: vi.fn(async () => result()),
      single: vi.fn(async () => result()),
      then: (
        resolve: (value: ReturnType<typeof result>) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve(result()).then(resolve, reject),
    };
    return builder;
  });
  return {
    creatorId,
    publicationId,
    listId,
    contactId,
    state,
    blockQuery,
    queries,
    from,
    createNewsletterConfirmationToken: vi.fn().mockResolvedValue("signed.token"),
    enqueueEmail: vi.fn().mockResolvedValue("outbox-id"),
    enforceRequestRateLimit: vi.fn().mockResolvedValue(undefined),
    requirePlanEntitlement: vi.fn().mockResolvedValue("creator"),
    recordEmailMarketingCapacityBlock: vi.fn().mockResolvedValue(true),
    scheduleAudienceCampaignForCreator: vi.fn().mockResolvedValue({ queued: 1, scheduledAt: null }),
    rpc: vi.fn(),
  };
});

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (input: unknown) => input;
    const builder = {
      middleware: () => builder,
      validator: (next: typeof validate) => {
        validate = next;
        return builder;
      },
      handler:
        (handler: (input: { data: unknown; context: { userId: string } }) => unknown) =>
        ({ data }: { data: unknown }) =>
          handler({
            data: validate(data),
            context: { userId: "00000000-0000-4000-8000-000000000002" },
          }),
    };
    return builder;
  },
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: mocks.from,
    rpc: mocks.rpc,
  },
}));
vi.mock("./email.server", () => ({
  createNewsletterConfirmationToken: mocks.createNewsletterConfirmationToken,
  enqueueEmail: mocks.enqueueEmail,
  enqueueEmailBatch: vi.fn(),
  getCreatorEmailCapacity: vi.fn().mockResolvedValue({
    plan: "creator",
    limit: 500,
    subscribed: 1,
    remaining: 499,
    overLimit: false,
  }),
  recordEmailMarketingCapacityBlock: mocks.recordEmailMarketingCapacityBlock,
  scheduleAudienceCampaignForCreator: mocks.scheduleAudienceCampaignForCreator,
}));
vi.mock("./plan.server", () => ({ requirePlanEntitlement: mocks.requirePlanEntitlement }));
vi.mock("./request-security.server", () => ({
  enforceRequestRateLimit: mocks.enforceRequestRateLimit,
}));

import {
  capturePublicEmailCapture,
  createAudienceList,
  getPublicationAudience,
  saveAudienceCampaign,
  scheduleNewsletterIssue,
  sendAudienceCampaign,
  setAudienceListMember,
  unsubscribePublicationSubscribers,
} from "./commerce-growth.functions";
import commerceGrowthSource from "./commerce-growth.functions.ts?raw";

describe("public email capture server boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.block.content = {};
    mocks.state.publication = { id: mocks.publicationId, paid_product_id: null };
    mocks.state.list = { id: mocks.listId };
    mocks.state.campaign = { id: "00000000-0000-4000-8000-000000000006" };
    mocks.state.accessGrants = [];
    mocks.queries.length = 0;
    mocks.rpc.mockResolvedValue({ data: null, error: null });
  });

  it("routes publication-linked blocks through pending confirmation capture", async () => {
    mocks.state.block.content = {
      newsletterPublicationId: "00000000-0000-4000-8000-000000000003",
    };
    mocks.rpc.mockResolvedValueOnce({ data: { confirmation_required: true }, error: null });
    await expect(
      capturePublicEmailCapture({
        data: {
          blockId: mocks.state.block.id,
          email: "reader@example.com",
        },
      }),
    ).resolves.toEqual({ ok: true, confirmationRequired: true });
    expect(mocks.rpc).toHaveBeenCalledWith("capture_public_newsletter_subscription", {
      p_block_id: mocks.state.block.id,
      p_email: "reader@example.com",
    });
    expect(mocks.createNewsletterConfirmationToken).not.toHaveBeenCalled();
    expect(mocks.enqueueEmail).not.toHaveBeenCalled();
  });

  it("leaves durable confirmation enqueue inside the atomic RPC", () => {
    const captureSource = commerceGrowthSource.slice(
      commerceGrowthSource.indexOf("capturePublicEmailCapture"),
      commerceGrowthSource.indexOf("async function requireGrowthEntitlement"),
    );
    expect(captureSource).not.toContain("enqueueEmail(");
    expect(captureSource).not.toContain("createNewsletterConfirmationToken(");
  });

  it("does not report or enqueue confirmation for an existing subscriber", async () => {
    mocks.state.block.content = {
      newsletterPublicationId: "00000000-0000-4000-8000-000000000003",
    };
    mocks.rpc.mockResolvedValueOnce({ data: { confirmation_required: false }, error: null });
    await expect(
      capturePublicEmailCapture({
        data: { blockId: mocks.state.block.id, email: "reader@example.com" },
      }),
    ).resolves.toEqual({ ok: true, confirmationRequired: false });
    expect(mocks.createNewsletterConfirmationToken).not.toHaveBeenCalled();
    expect(mocks.enqueueEmail).not.toHaveBeenCalled();
  });

  it("maps a rejected Supabase RPC to the stable public message", async () => {
    const internalError = new Error("connection reset while calling capture_public_email_audience");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.rpc.mockRejectedValueOnce(internalError);

    await expect(
      capturePublicEmailCapture({
        data: {
          blockId: "00000000-0000-4000-8000-000000000001",
          email: "reader@example.com",
        },
      }),
    ).rejects.toThrow("Could not subscribe. Please try again.");
    expect(consoleError).toHaveBeenCalledWith("[email-capture] persistence failed", internalError);

    consoleError.mockRestore();
  });

  it("keeps a capacity rejection neutral for the public visitor", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "P0001",
        message:
          "Email marketing contact allowance reached. Upgrade capacity or archive subscribed contacts.",
        details: JSON.stringify({ subscribed: 501, limit: 500 }),
      },
    });

    await expect(
      capturePublicEmailCapture({
        data: {
          blockId: mocks.state.block.id,
          email: "reader@example.com",
        },
      }),
    ).rejects.toThrow("Could not subscribe. Please try again.");
    expect(mocks.recordEmailMarketingCapacityBlock).toHaveBeenCalledWith({
      creatorId: mocks.state.block.user_id,
      source: "public_capture",
      error: expect.objectContaining({ code: "P0001" }),
    });

    consoleError.mockRestore();
  });
});

describe("publication-scoped audience boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.publication = { id: mocks.publicationId, paid_product_id: null };
    mocks.state.list = { id: mocks.listId };
    mocks.state.campaign = { id: "00000000-0000-4000-8000-000000000006" };
    mocks.queries.length = 0;
  });

  it("unsubscribes selected publication subscribers with one atomic batch RPC", async () => {
    mocks.rpc.mockResolvedValue({ data: 1, error: null });

    await expect(
      unsubscribePublicationSubscribers({
        data: {
          publicationId: mocks.publicationId,
          subscribers: [
            {
              subscriptionId: "00000000-0000-4000-8000-000000000007",
              email: "reader@example.com",
            },
          ],
        },
      }),
    ).resolves.toEqual({ unsubscribed: 1 });
    expect(mocks.rpc).toHaveBeenCalledWith("unsubscribe_public_newsletter_subscriptions", {
      p_creator_id: mocks.creatorId,
      p_publication_id: mocks.publicationId,
      p_subscribers: [
        {
          subscription_id: "00000000-0000-4000-8000-000000000007",
          email: "reader@example.com",
        },
      ],
    });
  });

  it("starts audience pages from selected-publication subscriptions", async () => {
    const page = await getPublicationAudience({
      data: {
        publicationId: mocks.publicationId,
        query: "reader",
        status: "subscribed",
        listId: mocks.listId,
      },
    });

    expect(page.subscribers).toEqual([
      expect.objectContaining({
        id: mocks.contactId,
        email: "reader@example.com",
        subscription_status: "subscribed",
        source: "csv_import",
      }),
    ]);
    expect(
      mocks.queries.find((query) => query.table === "newsletter_publications")?.filters,
    ).toEqual(
      expect.arrayContaining([
        ["id", mocks.publicationId],
        ["creator_id", mocks.creatorId],
      ]),
    );
    expect(mocks.queries.find((query) => query.table === "audience_lists")?.filters).toEqual(
      expect.arrayContaining([
        ["id", mocks.listId],
        ["publication_id", mocks.publicationId],
      ]),
    );
    expect(
      mocks.queries.find((query) => query.table === "newsletter_subscriptions")?.filters,
    ).toEqual(
      expect.arrayContaining([
        ["publication_id", mocks.publicationId],
        ["status", "subscribed"],
        ["audience_contacts.audience_list_members.list_id", mocks.listId],
        ["audience_contacts.email", "%reader%"],
      ]),
    );
    const subscriptionsQuery = mocks.queries.find(
      (query) => query.table === "newsletter_subscriptions",
    );
    expect(subscriptionsQuery?.selection).toContain("audience_list_members!inner(list_id)");
    expect(mocks.queries.some((query) => query.table === "audience_list_members")).toBe(false);
    expect(
      subscriptionsQuery?.filters.some(
        ([column, value]) => column === "contact_id" && Array.isArray(value),
      ),
    ).toBe(false);
  });

  it("derives paid access from the selected-publication normalized grant RPC", async () => {
    mocks.state.publication = {
      id: mocks.publicationId,
      paid_product_id: "00000000-0000-4000-8000-000000000099",
    };
    mocks.rpc.mockResolvedValue({ data: [{ contact_id: mocks.contactId }], error: null });
    await expect(
      getPublicationAudience({
        data: { publicationId: mocks.publicationId, query: "", status: "all" },
      }),
    ).resolves.toMatchObject({ subscribers: [expect.objectContaining({ paid_access: true })] });

    expect(mocks.rpc).toHaveBeenCalledWith("get_publication_audience_paid_access", {
      p_creator_id: mocks.creatorId,
      p_publication_id: mocks.publicationId,
      p_contact_ids: [mocks.contactId],
    });
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    await expect(
      getPublicationAudience({
        data: { publicationId: mocks.publicationId, query: "", status: "all" },
      }),
    ).resolves.toMatchObject({ subscribers: [expect.objectContaining({ paid_access: false })] });
  });

  it("filters and orders joined subscriptions before applying the cursor", async () => {
    await getPublicationAudience({
      data: {
        publicationId: mocks.publicationId,
        query: "",
        status: "all",
        joinedFrom: "2026-09-01",
        joinedTo: "2026-09-30",
        sortDirection: "asc",
      },
    });
    expect(mocks.queries.find((query) => query.table === "audience_contacts")?.filters).toEqual(
      expect.arrayContaining([
        ["created_at", "2026-09-01T00:00:00.000Z"],
        ["created_at", "2026-10-01T00:00:00.000Z"],
      ]),
    );
  });

  it("rejects unowned publications before reading memberships", async () => {
    mocks.state.publication = null as never;

    await expect(
      getPublicationAudience({
        data: { publicationId: mocks.publicationId, query: "", status: "all" },
      }),
    ).rejects.toThrow("Publication not found");
    expect(mocks.queries.some((query) => query.table === "newsletter_subscriptions")).toBe(false);
  });

  it("creates lists inside the selected publication", async () => {
    await createAudienceList({
      data: { publicationId: mocks.publicationId, name: "Launch", description: "" },
    });

    expect(
      mocks.queries.find((query) => query.table === "audience_lists" && query.action === "insert"),
    ).toMatchObject({
      value: expect.objectContaining({ publication_id: mocks.publicationId }),
    });
  });

  it("adds only selected-publication subscribers to selected-publication lists", async () => {
    await setAudienceListMember({
      data: {
        publicationId: mocks.publicationId,
        listId: mocks.listId,
        contactId: mocks.contactId,
        included: true,
      },
    });

    expect(mocks.queries.find((query) => query.table === "audience_lists")?.filters).toEqual(
      expect.arrayContaining([["publication_id", mocks.publicationId]]),
    );
    expect(
      mocks.queries.find((query) => query.table === "newsletter_subscriptions")?.filters,
    ).toEqual(
      expect.arrayContaining([
        ["publication_id", mocks.publicationId],
        ["contact_id", mocks.contactId],
      ]),
    );
  });

  it("saves and sends broadcasts only inside their selected publication", async () => {
    const campaign = await saveAudienceCampaign({
      data: {
        publicationId: mocks.publicationId,
        listId: mocks.listId,
        name: "Launch",
        subject: "Hello",
        previewText: "News",
        body: "Body",
        postalAddress: "123 Studio Road",
      },
    });
    await sendAudienceCampaign({
      data: { publicationId: mocks.publicationId, id: campaign.id, scheduledAt: null },
    });

    expect(
      mocks.queries.find(
        (query) => query.table === "audience_campaigns" && query.action === "insert",
      ),
    ).toMatchObject({ value: expect.objectContaining({ publication_id: mocks.publicationId }) });
    expect(
      mocks.queries.find(
        (query) => query.table === "audience_campaigns" && query.action === "select",
      )?.filters,
    ).toEqual(expect.arrayContaining([["publication_id", mocks.publicationId]]));
    expect(mocks.scheduleAudienceCampaignForCreator).toHaveBeenCalledWith({
      creatorId: mocks.creatorId,
      campaignId: campaign.id,
      publicationId: mocks.publicationId,
      kind: "broadcast",
      scheduledAt: null,
    });
  });

  it("schedules newsletter publication only through its owned publication", async () => {
    await scheduleNewsletterIssue({
      data: {
        publicationId: mocks.publicationId,
        id: "00000000-0000-4000-8000-000000000006",
        publish: true,
        scheduledAt: null,
      },
    });

    expect(
      mocks.queries.find((query) => query.table === "newsletter_publications")?.filters,
    ).toEqual(
      expect.arrayContaining([
        ["id", mocks.publicationId],
        ["creator_id", mocks.creatorId],
      ]),
    );
    expect(mocks.scheduleAudienceCampaignForCreator).toHaveBeenCalledWith({
      creatorId: mocks.creatorId,
      campaignId: "00000000-0000-4000-8000-000000000006",
      publicationId: mocks.publicationId,
      kind: "newsletter",
      scheduledAt: null,
      publish: true,
    });
  });
});
