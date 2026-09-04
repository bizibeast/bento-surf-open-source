import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

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
  mutateProduct,
  mergeMcpBlockContent,
  mergeMcpProductDraft,
  type CreatorMcpContext,
} from "./mcp.creator-ops.server";

const context: CreatorMcpContext = {
  userId: "00000000-0000-4000-8000-000000000001",
  supabase: {} as SupabaseClient<Database>,
};

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
