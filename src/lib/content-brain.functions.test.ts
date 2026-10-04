import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  requireContentWorkspace: vi.fn(),
  requestIndex: vi.fn(),
}));

function resultFor(table: string) {
  if (table === "creator_content_profiles") {
    return {
      data: {
        goal: "consistent_publishing",
        niche_keywords: ["creator economy"],
        language: "en",
        region: "global",
        timezone: "UTC",
        platform_frequencies: { linkedin: 3 },
      },
      error: null,
    };
  }
  if (table === "creator_content_index_jobs") return { data: null, error: null };
  if (table === "creator_content_media") return { data: [], error: null };
  if (table === "social_content_insights") return { data: [], error: null };
  if (table === "creator_brain_items") return { data: [], error: null };
  if (table === "social_connections") {
    return {
      data: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          provider: "linkedin",
          provider_handle: " @@creator ",
          provider_display_name: "Creator",
          status: "active",
          reauth_required: false,
        },
      ],
      error: null,
    };
  }
  if (table === "content_connections") {
    return {
      data: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          provider: "notion",
          display_name: "Creator HQ",
          status: "active",
        },
      ],
      error: null,
    };
  }
  if (table === "booking_calendar_connections") {
    return {
      data: [
        { id: "calendar", provider: "google", display_name: "Work calendar", status: "active" },
      ],
      error: null,
    };
  }
  if (table === "booking_fathom_connections") {
    return {
      data: [{ id: "fathom", display_name: "Creator meetings", status: "active" }],
      error: null,
    };
  }
  return { data: { id: "11111111-1111-4111-8111-111111111111" }, error: null };
}

function queryFor(table: string) {
  const query: Record<string, unknown> = {};
  for (const method of [
    "select",
    "eq",
    "in",
    "order",
    "limit",
    "upsert",
    "insert",
    "update",
    "delete",
  ] as const) {
    query[method] = vi.fn((...args: unknown[]) => {
      mocks.calls.push({ table, method, args });
      return query;
    });
  }
  query.maybeSingle = vi.fn(async () => resultFor(table));
  query.single = vi.fn(async () => resultFor(table));
  query.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve(resultFor(table)).then(resolve);
  return query;
}

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (data: unknown) => data;
    const fn: Record<string, unknown> = {};
    fn.middleware = () => fn;
    fn.validator = (schema: (data: unknown) => unknown) => {
      validate = schema;
      return fn;
    };
    fn.handler =
      (handler: (input: { context: { userId: string }; data: unknown }) => unknown) =>
      (input?: { data?: unknown }) =>
        handler({ context: { userId: "owner" }, data: validate(input?.data) });
    return fn;
  },
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => queryFor(table) },
}));
vi.mock("./content-index.server", () => ({ requestContentIndex: mocks.requestIndex }));
vi.mock("./content-access.server", () => ({
  requireContentWorkspace: mocks.requireContentWorkspace,
}));

import {
  deleteBrainItem,
  getContentBrain,
  saveContentProfile,
  setBrainItemLocked,
} from "./content-brain.functions";

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.requireContentWorkspace.mockReset().mockResolvedValue("creator");
});

describe("content Brain server functions", () => {
  it("loads only safe creator-owned Brain and connection summaries", async () => {
    const result = await getContentBrain();
    expect(mocks.requireContentWorkspace).toHaveBeenCalledWith("owner");
    expect(mocks.calls).toContainEqual({
      table: "creator_brain_items",
      method: "eq",
      args: ["user_id", "owner"],
    });
    expect(mocks.calls).toContainEqual({
      table: "social_connections",
      method: "eq",
      args: ["user_id", "owner"],
    });
    expect(result.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "linkedin", handle: "creator", status: "active" }),
        expect.objectContaining({ provider: "notion", displayName: "Creator HQ" }),
        expect.objectContaining({ provider: "google_calendar", displayName: "Work calendar" }),
        expect.objectContaining({ provider: "fathom", displayName: "Creator meetings" }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("access_token");
  });

  it("derives profile ownership from authenticated context", async () => {
    await saveContentProfile({
      data: {
        goal: "reach_growth",
        nicheKeywords: ["AI"],
        language: "en",
        region: "global",
        timezone: "UTC",
        platformFrequencies: { linkedin: 5 },
      },
    });
    const upsert = mocks.calls.find(
      (call) => call.table === "creator_content_profiles" && call.method === "upsert",
    );
    expect(upsert?.args[0]).toMatchObject({ user_id: "owner", goal: "reach_growth" });
  });

  it("scopes Brain locking and deletion to the authenticated creator", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    await setBrainItemLocked({ data: { id, locked: true } });
    await deleteBrainItem({ data: { id } });
    expect(
      mocks.calls.filter(
        (call) =>
          call.table === "creator_brain_items" &&
          call.method === "eq" &&
          call.args[0] === "user_id" &&
          call.args[1] === "owner",
      ),
    ).toHaveLength(4);
  });

  it("checks the Creator-plan entitlement for every operation", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    await setBrainItemLocked({ data: { id, locked: false } });
    expect(mocks.requireContentWorkspace).toHaveBeenCalledWith("owner");
  });
});
