import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const rows: Record<string, unknown> = {
    newsletter_publications: { id: "11111111-1111-4111-8111-111111111111" },
    audience_campaigns: { id: "22222222-2222-4222-8222-222222222222" },
  };
  const queries: Array<{
    table: string;
    action?: string;
    value?: unknown;
    selection?: string;
    filters: unknown[][];
    orders: unknown[][];
  }> = [];
  const responses: Record<string, Array<{ data: unknown; error: unknown }>> = {};

  return {
    rows,
    responses,
    queries,
    rpc: vi.fn(),
    requirePlanEntitlement: vi.fn(),
    recordEmailMarketingCapacityBlock: vi.fn().mockResolvedValue(true),
    verifyNewsletterConfirmationToken: vi.fn(),
    from: vi.fn((table: string) => {
      const state: {
        table: string;
        action?: string;
        value?: unknown;
        selection?: string;
        filters: unknown[][];
        orders: unknown[][];
      } = { table, filters: [], orders: [] };
      queries.push(state);
      const query = {
        upsert: vi.fn((value: unknown) => {
          state.action = "upsert";
          state.value = value;
          return query;
        }),
        insert: vi.fn((value: unknown) => {
          state.action = "insert";
          state.value = value;
          return query;
        }),
        update: vi.fn((value: unknown) => {
          state.action = "update";
          state.value = value;
          return query;
        }),
        delete: vi.fn(() => {
          state.action = "delete";
          return query;
        }),
        eq: vi.fn((...filter: unknown[]) => {
          state.filters.push(filter);
          return query;
        }),
        is: vi.fn((...filter: unknown[]) => {
          state.filters.push(["is", ...filter]);
          return query;
        }),
        neq: vi.fn((...filter: unknown[]) => {
          state.filters.push(["neq", ...filter]);
          return query;
        }),
        in: vi.fn((...filter: unknown[]) => {
          state.filters.push(["in", ...filter]);
          return query;
        }),
        not: vi.fn((...filter: unknown[]) => {
          state.filters.push(["not", ...filter]);
          return query;
        }),
        contains: vi.fn((...filter: unknown[]) => {
          state.filters.push(["contains", ...filter]);
          return query;
        }),
        order: vi.fn((...order: unknown[]) => {
          state.orders.push(order);
          return query;
        }),
        limit: vi.fn(() => query),
        select: vi.fn((selection?: string) => {
          state.selection = selection;
          return query;
        }),
        maybeSingle: vi.fn(
          async () => responses[table]?.shift() ?? { data: rows[table], error: null },
        ),
        single: vi.fn(async () => responses[table]?.shift() ?? { data: rows[table], error: null }),
        then: (
          resolve: (value: { data: unknown; error: unknown }) => unknown,
          reject: (reason: unknown) => unknown,
        ) =>
          Promise.resolve(responses[table]?.shift() ?? { data: rows[table], error: null }).then(
            resolve,
            reject,
          ),
      };
      return query;
    }),
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
        (
          handler: (input: {
            data: never;
            context: { userId: string; supabase: { from: typeof mocks.from } };
          }) => unknown,
        ) =>
        (input?: { data?: unknown }) =>
          handler({
            data: validate(input?.data) as never,
            context: {
              userId: "33333333-3333-4333-8333-333333333333",
              supabase: { from: mocks.from },
            },
          }),
    };
    return builder;
  },
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("./email.server", () => ({
  enqueueEmailBatch: vi.fn(),
  recordEmailMarketingCapacityBlock: mocks.recordEmailMarketingCapacityBlock,
  verifyNewsletterConfirmationToken: mocks.verifyNewsletterConfirmationToken,
}));
vi.mock("./plan.server", () => ({
  getPlan: vi.fn(),
  requirePlanEntitlement: mocks.requirePlanEntitlement,
}));
vi.mock("./payment-connection-policy.server", () => ({
  requireCreatorStorePaymentSetup: vi.fn().mockResolvedValue({
    ready: true,
    selectedProvider: "stripe",
  }),
}));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: vi.fn() }));

import { saveAudienceCampaign } from "./commerce-growth.functions";
import { mutateAudience, type CreatorMcpContext } from "./mcp.creator-ops.server";
import {
  addNewsletterToBento,
  archiveNewsletterPublication,
  confirmNewsletterSubscription,
  createNewsletterPublication,
  deleteNewsletterDraft,
  getMyNewsletterPublication,
  getMyNewsletterPublications,
  getMyNewsletter,
  getPublicNewsletterArchive,
  getPublicNewsletterIssue,
  getPublicNewsletterPublications,
  hasPaidNewsletterAccess,
  removeNewsletterFromBento,
  savePaidNewsletterOffer,
  saveNewsletterIssue,
  saveNewsletterPublication,
  setDefaultNewsletterPublication,
  updateNewsletterPublication,
  validateNewsletterSubscriptionConfirmation,
} from "./newsletter.functions";

