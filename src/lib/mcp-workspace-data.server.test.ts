import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatorMcpContext } from "./mcp.creator-ops.server";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  getPlan: vi.fn(),
  access: vi.fn(),
  rate: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("./plan.server", () => ({ getPlan: mocks.getPlan, requirePlanEntitlement: mocks.access }));
vi.mock("./content-access.server", () => ({ requireContentWorkspace: mocks.access }));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: mocks.rate }));

import { readWorkspaceData } from "./mcp-workspace-data.server";
import { getAnalyticsWorkspace } from "./mcp.creator-ops.server";

const owner = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000099";
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Row = Record<string, unknown>;
let rows: Record<string, Row[]>;
let calls: Array<{
  table: string;
  filters: Array<[string, string, unknown]>;
  order?: string;
  limit?: number;
  fields?: string;
}>;
const rpc = vi.fn();
const context = {
  userId: owner,
  supabase: { from: mocks.from, rpc },
} as unknown as CreatorMcpContext;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getPlan.mockResolvedValue("creator_plus");
  rpc.mockResolvedValue({ data: { totalViews: 10 }, error: null });
  rows = { profiles: [{ id: owner, account_timezone: "Asia/Kolkata" }] };
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Reads must not call providers");
    }),
  );
  mocks.from.mockImplementation((table: string) => {
    const call: (typeof calls)[number] = { table, filters: [] };
    calls.push(call);
    const result = () => {
      let data = (rows[table] || []).filter((row) =>
        call.filters.every(([op, key, value]) => {
          if (op === "eq") return row[key] === value;
          if (op === "is") return (row[key] ?? null) === value;
          if (op === "gt") return String(row[key]) > String(value);
          if (op === "gte") return String(row[key]) >= String(value);
          if (op === "lt") return String(row[key]) < String(value);
          if (op === "ilike")
            return String(row[key])
              .toLowerCase()
              .includes(String(value).slice(1, -1).toLowerCase());
          if (op === "saved")
            return row.feedback === "saved" || (row.metadata as Row)?.saved === true;
          return false;
        }),
      );
      if (call.order)
        data = [...data].sort((a, b) =>
          String(a[call.order!]).localeCompare(String(b[call.order!])),
        );
      if (call.limit) data = data.slice(0, call.limit);
      return { data, error: null };
    };
    const query = {
      select: (fields: string) => {
        call.fields = fields;
        return query;
      },
      eq: (key: string, value: unknown) => {
        call.filters.push(["eq", key, value]);
        return query;
      },
      is: (key: string, value: unknown) => {
        call.filters.push(["is", key, value]);
        return query;
      },
      gt: (key: string, value: unknown) => {
        call.filters.push(["gt", key, value]);
        return query;
      },
      gte: (key: string, value: unknown) => {
        call.filters.push(["gte", key, value]);
        return query;
      },
      lt: (key: string, value: unknown) => {
        call.filters.push(["lt", key, value]);
        return query;
      },
      ilike: (key: string, value: unknown) => {
        call.filters.push(["ilike", key, value]);
        return query;
      },
      or: () => {
        call.filters.push(["saved", "", null]);
        return query;
      },
      order: (key: string) => {
        if (table === "social_analytics_snapshots" && key === "captured_at")
          throw new Error("column does not exist");
        call.order = key;
        return query;
      },
      limit: (limit: number) => {
        call.limit = limit;
        return query;
      },
      single: async () => ({ data: result().data[0] || null, error: null }),
      then: <T>(resolve: (value: ReturnType<typeof result>) => T) =>
        Promise.resolve(result()).then(resolve),
    };
    return query;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("stored MCP workspace data", () => {
  it.each([
    ["brain_items", "creator_brain_items"],
    ["brain_sources", "content_source_records"],
    ["routines", "content_routines"],
    ["routine_runs", "content_routine_runs"],
    ["discover_items", "creator_content_recommendations"],
    ["social_accounts", "social_analytics_snapshots"],
    ["social_posts", "social_content_insights"],
    ["social_history", "social_analytics_history"],
  ] as const)(
    "scopes %s to the authenticated workspace without provider calls",
    async (collection, table) => {
      rows[table] = [
        { id: id(1), connection_id: id(1), user_id: owner, title: "Own", content: "Own" },
        {
          id: id(2),
          connection_id: id(2),
          user_id: other,
          title: "Other private",
          content: "Other private",
        },
      ];
      const result = await readWorkspaceData(context, { collection });
      expect(result.items).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("Other private");
      expect(calls.find((call) => call.table === table)?.filters).toContainEqual([
        "eq",
        "user_id",
        owner,
      ]);
      expect(calls.find((call) => call.table === table)?.limit).toBe(11);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("traverses complete pages and retrieves a full document without silent text truncation", async () => {
    const fullText = "A creator's complete story. ".repeat(400);
    rows.creator_brain_items = [1, 2, 3].map((n) => ({
      id: id(n),
      user_id: owner,
      content: fullText,
      title: "Voice",
      access_token: "secret",
    }));
    const first = await readWorkspaceData(context, { collection: "brain_items", limit: 2 });
    expect(first).toMatchObject({ hasMore: true, nextCursor: id(2) });
    expect(first.items[0]).toMatchObject({
      content: fullText.slice(0, 500),
      contentTruncated: true,
    });
    const second = await readWorkspaceData(context, {
      collection: "brain_items",
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second).toMatchObject({ items: [{ id: id(3) }], hasMore: false, nextCursor: null });
    const detail = await readWorkspaceData(context, { collection: "brain_items", id: id(1) });
    expect(detail.items[0]).toMatchObject({ content: fullText, contentTruncated: false });
    expect(JSON.stringify(detail)).not.toContain("secret");
    expect(
      await readWorkspaceData(
        { ...context, userId: other },
        { collection: "brain_items", id: id(1) },
      ),
    ).toMatchObject({ items: [] });
  });

  it("omits deleted source records and preserves original text and provenance", async () => {
    rows.content_source_records = [
      {
        id: id(1),
        user_id: owner,
        title: "Launch notes",
        body: "Full source",
        canonical_source_url: "https://example.com/source",
        deleted_at: null,
      },
      { id: id(2), user_id: owner, title: "Deleted", deleted_at: "2026-10-10" },
    ];
    const result = await readWorkspaceData(context, {
      collection: "brain_sources",
      query: "Launch",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      body: "Full source",
      canonical_source_url: "https://example.com/source",
    });
  });

  it("returns history IDs as strings accepted by the detail schema", async () => {
    rows.social_analytics_history = [
      { id: 123, user_id: owner, captured_at: "2026-10-16T12:00:00Z" },
    ];
    const result = await readWorkspaceData(context, { collection: "social_history" });
    expect(result.items[0].id).toBe("123");
    expect(result.nextCursor).toBeNull();
  });

  it("returns older bookmarks and safe inspiration fields without arbitrary provider metadata", async () => {
    rows.creator_content_recommendations = [
      {
        id: id(1),
        user_id: owner,
        title: "Old saved",
        feedback: "pending",
        metadata: {
          saved: true,
          api_key: "secret",
          stats: { views: 20, token: "secret" },
          inspiration: { hook: "The hook", outline: ["Point"], token: "secret" },
        },
      },
      { id: id(2), user_id: owner, title: "Not saved", feedback: "pending" },
    ];
    const result = await readWorkspaceData(context, {
      collection: "discover_items",
      savedOnly: true,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      saved: true,
      stats: { views: 20 },
      inspiration: { hook: "The hook", outline: ["Point"] },
    });
    expect(JSON.stringify(result)).not.toMatch(/api_key|token|secret/);
  });

  it("honors plan history limits in the creator timezone, even for id lookups", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    mocks.getPlan.mockResolvedValue("free");
    rows.social_content_insights = [
      { id: id(1), user_id: owner, published_at: "2026-10-09T18:29:59Z" },
      { id: id(2), user_id: owner, published_at: "2026-10-09T18:30:00Z" },
    ];
    const result = await readWorkspaceData(context, { collection: "social_posts", range: "all" });
    expect(result).toMatchObject({
      items: [{ id: id(2) }],
      historyDays: 7,
      effectiveStart: "2026-10-10",
    });
    expect(
      await readWorkspaceData(context, { collection: "social_posts", id: id(1) }),
    ).toMatchObject({ items: [] });
  });

  it("rejects malformed requests before any database read", async () => {
    for (const input of [
      { collection: "brain_items", limit: 26 },
      { collection: "brain_items", userId: other },
      { collection: "brain_items", cursor: "1" },
      { collection: "social_history", cursor: id(1) },
      { collection: "routines", query: "anything" },
      { collection: "brain_items", id: id(1), cursor: id(2) },
    ])
      await expect(
        readWorkspaceData(context, input as Parameters<typeof readWorkspaceData>[1]),
      ).rejects.toThrow();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("stops on denied workspace access or rate limits", async () => {
    mocks.access.mockRejectedValueOnce(new Error("Not available on plan"));
    await expect(readWorkspaceData(context, { collection: "brain_items" })).rejects.toThrow(
      "Not available",
    );
    mocks.rate.mockRejectedValueOnce(new Error("Rate limit"));
    await expect(readWorkspaceData(context, { collection: "social_posts" })).rejects.toThrow(
      "Rate limit",
    );
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("loads analytics using the actual snapshot timestamp and filters old posts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    rows.social_analytics_snapshots = [
      { user_id: owner, connection_id: id(1), fetched_at: "2026-10-16T00:00:00Z", followers: 123 },
    ];
    rows.social_content_insights = [
      { user_id: owner, id: id(1), published_at: "2026-10-16T10:00:00Z" },
      { user_id: owner, id: id(2), published_at: "2025-01-01T00:00:00Z" },
    ];
    const result = await getAnalyticsWorkspace(context, { range: "7d" });
    expect(result.socialSnapshots).toHaveLength(1);
    expect(result.socialContent).toHaveLength(1);
    expect(calls.find((call) => call.table === "social_analytics_snapshots")?.order).toBe(
      "fetched_at",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("imported social analytics filters", () => {
  it.each(["video", "VIDEO", " ViDeO "])(
    "filters canonical content type from %s while retaining owner, date bounds and freshness",
    async (contentType) => {
      rows.social_content_insights = [
        {
          id: id(1),
          user_id: owner,
          connection_id: id(5),
          provider: "instagram",
          content_type: "video",
          caption: "Reel",
          published_at: "2026-10-19T03:32:27Z",
          fetched_at: "2026-10-22T02:01:00Z",
          views: 1251,
        },
        {
          id: id(2),
          user_id: owner,
          connection_id: id(5),
          provider: "instagram",
          content_type: "video",
          published_at: "2026-10-20T03:32:27Z",
        },
        {
          id: id(3),
          user_id: other,
          connection_id: id(5),
          provider: "instagram",
          content_type: "video",
          published_at: "2026-10-19T03:32:27Z",
        },
        {
          id: id(4),
          user_id: owner,
          connection_id: id(5),
          provider: "youtube",
          content_type: "video",
          published_at: "2026-10-19T03:32:27Z",
        },
      ];
      const result = await readWorkspaceData(context, {
        collection: "social_posts",
        provider: "instagram",
        connectionId: id(5),
        contentType,
        dateFrom: "2026-10-18T18:30:00Z",
        dateTo: "2026-10-19T18:30:00Z",
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        id: id(1),
        views: 1251,
        fetched_at: "2026-10-22T02:01:00Z",
      });
      const call = calls.find((call) => call.table === "social_content_insights")!;
      expect(call.filters).toContainEqual(["eq", "user_id", owner]);
      expect(call.filters).toContainEqual(["eq", "content_type", "video"]);
      expect(call.filters).toContainEqual(["lt", "published_at", "2026-10-19T18:30:00Z"]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("rejects irrelevant social filters rather than silently ignoring them", async () => {
    for (const input of [
      { collection: "brain_items", provider: "instagram" },
      { collection: "social_posts", targetStatus: "published" },
      { collection: "social_accounts", dateFrom: "2026-10-19T00:00:00Z" },
    ]) {
      await expect(
        readWorkspaceData(context, input as Parameters<typeof readWorkspaceData>[1]),
      ).rejects.toThrow();
    }
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
