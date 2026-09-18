import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getPlan } from "./plan.server";

vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: vi.fn() }));
vi.mock("./plan.server", () => ({
  getPlan: vi.fn().mockResolvedValue("store"),
  requirePlanEntitlement: vi.fn(),
}));
vi.mock("./payment-connection-policy.server", () => ({
  requireCreatorStorePaymentSetup: vi.fn(),
}));
const { adminFrom } = vi.hoisted(() => ({ adminFrom: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: adminFrom },
}));
import {
  getStoreWorkspace,
  mutateAudience,
  mutateBlock,
  mutateCalendar,
  mutatePage,
  updateCreatorProfile,
  getProfileWorkspace,
  mutateProduct,
  mergeMcpBlockContent,
  mergeMcpProductDraft,
  type CreatorMcpContext,
} from "./mcp.creator-ops.server";

const context: CreatorMcpContext = {
  userId: "00000000-0000-4000-8000-000000000001",
  supabase: {} as SupabaseClient<Database>,
};

describe("MCP owned-page behavior", () => {
  function clientFor(pageRows: any[] = []) {
    const rows: Record<string, any[]> = {
      pages: pageRows,
      blocks: [],
      newsletter_publications: [],
      profiles: [
        {
          id: context.userId,
          username: "owner",
          calendar_page_enabled: false,
          calendar_page_name: "Calendar",
        },
      ],
    };
    const calls: any[] = [];
    const client = {
      from: (table: string) => {
        const state: any = { table, filters: [], action: "select" };
        calls.push(state);
        const result = () => {
          let matches = (rows[table] ?? []).filter((row) =>
            state.filters.every(([key, value]: any[]) =>
              Array.isArray(value) ? value.includes(row[key]) : row[key] === value,
            ),
          );
          if (state.desc) matches = [...matches].sort((a, b) => b.position - a.position);
          if (state.action === "insert") {
            const row = { id: "22222222-2222-4222-8222-222222222222", ...state.value };
            rows[table].push(row);
            matches = [row];
          }
          if (state.action === "update") matches.forEach((row) => Object.assign(row, state.value));
          if (state.action === "delete")
            rows[table] = rows[table].filter((row) => !matches.includes(row));
          return {
            data: state.single
              ? matches[0]
                ? { ...matches[0] }
                : null
              : matches.map((row) => ({ ...row })),
            count: matches.length,
            error: null,
          };
        };
        const query: any = {
          select: () => query,
          eq: (key: string, value: any) => {
            state.filters.push([key, value]);
            return query;
          },
          is: (key: string, value: any) => {
            state.filters.push([key, value]);
            return query;
          },
          neq: () => query,
          in: (key: string, value: any) => {
            state.filters.push([key, value]);
            return query;
          },
          order: (_key: string, options: any) => {
            state.desc = options?.ascending === false;
            return query;
          },
          limit: () => query,
          update: (value: any) => {
            state.action = "update";
            state.value = value;
            return query;
          },
          insert: (value: any) => {
            state.action = "insert";
            state.value = value;
            return query;
          },
          delete: () => {
            state.action = "delete";
            return query;
          },
          single: async () => {
            state.single = true;
            return result();
          },
          maybeSingle: async () => {
            state.single = true;
            return result();
          },
          then: (resolve: any) => Promise.resolve(result()).then(resolve),
        };
        return query;
      },
    };
    return {
      ctx: { ...context, supabase: client as unknown as SupabaseClient<Database> },
      rows,
      calls,
    };
  }
  const systemRow = () => ({
    id: "11111111-1111-4111-8111-111111111111",
    user_id: context.userId,
    system: "calendar",
    slug: "__system_calendar",
    name: "Calendar",
    position: 3,
    url: null,
  });

  it("rejects system deletion and preserves its row", async () => {
    const test = clientFor([systemRow()]);
    await expect(mutatePage(test.ctx, { action: "delete", id: systemRow().id })).rejects.toThrow(
      "Hide system pages from their page settings.",
    );
    expect(test.rows.pages).toHaveLength(1);
  });
  it("renames a system label without rewriting its slug", async () => {
    const test = clientFor([systemRow()]);
    await expect(
      mutatePage(test.ctx, { action: "rename", id: systemRow().id, name: "Office hours" }),
    ).resolves.toMatchObject({ name: "Office hours", slug: "__system_calendar" });
  });
  it("excludes system and external rows from hosted quotas and permits external links at the limit", async () => {
    vi.mocked(getPlan).mockResolvedValueOnce("free").mockResolvedValueOnce("free");
    const test = clientFor([
      systemRow(),
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `external-${i}`,
        user_id: context.userId,
        system: null,
        url: "https://example.com",
        slug: `external-${i}`,
        position: i + 4,
      })),
    ]);
    await expect(mutatePage(test.ctx, { action: "create", name: "About" })).resolves.toMatchObject({
      slug: "about",
      position: 10,
    });
    test.rows.pages.push(
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `hosted-${i}`,
        user_id: context.userId,
        system: null,
        url: null,
        slug: `hosted-${i}`,
        position: 11 + i,
      })),
    );
    await expect(
      mutatePage(test.ctx, { action: "create", name: "Outside", url: "https://example.org" }),
    ).resolves.toMatchObject({ url: "https://example.org" });
  });
  it("synchronizes MCP calendar visibility and name into the same owned row", async () => {
    const test = clientFor([systemRow()]);
    adminFrom.mockImplementation(test.ctx.supabase.from);
    await mutateCalendar(test.ctx, { action: "set_public_page", enabled: true });
    expect(test.rows.pages[0]).toMatchObject({ is_visible: true });
    await mutateCalendar(test.ctx, { action: "rename_public_page", name: "Office hours" });
    expect(test.rows.pages[0]).toMatchObject({ name: "Office hours", slug: "__system_calendar" });
  });

  it.each(["update", "delete"])(
    "reconciles MCP homepage signup creation and %s",
    async (action) => {
      const test = clientFor([
        { ...systemRow(), system: "newsletter", slug: "__system_newsletter", is_visible: false },
      ]);
      test.rows.newsletter_publications.push({
        id: systemRow().id,
        creator_id: context.userId,
        status: "published",
      });
      const block = (await mutateBlock(test.ctx, {
        action: "create",
        type: "email_capture",
        content: { newsletterPublicationId: systemRow().id },
      })) as any;
      expect(test.rows.pages[0].is_visible).toBe(true);
      await mutateBlock(test.ctx, {
        action,
        id: block.id,
        ...(action === "update" ? { content: { newsletterPublicationId: null } } : {}),
      });
      expect(test.rows.pages[0].is_visible).toBe(false);
    },
  );

  it("uses the shared Store gate and owned row for MCP profile updates", async () => {
    const test = clientFor([
      { ...systemRow(), system: "store", slug: "__system_store", is_visible: false },
    ]);
    vi.mocked(getPlan).mockResolvedValueOnce("free");
    await expect(updateCreatorProfile(test.ctx, { store_page_enabled: true })).rejects.toThrow(
      "Upgrade",
    );
    expect(test.rows.pages[0].is_visible).toBe(false);
    vi.mocked(getPlan).mockResolvedValueOnce("store");
    await updateCreatorProfile(test.ctx, { store_page_enabled: true });
    expect(test.rows.profiles[0].store_page_enabled).toBe(true);
    expect(test.rows.pages[0].is_visible).toBe(true);
    await updateCreatorProfile(test.ctx, { store_page_enabled: false });
    expect(test.rows.pages[0].is_visible).toBe(false);
  });

  it("uses hosted-only counts in the MCP profile workspace", async () => {
    const test = clientFor([
      systemRow(),
      { id: "external", user_id: context.userId, system: null, url: "https://example.org" },
      { id: "hosted", user_id: context.userId, system: null, url: null },
    ]);
    adminFrom.mockImplementation(test.ctx.supabase.from);
    const result = await getProfileWorkspace(test.ctx);
    expect(test.calls.find((call) => call.table === "pages").filters).toEqual([
      ["user_id", context.userId],
      ["system", null],
      ["url", null],
    ]);
    expect(result.usage.pages).toBe(2);
  });
});

