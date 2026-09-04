import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const creatorId = "11111111-1111-4111-8111-111111111111";
  const publicationIds = [
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ];
  const batchIds = ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];
  const state = {
    ownedPublications: new Set(publicationIds),
    contacts: new Map<string, string>(),
    subscriptions: new Map<string, Record<string, unknown>>(),
    consents: new Set<string>(),
    consentProofs: new Set<string>(),
    lists: new Map<string, string>(),
    members: new Set<string>(),
    globallySubscribed: new Set<string>(),
    capacity: 500,
  };
  const queries: Array<{
    table: string;
    action: string;
    value?: Record<string, unknown>;
    filters: Array<[string, unknown]>;
  }> = [];

  function from(table: string) {
    const query: {
      table: string;
      action: string;
      value?: Record<string, unknown>;
      filters: Array<[string, unknown]>;
    } = { table, action: "select", filters: [] };
    queries.push(query);

    const execute = () => {
      const filters = Object.fromEntries(query.filters);
      if (table === "newsletter_publications") {
        const id = String(filters.id ?? "");
        return {
          data: filters.creator_id === creatorId && state.ownedPublications.has(id) ? { id } : null,
          error: null,
        };
      }
      if (table === "newsletter_subscriptions") {
        const key = `${filters.publication_id ?? query.value?.publication_id}:${filters.contact_id ?? query.value?.contact_id}`;
        if (query.action === "upsert") {
          state.subscriptions.set(key, query.value ?? {});
          return { data: null, error: null };
        }
        const subscription = state.subscriptions.get(key);
        const contactId = String(filters.contact_id ?? "");
        return {
          data: subscription
            ? {
                ...subscription,
                audience_contacts: {
                  marketing_status: state.globallySubscribed.has(contactId)
                    ? "subscribed"
                    : "unsubscribed",
                },
              }
            : null,
          error: null,
        };
      }
      if (table === "audience_contacts") {
        const contactId = String(filters.id ?? "");
        return {
          data: {
            id: contactId,
            marketing_status: state.globallySubscribed.has(contactId)
              ? "subscribed"
              : "unsubscribed",
          },
          error: null,
        };
      }
      if (table === "audience_consent_events") {
        const proof = filters.proof as { publication_id?: string } | undefined;
        const key = `${proof?.publication_id}:${filters.contact_id}`;
        if (query.action === "insert") {
          const contactId = String(query.value?.contact_id ?? "");
          const idempotencyKey = String(query.value?.idempotency_key ?? "");
          if (idempotencyKey && state.consents.has(idempotencyKey)) {
            return {
              data: null,
              error: { code: "23505", message: "duplicate consent idempotency key" },
            };
          }
          if (
            !state.globallySubscribed.has(contactId) &&
            state.globallySubscribed.size >= state.capacity
          ) {
            return {
              data: null,
              error: {
                code: "P0001",
                message: "Email marketing contact allowance reached.",
              },
            };
          }
          state.globallySubscribed.add(contactId);
          const publicationId = (query.value?.proof as { publication_id?: string })?.publication_id;
          state.consents.add(idempotencyKey || `legacy-${state.consents.size + 1}`);
          state.consentProofs.add(`${publicationId}:${contactId}`);
          return { data: null, error: null };
        }
        return { data: state.consentProofs.has(key) ? { id: "consent" } : null, error: null };
      }
      if (table === "audience_lists") {
        const publicationId = String(filters.publication_id ?? query.value?.publication_id ?? "");
        const name = String(filters.name ?? query.value?.name ?? "");
        const key = `${publicationId}:${name}`;
        if (query.action === "insert") {
          const id = `list-${state.lists.size + 1}`;
          state.lists.set(key, id);
          return { data: { id }, error: null };
        }
        const id = state.lists.get(key);
        return { data: id ? { id } : null, error: null };
      }
      if (table === "audience_list_members" && query.action === "upsert") {
        state.members.add(`${query.value?.list_id}:${query.value?.contact_id}`);
        return { data: null, error: null };
      }
      throw new Error(`Unexpected query ${query.action} ${table}`);
    };

    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn((column: string, value: unknown) => {
        query.filters.push([column, value]);
        return builder;
      }),
      neq: vi.fn((column: string, value: unknown) => {
        query.filters.push([column, value]);
        return builder;
      }),
      contains: vi.fn((column: string, value: unknown) => {
        query.filters.push([column, value]);
        return builder;
      }),
      insert: vi.fn((value: Record<string, unknown>) => {
        query.action = "insert";
        query.value = value;
        return builder;
      }),
      upsert: vi.fn((value: Record<string, unknown>) => {
        query.action = "upsert";
        query.value = value;
        return builder;
      }),
      maybeSingle: vi.fn(async () => execute()),
      then: (
        resolve: (value: ReturnType<typeof execute>) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve(execute()).then(resolve, reject),
    };
    return builder;
  }

  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name !== "commerce_upsert_audience_contact") {
      throw new Error(`Unexpected RPC ${name}`);
    }
    const email = String(args.p_email).trim().toLowerCase();
    let contactId = state.contacts.get(email);
    if (!contactId) {
      contactId = `contact-${state.contacts.size + 1}`;
      state.contacts.set(email, contactId);
    }
    return { data: contactId, error: null };
  });

  return {
    creatorId,
    publicationIds,
    batchIds,
    state,
    queries,
    from: vi.fn(from),
    rpc,
    requirePlanEntitlement: vi.fn(),
    recordEmailMarketingCapacityBlock: vi.fn(),
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
        (handler: (input: { data: never; context: { userId: string } }) => unknown) =>
        (input?: { data?: unknown }) =>
          handler({
            data: validate(input?.data) as never,
            context: { userId: mocks.creatorId },
          }),
    };
    return builder;
  },
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("./plan.server", () => ({
  requirePlanEntitlement: mocks.requirePlanEntitlement,
}));
vi.mock("./email.server", () => ({
  recordEmailMarketingCapacityBlock: mocks.recordEmailMarketingCapacityBlock,
}));

