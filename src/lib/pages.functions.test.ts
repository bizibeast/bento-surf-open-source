import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const queries: Array<{ action: string; value?: any; filters: any[] }> = [];
  const responses: any[] = [];
  const rpc = vi.fn();
  const from = vi.fn(() => {
    const state = { action: "select", filters: [] as any[], value: undefined as any };
    queries.push(state);
    const query: any = {
      select: vi.fn(() => query),
      order: vi.fn(() => query),
      limit: vi.fn(() => query),
      eq: vi.fn((...args) => {
        state.filters.push(args);
        return query;
      }),
      is: vi.fn((...args) => {
        state.filters.push(args);
        return query;
      }),
      neq: vi.fn(() => query),
      update: vi.fn((value) => {
        state.action = "update";
        state.value = value;
        return query;
      }),
      insert: vi.fn((value) => {
        state.action = "insert";
        state.value = value;
        return query;
      }),
      delete: vi.fn(() => {
        state.action = "delete";
        return query;
      }),
      single: vi.fn(async () => responses.shift() ?? { data: null, error: null }),
      maybeSingle: vi.fn(async () => responses.shift() ?? { data: null, error: null }),
      then: (resolve: any) =>
        Promise.resolve(responses.shift() ?? { data: [], error: null }).then(resolve),
    };
    return query;
  });
  return { queries, responses, rpc, from, getPlan: vi.fn().mockResolvedValue("creator") };
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
      handler: (fn: any) => (input: any) =>
        fn({
          data: validate(input?.data),
          context: {
            userId: "creator",
            supabase: { from: mocks.from, rpc: mocks.rpc },
          },
        }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("./plan.server", () => ({ getPlan: mocks.getPlan }));

import {
  createPage,
  deletePage,
  getMyPages,
  renamePage,
  reorderMyPages,
  setSystemPageVisibility,
} from "./pages.functions";

const calendarId = "11111111-1111-4111-8111-111111111111";
const aboutId = "22222222-2222-4222-8222-222222222222";
const calendar = {
  id: calendarId,
  system: "calendar",
  slug: "__system_calendar",
  name: "Calendar",
  position: 4,
};
const client = { from: mocks.from } as any;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.responses.length = 0;
  mocks.queries.length = 0;
  mocks.getPlan.mockResolvedValue("creator");
});
afterEach(() => vi.unstubAllGlobals());

