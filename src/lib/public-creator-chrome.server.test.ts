import { beforeEach, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  host: "bento.surf",
  fail: "",
}));
vi.mock("@tanstack/react-start", () => ({ createServerOnlyFn: (fn: any) => fn }));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHost: () => {
    if (db.host === "missing-request") throw new Error("No StartEvent");
    return db.host;
  },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      let rows = [...(db.tables[table] ?? [])];
      let columns = "";
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
        in: (key: string, values: unknown[]) => {
          rows = rows.filter((row) => values.includes(row[key]));
          return query;
        },
        order: (key: string) => {
          rows.sort((a, b) => a[key] - b[key]);
          return query;
        },
        limit: (count: number) => {
          rows = rows.slice(0, count);
          return query;
        },
        maybeSingle: () => {
          single = true;
          return query;
        },
        then: (resolve: any, reject: any) => {
          const selected = rows.map((row) =>
            Object.fromEntries(columns.split(",").map((key) => [key.trim(), row[key.trim()]])),
          );
          return Promise.resolve({
            data: single ? (selected[0] ?? null) : selected,
            error: db.fail === table ? { message: "Database unavailable" } : null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  },
}));

import { loadPublicCreatorChrome } from "./public-creator-chrome.server";

function page(id: string, system: string | null, position: number, extra = {}) {
  return {
    id,
    user_id: "owner",
    name: id,
    slug: system ? `__system_${system}` : id,
    system,
    position,
    is_visible: true,
    url: null,
    updated_at: "2026-09-05",
    ...extra,
  };
}

beforeEach(() => {
  db.host = "bento.surf";
  db.fail = "";
  db.tables = {
    profiles: [
      {
        id: "owner",
        username: "creator",
        display_name: "Creator",
        bio: "Hello",
        avatar_url: null,
        cover_url: null,
        theme: "light",
        accent_color: "indigo",
        primary_font: null,
        secondary_font: null,
        header_mode: "with_photo",
        pattern: "none",
        pattern_settings: null,
        is_pro: true,
        onboarded: true,
        noindex: false,
        plan_id: "creator",
        badge_hidden: false,
        calendar_page_enabled: true,
        calendar_page_name: "Calendar",
        social_insights_enabled: true,
        store_page_enabled: true,
        meta_title: null,
        meta_description: null,
        updated_at: "2026-09-05",
        email: "private@example.com",
      },
    ],
    pages: [
      page("Store", "store", 3),
      page("About", null, 0),
      page("Newsletters", "newsletter", 4),
      page("Calendar", "calendar", 1),
      page("Insights", "insights", 2),
      page("Hidden", null, 5, { is_visible: false }),
      page("Foreign", null, 6, { user_id: "someone-else" }),
    ],
    newsletter_publications: [
      {
        id: "publication",
        creator_id: "owner",
        status: "published",
        "audience_campaigns.status": "published",
        "audience_campaigns.web_visibility": "public",
      },
    ],
    custom_domains: [],
  };
});

it("loads only public fields and visible owned pages in saved order, with canonical system URLs", async () => {
  const chrome = await loadPublicCreatorChrome("owner", "old-username");
  expect(chrome?.creator.username).toBe("creator");
  expect(chrome?.creator).not.toHaveProperty("email");
  expect(chrome?.pages.map(({ id, href }) => [id, href])).toEqual([
    ["About", "/@creator/About"],
    ["Calendar", "/@creator/calendar"],
    ["Insights", "/@creator/insights"],
    ["Store", "/@creator/store"],
    ["Newsletters", "/@creator/newsletters"],
  ]);
  expect(JSON.stringify(chrome)).not.toContain("__system_");
  expect(chrome?.pages[0]).not.toHaveProperty("user_id");
});

it.each(["calendar", "store", "insights", "newsletter"])(
  "rejects stale %s visibility after a plan downgrade",
  async (system) => {
    db.tables.profiles[0].plan_id = "free";
    db.tables.profiles[0].is_pro = false;
    expect((await loadPublicCreatorChrome("owner"))?.pages.map((page) => page.id)).toEqual([
      "About",
    ]);
    expect(await loadPublicCreatorChrome("owner", "creator", system as never)).toBeNull();
  },
);

it("keeps the newsletter page visible without published issues", async () => {
  Object.assign(db.tables.profiles[0], {
    calendar_page_enabled: false,
    store_page_enabled: false,
    social_insights_enabled: false,
  });
  db.tables.newsletter_publications = [
    { id: "draft", creator_id: "owner", status: "draft" },
    { id: "foreign", creator_id: "someone-else", status: "published" },
  ];
  expect((await loadPublicCreatorChrome("owner"))?.pages.map((page) => page.id)).toEqual([
    "About",
    "Newsletters",
  ]);
});

it("uses verified owned custom domains and keeps external URLs sanitized", async () => {
  db.host = "creator.example";
  db.tables.custom_domains = [
    { user_id: "owner", hostname: db.host, status: "active", ssl_status: "active" },
  ];
  db.tables.pages.push(
    page("External", null, 6, { url: "https://example.com" }),
    page("Unsafe", null, 7, { url: "javascript:alert(1)" }),
  );
  const chrome = await loadPublicCreatorChrome("owner");
  expect(chrome?.customDomain).toBe("creator.example");
  expect(chrome?.pages.map((page) => page.href)).toEqual([
    "/About",
    "/calendar",
    "/insights",
    "/store",
    "/newsletters",
    "https://example.com/",
  ]);
});

it.each([{ user_id: "someone-else" }, { ssl_status: "pending" }, { status: "pending" }])(
  "does not use an unverified or foreign custom domain: %j",
  async (override) => {
    db.host = "creator.example";
    db.tables.custom_domains = [
      { user_id: "owner", hostname: db.host, status: "active", ssl_status: "active", ...override },
    ];
    expect((await loadPublicCreatorChrome("owner"))?.customDomain).toBeNull();
  },
);

it("returns null for a missing creator or hidden active system and propagates database failures", async () => {
  expect(await loadPublicCreatorChrome("missing")).toBeNull();
  db.tables.pages.find((page) => page.system === "calendar").is_visible = false;
  expect(await loadPublicCreatorChrome("owner", "creator", "calendar")).toBeNull();
  db.fail = "pages";
  await expect(loadPublicCreatorChrome("owner")).rejects.toThrow("Unable to load public creator");
});

it("supports raw Worker image requests without a TanStack request context", async () => {
  db.host = "missing-request";
  const chrome = await loadPublicCreatorChrome("owner", undefined, undefined, "bento.surf");
  expect(chrome?.creator.username).toBe("creator");
});