import { parseSubscriberCsv, summarizeSubscriberImportCapacity } from "./newsletter-import";
import { importPublicationSubscribers } from "./newsletter-import.functions";

describe("subscriber CSV parser", () => {
  it("parses quoted commas and normalizes accepted headers", () => {
    expect(parseSubscriberCsv('EMAIL,Name\r\n"a@example.com","A, Person"').rows).toEqual([
      { email: "a@example.com", name: "A, Person" },
    ]);
  });

  it("supports BOM, escaped quotes, optional lists, and blank rows", () => {
    expect(
      parseSubscriberCsv('\uFEFFemail,name,list\nreader@example.com,"A ""Reader""",Launch\n,,\n')
        .rows,
    ).toEqual([{ email: "reader@example.com", name: 'A "Reader"', list: "Launch" }]);
  });

  it("uses explicit column mapping without importing omitted optional columns", () => {
    expect(
      parseSubscriberCsv("address,name,group\nreader@example.com,Ignored,Founders", {
        email: "address",
        list: "group",
      }).rows,
    ).toEqual([{ email: "reader@example.com", list: "Founders" }]);
    expect(
      parseSubscriberCsv("address,name\nreader@example.com,Reader", {
        email: "address",
        name: "address",
      }).errors,
    ).toEqual([expect.objectContaining({ code: "duplicate_header", row: 1 })]);
  });

  it("returns deterministic validation errors without dropping valid rows", () => {
    const result = parseSubscriberCsv("email\nbad\nvalid@example.com");

    expect(result.rows).toEqual([{ email: "valid@example.com" }]);
    expect(result.errors).toEqual([expect.objectContaining({ code: "invalid_email", row: 2 })]);
  });

  it("rejects malformed CSV and a missing email header deterministically", () => {
    expect(parseSubscriberCsv('email\n"unterminated').errors[0]?.code).toBe("malformed_csv");
    expect(parseSubscriberCsv('email\n"a@example.com"x').errors[0]?.code).toBe("malformed_csv");
    expect(parseSubscriberCsv("name\nReader").errors[0]?.code).toBe("missing_email_header");
  });

  it("limits imports to 10,000 non-blank data rows", () => {
    const text = ["email", ...Array.from({ length: 10_001 }, (_, i) => `r${i}@example.com`)].join(
      "\n",
    );
    const result = parseSubscriberCsv(text);

    expect(result.rows).toHaveLength(10_000);
    expect(result.errors.at(-1)).toMatchObject({ code: "row_limit_exceeded", row: 10_002 });
  });
});

describe("subscriber import capacity preview", () => {
  it("charges slots for new and non-subscribed existing contacts only", () => {
    expect(
      summarizeSubscriberImportCapacity(
        [
          "subscribed@example.com",
          "unsubscribed@example.com",
          "unknown@example.com",
          "new@example.com",
        ],
        [
          { email_normalized: "subscribed@example.com", marketing_status: "subscribed" },
          { email_normalized: "unsubscribed@example.com", marketing_status: "unsubscribed" },
          { email_normalized: "unknown@example.com", marketing_status: "unknown" },
        ],
        2,
      ),
    ).toEqual({ existing: 3, required: 3, blocked: 1 });
  });
});

