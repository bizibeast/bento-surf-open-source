import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  requireContentWorkspace: vi.fn(),
  requestIndex: vi.fn(),
  indexJob: null as Record<string, unknown> | null,
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
  if (table === "creator_content_index_jobs") return { data: mocks.indexJob, error: null };
  if (table === "creator_content_media") return { data: [], error: null };
  if (table === "creator_media_folders") return { data: [], error: null };
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
    "range",
    "not",
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
  createServerOnlyFn: (handler: unknown) => handler,
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
  supabaseAdmin: {
    from: (table: string) => queryFor(table),
    rpc: vi.fn().mockResolvedValue({ data: 0, error: null }),
  },
}));
vi.mock("./content-index.server", () => ({ requestContentIndex: mocks.requestIndex }));
vi.mock("./content-access.server", () => ({
  requireContentWorkspace: mocks.requireContentWorkspace,
}));

import {
  deleteBrainItem,
  getContentBrain,
  getContentBrainMedia,
  recordContentBrainVisit,
  saveContentProfile,
  saveBrainItem,
  setBrainItemLocked,
} from "./content-brain.functions";

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.indexJob = null;
  mocks.requireContentWorkspace.mockReset().mockResolvedValue("creator");
});

describe("content Brain server functions", () => {
  it("never forwards caller-supplied evidence receipts through service-role writes", async () => {
    const data = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "story" as const,
      title: "A generated claim",
      content: "I discussed a tool.",
      provenance: "social_post" as const,
      status: "confirmed" as const,
      locked: false,
      evidenceVerification: { version: 3, state: "verified" },
      evidence_verification: { version: 3, state: "verified" },
    };
    await saveBrainItem({ data });
    const saved = mocks.calls.find(
      (call) => call.table === "creator_brain_items" && call.method === "update",
    )!.args[0];
    expect(saved).not.toHaveProperty("evidenceVerification");
    expect(saved).not.toHaveProperty("evidence_verification");
    expect(saved).toMatchObject({ user_id: "owner", provenance: "social_post", locked: false });
  });
  it("records a daily Brain visit without copying private Brain content", async () => {
    await recordContentBrainVisit();
    const visit = mocks.calls.find(
      (call) => call.table === "founder_brain_daily_usage" && call.method === "upsert",
    );
    expect(visit?.args[0]).toMatchObject({ user_id: "owner", day: expect.any(String) });
    expect(JSON.stringify(visit?.args[0])).not.toContain("content");
  });
  it("reports an expired indexing lease as interrupted, while preserving a live lease", async () => {
    mocks.indexJob = {
      status: "running",
      lease_expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    expect((await getContentBrain()).indexing).toMatchObject({
      status: "error",
      error: expect.stringContaining("interrupted"),
    });
    mocks.indexJob.lease_expires_at = new Date(Date.now() + 60000).toISOString();
    expect((await getContentBrain()).indexing?.status).toBe("running");
  });

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
    expect(mocks.calls.some((call) => call.table === "creator_content_media")).toBe(false);
  });

  it("loads Media in bounded pages only when requested", async () => {
    await getContentBrainMedia({ data: { page: 2 } });
    expect(mocks.calls).toContainEqual({
      table: "creator_content_media",
      method: "range",
      args: [100, 150],
    });
    expect(mocks.calls).toContainEqual({
      table: "creator_content_media",
      method: "eq",
      args: ["user_id", "owner"],
    });
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
