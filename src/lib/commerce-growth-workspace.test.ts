import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const membershipRows = Array.from({ length: 1_001 }, (_, index) => ({
    list_id: "11111111-1111-4111-8111-111111111111",
    contact_id: `contact-${index}`,
    audience_lists: { creator_id: "22222222-2222-4222-8222-222222222222" },
  }));
  const subscriptionRows = [
    {
      id: "33333333-3333-4333-8333-333333333333",
      contact_id: "contact-1",
      status: "pending",
      email_enabled: true,
      newsletter_publications: {
        title: "Studio Notes",
        creator_id: "22222222-2222-4222-8222-222222222222",
      },
    },
  ];
  const audienceRows = [
    {
      id: "33333333-3333-4333-8333-333333333333",
      creator_id: "22222222-2222-4222-8222-222222222222",
      email: "reader@example.com",
      name: "Reader",
      marketing_status: "subscribed",
      last_seen_at: "2026-09-01T00:00:00.000Z",
    },
    {
      id: "55555555-5555-4555-8555-555555555555",
      creator_id: "22222222-2222-4222-8222-222222222222",
      email: "reader-too-new@example.com",
      name: "Reader too new",
      marketing_status: "subscribed",
      last_seen_at: "2026-09-01T00:00:00.000Z",
    },
    ...Array.from({ length: 55 }, (_, index) => ({
      id: `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`,
      creator_id: "22222222-2222-4222-8222-222222222222",
      email: `reader-${index}@example.com`,
      name: `Reader ${index}`,
      marketing_status: "subscribed",
      last_seen_at: "2026-08-31T00:00:00.000Z",
    })),
    {
      id: "66666666-6666-4666-8666-666666666666",
      creator_id: "99999999-9999-4999-8999-999999999999",
      email: "reader-foreign@example.com",
      name: "Foreign reader",
      marketing_status: "subscribed",
      last_seen_at: "2026-08-31T00:00:00.000Z",
    },
    {
      id: "77777777-7777-4777-8777-777777777777",
      creator_id: "22222222-2222-4222-8222-222222222222",
      email: "reader-unsubscribed@example.com",
      name: "Unsubscribed reader",
      marketing_status: "unsubscribed",
      last_seen_at: "2026-08-31T00:00:00.000Z",
    },
    {
      id: "88888888-8888-4888-8888-888888888888",
      creator_id: "22222222-2222-4222-8222-222222222222",
      email: "audience@example.com",
      name: "Audience member",
      marketing_status: "subscribed",
      last_seen_at: "2026-08-31T00:00:00.000Z",
    },
  ];

  function query(rows: unknown[] = []) {
    let requestedLimit: number | undefined;
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      in: vi.fn(() => builder),
      ilike: vi.fn(() => builder),
      or: vi.fn(() => builder),
      order: vi.fn(() => builder),
      limit: vi.fn((limit: number) => {
        requestedLimit = limit;
        return builder;
      }),
      then: (
        resolve: (value: { data: unknown[]; error: null }) => unknown,
        reject: (reason: unknown) => unknown,
      ) =>
        Promise.resolve({
          data: rows.slice(0, requestedLimit ?? 1_000),
          error: null,
        }).then(resolve, reject),
    };
    return builder;
  }

  function audienceQuery(rows: Array<Record<string, string>>) {
    const equalityFilters: Array<[string, string]> = [];
    const orderFilters: Array<[string, { ascending: boolean }]> = [];
    let search: [string, string] | undefined;
    let cursorPredicate: string | undefined;
    let requestedLimit = 1_000;
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn((column: string, value: string) => {
        equalityFilters.push([column, value]);
        return builder;
      }),
      ilike: vi.fn((column: string, value: string) => {
        search = [column, value];
        return builder;
      }),
      or: vi.fn((predicate: string) => {
        cursorPredicate = predicate;
        return builder;
      }),
      order: vi.fn((column: string, options: { ascending: boolean }) => {
        orderFilters.push([column, options]);
        return builder;
      }),
      limit: vi.fn((limit: number) => {
        requestedLimit = limit;
        return builder;
      }),
      then: (
        resolve: (value: { data: Array<Record<string, string>>; error: null }) => unknown,
        reject: (reason: unknown) => unknown,
      ) => {
        let result = rows.filter((row) =>
          equalityFilters.every(([column, value]) => row[column] === value),
        );
        if (search) {
          const [column, pattern] = search;
          const term = pattern.replaceAll("%", "").toLowerCase();
          result = result.filter((row) => row[column].toLowerCase().includes(term));
        }
        if (cursorPredicate) {
          const match = cursorPredicate.match(
            /^last_seen_at\.lt\.(.+),and\(last_seen_at\.eq\.(.+),id\.lt\.(.+)\)$/,
          );
          if (!match) throw new Error(`Unsupported cursor predicate: ${cursorPredicate}`);
          const [, before, equal, id] = match;
          result = result.filter(
            (row) => row.last_seen_at < before || (row.last_seen_at === equal && row.id < id),
          );
        }
        result.sort((left, right) => {
          for (const [column, options] of orderFilters) {
            if (left[column] === right[column]) continue;
            const comparison = left[column] < right[column] ? -1 : 1;
            return options.ascending ? comparison : -comparison;
          }
          return 0;
        });
        return Promise.resolve({ data: result.slice(0, requestedLimit), error: null }).then(
          resolve,
          reject,
        );
      },
    };
    return builder;
  }

  const membersQuery = query(membershipRows);
  const audienceContactsQueries: ReturnType<typeof audienceQuery>[] = [];
  return {
    membersQuery,
    audienceContactsQueries,
    rpc: vi.fn((name: string) =>
      Promise.resolve(
        name === "archive_audience_contacts"
          ? { data: 1, error: null }
          : {
              data: { plan: "creator", limit: 500, subscribed: 482, remaining: 18 },
              error: null,
            },
      ),
    ),
    from: vi.fn((table: string) =>
      table === "audience_list_members"
        ? membersQuery
        : table === "newsletter_subscriptions"
          ? query(subscriptionRows)
          : table === "audience_contacts"
            ? (() => {
                const result = audienceQuery(audienceRows);
                audienceContactsQueries.push(result);
                return result;
              })()
            : query(),
    ),
    getPlan: vi.fn().mockResolvedValue("creator"),
    requirePlanEntitlement: vi.fn(),
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
        (input?: { data?: unknown }) =>
          handler({
            data: validate(input?.data),
            context: { userId: "22222222-2222-4222-8222-222222222222" },
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
  getCreatorEmailCapacity: vi.fn().mockResolvedValue({
    plan: "creator",
    limit: 500,
    subscribed: 482,
    remaining: 18,
    overLimit: false,
  }),
}));
vi.mock("./plan.server", () => ({
  getPlan: mocks.getPlan,
  requirePlanEntitlement: mocks.requirePlanEntitlement,
}));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: vi.fn() }));

