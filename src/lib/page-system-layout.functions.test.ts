/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase query-chain test doubles accept generated row shapes. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const rows: Record<string, any[]> = {};
  const queries: Array<{ table: string; filters: any[] }> = [];
  const rpc = vi.fn();
  const from = vi.fn((table: string) => {
    const state = { table, filters: [] as any[] };
    queries.push(state);
    let limit = Infinity;
    const result = () => ({
      data: (rows[table] ?? [])
        .filter((row) =>
          state.filters.every(([op, key, value]) =>
            op === "eq"
              ? row[key] === value
              : op === "in"
                ? value.includes(row[key])
                : row[key] !== null && row[key] !== undefined,
          ),
        )
        .slice(0, limit),
      error: null,
    });
    const query: any = {
      select: () => query,
      order: () => query,
      eq: (key: string, value: any) => {
        state.filters.push(["eq", key, value]);
        return query;
      },
      in: (key: string, value: any) => {
        state.filters.push(["in", key, value]);
        return query;
      },
      not: (key: string) => {
        state.filters.push(["not", key]);
        return query;
      },
      limit: (value: number) => {
        limit = value;
        return query;
      },
      maybeSingle: async () => ({ ...result(), data: result().data[0] ?? null }),
      then: (resolve: any) => Promise.resolve(result()).then(resolve),
    };
    return query;
  });
  const adminFrom = vi.fn((table: string) => from(table));
  return {
    rows,
    queries,
    rpc,
    from,
    adminFrom,
    getPlan: vi.fn(),
    analytics: vi.fn(),
    invalidate: vi.fn(),
  };
});

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (data: any) => data;
    const builder: any = {
      middleware: () => builder,
      validator: (fn: any) => {
        validate = fn;
        return builder;
      },
      handler: (fn: any) => async (input: any) =>
        fn({
          data: validate(input.data),
          context: { userId: "creator", supabase: { from: mocks.from, rpc: mocks.rpc } },
        }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.adminFrom },
}));
vi.mock("./plan.server", () => ({ getPlan: mocks.getPlan }));
vi.mock("./pages.functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pages.functions")>()),
  invalidateCreatorPageCaches: mocks.invalidate,
}));
vi.mock("./social-analytics.functions", () => ({
  loadPublicSocialAnalytics: mocks.analytics,
  summarizeSocialAnalytics: () => ({
    totalFollowers: 10,
    totalViews: 20,
    totalReach: 30,
    totalEngagements: 4,
    totalPosts: 5,
  }),
}));

import { getMySystemPageCanvas, saveMySystemPageLayout } from "./page-system-layout.functions";

const calendarId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const item = { itemKey: `session:${sessionId}`, x: 0, y: 0, w: 4, h: 2, position: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(mocks.rows)) delete mocks.rows[key];
  mocks.queries.length = 0;
  mocks.getPlan.mockResolvedValue("creator");
  mocks.rpc.mockResolvedValue({ data: null, error: null });
  mocks.rows.pages = [
    {
      id: calendarId,
      user_id: "creator",
      system: "calendar",
      name: "Calendar",
      is_visible: true,
      url: null,
    },
  ];
  mocks.rows.profiles = [
    {
      id: "creator",
      username: "creator",
      display_name: "Creator",
      bio: "Hello",
      calendar_page_enabled: true,
      store_page_enabled: true,
      social_insights_enabled: true,
    },
  ];
  mocks.rows.commerce_products = [
    {
      id: sessionId,
      creator_id: "creator",
      kind: "coaching_call",
      status: "published",
      title: "Session",
      settings: { durationMinutes: 30 },
      pricing_type: "one_time",
      price_amount: 1000,
      currency: "USD",
    },
  ];
});