describe("publication subscriber import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.ownedPublications = new Set(mocks.publicationIds);
    mocks.state.contacts.clear();
    mocks.state.subscriptions.clear();
    mocks.state.consents.clear();
    mocks.state.consentProofs.clear();
    mocks.state.lists.clear();
    mocks.state.members.clear();
    mocks.state.globallySubscribed.clear();
    mocks.state.capacity = 500;
    mocks.queries.length = 0;
  });

  it("requires affirmed consent before any database write", async () => {
    await expect(
      importPublicationSubscribers({
        data: {
          publicationId: mocks.publicationIds[0],
          batchId: mocks.batchIds[0],
          rows: [{ email: "reader@example.com" }],
          consentConfirmed: false,
        },
      }),
    ).rejects.toThrow("Confirm subscriber consent");
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("normalizes and deduplicates creator-global contacts", async () => {
    await expect(
      importPublicationSubscribers({
        data: {
          publicationId: mocks.publicationIds[0],
          batchId: mocks.batchIds[0],
          rows: [
            { email: " Reader@Example.com ", name: "Reader" },
            { email: "reader@example.com", name: "Duplicate" },
          ],
          consentConfirmed: true,
        },
      }),
    ).resolves.toEqual({ imported: 1, updated: 0, skipped: 1, invalid: 0, blocked: 0 });
    expect(mocks.state.contacts.size).toBe(1);
    expect(mocks.state.subscriptions.size).toBe(1);
    expect(mocks.state.consents.size).toBe(1);
  });

  it("merges list memberships from duplicate normalized emails", async () => {
    await importPublicationSubscribers({
      data: {
        publicationId: mocks.publicationIds[0],
        batchId: mocks.batchIds[0],
        rows: [
          { email: "reader@example.com", list: "Alpha" },
          { email: " READER@example.com ", list: "Beta" },
        ],
        consentConfirmed: true,
      },
    });

    expect(mocks.state.lists).toEqual(
      new Map([
        [`${mocks.publicationIds[0]}:Alpha`, "list-1"],
        [`${mocks.publicationIds[0]}:Beta`, "list-2"],
      ]),
    );
    expect(mocks.state.members).toEqual(new Set(["list-1:contact-1", "list-2:contact-1"]));
  });

  it("uses one capacity slot for the same contact in two publications", async () => {
    for (const publicationId of mocks.publicationIds) {
      await expect(
        importPublicationSubscribers({
          data: {
            publicationId,
            batchId: mocks.batchIds[0],
            rows: [{ email: "reader@example.com" }],
            consentConfirmed: true,
          },
        }),
      ).resolves.toMatchObject({ imported: 1, blocked: 0 });
    }

    expect(mocks.state.contacts.size).toBe(1);
    expect(mocks.state.globallySubscribed.size).toBe(1);
    expect(mocks.state.subscriptions.size).toBe(2);
  });

  it("blocks only rows that exceed creator-global contact capacity", async () => {
    mocks.state.capacity = 1;
    await expect(
      importPublicationSubscribers({
        data: {
          publicationId: mocks.publicationIds[0],
          batchId: mocks.batchIds[0],
          rows: [{ email: "one@example.com" }, { email: "two@example.com" }],
          consentConfirmed: true,
        },
      }),
    ).resolves.toEqual({ imported: 1, updated: 0, skipped: 0, invalid: 0, blocked: 1 });
    expect(mocks.state.subscriptions.size).toBe(1);
    expect(mocks.recordEmailMarketingCapacityBlock).toHaveBeenCalledOnce();
  });

  it("is idempotent when a successful batch is retried", async () => {
    const input = {
      publicationId: mocks.publicationIds[0],
      batchId: mocks.batchIds[0],
      rows: [{ email: "reader@example.com" }],
      consentConfirmed: true,
    };
    await importPublicationSubscribers({ data: input });

    await expect(importPublicationSubscribers({ data: input })).resolves.toEqual({
      imported: 0,
      updated: 0,
      skipped: 1,
      invalid: 0,
      blocked: 0,
    });
    expect(mocks.state.consents.size).toBe(1);
    expect(mocks.state.subscriptions.size).toBe(1);
  });

  it("uses one database-enforced consent key for concurrent same-batch imports", async () => {
    const data = {
      publicationId: mocks.publicationIds[0],
      batchId: mocks.batchIds[0],
      rows: [{ email: "reader@example.com" }],
      consentConfirmed: true,
    };

    await Promise.all([
      importPublicationSubscribers({ data }),
      importPublicationSubscribers({ data }),
    ]);

    const expectedKey = `${mocks.batchIds[0]}:${mocks.publicationIds[0]}:contact-1`;
    expect(
      mocks.queries
        .filter((query) => query.table === "audience_consent_events" && query.action === "insert")
        .map((query) => query.value?.idempotency_key),
    ).toEqual(expect.arrayContaining([expectedKey]));
    expect(mocks.state.consents).toEqual(new Set([expectedKey]));
    expect(mocks.state.subscriptions.size).toBe(1);
  });

  it("resumes the same batch after consent committed but subscription activation failed", async () => {
    mocks.state.contacts.set("reader@example.com", "contact-1");
    mocks.state.globallySubscribed.add("contact-1");
    mocks.state.consents.add(`${mocks.batchIds[0]}:${mocks.publicationIds[0]}:contact-1`);
    mocks.state.consentProofs.add(`${mocks.publicationIds[0]}:contact-1`);

    await expect(
      importPublicationSubscribers({
        data: {
          publicationId: mocks.publicationIds[0],
          batchId: mocks.batchIds[0],
          rows: [{ email: "reader@example.com" }],
          consentConfirmed: true,
        },
      }),
    ).resolves.toMatchObject({ imported: 1, blocked: 0 });
    expect(
      mocks.queries.find(
        (query) => query.table === "audience_consent_events" && query.action === "insert",
      )?.value?.idempotency_key,
    ).toBe(`${mocks.batchIds[0]}:${mocks.publicationIds[0]}:contact-1`);
  });

  it("reactivates creator-global consent after an account archive", async () => {
    mocks.state.contacts.set("reader@example.com", "contact-1");
    mocks.state.subscriptions.set(`${mocks.publicationIds[0]}:contact-1`, {
      id: "subscription-1",
      status: "subscribed",
      email_enabled: true,
    });

    await expect(
      importPublicationSubscribers({
        data: {
          publicationId: mocks.publicationIds[0],
          batchId: mocks.batchIds[0],
          rows: [{ email: "reader@example.com" }],
          consentConfirmed: true,
        },
      }),
    ).resolves.toEqual({ imported: 0, updated: 1, skipped: 0, invalid: 0, blocked: 0 });
    expect(mocks.state.globallySubscribed).toEqual(new Set(["contact-1"]));
  });

  it("records fresh consent for a new batch when publication A was unsubscribed but B remains active", async () => {
    mocks.state.contacts.set("reader@example.com", "contact-1");
    mocks.state.globallySubscribed.add("contact-1");
    mocks.state.subscriptions.set(`${mocks.publicationIds[0]}:contact-1`, {
      id: "subscription-a",
      status: "unsubscribed",
      email_enabled: false,
    });
    mocks.state.subscriptions.set(`${mocks.publicationIds[1]}:contact-1`, {
      id: "subscription-b",
      status: "subscribed",
      email_enabled: true,
    });
    const priorKey = `${mocks.batchIds[0]}:${mocks.publicationIds[0]}:contact-1`;
    mocks.state.consents.add(priorKey);
    mocks.state.consentProofs.add(`${mocks.publicationIds[0]}:contact-1`);

    await expect(
      importPublicationSubscribers({
        data: {
          publicationId: mocks.publicationIds[0],
          batchId: mocks.batchIds[1],
          rows: [{ email: "reader@example.com" }],
          consentConfirmed: true,
        },
      }),
    ).resolves.toMatchObject({ updated: 1 });

    expect(mocks.state.consents).toEqual(
      new Set([priorKey, `${mocks.batchIds[1]}:${mocks.publicationIds[0]}:contact-1`]),
    );
  });

  it("rejects a publication the authenticated creator does not own", async () => {
    mocks.state.ownedPublications.clear();
    await expect(
      importPublicationSubscribers({
        data: {
          publicationId: mocks.publicationIds[0],
          batchId: mocks.batchIds[0],
          rows: [{ email: "reader@example.com" }],
          consentConfirmed: true,
        },
      }),
    ).rejects.toThrow("Publication not found");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("creates publication-owned lists and memberships", async () => {
    await importPublicationSubscribers({
      data: {
        publicationId: mocks.publicationIds[0],
        batchId: mocks.batchIds[0],
        rows: [{ email: "reader@example.com", list: "Launch" }],
        consentConfirmed: true,
        listName: "VIP",
      },
    });

    expect(mocks.state.lists).toEqual(
      new Map([
        [`${mocks.publicationIds[0]}:VIP`, "list-1"],
        [`${mocks.publicationIds[0]}:Launch`, "list-2"],
      ]),
    );
    expect(mocks.state.members).toEqual(new Set(["list-1:contact-1", "list-2:contact-1"]));
    expect(
      mocks.queries.filter(
        (query) => query.table === "audience_lists" && query.action === "insert",
      ),
    ).toEqual([
      expect.objectContaining({
        value: expect.objectContaining({ publication_id: mocks.publicationIds[0] }),
      }),
      expect.objectContaining({
        value: expect.objectContaining({ publication_id: mocks.publicationIds[0] }),
      }),
    ]);
  });
});