describe("Bento MCP creator-operation validation", () => {
  beforeEach(() => adminFrom.mockReset());

  it("loads all publications and scopes the selected Email Marketing workspace", async () => {
    const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
    const rows: Record<string, unknown[]> = {
      newsletter_publications: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          title: "Studio Notes",
          is_default: true,
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          title: "Product Notes",
          is_default: false,
        },
      ],
      audience_lists: [],
      audience_campaigns: [],
    };
    adminFrom.mockImplementation((table: string) => {
      const state = { table, filters: [] as Array<[string, unknown]> };
      calls.push(state);
      const query: Record<string, unknown> = {
        select: vi.fn(() => query),
        eq: vi.fn((column: string, value: unknown) => {
          state.filters.push([column, value]);
          return query;
        }),
        neq: vi.fn(() => query),
        order: vi.fn(() => query),
        limit: vi.fn(() => query),
        then: (resolve: (value: unknown) => void) =>
          resolve({ data: rows[table] ?? [], error: null }),
      };
      return query;
    });

    await expect(
      getStoreWorkspace(context, "22222222-2222-4222-8222-222222222222"),
    ).resolves.toMatchObject({
      publications: [
        { id: "11111111-1111-4111-8111-111111111111" },
        { id: "22222222-2222-4222-8222-222222222222" },
      ],
      selectedPublicationId: "22222222-2222-4222-8222-222222222222",
    });
    expect(
      calls.filter((call) => ["audience_lists", "audience_campaigns"].includes(call.table)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filters: expect.arrayContaining([
            ["publication_id", "22222222-2222-4222-8222-222222222222"],
          ]),
        }),
      ]),
    );
  });

  it("creates a list only inside an owned publication", async () => {
    const inserted: unknown[] = [];
    adminFrom.mockImplementation((table: string) => {
      const query: Record<string, unknown> = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        neq: vi.fn(() => query),
        maybeSingle: vi.fn().mockResolvedValue({
          data:
            table === "newsletter_publications"
              ? { id: "11111111-1111-4111-8111-111111111111" }
              : null,
          error: null,
        }),
        insert: vi.fn((value: unknown) => {
          inserted.push(value);
          return query;
        }),
        single: vi.fn().mockResolvedValue({
          data: {
            id: "22222222-2222-4222-8222-222222222222",
            publication_id: "11111111-1111-4111-8111-111111111111",
          },
          error: null,
        }),
      };
      return query;
    });

    await expect(
      mutateAudience(context, {
        action: "create_list",
        publicationId: "11111111-1111-4111-8111-111111111111",
        name: "Readers",
      }),
    ).resolves.toMatchObject({ publication_id: "11111111-1111-4111-8111-111111111111" });
    expect(inserted).toContainEqual(
      expect.objectContaining({
        publication_id: "11111111-1111-4111-8111-111111111111",
      }),
    );
  });

  it("rejects a publication-scoped audience mutation before touching its resource when unowned", async () => {
    const touched: unknown[] = [];
    adminFrom.mockImplementation((table: string) => {
      touched.push(table);
      const query: Record<string, unknown> = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        neq: vi.fn(() => query),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
      return query;
    });

    await expect(
      mutateAudience(context, {
        action: "delete_list",
        id: "22222222-2222-4222-8222-222222222222",
        publicationId: "99999999-9999-4999-8999-999999999999",
      }),
    ).rejects.toThrow("Publication not found");
    expect(touched).toEqual(["newsletter_publications"]);
  });
  it("merges partial block and product updates without erasing undisclosed state", () => {
    expect(
      mergeMcpBlockContent({ title: "Old", url: "https://example.com" }, { title: "New" }),
    ).toEqual({ title: "New", url: "https://example.com" });
    expect(
      mergeMcpProductDraft(
        {
          kind: "digital_product",
          title: "Guide",
          subtitle: "",
          description: "Original",
          cover_url: null,
          pricing_type: "one_time",
          price_amount: 1000,
          currency: "usd",
          billing_interval: null,
          cta_label: "Buy",
          settings: { files: [{ id: "private-file" }], thankYou: "Thanks" },
          inventory_limit: null,
          noindex: true,
        },
        { description: "Updated", settings: { thankYou: "New thanks" } },
      ),
    ).toMatchObject({
      title: "Guide",
      description: "Updated",
      noindex: true,
      settings: { files: [{ id: "private-file" }], thankYou: "New thanks" },
    });
  });

  it("rejects unsafe block content before touching storage", async () => {
    await expect(
      mutateBlock(context, {
        action: "create",
        type: "generic_link",
        content: { url: "javascript:alert(1)" },
      }),
    ).rejects.toThrow("unsafe value");
  });

  it("applies the existing product-kind pricing rules", async () => {
    await expect(
      mutateProduct(context, {
        action: "create",
        addToBento: false,
        product: {
          kind: "lead_form",
          title: "Apply",
          pricing_type: "one_time",
          price_amount: 100,
          currency: "usd",
          cta_label: "Apply",
          settings: {},
        },
      }),
    ).rejects.toThrow("always free");
  });

  it("rejects newsletter creation before generic MCP commerce storage", async () => {
    const from = vi.fn(() => {
      throw new Error("Generic MCP commerce storage reached.");
    });

    await expect(
      mutateProduct(
        { ...context, supabase: { from } as never },
        {
          action: "create",
          addToBento: false,
          product: {
            kind: "newsletter",
            title: "Studio Notes paid newsletter",
            subtitle: "Paid newsletter",
            description: "Paid Studio Notes.",
            cover_url: null,
            pricing_type: "subscription",
            price_amount: 900,
            currency: "usd",
            billing_interval: "month",
            cta_label: "Subscribe",
            settings: {
              newsletterPublicationId: "11111111-1111-4111-8111-111111111111",
            },
            inventory_limit: null,
            noindex: false,
          },
        },
      ),
    ).rejects.toThrow("Manage paid newsletters in Email Marketing.");
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects pricing updates when the owned MCP product is a newsletter", async () => {
    const update = vi.fn();
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: "55555555-5555-4555-8555-555555555555",
          creator_id: context.userId,
          kind: "newsletter",
          title: "Studio Notes paid newsletter",
          subtitle: "Paid newsletter",
          description: "Paid Studio Notes.",
          cover_url: null,
          pricing_type: "subscription",
          price_amount: 900,
          currency: "usd",
          billing_interval: "month",
          cta_label: "Subscribe",
          settings: {
            newsletterPublicationId: "11111111-1111-4111-8111-111111111111",
          },
          inventory_limit: null,
          noindex: false,
          status: "draft",
        },
        error: null,
      }),
      update,
    };
    const from = vi.fn(() => query);

    await expect(
      mutateProduct(
        { ...context, supabase: { from } as never },
        {
          action: "update",
          id: "55555555-5555-4555-8555-555555555555",
          product: {
            price_amount: 1,
            currency: "eur",
            billing_interval: "year",
          },
        },
      ),
    ).rejects.toThrow("Manage paid newsletters in Email Marketing.");
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    { action: "delete", productId: "55555555-5555-4555-8555-555555555555" },
    { action: "add_to_page", productId: "55555555-5555-4555-8555-555555555555" },
    {
      action: "set_status",
      id: "55555555-5555-4555-8555-555555555555",
      status: "archived",
    },
  ])("rejects generic MCP $action for a newsletter before mutation", async (input) => {
    const product = {
      id: "55555555-5555-4555-8555-555555555555",
      creator_id: context.userId,
      kind: "newsletter",
      settings: {},
      status: "published",
    };
    const update = vi.fn();
    let selectedColumns = "*";
    const selectedProduct = () =>
      selectedColumns === "*" || selectedColumns.split(",").includes("kind")
        ? product
        : { id: product.id, settings: product.settings };
    const query = {
      select: vi.fn((columns: string) => {
        selectedColumns = columns;
        return query;
      }),
      eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: selectedProduct(), error: null })),
      single: vi.fn(async () => ({ data: selectedProduct(), error: null })),
      update,
    };
    const from = vi.fn(() => query);
    const rpc = vi.fn();

    await expect(
      mutateProduct({ ...context, supabase: { from, rpc } as never }, input),
    ).rejects.toThrow("Manage paid newsletters in Email Marketing.");
    expect(update).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects invalid page and calendar inputs before database access", async () => {
    await expect(mutatePage(context, { action: "create", name: "x".repeat(41) })).rejects.toThrow();
    await expect(
      mutateCalendar(context, {
        action: "save_availability",
        availability: {
          timezone: "Not/AZone",
          weeklyRules: [],
          dateOverrides: [],
          minimumNoticeMinutes: 0,
          maximumDaysAhead: 30,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          slotIntervalMinutes: 30,
        },
      }),
    ).rejects.toThrow("valid timezone");
  });
});