describe("owned pages", () => {
  it("bounds reorder requests at 100 IDs", async () => {
    const ids = Array.from(
      { length: 101 },
      (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
    );
    mocks.rpc.mockResolvedValue({ error: null });
    await expect(reorderMyPages({ data: { pageIds: ids.slice(0, 100) } })).resolves.toEqual({
      ok: true,
    });
    mocks.rpc.mockClear();
    await expect(async () => reorderMyPages({ data: { pageIds: ids } })).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(["rename", "delete"])(
    "invalidates the previous public slug during %s",
    async (action) => {
      const remove = vi.fn().mockResolvedValue(true);
      vi.stubGlobal("caches", { default: { delete: remove } });
      mocks.responses.push({ data: { id: aboutId, system: null, slug: "old-about" }, error: null });
      if (action === "rename") mocks.responses.push({ data: null, error: null });
      mocks.responses.push(
        { data: { id: aboutId, system: null, slug: "new-about" }, error: null },
        { data: { username: "creator" }, error: null },
        { data: action === "rename" ? [{ slug: "new-about" }] : [], error: null },
        { data: [{ hostname: "creator.example" }], error: null },
      );
      if (action === "rename") await renamePage({ data: { id: aboutId, name: "New about" } });
      else await deletePage({ data: { id: aboutId } });
      const urls = remove.mock.calls.map(([request]) => request.url);
      expect(urls).toContain("https://profile-cache.bento.internal/v2/bento/creator/old-about");
      expect(urls).toContain(
        "https://profile-cache.bento.internal/v2/host/creator.example/old-about",
      );
      if (action === "rename")
        expect(urls).toContain("https://profile-cache.bento.internal/v2/bento/creator/new-about");
    },
  );
  it("invalidates the public profile and calendar caches after a visibility update", async () => {
    const remove = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("caches", { default: { delete: remove } });
    mocks.responses.push(
      { data: calendar, error: null },
      { data: calendar, error: null },
      { data: { username: "creator" }, error: null },
      { data: [{ slug: "about" }], error: null },
      { data: [{ hostname: "creator.example" }], error: null },
    );
    await setSystemPageVisibility(client, "creator", "calendar", false);
    const urls = remove.mock.calls.map(([request]) => request.url);
    expect(urls).toContain("https://profile-cache.bento.internal/v2/bento/creator/about");
    expect(urls).toContain("https://profile-cache.bento.internal/v2/host/creator.example/calendar");
    expect(urls).toContain("https://booking-calendar-cache.bento.internal/v2/creator");
  });
  it("reorders the complete visible owned list through the atomic RPC", async () => {
    mocks.rpc.mockResolvedValue({ error: null });
    await expect(reorderMyPages({ data: { pageIds: [calendarId, aboutId] } })).resolves.toEqual({
      ok: true,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("reorder_creator_pages", {
      page_ids: [calendarId, aboutId],
    });
  });

  it("rejects duplicate reorder IDs and reports database rejection", async () => {
    await expect(async () =>
      reorderMyPages({ data: { pageIds: [calendarId, calendarId] } }),
    ).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue({ error: { message: "Include every visible page." } });
    await expect(reorderMyPages({ data: { pageIds: [calendarId] } })).rejects.toThrow(
      "Include every visible page.",
    );
  });

  it("filters hidden owned rows", async () => {
    mocks.responses.push({ data: [calendar], error: null });
    expect(await getMyPages()).toEqual([calendar]);
    expect(mocks.queries[0].filters).toEqual([
      ["user_id", "creator"],
      ["is_visible", true],
    ]);
  });

  it("hides and restores the same system row without changing its position or layout", async () => {
    for (const visible of [false, true]) {
      mocks.responses.push(
        { data: calendar, error: null },
        { data: { ...calendar, is_visible: visible }, error: null },
      );
      expect(await setSystemPageVisibility(client, "creator", "calendar", visible)).toMatchObject({
        id: calendarId,
        is_visible: visible,
      });
    }
    expect(mocks.queries.filter((q) => q.action === "update").map((q) => q.value)).toEqual([
      { is_visible: false },
      { is_visible: true },
    ]);
    expect(mocks.queries.some((q) => q.action === "delete" || q.action === "insert")).toBe(false);
  });

  it("creates system pages at the end using an internal slug", async () => {
    mocks.responses.push(
      { data: null, error: null },
      { data: { position: 9 }, error: null },
      { data: calendar, error: null },
    );
    await setSystemPageVisibility(client, "creator", "calendar", true, " Book time ");
    expect(mocks.queries.find((q) => q.action === "insert")?.value).toEqual({
      user_id: "creator",
      system: "calendar",
      slug: "__system_calendar",
      name: "Book time",
      is_visible: true,
      position: 10,
    });
  });

  it("renames a system page without changing its stable slug", async () => {
    mocks.responses.push(
      { data: calendar, error: null },
      { data: { ...calendar, name: "Book time" }, error: null },
    );
    await renamePage({ data: { id: calendarId, name: "Book time" } });
    expect(mocks.queries.find((q) => q.action === "update")?.value).toEqual({ name: "Book time" });
  });

  it("reuses the winner of a concurrent system-page insertion", async () => {
    mocks.responses.push(
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: { code: "23505", message: "duplicate" } },
      { data: calendar, error: null },
    );
    expect(await setSystemPageVisibility(client, "creator", "calendar", true)).toEqual(calendar);
    expect(mocks.queries.at(-1)).toMatchObject({
      action: "update",
      value: { is_visible: true },
      filters: [
        ["user_id", "creator"],
        ["system", "calendar"],
      ],
    });
  });

  it("does not let generic delete remove a system page", async () => {
    mocks.responses.push({ data: calendar, error: null });
    await expect(deletePage({ data: { id: calendarId } })).rejects.toThrow(
      "Hide system pages from their page settings.",
    );
    expect(mocks.queries.some((q) => q.action === "delete")).toBe(false);
  });

  it("counts only hosted custom pages and keeps reserved routes unavailable", async () => {
    mocks.responses.push(
      { count: 0, error: null },
      { data: { position: 8 }, error: null },
      { data: null, error: null },
      { data: { slug: "calendar-page" }, error: null },
    );
    expect(await createPage({ data: { name: "Calendar" } })).toMatchObject({
      slug: "calendar-page",
    });
    expect(mocks.queries[0].filters).toEqual([
      ["user_id", "creator"],
      ["system", null],
      ["url", null],
    ]);
    expect(mocks.queries.find((q) => q.action === "insert")?.value.position).toBe(9);
  });
});