import * as commerceGrowth from "./commerce-growth.functions";

describe("Email Marketing workspace loader", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requests up to 10,000 audience list memberships", async () => {
    const workspace = await commerceGrowth.getMyEmailMarketing();

    expect(mocks.membersQuery.limit).toHaveBeenCalledWith(10_000);
    expect(workspace.audienceListMembers).toHaveLength(1_001);
  });

  it("loads publication subscription state for the Audience workspace", async () => {
    const workspace = await commerceGrowth.getMyEmailMarketing();

    expect(mocks.from).toHaveBeenCalledWith("newsletter_subscriptions");
    expect(workspace.newsletterSubscriptions).toEqual([
      {
        id: "33333333-3333-4333-8333-333333333333",
        contact_id: "contact-1",
        status: "pending",
        email_enabled: true,
        publication_title: "Studio Notes",
      },
    ]);
  });

  it("loads a 50-row creator-scoped Audience page with contact capacity", async () => {
    const getMyAudienceContacts = (commerceGrowth as Record<string, unknown>)
      .getMyAudienceContacts as (input: {
      data: {
        query: string;
        status: "all" | "subscribed";
        cursor: { lastSeenAt: string; id: string };
      };
    }) => Promise<{
      contacts: Array<{ id: string; creator_id: string; email: string; marketing_status: string }>;
      contactUsage: { subscribed: number; limit: number };
      nextCursor: { id: string } | null;
    }>;

    const page = await getMyAudienceContacts({
      data: {
        query: "reader",
        status: "subscribed",
        cursor: {
          lastSeenAt: "2026-09-01T00:00:00.000Z",
          id: "44444444-4444-4444-8444-444444444444",
        },
      },
    });
    const contactsQuery = mocks.audienceContactsQueries.at(-1);

    expect(page.contacts).toHaveLength(50);
    expect(page.contacts[0]).toMatchObject({
      id: "33333333-3333-4333-8333-333333333333",
      email: "reader@example.com",
    });
    expect(page.contacts[1]).toMatchObject({
      id: "44444444-4444-4444-8444-000000000054",
    });
    expect(page.contacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ creator_id: "22222222-2222-4222-8222-222222222222" }),
      ]),
    );
    expect(
      page.contacts.every(
        (contact) => contact.creator_id === "22222222-2222-4222-8222-222222222222",
      ),
    ).toBe(true);
    expect(page.contacts.every((contact) => contact.marketing_status === "subscribed")).toBe(true);
    expect(page.contacts.every((contact) => contact.email.includes("reader"))).toBe(true);
    expect(page.nextCursor).toEqual(expect.objectContaining({ id: expect.any(String) }));
    expect(page.contactUsage).toMatchObject({ subscribed: 482, limit: 500 });
    expect(contactsQuery?.eq).toHaveBeenCalledWith(
      "creator_id",
      "22222222-2222-4222-8222-222222222222",
    );
    expect(contactsQuery?.ilike).toHaveBeenCalledWith("email", "%reader%");
    expect(contactsQuery?.eq).toHaveBeenCalledWith("marketing_status", "subscribed");
    expect(contactsQuery?.order).toHaveBeenNthCalledWith(1, "last_seen_at", { ascending: false });
    expect(contactsQuery?.order).toHaveBeenNthCalledWith(2, "id", { ascending: false });
    expect(contactsQuery?.limit).toHaveBeenCalledWith(51);
    expect(contactsQuery?.or).toHaveBeenCalledWith(
      "last_seen_at.lt.2026-09-01T00:00:00.000Z,and(last_seen_at.eq.2026-09-01T00:00:00.000Z,id.lt.44444444-4444-4444-8444-444444444444)",
    );

    expect(() =>
      getMyAudienceContacts({
        data: {
          query: "",
          status: "all",
          cursor: { lastSeenAt: "not-a-date", id: "44444444-4444-4444-8444-444444444444" },
        },
      }),
    ).toThrow();
  });

  it("uses one overflow row to distinguish a full page from an exact 50-row page", async () => {
    const getMyAudienceContacts = (commerceGrowth as Record<string, unknown>)
      .getMyAudienceContacts as (input: {
      data: {
        query: string;
        status: "all" | "subscribed";
        cursor?: { lastSeenAt: string; id: string };
      };
    }) => Promise<{
      contacts: Array<{ id: string }>;
      nextCursor: { lastSeenAt: string; id: string } | null;
    }>;

    const firstPage = await getMyAudienceContacts({
      data: { query: "reader", status: "subscribed" },
    });
    expect(firstPage.contacts).toHaveLength(50);
    expect(firstPage.nextCursor).toEqual(expect.objectContaining({ id: expect.any(String) }));

    const exactPage = await getMyAudienceContacts({
      data: {
        query: "reader",
        status: "subscribed",
        cursor: {
          lastSeenAt: "2026-08-31T00:00:00.000Z",
          id: "44444444-4444-4444-8444-000000000050",
        },
      },
    });
    expect(exactPage.contacts).toHaveLength(50);
    expect(exactPage.nextCursor).toBeNull();
    expect(mocks.audienceContactsQueries.at(-1)?.limit).toHaveBeenCalledWith(51);
  });

  it("escapes percent and underscore in literal Audience email searches", async () => {
    const getMyAudienceContacts = (commerceGrowth as Record<string, unknown>)
      .getMyAudienceContacts as (input: {
      data: { query: string; status: "all" };
    }) => Promise<unknown>;

    await getMyAudienceContacts({ data: { query: "reader%_", status: "all" } });

    expect(mocks.audienceContactsQueries.at(-1)?.ilike).toHaveBeenCalledWith(
      "email",
      "%reader\\%\\_%",
    );
  });

  it("builds the exact descending equal-timestamp cursor predicate", () => {
    const audienceContactsCursorPredicate = (commerceGrowth as Record<string, unknown>)
      .audienceContactsCursorPredicate as (cursor: { lastSeenAt: string; id: string }) => string;

    expect(
      audienceContactsCursorPredicate({
        lastSeenAt: "2026-09-01T00:00:00.000Z",
        id: "44444444-4444-4444-8444-444444444444",
      }),
    ).toBe(
      "last_seen_at.lt.2026-09-01T00:00:00.000Z,and(last_seen_at.eq.2026-09-01T00:00:00.000Z,id.lt.44444444-4444-4444-8444-444444444444)",
    );
  });

  it("archives through the atomic creator-scoped RPC", async () => {
    const archiveAudienceContacts = (commerceGrowth as Record<string, unknown>)
      .archiveAudienceContacts as (input: { data: { contactIds: string[] } }) => Promise<{
      transitioned: number;
    }>;

    await expect(
      archiveAudienceContacts({
        data: { contactIds: ["44444444-4444-4444-8444-444444444444"] },
      }),
    ).resolves.toEqual({ transitioned: 1 });
    expect(mocks.requirePlanEntitlement).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      "emailMarketing",
      expect.any(String),
    );
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("archive_audience_contacts", {
      p_creator_id: "22222222-2222-4222-8222-222222222222",
      p_contact_ids: ["44444444-4444-4444-8444-444444444444"],
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("rejects archive requests above 100 unique UUIDs", async () => {
    const archiveAudienceContacts = (commerceGrowth as Record<string, unknown>)
      .archiveAudienceContacts as (input: { data: { contactIds: string[] } }) => Promise<unknown>;
    const contactIds = Array.from(
      { length: 101 },
      (_, index) => `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`,
    );

    expect(() => archiveAudienceContacts({ data: { contactIds } })).toThrow();
    expect(() =>
      archiveAudienceContacts({
        data: {
          contactIds: [
            "44444444-4444-4444-8444-444444444444",
            "44444444-4444-4444-8444-444444444444",
          ],
        },
      }),
    ).toThrow();
  });
});
