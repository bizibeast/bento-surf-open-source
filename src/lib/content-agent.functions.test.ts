import { beforeEach, describe, expect, it, vi } from "vitest";

const ids = {
  thread: "11111111-1111-4111-8111-111111111111",
  message: "22222222-2222-4222-8222-222222222222",
  connection: "33333333-3333-4333-8333-333333333333",
};

const payload = {
  action: "schedule_proposal",
  message: "Ready to schedule",
  cards: [
    {
      type: "draft",
      cardId: "draft-1",
      platform: "linkedin",
      format: "post",
      title: "",
      body: "A reviewed LinkedIn post.",
      visualBrief: null,
      sourceUrls: [],
      rationale: "Uses confirmed context.",
    },
    {
      type: "schedule_proposal",
      cardId: "schedule-1",
      draftCardId: "draft-1",
      connectionId: ids.connection,
      scheduledAt: "2026-09-19T03:30:00.000Z",
      timezone: "Asia/Kolkata",
    },
  ],
};

const mocks = vi.hoisted(() => ({
  runTurn: vi.fn(),
  inferBrain: vi.fn(),
  requestIndex: vi.fn(),
  saveSocialPostForUser: vi.fn(),
  requireContentWorkspace: vi.fn(),
  enforceRateLimit: vi.fn(),
  insert: vi.fn(),
}));

function queryFor(table: string) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit", "insert", "update", "gt"] as const) {
    query[method] = vi.fn((...args: unknown[]) => {
      if (method === "insert") mocks.insert(table, args[0]);
      return query;
    });
  }
  query.maybeSingle = vi.fn(async () => ({
    data:
      table === "content_agent_messages"
        ? { id: ids.message, thread_id: ids.thread, role: "assistant", payload }
        : { id: ids.thread },
    error: null,
  }));
  query.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(resolve);
  return query;
}

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (value: unknown) => value;
    const fn: Record<string, unknown> = {};
    fn.middleware = () => fn;
    fn.validator = (schema: (value: unknown) => unknown) => {
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
vi.mock("./request-security.server", () => ({
  enforceRequestRateLimit: mocks.enforceRateLimit,
}));
vi.mock("./content-agent.server", () => ({
  runContentAgentTurn: mocks.runTurn,
  inferInitialBrainSuggestions: mocks.inferBrain,
}));
vi.mock("./social-scheduler.functions", () => ({
  saveSocialPostForUser: mocks.saveSocialPostForUser,
}));

import {
  approveAgentScheduleProposal,
  generateInitialBrainSuggestions,
  rejectAgentDraft,
  sendContentAgentMessage,
} from "./content-agent.functions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireContentWorkspace.mockResolvedValue("creator");
  mocks.runTurn.mockResolvedValue({ threadId: ids.thread, result: payload });
  mocks.inferBrain.mockResolvedValue([]);
  mocks.saveSocialPostForUser.mockResolvedValue({ queuedPostId: null });
});

describe("content Agent authenticated functions", () => {
  it("derives the creator from auth and rate limits every Agent turn", async () => {
    await sendContentAgentMessage({ data: { threadId: ids.thread, text: "Plan my week" } });
    expect(mocks.runTurn).toHaveBeenCalledWith({
      userId: "owner",
      threadId: ids.thread,
      text: "Plan my week",
    });
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith(
      "EXPENSIVE_API_RATE_LIMITER",
      "content-agent-turn",
      "owner",
    );
  });

  it("creates initial Brain suggestions without confirming them", async () => {
    await generateInitialBrainSuggestions();
    expect(mocks.requestIndex).toHaveBeenCalledWith("owner", true);
  });

  it("stores rejection feedback without scheduling", async () => {
    await rejectAgentDraft({
      data: { messageId: ids.message, cardId: "draft-1", reason: "Too generic" },
    });
    expect(mocks.insert).toHaveBeenCalledWith(
      "content_agent_messages",
      expect.objectContaining({
        user_id: "owner",
        role: "system_event",
        payload: expect.objectContaining({
          feedback: expect.objectContaining({ type: "rejected" }),
        }),
      }),
    );
    expect(mocks.saveSocialPostForUser).not.toHaveBeenCalled();
  });

  it("schedules only the exact persisted proposal after approval", async () => {
    await approveAgentScheduleProposal({
      data: {
        messageId: ids.message,
        draftCardId: "draft-1",
        scheduleCardId: "schedule-1",
      },
    });
    expect(mocks.saveSocialPostForUser).toHaveBeenCalledWith(
      "owner",
      expect.objectContaining({
        body: "A reviewed LinkedIn post.",
        connectionIds: [ids.connection],
        scheduledAt: "2026-09-19T03:30:00.000Z",
        publishNow: false,
        asDraft: false,
      }),
    );
  });
});
