/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase query-chain test doubles accept generated row shapes. */
import { beforeEach, afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  queries: [] as string[],
  host: "bento.surf",
}));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    let validate = (data: any) => data;
    const builder: any = {
      middleware: () => builder,
      validator: (fn: any) => {
        validate = fn;
        return builder;
      },
      handler: (fn: any) => (input: any) => fn({ data: validate(input?.data) }),
    };
    return builder;
  },
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHost: () => state.host }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: vi.fn() }));
vi.mock("./plan.server", () => ({
  getPlan: async () => "creator",
  requirePlanEntitlement: vi.fn(),
}));
vi.mock("./username-alias.server", () => ({
  resolvePublicUsername: async () => ({ userId: "owner", username: "bizibeast" }),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      state.queries.push(table);
      let rows = [...(state.tables[table] ?? [])];
      let columns = "*";
      let single = false;
      const query: any = {
        select: (value: string) => {
          columns = value;
          return query;
        },
        eq: (key: string, value: unknown) => {
          rows = rows.filter((row) => row[key] === value);
          return query;
        },
        is: (key: string, value: unknown) => {
          rows = rows.filter((row) => row[key] === value);
          return query;
        },
        in: (key: string, values: unknown[]) => {
          rows = rows.filter((row) => values.includes(row[key]));
          return query;
        },
        not: (key: string) => {
          rows = rows.filter((row) => row[key] != null);
          return query;
        },
        order: () => query,
        limit: (limit: number) => {
          rows = rows.slice(0, limit);
          return query;
        },
        maybeSingle: () => {
          single = true;
          return query;
        },
        then: (resolve: any, reject: any) => {
          const selected = rows.map((row) =>
            columns === "*"
              ? row
              : Object.fromEntries(columns.split(",").map((key) => [key.trim(), row[key.trim()]])),
          );
          return Promise.resolve({
            data: single ? (selected[0] ?? null) : selected,
            error: null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  },
}));

import { getPublicBookingCalendar } from "./booking.functions";
import { getPublicCommerceStore } from "./commerce.functions";
import { getPublicNewsletterPublications } from "./newsletter.functions";

const pageId = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  state.host = "bento.surf";
  state.queries = [];
  state.tables = {
    profiles: [
      {
        id: "owner",
        username: "bizibeast",
        display_name: "Bizibeast",
        bio: "Creator bio",
        plan_id: "creator",
        is_pro: true,
        calendar_page_enabled: true,
        store_page_enabled: true,
        social_insights_enabled: false,
      },
    ],
    pages: ["calendar", "store", "newsletter"].map((system, position) => ({
      id: `${pageId.slice(0, -1)}${position + 1}`,
      system,
      name: system,
      slug: `__system_${system}`,
      user_id: "owner",
      url: null,
      is_visible: true,
      position,
    })),
    blocks: [
      {
        id: "signup",
        user_id: "owner",
        page_id: pageId,
        type: "email_capture",
        content: { title: "Join", newsletterPublicationId: "pub" },
        x: 0,
        y: 4,
        w: 2,
        h: 2,
        position: 0,
      },
    ],
    commerce_products: [
      {
        id: "session",
        creator_id: "owner",
        kind: "coaching_call",
        status: "published",
        public_slug: "strategy",
        title: "Strategy",
        pricing_type: "free",
        settings: { durationMinutes: 30 },
      },
      {
        id: "guide",
        creator_id: "owner",
        kind: "digital_download",
        status: "published",
        public_slug: "guide",
        title: "Guide",
        pricing_type: "one_time",
        price_amount: 1900,
        currency: "usd",
        settings: {},
      },
      {
        id: "draft",
        creator_id: "owner",
        kind: "digital_download",
        status: "draft",
        title: "Secret draft",
      },
      {
        id: "foreign",
        creator_id: "other",
        kind: "coaching_call",
        status: "published",
        title: "Other creator",
      },
    ],
    booking_reviews: [
      {
        id: "review",
        creator_id: "owner",
        is_public: true,
        submitted_at: "2026-09-05",
        reviewer_name: "Ria",
        body: "Helpful",
        rating: 5,
      },
      {
        id: "private",
        creator_id: "owner",
        is_public: false,
        submitted_at: "2026-09-05",
        body: "Secret review",
      },
    ],
    newsletter_publications: [
      {
        id: "pub",
        creator_id: "owner",
        status: "published",
        title: "Studio Notes",
        slug: "studio-notes",
        "audience_campaigns.status": "published",
        "audience_campaigns.web_visibility": "public",
      },
      { id: "draft", creator_id: "owner", status: "draft", title: "Secret publication" },
    ],
    page_system_item_layouts: [
      { page_id: pageId, item_key: "session:session", x: 4, y: 2, w: 4, h: 2, position: 0 },
    ],
    custom_domains: [
      { user_id: "owner", hostname: "creator.example", status: "active", ssl_status: "active" },
    ],
  };
  const cached = new Map<string, Response>();
  vi.stubGlobal("caches", {
    default: {
      match: async (request: Request) => cached.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => {
        cached.set(request.url, response.clone());
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("loads the canonical Calendar canvas with signup blocks and the same filtered domain data once", async () => {
  const data = await getPublicBookingCalendar({ data: { username: "bizibeast" } });
  expect(data?.page.id).toBe(pageId);
  expect(data?.systemLayout).toContainEqual({
    itemKey: "session:session",
    x: 4,
    y: 2,
    w: 4,
    h: 2,
    position: 0,
  });
  expect(data?.sessions).toMatchObject([{ id: "session", slug: "strategy", durationMinutes: 30 }]);
  expect(data?.reviews).toMatchObject([{ reviewerName: "Ria", rating: 5, body: "Helpful" }]);
  expect(data?.blocks[0].content).toEqual({ title: "Join" });
  expect(JSON.stringify(data)).not.toMatch(/Secret|Other creator/);
  expect(state.queries.filter((table) => table === "commerce_products")).toHaveLength(1);
});

it("does not reuse Bento-host Calendar chrome on a creator's custom domain", async () => {
  await getPublicBookingCalendar({ data: { username: "bizibeast" } });
  state.host = "creator.example";
  const data = await getPublicBookingCalendar({ data: { username: "bizibeast" } });
  expect(data?.chrome.customDomain).toBe("creator.example");
  expect(data?.chrome.pages[0].href).toBe("/calendar");
});

it("keeps Store and Newsletter payloads aligned with normalized published items", async () => {
  const store = await getPublicCommerceStore({ data: { username: "bizibeast" } });
  if (!store || store.isStandalone) throw new Error("Expected a configured Store page");
  expect(store?.products.map((product) => product.id)).toEqual(["session", "guide"]);
  expect(store?.systemItems.map((item) => item.key)).toEqual(["product:session", "product:guide"]);
  const newsletter = await getPublicNewsletterPublications({ data: { username: "bizibeast" } });
  expect(newsletter?.publications.map((publication) => publication.slug)).toEqual(["studio-notes"]);
  expect(newsletter?.systemItems.map((item) => item.key)).toEqual(["publication:pub"]);
  state.tables.pages[1].is_visible = false;
  expect(await getPublicCommerceStore({ data: { username: "bizibeast" } })).toBeNull();
});

it("selects the canonical system UUID even when an older custom page uses the Store slug", async () => {
  state.tables.pages.unshift({
    id: "legacy-custom",
    user_id: "owner",
    slug: "store",
    name: "Old store",
    system: null,
    url: null,
    is_visible: true,
    position: -1,
  });
  const store = await getPublicCommerceStore({ data: { username: "bizibeast" } });
  if (!store || store.isStandalone) throw new Error("Expected a configured Store page");
  expect(store?.page).toMatchObject({ id: `${pageId.slice(0, -1)}2`, system: "store" });
});

it("serves a standalone catalog when published products have no Store page", async () => {
  state.tables.pages = state.tables.pages.filter((page) => page.system !== "store");
  state.tables.profiles[0].store_page_enabled = false;
  const store = await getPublicCommerceStore({ data: { username: "bizibeast" } });
  expect(store?.isStandalone).toBe(true);
  expect(store?.products.map((product) => product.id)).toEqual(["session", "guide"]);
});