describe("newsletter authenticated writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockReset();
    mocks.requirePlanEntitlement.mockReset().mockResolvedValue(undefined);
    mocks.queries.length = 0;
    for (const table of Object.keys(mocks.responses)) delete mocks.responses[table];
    mocks.rows.newsletter_publications = {
      id: "11111111-1111-4111-8111-111111111111",
      postal_address: "123 Studio Road, Bengaluru",
    };
    mocks.rows.audience_campaigns = { id: "22222222-2222-4222-8222-222222222222" };
    mocks.rows.audience_lists = { id: "44444444-4444-4444-8444-444444444444" };
    mocks.rows.profiles = { username: "creator" };
    mocks.rows.commerce_products = null;
    mocks.rows.commerce_access_grants = null;
    mocks.rows.blocks = null;
  });

  it("creates independent Bento signup blocks for selected publications", async () => {
    mocks.responses.newsletter_publications = [
      {
        data: {
          id: "11111111-1111-4111-8111-111111111111",
          title: "Studio Notes",
          slug: "studio-notes",
          description: "Notes from the studio",
          status: "published",
        },
        error: null,
      },
      {
        data: {
          id: "66666666-6666-4666-8666-666666666666",
          title: "Product Notes",
          slug: "product-notes",
          description: "Product updates",
          status: "published",
        },
        error: null,
      },
    ];
    mocks.responses.profiles = [
      { data: { username: "creator" }, error: null },
      { data: { username: "creator" }, error: null },
    ];
    mocks.responses.blocks = [
      { data: [], error: null },
      { data: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, error: null },
      {
        data: [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            type: "email_capture",
            content: {
              newsletterPublicationId: "11111111-1111-4111-8111-111111111111",
            },
            y: 0,
            h: 2,
            position: 0,
          },
        ],
        error: null,
      },
      { data: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, error: null },
    ];

    await addNewsletterToBento({
      data: { publicationId: "11111111-1111-4111-8111-111111111111" },
    });
    await addNewsletterToBento({
      data: { publicationId: "66666666-6666-4666-8666-666666666666" },
    });

    const publicationQueries = mocks.queries.filter(
      (query) => query.table === "newsletter_publications",
    );
    expect(publicationQueries[0].filters).toContainEqual([
      "id",
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(publicationQueries[1].filters).toContainEqual([
      "id",
      "66666666-6666-4666-8666-666666666666",
    ]);
    expect(
      mocks.queries
        .filter((query) => query.table === "blocks" && query.action === "insert")
        .map((query) => query.value),
    ).toEqual([
      expect.objectContaining({
        content: expect.objectContaining({
          newsletterPublicationId: "11111111-1111-4111-8111-111111111111",
          url: "/@creator/newsletters/studio-notes",
        }),
      }),
      expect.objectContaining({
        content: expect.objectContaining({
          newsletterPublicationId: "66666666-6666-4666-8666-666666666666",
          url: "/@creator/newsletters/product-notes",
        }),
      }),
    ]);
  });

  it("updates only the Bento block linked to the selected publication", async () => {
    mocks.rows.newsletter_publications = {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Studio Notes",
      slug: "studio-notes",
      description: "Notes from the studio",
      status: "published",
    };
    mocks.rows.profiles = { username: "creator" };
    mocks.rows.blocks = [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        type: "email_capture",
        content: {
          title: "Custom title",
          newsletterPublicationId: "11111111-1111-4111-8111-111111111111",
        },
        y: 0,
        h: 2,
        position: 0,
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        type: "email_capture",
        content: {
          title: "Other publication",
          newsletterPublicationId: "66666666-6666-4666-8666-666666666666",
        },
        y: 2,
        h: 2,
        position: 1,
      },
    ];

    await addNewsletterToBento({
      data: { publicationId: "11111111-1111-4111-8111-111111111111" },
    });

    expect(
      mocks.queries.filter((query) => query.table === "blocks" && query.action === "update"),
    ).toEqual([
      expect.objectContaining({
        value: {
          content: expect.objectContaining({
            title: "Custom title",
            newsletterPublicationId: "11111111-1111-4111-8111-111111111111",
            url: "/@creator/newsletters/studio-notes",
          }),
        },
        filters: [
          ["id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
          ["user_id", "33333333-3333-4333-8333-333333333333"],
        ],
      }),
    ]);
  });

  it("removes only the selected publication signup block from Bento", async () => {
    mocks.rows.newsletter_publications = {
      id: "11111111-1111-4111-8111-111111111111",
    };
    mocks.rows.blocks = [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        content: { newsletterPublicationId: "11111111-1111-4111-8111-111111111111" },
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        content: { newsletterPublicationId: "66666666-6666-4666-8666-666666666666" },
      },
    ];

    await removeNewsletterFromBento({
      data: { publicationId: "11111111-1111-4111-8111-111111111111" },
    });

    expect(
      mocks.queries.find((query) => query.table === "blocks" && query.action === "delete"),
    ).toMatchObject({
      filters: expect.arrayContaining([
        ["user_id", "33333333-3333-4333-8333-333333333333"],
        ["in", "id", ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]],
      ]),
    });
  });

  it("loads plural publications by owned slug and singular routes by default", async () => {
    const queuePublicRows = () => {
      mocks.responses.profiles = [
        {
          data: {
            id: "33333333-3333-4333-8333-333333333333",
            username: "creator",
          },
          error: null,
        },
        {
          data: {
            id: "33333333-3333-4333-8333-333333333333",
            username: "creator",
            display_name: "Creator",
            accent_color: null,
            noindex: false,
            onboarded: true,
          },
          error: null,
        },
      ];
      mocks.rows.newsletter_publications = {
        id: "11111111-1111-4111-8111-111111111111",
        creator_id: "33333333-3333-4333-8333-333333333333",
        title: "Studio Notes",
        slug: "studio-notes",
        description: "Notes",
        accent_color: null,
        postal_address: "123 Studio Road, Bengaluru",
        status: "published",
        paid_product_id: null,
        is_default: true,
      };
      mocks.rows.audience_campaigns = [];
      mocks.rows.commerce_products = [];
      mocks.rows.blocks = null;
    };

    queuePublicRows();
    await getPublicNewsletterArchive({
      data: { username: "creator", publicationSlug: "studio-notes" },
    });
    expect(
      mocks.queries.find((query) => query.table === "newsletter_publications")?.filters,
    ).toContainEqual(["slug", "studio-notes"]);

    mocks.queries.length = 0;
    queuePublicRows();
    await getPublicNewsletterArchive({ data: { username: "creator" } });
    expect(
      mocks.queries.find((query) => query.table === "newsletter_publications")?.filters,
    ).toContainEqual(["is_default", true]);
  });

  it("loads every published publication with the creator's Bento theme", async () => {
    mocks.responses.profiles = [
      {
        data: { id: "33333333-3333-4333-8333-333333333333", username: "creator" },
        error: null,
      },
      {
        data: {
          id: "33333333-3333-4333-8333-333333333333",
          username: "creator",
          display_name: "Creator",
          theme: "dark",
          accent_color: "#3478f6",
          primary_font: "Inter",
          secondary_font: "Instrument Serif",
          pattern: "dots",
          pattern_settings: { intensity: 40 },
        },
        error: null,
      },
    ];
    mocks.rows.newsletter_publications = [
      {
        title: "Studio Notes",
        slug: "studio-notes",
        description: "Studio dispatches",
        logo_url: "https://cdn.example.com/studio.png",
        accent_color: "#3478f6",
      },
      {
        title: "Product Notes",
        slug: "product-notes",
        description: "Product updates",
        logo_url: null,
        accent_color: null,
      },
    ];

    await expect(
      getPublicNewsletterPublications({ data: { username: "creator" } }),
    ).resolves.toMatchObject({
      creator: { username: "creator", theme: "dark", pattern: "dots" },
      publications: [
        { title: "Studio Notes", slug: "studio-notes" },
        { title: "Product Notes", slug: "product-notes" },
      ],
    });
    expect(
      mocks.queries.find(
        (query) => query.table === "profiles" && query.selection?.includes("theme"),
      )?.selection,
    ).toContain("theme");
  });

  it("loads persisted template identity through the public post database projection", async () => {
    mocks.responses.profiles = [
      {
        data: {
          id: "33333333-3333-4333-8333-333333333333",
          username: "creator",
        },
        error: null,
      },
      {
        data: {
          id: "33333333-3333-4333-8333-333333333333",
          username: "creator",
          display_name: "Creator",
          accent_color: null,
          noindex: false,
          onboarded: true,
        },
        error: null,
      },
    ];
    mocks.rows.newsletter_publications = {
      id: "11111111-1111-4111-8111-111111111111",
      creator_id: "33333333-3333-4333-8333-333333333333",
      title: "Studio Notes",
      slug: "studio-notes",
      description: "Notes",
      accent_color: null,
      postal_address: "123 Studio Road, Bengaluru",
      status: "published",
      paid_product_id: null,
      is_default: true,
    };
    mocks.rows.audience_campaigns = [
      {
        subject: "Launch day",
        preview_text: "We are live",
        public_slug: "launch-day",
        web_visibility: "public",
        status: "published",
        published_at: "2026-09-02T00:00:00.000Z",
        template_id: "bold-digest",
        content: [{ id: "body", type: "paragraph", text: "Launch body" }],
      },
    ];
    mocks.rows.commerce_products = [];
    mocks.rows.blocks = null;

    const result = await getPublicNewsletterIssue({
      data: {
        username: "creator",
        publicationSlug: "studio-notes",
        issueSlug: "launch-day",
      },
    });

    expect(
      mocks.queries.find((query) => query.table === "audience_campaigns")?.selection,
    ).toContain("template_id");
    expect(result?.issue).toMatchObject({ templateId: "bold-digest" });
  });

  it("lists publication summaries with subscribed-contact counts", async () => {
    mocks.rows.newsletter_publications = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Studio Notes",
        slug: "studio-notes",
        logo_url: "https://cdn.example.com/logo.png",
        status: "published",
        is_default: true,
      },
      {
        id: "66666666-6666-4666-8666-666666666666",
        title: "Product Notes",
        slug: "product-notes",
        logo_url: null,
        status: "draft",
        is_default: false,
      },
    ];
    mocks.rows.newsletter_subscriptions = [
      { publication_id: "11111111-1111-4111-8111-111111111111" },
      { publication_id: "11111111-1111-4111-8111-111111111111" },
      { publication_id: "66666666-6666-4666-8666-666666666666" },
    ];

    await expect(getMyNewsletterPublications()).resolves.toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Studio Notes",
        slug: "studio-notes",
        logoUrl: "https://cdn.example.com/logo.png",
        status: "published",
        isDefault: true,
        subscriberCount: 2,
      },
      {
        id: "66666666-6666-4666-8666-666666666666",
        title: "Product Notes",
        slug: "product-notes",
        logoUrl: null,
        status: "draft",
        isDefault: false,
        subscriberCount: 1,
      },
    ]);
    expect(mocks.queries[0]).toMatchObject({
      table: "newsletter_publications",
      filters: [
        ["creator_id", "33333333-3333-4333-8333-333333333333"],
        ["neq", "status", "archived"],
      ],
    });
  });

  it("builds the owned Website preview through the public archive contract", async () => {
    mocks.responses.newsletter_publications = [
      {
        data: {
          id: "11111111-1111-4111-8111-111111111111",
          creator_id: "33333333-3333-4333-8333-333333333333",
          title: "Studio Notes",
          slug: "studio-notes",
          description: "Notes from the studio",
          accent_color: "#3478f6",
          postal_address: "123 Studio Road, Bengaluru",
          status: "published",
          paid_product_id: null,
        },
        error: null,
      },
    ];
    mocks.rows.audience_campaigns = [
      {
        id: "22222222-2222-4222-8222-222222222222",
        publication_id: "11111111-1111-4111-8111-111111111111",
        subject: "Created later, published earlier",
        preview_text: "The older live archive entry",
        public_slug: "published-earlier",
        web_visibility: "public",
        status: "published",
        published_at: "2026-09-02T00:00:00.000Z",
        created_at: "2026-09-03T00:00:00.000Z",
      },
      {
        id: "77777777-7777-4777-8777-777777777777",
        publication_id: "11111111-1111-4111-8111-111111111111",
        subject: "Created earlier, published later",
        preview_text: "The newest live archive entry",
        public_slug: "published-later",
        web_visibility: "public",
        status: "published",
        published_at: "2026-09-04T00:00:00.000Z",
        created_at: "2026-09-01T00:00:00.000Z",
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        publication_id: "11111111-1111-4111-8111-111111111111",
        subject: "Missing date",
        preview_text: "Not a production page",
        public_slug: "missing-date",
        web_visibility: "public",
        status: "published",
        published_at: null,
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        publication_id: "11111111-1111-4111-8111-111111111111",
        subject: "Unfunded paid page",
        preview_text: "No valid paid product",
        public_slug: "unfunded-paid-page",
        web_visibility: "paid",
        status: "published",
        published_at: "2026-09-01T00:00:00.000Z",
      },
    ];
    mocks.rows.profiles = {
      id: "33333333-3333-4333-8333-333333333333",
      username: "creator",
      display_name: "Creator Display",
      accent_color: "#112233",
      noindex: false,
      onboarded: true,
    };
    mocks.rows.blocks = {
      id: "66666666-6666-4666-8666-666666666666",
      content: { title: "Join the real publication" },
    };

    await expect(
      getMyNewsletterPublication({
        data: { publicationId: "11111111-1111-4111-8111-111111111111" },
      }),
    ).resolves.toMatchObject({
      publication: { id: "11111111-1111-4111-8111-111111111111" },
      websiteArchive: {
        creator: { username: "creator", displayName: "Creator Display" },
        paidProduct: null,
        signupBlock: {
          id: "66666666-6666-4666-8666-666666666666",
          content: {
            title: "Join the real publication",
            subtitle: "Notes from the studio",
            buttonLabel: "Subscribe",
          },
        },
        issues: [
          {
            slug: "published-later",
            subject: "Created earlier, published later",
            visibility: "public",
          },
          {
            slug: "published-earlier",
            subject: "Created later, published earlier",
            visibility: "public",
          },
        ],
      },
    });
    expect(mocks.queries.find((query) => query.table === "newsletter_publications")).toMatchObject({
      filters: [
        ["id", "11111111-1111-4111-8111-111111111111"],
        ["creator_id", "33333333-3333-4333-8333-333333333333"],
      ],
    });
    expect(mocks.queries.find((query) => query.table === "audience_campaigns")).toMatchObject({
      filters: [
        ["creator_id", "33333333-3333-4333-8333-333333333333"],
        ["publication_id", "11111111-1111-4111-8111-111111111111"],
        ["kind", "newsletter"],
      ],
    });
    expect(mocks.queries.find((query) => query.table === "blocks")).toMatchObject({
      filters: [
        ["user_id", "33333333-3333-4333-8333-333333333333"],
        ["type", "email_capture"],
        [
          "contains",
          "content",
          {
            newsletterPublicationId: "11111111-1111-4111-8111-111111111111",
          },
        ],
      ],
    });
  });

  it("creates a publication with a server-resolved slug using an insert", async () => {
    mocks.responses.newsletter_publications = [
      { data: [{ slug: "studio-notes" }], error: null },
      {
        data: {
          id: "66666666-6666-4666-8666-666666666666",
          slug: "studio-notes-2",
          is_default: false,
        },
        error: null,
      },
    ];

    await createNewsletterPublication({
      data: {
        title: "Studio Notes",
        description: "A second publication",
        senderName: "Ari",
        replyToEmail: null,
        postalAddress: "123 Studio Road, Bengaluru",
        accentColor: null,
        logoUrl: null,
        defaultTemplateId: "editorial",
        status: "draft",
      },
    });

    expect(mocks.queries.at(-1)).toMatchObject({
      table: "newsletter_publications",
      action: "insert",
      value: expect.objectContaining({
        creator_id: "33333333-3333-4333-8333-333333333333",
        slug: "studio-notes-2",
        is_default: false,
      }),
    });
  });

  it("makes the creator's first publication the default in its insert", async () => {
    mocks.responses.newsletter_publications = [
      { data: [], error: null },
      {
        data: {
          id: "11111111-1111-4111-8111-111111111111",
          slug: "studio-notes",
          is_default: true,
        },
        error: null,
      },
    ];

    await createNewsletterPublication({
      data: {
        title: "Studio Notes",
        description: "The first publication",
        senderName: "Ari",
        postalAddress: "123 Studio Road, Bengaluru",
      },
    });

    expect(mocks.queries.at(-1)).toMatchObject({
      action: "insert",
      value: expect.objectContaining({ is_default: true }),
    });
  });

  it("retries a concurrent first-publication default conflict as non-default", async () => {
    mocks.responses.newsletter_publications = [
      { data: [], error: null },
      {
        data: null,
        error: {
          code: "23505",
          message: "newsletter_publications_one_default_per_creator",
        },
      },
      {
        data: {
          id: "66666666-6666-4666-8666-666666666666",
          slug: "studio-notes",
          is_default: false,
        },
        error: null,
      },
    ];

    await expect(
      createNewsletterPublication({
        data: {
          title: "Studio Notes",
          description: "A concurrently created publication",
          senderName: "Ari",
          postalAddress: "123 Studio Road, Bengaluru",
        },
      }),
    ).resolves.toMatchObject({ is_default: false });
    expect(mocks.queries.at(-1)).toMatchObject({
      action: "insert",
      value: expect.objectContaining({ is_default: false }),
    });
  });

  it("recomputes the slug after a creator-slug constraint conflict", async () => {
    mocks.responses.newsletter_publications = [
      { data: [{ slug: "weekly" }], error: null },
      {
        data: null,
        error: {
          code: "23505",
          message: "duplicate key value violates unique constraint",
          details: "newsletter_publications_creator_slug_unique",
        },
      },
      { data: [{ slug: "weekly" }, { slug: "studio-notes" }], error: null },
      {
        data: {
          id: "66666666-6666-4666-8666-666666666666",
          slug: "studio-notes-2",
          is_default: false,
        },
        error: null,
      },
    ];

    await expect(
      createNewsletterPublication({
        data: {
          title: "Studio Notes",
          description: "A concurrent duplicate title",
          senderName: "Ari",
          postalAddress: "123 Studio Road, Bengaluru",
        },
      }),
    ).resolves.toMatchObject({ slug: "studio-notes-2" });
    expect(mocks.queries.at(-1)).toMatchObject({
      action: "insert",
      value: expect.objectContaining({ slug: "studio-notes-2", is_default: false }),
    });
  });

  it("updates only the selected creator-owned publication", async () => {
    await updateNewsletterPublication({
      data: {
        publicationId: "11111111-1111-4111-8111-111111111111",
        title: "Studio Notes",
        description: "Updated",
        senderName: "Ari",
        replyToEmail: null,
        postalAddress: "123 Studio Road, Bengaluru",
        accentColor: null,
        logoUrl: null,
        defaultTemplateId: "minimal",
        status: "draft",
      },
    });

    expect(mocks.queries.at(-1)).toMatchObject({
      table: "newsletter_publications",
      action: "update",
      filters: [
        ["id", "11111111-1111-4111-8111-111111111111"],
        ["creator_id", "33333333-3333-4333-8333-333333333333"],
      ],
    });
  });

  it("switches the default through the owned-active transactional RPC", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { id: "11111111-1111-4111-8111-111111111111", is_default: true },
      error: null,
    });

    await expect(
      setDefaultNewsletterPublication({
        data: { publicationId: "11111111-1111-4111-8111-111111111111" },
      }),
    ).resolves.toMatchObject({ is_default: true });
    expect(mocks.rpc).toHaveBeenCalledWith("set_default_newsletter_publication", {
      p_creator_id: "33333333-3333-4333-8333-333333333333",
      p_publication_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("archives through the owned-active transactional RPC", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { id: "11111111-1111-4111-8111-111111111111", status: "archived" },
      error: null,
    });

    await expect(
      archiveNewsletterPublication({
        data: {
          publicationId: "11111111-1111-4111-8111-111111111111",
          confirmation: "Studio Notes",
        },
      }),
    ).resolves.toMatchObject({ status: "archived" });
    expect(mocks.rpc).toHaveBeenCalledWith("archive_newsletter_publication", {
      p_creator_id: "33333333-3333-4333-8333-333333333333",
      p_publication_id: "11111111-1111-4111-8111-111111111111",
      p_confirmation: "Studio Notes",
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("surfaces transactional archive rejection", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "Choose another default publication before archiving this one." },
    });

    await expect(
      archiveNewsletterPublication({
        data: {
          publicationId: "11111111-1111-4111-8111-111111111111",
          confirmation: "Studio Notes",
        },
      }),
    ).rejects.toThrow("Choose another default publication");
  });

  it("rejects a free-plan publication save before touching newsletter storage", async () => {
    mocks.requirePlanEntitlement.mockRejectedValueOnce(
      new Error("Upgrade to use Email Marketing."),
    );

    await expect(
      saveNewsletterPublication({
        data: {
          title: "Studio Notes",
          description: "Weekly notes",
          senderName: "Ari",
          replyToEmail: "ari@example.com",
          postalAddress: "123 Studio Road, Bengaluru",
          status: "draft",
        },
      }),
    ).rejects.toThrow("Upgrade to use Email Marketing.");
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("rejects a free-plan issue save before touching newsletter storage", async () => {
    mocks.requirePlanEntitlement.mockRejectedValueOnce(
      new Error("Upgrade to use Email Marketing."),
    );

    expect(() =>
      saveNewsletterIssue({
        data: {
          publicationId: "11111111-1111-4111-8111-111111111111",
          name: "Launch issue",
          subject: "We are live",
          content: [{ id: "1", type: "paragraph", text: "Launch." }],
          webVisibility: "private",
        },
      }),
    ).rejects.toThrow("Upgrade to use Email Marketing.");
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("deletes only a creator-owned draft in the selected publication", async () => {
    await expect(
      deleteNewsletterDraft({
        data: {
          id: "22222222-2222-4222-8222-222222222222",
          publicationId: "11111111-1111-4111-8111-111111111111",
        },
      }),
    ).resolves.toEqual({ id: "22222222-2222-4222-8222-222222222222" });

    expect(mocks.queries.at(-1)).toMatchObject({
      table: "audience_campaigns",
      action: "delete",
      filters: [
        ["id", "22222222-2222-4222-8222-222222222222"],
        ["publication_id", "11111111-1111-4111-8111-111111111111"],
        ["creator_id", "33333333-3333-4333-8333-333333333333"],
        ["kind", "newsletter"],
        ["status", "draft"],
      ],
    });
  });

  it("creates a creator-owned recurring newsletter offer and links it after validation", async () => {
    mocks.rows.newsletter_publications = {
      id: "11111111-1111-4111-8111-111111111111",
      creator_id: "33333333-3333-4333-8333-333333333333",
      title: "Studio Notes",
      slug: "studio-notes",
      description: "Notes from the studio",
      paid_product_id: null,
    };
    mocks.rows.commerce_products = {
      id: "55555555-5555-4555-8555-555555555555",
      creator_id: "33333333-3333-4333-8333-333333333333",
      kind: "newsletter",
      status: "published",
    };

    await savePaidNewsletterOffer({
      data: {
        publicationId: "11111111-1111-4111-8111-111111111111",
        priceAmount: 900,
        currency: "usd",
        billingInterval: "month",
      },
    });

    expect(mocks.queries).toContainEqual(
      expect.objectContaining({
        table: "commerce_products",
        action: "insert",
        value: expect.objectContaining({
          creator_id: "33333333-3333-4333-8333-333333333333",
          kind: "newsletter",
          pricing_type: "subscription",
          price_amount: 900,
          billing_interval: "month",
          settings: {
            newsletterPublicationId: "11111111-1111-4111-8111-111111111111",
          },
        }),
      }),
    );
    expect(mocks.queries).toContainEqual(
      expect.objectContaining({
        table: "newsletter_publications",
        action: "update",
        value: { paid_product_id: "55555555-5555-4555-8555-555555555555" },
      }),
    );
  });

  it("rejects a paid offer for a publication the creator does not own", async () => {
    mocks.rows.newsletter_publications = null;

    await expect(
      savePaidNewsletterOffer({
        data: {
          publicationId: "11111111-1111-4111-8111-111111111111",
          priceAmount: 900,
          currency: "usd",
          billingInterval: "month",
        },
      }),
    ).rejects.toThrow("Newsletter publication not found.");
    expect(mocks.queries.some((query) => query.table === "commerce_products")).toBe(false);
  });

  it("derives paid eligibility only from active unexpired commerce grants", async () => {
    mocks.rows.newsletter_publications = {
      id: "11111111-1111-4111-8111-111111111111",
      paid_product_id: "55555555-5555-4555-8555-555555555555",
    };
    mocks.rows.commerce_access_grants = {
      status: "active",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    await expect(
      hasPaidNewsletterAccess({
        publicationId: "11111111-1111-4111-8111-111111111111",
        email: " Reader@Example.com ",
      }),
    ).resolves.toBe(true);
    expect(mocks.queries.at(-1)?.filters).toContainEqual(["buyer_email", "reader@example.com"]);
    expect(mocks.queries.at(-1)?.filters).toContainEqual(["status", "active"]);

    mocks.rows.commerce_access_grants = {
      status: "active",
      expires_at: "2020-01-01T00:00:00.000Z",
    };
    await expect(
      hasPaidNewsletterAccess({
        publicationId: "11111111-1111-4111-8111-111111111111",
        email: "reader@example.com",
      }),
    ).resolves.toBe(false);

    mocks.rows.commerce_access_grants = { status: "revoked", expires_at: null };
    await expect(
      hasPaidNewsletterAccess({
        publicationId: "11111111-1111-4111-8111-111111111111",
        email: "reader@example.com",
      }),
    ).resolves.toBe(false);
  });

  it("returns an empty compatibility payload when the creator has no publication", async () => {
    mocks.rows.newsletter_publications = [];

    await expect(getMyNewsletter()).resolves.toEqual({
      publication: null,
      posts: [],
      products: [],
      creatorUsername: null,
      websiteArchive: null,
    });
    expect(mocks.queries.find((query) => query.table === "newsletter_publications")).toMatchObject({
      filters: [
        ["creator_id", "33333333-3333-4333-8333-333333333333"],
        ["neq", "status", "archived"],
      ],
    });
    expect(mocks.queries.some((query) => query.table === "audience_campaigns")).toBe(false);
  });

  it("confirms the immutable publication/subscription token scope", async () => {
    mocks.verifyNewsletterConfirmationToken.mockResolvedValueOnce({
      publicationId: "11111111-1111-4111-8111-111111111111",
      subscriptionId: "22222222-2222-4222-8222-222222222222",
      confirmationNonce: "44444444-4444-4444-8444-444444444444",
      email: "reader@example.com",
    });
    mocks.rpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(
      confirmNewsletterSubscription({ data: { token: "signed.token" } }),
    ).resolves.toEqual({ confirmed: true });
    expect(mocks.rpc).toHaveBeenCalledWith("confirm_public_newsletter_subscription", {
      p_publication_id: "11111111-1111-4111-8111-111111111111",
      p_subscription_id: "22222222-2222-4222-8222-222222222222",
      p_confirmation_nonce: "44444444-4444-4444-8444-444444444444",
      p_email: "reader@example.com",
    });
  });

  it("records a capacity block while keeping confirmation neutral", async () => {
    mocks.verifyNewsletterConfirmationToken.mockResolvedValueOnce({
      publicationId: "11111111-1111-4111-8111-111111111111",
      subscriptionId: "22222222-2222-4222-8222-222222222222",
      confirmationNonce: "44444444-4444-4444-8444-444444444444",
      email: "reader@example.com",
    });
    const error = {
      code: "P0001",
      message:
        "Email marketing contact allowance reached. Upgrade capacity or archive subscribed contacts.",
      details: JSON.stringify({
        creator_id: "33333333-3333-4333-8333-333333333333",
        subscribed: 501,
        limit: 500,
      }),
    };
    mocks.rpc.mockResolvedValueOnce({ data: null, error });

    await expect(
      confirmNewsletterSubscription({ data: { token: "signed.token" } }),
    ).resolves.toEqual({ confirmed: false });
    expect(mocks.recordEmailMarketingCapacityBlock).toHaveBeenCalledWith({
      source: "newsletter_confirmation",
      error,
    });
  });

  it("validates a confirmation GET without consuming the nonce", async () => {
    mocks.verifyNewsletterConfirmationToken.mockResolvedValueOnce({
      publicationId: "11111111-1111-4111-8111-111111111111",
      subscriptionId: "22222222-2222-4222-8222-222222222222",
      confirmationNonce: "44444444-4444-4444-8444-444444444444",
      email: "reader@example.com",
    });

    await expect(
      validateNewsletterSubscriptionConfirmation({ data: { token: "signed.token" } }),
    ).resolves.toEqual({ valid: true });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("derives publication ownership and slug from the authenticated creator", async () => {
    await saveNewsletterPublication({
      data: {
        title: "Bento Dispatch",
        description: "Product notes",
        senderName: "Bento",
        replyToEmail: "hello@bento.surf",
        postalAddress: "Bengaluru, India",
        accentColor: "#ff6600",
        status: "published",
      },
    });

    expect(
      mocks.queries.find(
        (query) => query.table === "newsletter_publications" && query.action === "insert",
      ),
    ).toMatchObject({
      table: "newsletter_publications",
      action: "insert",
      value: expect.objectContaining({
        creator_id: "33333333-3333-4333-8333-333333333333",
        title: "Bento Dispatch",
        slug: "bento-dispatch",
        is_default: true,
      }),
    });
  });

  it("updates the oldest active publication when the legacy save has no default", async () => {
    mocks.responses.newsletter_publications = [
      {
        data: [
          {
            id: "66666666-6666-4666-8666-666666666666",
            is_default: false,
          },
        ],
        error: null,
      },
      {
        data: { id: "66666666-6666-4666-8666-666666666666" },
        error: null,
      },
    ];

    await saveNewsletterPublication({
      data: {
        title: "Recovered Notes",
        description: "Updated fallback",
        senderName: "Bento",
        postalAddress: "Bengaluru, India",
        status: "draft",
      },
    });

    expect(mocks.queries[0]).toMatchObject({
      filters: [
        ["creator_id", "33333333-3333-4333-8333-333333333333"],
        ["neq", "status", "archived"],
      ],
      orders: [
        ["is_default", { ascending: false }],
        ["created_at", { ascending: true }],
      ],
    });
    expect(mocks.queries.at(-1)).toMatchObject({
      action: "update",
      filters: [
        ["id", "66666666-6666-4666-8666-666666666666"],
        ["creator_id", "33333333-3333-4333-8333-333333333333"],
      ],
    });
  });

  it("rejects a punctuation-only legacy title before a database write", async () => {
    await expect(
      saveNewsletterPublication({
        data: {
          title: "!!!",
          description: "Invalid title",
          senderName: "Bento",
          postalAddress: "Bengaluru, India",
          status: "draft",
        },
      }),
    ).rejects.toThrow("letter or number");
    expect(mocks.queries.every((query) => !query.action)).toBe(true);
  });

  it("stores structured newsletter content and its plain-text fallback", async () => {
    await saveNewsletterIssue({
      data: {
        publicationId: "11111111-1111-4111-8111-111111111111",
        listId: null,
        name: "Launch issue",
        subject: "We are live",
        previewText: "The first issue",
        publicSlug: "launch-issue",
        webVisibility: "public",
        content: [
          { id: "1", type: "heading", text: "Launch" },
          { id: "2", type: "paragraph", text: "We are live." },
        ],
      },
    });

    expect(
      mocks.queries.find(
        (query) => query.table === "audience_campaigns" && query.action === "insert",
      ),
    ).toMatchObject({
      table: "audience_campaigns",
      action: "insert",
      value: {
        creator_id: "33333333-3333-4333-8333-333333333333",
        kind: "newsletter",
        publication_id: "11111111-1111-4111-8111-111111111111",
        body_markdown: "Launch\n\nWe are live.",
        sender_postal_address: "123 Studio Road, Bengaluru",
      },
    });
  });

  it("persists an explicit post template and falls back to the publication default", async () => {
    mocks.rows.newsletter_publications = {
      id: "11111111-1111-4111-8111-111111111111",
      postal_address: "123 Studio Road, Bengaluru",
      default_template_id: "weekly-roundup",
    };

    await saveNewsletterIssue({
      data: {
        publicationId: "11111111-1111-4111-8111-111111111111",
        name: "Default styled post",
        subject: "Weekly notes",
        content: [{ id: "1", type: "paragraph", text: "Hello." }],
        webVisibility: "private",
      },
    });
    expect(
      mocks.queries.find(
        (query) => query.table === "audience_campaigns" && query.action === "insert",
      )?.value,
    ).toMatchObject({ template_id: "weekly-roundup" });

    await saveNewsletterIssue({
      data: {
        publicationId: "11111111-1111-4111-8111-111111111111",
        templateId: "personal-note",
        name: "Personal post",
        subject: "A note",
        content: [{ id: "2", type: "paragraph", text: "Hello again." }],
        webVisibility: "private",
      },
    });
    expect(mocks.queries.at(-1)?.value).toMatchObject({ template_id: "personal-note" });
  });

  it("uses Posts terminology in validation errors", () => {
    expect(() =>
      saveNewsletterIssue({
        data: {
          publicationId: "11111111-1111-4111-8111-111111111111",
          name: "Public post",
          subject: "Public post",
          content: [{ id: "1", type: "paragraph", text: "Hello." }],
          webVisibility: "public",
        },
      }),
    ).toThrow("Public newsletter posts require a slug.");
  });

  it("publishes an issue without sending it", async () => {
    await saveNewsletterIssue({
      data: {
        publicationId: "11111111-1111-4111-8111-111111111111",
        name: "Launch issue",
        subject: "We are live",
        content: [{ id: "1", type: "paragraph", text: "Launch." }],
        webVisibility: "private",
        status: "published",
      },
    });

    expect(
      mocks.queries.find(
        (query) => query.table === "audience_campaigns" && query.action === "insert",
      ),
    ).toMatchObject({
      table: "audience_campaigns",
      action: "insert",
      value: {
        status: "published",
        published_at: expect.any(String),
        scheduled_at: null,
        sent_at: null,
      },
    });
  });

  it("edits only a creator-owned draft issue", async () => {
    await saveNewsletterIssue({
      data: {
        id: "22222222-2222-4222-8222-222222222222",
        publicationId: "11111111-1111-4111-8111-111111111111",
        name: "Launch issue",
        subject: "We are live",
        content: [{ id: "1", type: "paragraph", text: "Updated." }],
        webVisibility: "private",
      },
    });

    expect(
      mocks.queries.find(
        (query) => query.table === "audience_campaigns" && query.action === "update",
      )?.filters,
    ).toEqual([
      ["id", "22222222-2222-4222-8222-222222222222"],
      ["creator_id", "33333333-3333-4333-8333-333333333333"],
      ["status", "draft"],
      ["kind", "newsletter"],
    ]);
  });

  it("rejects a cross-creator audience list before saving an issue", async () => {
    mocks.rows.audience_lists = null;

    await expect(
      saveNewsletterIssue({
        data: {
          publicationId: "11111111-1111-4111-8111-111111111111",
          listId: "44444444-4444-4444-8444-444444444444",
          name: "Launch issue",
          subject: "We are live",
          content: [{ id: "1", type: "paragraph", text: "Launch." }],
          webVisibility: "private",
        },
      }),
    ).rejects.toThrow("Audience list not found.");
    expect(mocks.queries.find((query) => query.table === "audience_lists")).toMatchObject({
      filters: [
        ["id", "44444444-4444-4444-8444-444444444444"],
        ["creator_id", "33333333-3333-4333-8333-333333333333"],
      ],
    });
  });

  it("keeps browser broadcast edits scoped to broadcast drafts", async () => {
    await saveAudienceCampaign({
      data: {
        publicationId: "11111111-1111-4111-8111-111111111111",
        id: "22222222-2222-4222-8222-222222222222",
        listId: null,
        name: "Broadcast",
        subject: "Hello",
        previewText: "News",
        content: [{ id: "body", type: "paragraph", text: "Body" }],
        postalAddress: "123 Studio Road, Bengaluru",
      },
    });

    expect(
      mocks.queries.find(
        (query) => query.table === "audience_campaigns" && query.action === "update",
      ),
    ).toMatchObject({
      table: "audience_campaigns",
      value: expect.objectContaining({
        kind: "broadcast",
        publication_id: "11111111-1111-4111-8111-111111111111",
        body_markdown: "Body",
        content: [{ id: "body", type: "paragraph", text: "Body" }],
        sender_postal_address: "123 Studio Road, Bengaluru",
      }),
      filters: expect.arrayContaining([
        ["id", "22222222-2222-4222-8222-222222222222"],
        ["creator_id", "33333333-3333-4333-8333-333333333333"],
        ["status", "draft"],
        ["kind", "broadcast"],
        ["publication_id", "11111111-1111-4111-8111-111111111111"],
      ]),
    });
  });

  it("keeps MCP broadcast edits scoped to broadcast drafts", async () => {
    await mutateAudience(
      {
        userId: "33333333-3333-4333-8333-333333333333",
        supabase: {} as CreatorMcpContext["supabase"],
      },
      {
        action: "save_campaign",
        publicationId: "11111111-1111-4111-8111-111111111111",
        id: "22222222-2222-4222-8222-222222222222",
        listId: null,
        name: "Broadcast",
        subject: "Hello",
        previewText: "News",
        body: "Body",
      },
    );

    expect(
      mocks.queries.find(
        (query) => query.table === "audience_campaigns" && query.action === "update",
      ),
    ).toMatchObject({
      table: "audience_campaigns",
      value: { kind: "broadcast" },
      filters: expect.arrayContaining([
        ["id", "22222222-2222-4222-8222-222222222222"],
        ["creator_id", "33333333-3333-4333-8333-333333333333"],
        ["publication_id", "11111111-1111-4111-8111-111111111111"],
        ["status", "draft"],
        ["kind", "broadcast"],
      ]),
    });
  });

  it("rejects a public issue without a public slug before writing", () => {
    expect(() =>
      saveNewsletterIssue({
        data: {
          publicationId: "11111111-1111-4111-8111-111111111111",
          name: "Launch issue",
          subject: "We are live",
          content: [{ id: "1", type: "paragraph", text: "Launch." }],
          webVisibility: "public",
        },
      }),
    ).toThrow();
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