describe("owned system canvas", () => {
  it.each(["foreign", "hidden", "ordinary", "external", "unknown"])(
    "rejects %s pages before loading sources or saving",
    async (mode) => {
      Object.assign(
        mocks.rows.pages[0],
        mode === "foreign"
          ? { user_id: "other" }
          : mode === "hidden"
            ? { is_visible: false }
            : mode === "ordinary"
              ? { system: null }
              : mode === "external"
                ? { url: "https://example.com" }
                : { system: "unknown" },
      );
      await expect(getMySystemPageCanvas({ data: { pageId: calendarId } })).rejects.toThrow();
      await expect(
        saveMySystemPageLayout({ data: { pageId: calendarId, items: [item] } }),
      ).rejects.toThrow();
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.from).not.toHaveBeenCalledWith("commerce_products");
    },
  );
  it("loads published owned sessions, submitted public reviews, and saved geometry", async () => {
    mocks.rows.commerce_products.push(
      { ...mocks.rows.commerce_products[0], id: "draft", status: "draft" },
      { ...mocks.rows.commerce_products[0], id: "foreign", creator_id: "other" },
      { ...mocks.rows.commerce_products[0], id: "book", kind: "digital_product" },
    );
    mocks.rows.booking_reviews = [
      {
        id: "review",
        creator_id: "creator",
        is_public: true,
        submitted_at: "2026-09-01",
        reviewer_name: "Reader",
        body: "Great",
        rating: 5,
      },
      { id: "private", creator_id: "creator", is_public: false, submitted_at: "2026-09-01" },
      { id: "pending", creator_id: "creator", is_public: true, submitted_at: null },
    ];
    mocks.rows.page_system_item_layouts = [
      {
        page_id: calendarId,
        item_key: `session:${sessionId}`,
        x: 4,
        y: 4,
        w: 4,
        h: 2,
        position: 0,
      },
      { page_id: calendarId, item_key: "session:deleted", x: 0, y: 8, w: 4, h: 2, position: 1 },
    ];
    const result = await getMySystemPageCanvas({ data: { pageId: calendarId } });
    expect(result.items.map((entry) => entry.key)).toEqual([
      `session:${sessionId}`,
      "review:review",
    ]);
    expect(
      result.items.every((entry) => entry.pageId === calendarId && entry.system === "calendar"),
    ).toBe(true);
    expect(result.layout).toEqual([
      { ...item, x: 4, y: 4 },
      { itemKey: "review:review", x: 0, y: 0, w: 4, h: 2, position: 1 },
    ]);
  });
  it("derives keys again at save time and passes the literal SQL payload", async () => {
    await expect(
      saveMySystemPageLayout({ data: { pageId: calendarId, items: [item] } }),
    ).resolves.toEqual({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledWith("replace_page_system_item_layout", {
      target_page_id: calendarId,
      layout_items: [
        {
          item_key: "session:22222222-2222-4222-8222-222222222222",
          x: 0,
          y: 0,
          w: 4,
          h: 2,
          position: 0,
        },
      ],
    });
    expect(mocks.invalidate).toHaveBeenCalled();
    mocks.rows.commerce_products[0].status = "draft";
    mocks.rpc.mockClear();
    await expect(
      saveMySystemPageLayout({ data: { pageId: calendarId, items: [item] } }),
    ).rejects.toThrow(/item/i);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([
    { itemKey: "session:unknown" },
    { x: -1 },
    { x: 5 },
    { y: 0.5 },
    { y: 10001 },
    { w: 0 },
    { h: 1001 },
    { position: 200 },
  ])("rejects unknown keys or invalid geometry %j", async (patch) => {
    await expect(
      saveMySystemPageLayout({ data: { pageId: calendarId, items: [{ ...item, ...patch }] } }),
    ).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects duplicate keys and more than 200 items", async () => {
    await expect(
      saveMySystemPageLayout({ data: { pageId: calendarId, items: [item, item] } }),
    ).rejects.toThrow();
    await expect(
      saveMySystemPageLayout({
        data: {
          pageId: calendarId,
          items: Array.from({ length: 201 }, (_, i) => ({
            ...item,
            itemKey: `product:${i}`,
            position: i % 200,
          })),
        },
      }),
    ).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("surfaces RPC failures", async () => {
    mocks.rpc.mockResolvedValue({ error: { message: "Layout write failed" } });
    await expect(
      saveMySystemPageLayout({ data: { pageId: calendarId, items: [item] } }),
    ).rejects.toThrow("Layout write failed");
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  it("round-trips exactly 200 current source items", async () => {
    mocks.rows.commerce_products = Array.from({ length: 200 }, (_, index) => ({
      ...mocks.rows.commerce_products[0],
      id: `session-${index}`,
    }));
    const canvas = await getMySystemPageCanvas({ data: { pageId: calendarId } });
    expect(canvas.items).toHaveLength(200);
    expect(canvas.layout.at(-1)).toEqual({
      itemKey: "session:session-199",
      x: 4,
      y: 198,
      w: 4,
      h: 2,
      position: 199,
    });
    await expect(
      saveMySystemPageLayout({ data: { pageId: calendarId, items: canvas.layout } }),
    ).resolves.toEqual({
      ok: true,
    });
    expect(mocks.rpc.mock.calls[0][1].layout_items).toHaveLength(200);
    mocks.rows.page_system_item_layouts = mocks.rpc.mock.calls[0][1].layout_items.map(
      (row: object) => ({ ...row, page_id: calendarId }),
    );
    expect((await getMySystemPageCanvas({ data: { pageId: calendarId } })).layout).toEqual(
      canvas.layout,
    );
  });
  it("rejects 201 source items on load and save before any RPC, even for a submitted subset", async () => {
    mocks.rows.commerce_products = Array.from({ length: 201 }, (_, index) => ({
      ...mocks.rows.commerce_products[0],
      id: `session-${index}`,
    }));
    await expect(getMySystemPageCanvas({ data: { pageId: calendarId } })).rejects.toThrow(
      "System pages support at most 200 items.",
    );
    await expect(
      saveMySystemPageLayout({
        data: { pageId: calendarId, items: [{ ...item, itemKey: "intro" }] },
      }),
    ).rejects.toThrow("System pages support at most 200 items.");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects duplicate source records before rendering or saving", async () => {
    mocks.rows.commerce_products.push({ ...mocks.rows.commerce_products[0] });
    await expect(getMySystemPageCanvas({ data: { pageId: calendarId } })).rejects.toThrow(
      /unique/i,
    );
    await expect(
      saveMySystemPageLayout({ data: { pageId: calendarId, items: [item] } }),
    ).rejects.toThrow(/unique/i);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("loads Store products under current plan entitlements", async () => {
    mocks.rows.pages[0].system = "store";
    mocks.rows.commerce_products.push({
      ...mocks.rows.commerce_products[0],
      id: "free-community",
      kind: "paid_community",
      pricing_type: "free",
      price_amount: 0,
    });
    const result = await getMySystemPageCanvas({ data: { pageId: calendarId } });
    expect(result.items.map((entry) => entry.key)).toEqual([`product:${sessionId}`]);
    mocks.getPlan.mockResolvedValue("free");
    expect(
      (await getMySystemPageCanvas({ data: { pageId: calendarId } })).items.map(
        (entry) => entry.key,
      ),
    ).toEqual([]);
  });
  it("loads only published owned newsletter publications", async () => {
    mocks.rows.pages[0].system = "newsletter";
    mocks.rows.newsletter_publications = [
      { id: "pub", creator_id: "creator", status: "published", title: "News" },
      { id: "draft", creator_id: "creator", status: "draft" },
      { id: "other", creator_id: "other", status: "published" },
    ];
    expect(
      (await getMySystemPageCanvas({ data: { pageId: calendarId } })).items.map(
        (entry) => entry.key,
      ),
    ).toEqual(["publication:pub"]);
  });
  it("uses public-period analytics and currently active owned connections", async () => {
    mocks.rows.pages[0].system = "insights";
    mocks.rows.social_connections = [
      { id: "active", user_id: "creator", status: "active" },
      { id: "expired", user_id: "creator", status: "expired" },
    ];
    mocks.analytics.mockResolvedValue({
      accounts: [
        { connectionId: "active", displayName: "Active" },
        { connectionId: "expired" },
        { connectionId: "foreign" },
      ],
      displayPeriodDays: 30,
    });
    expect(
      (await getMySystemPageCanvas({ data: { pageId: calendarId } })).items.map(
        (entry) => entry.key,
      ),
    ).toEqual([
      "summary:followers",
      "summary:views",
      "summary:posts",
      "summary:engagements",
      "account:active",
    ]);
    expect(
      (await getMySystemPageCanvas({ data: { pageId: calendarId } })).items.find(
        (entry) => entry.key === "summary:engagements",
      )?.title,
    ).toBe("Engagement");
    expect(
      (await getMySystemPageCanvas({ data: { pageId: calendarId } })).items.find(
        (entry) => entry.key === "account:active",
      )?.defaultH,
    ).toBe(2);
    expect(mocks.analytics).toHaveBeenCalledWith("creator");
  });

  it("loads protected Insights sources with the server client after owner validation", async () => {
    mocks.rows.pages[0].system = "insights";
    mocks.rows.social_connections = [{ id: "active", user_id: "creator", status: "active" }];
    mocks.analytics.mockResolvedValue({
      accounts: [{ connectionId: "active", displayName: "Active" }],
      displayPeriodDays: 30,
    });

    await getMySystemPageCanvas({ data: { pageId: calendarId } });

    expect(mocks.from).toHaveBeenCalledWith("pages");
    expect(mocks.adminFrom).toHaveBeenCalledWith("social_connections");
  });
});
