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
  recordEvent: vi.fn(),
  runTurn: vi.fn(),
  inferBrain: vi.fn(),
  requestIndex: vi.fn(),
  saveSocialPostForUser: vi.fn(),
  requireContentWorkspace: vi.fn(),
  enforceRateLimit: vi.fn(),
  insert: vi.fn(),
  rpc: vi.fn(),
  messageRows: [] as Array<{ id: string; created_at: string }>,
  queries: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));

function queryFor(table: string) {
  const query: Record<string, unknown> = {};
  for (const method of [
    "select",
    "eq",
    "order",
    "limit",
    "insert",
    "update",
    "delete",
    "gt",
  ] as const) {
    query[method] = vi.fn((...args: unknown[]) => {
      mocks.queries.push({ table, method, args });
      if (method === "insert") mocks.insert(table, args[0]);
      return query;
    });
  }
  query.maybeSingle = vi.fn(async () => ({
    data:
      table === "content_agent_messages"
        ? { id: ids.message, thread_id: ids.thread, role: "assistant", payload }
        : { id: ids.thread, content_revision: 7 },
    error: null,
  }));
  query.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({
      data: table === "content_agent_messages" ? mocks.messageRows : [],
      error: null,
    }).then(resolve);
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
        handler({
          context: {
            userId: "owner",
            supabase: { scope: "authenticated" },
            accessToken: "user-jwt",
          } as any,
          data: validate(input?.data),
        });
    return fn;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => queryFor(table), rpc: mocks.rpc },
}));
vi.mock("./content-workspace-analytics.server", () => ({ recordContentEvent: mocks.recordEvent }));
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
vi.mock("./content-agent-preparation.server", () => ({
  prepareAgentMessage: async () => ({ draftStates: {} }),
}));
vi.mock("./content-agent-media.server", () => ({
  resolveOwnedAgentMedia: async () => [
    { key: "users/owner/photo.jpg", mimeType: "image/jpeg", size: 100 },
  ],
  registerAgentMedia: vi.fn(),
}));

import {
  approveAgentScheduleProposal,
  generateInitialBrainSuggestions,
  rejectAgentDraft,
  regenerateAgentDraft,
  sendContentAgentMessage,
  listContentAgentThreads,
  listContentAgentThreadsPage,
  setContentAgentThreadPinned,
  renameContentAgentChat,
  deleteContentAgentChat,
  markContentAgentThreadRead,
  getContentAgentThread,
} from "./content-agent.functions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queries.length = 0;
  mocks.messageRows = [];
  mocks.rpc.mockResolvedValue({
    data: { agent: { id: ids.thread, kind: "agent" }, chats: [], nextCursor: null },
    error: null,
  });
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
      attachmentIds: [],
      toolContext: {
        userId: "owner",
        supabase: { scope: "authenticated" },
        accessToken: "user-jwt",
      },
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
        revision: 0,
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
      { messageId: ids.message, cardId: "draft-1", revision: 0 },
    );
  });
});

describe("content agent sidebar contract", () => {
  it("renames and deletes only chats owned by the authenticated workspace", async () => {
    await renameContentAgentChat({ data: { threadId: ids.thread, title: "  Better title  " } });
    expect(mocks.queries).toEqual(
      expect.arrayContaining([
        { table: "content_agent_threads", method: "update", args: [{ title: "Better title" }] },
        { table: "content_agent_threads", method: "eq", args: ["user_id", "owner"] },
        { table: "content_agent_threads", method: "eq", args: ["kind", "chat"] },
      ]),
    );
    mocks.queries.length = 0;
    await deleteContentAgentChat({ data: { threadId: ids.thread } });
    expect(mocks.queries).toEqual(
      expect.arrayContaining([
        { table: "content_agent_threads", method: "delete", args: [] },
        { table: "content_agent_threads", method: "eq", args: ["user_id", "owner"] },
        { table: "content_agent_threads", method: "eq", args: ["kind", "chat"] },
      ]),
    );
  });
  it("preserves the legacy list array with its named-agent row", async () => {
    const rows = await listContentAgentThreads();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toEqual([{ id: ids.thread, kind: "agent" }]);
  });
  it("passes the full pinned/activity/id cursor for later ordinary-chat pages", async () => {
    const cursor = { pinnedAt: null, lastMessageAt: "2026-10-12T10:00:00.000Z", id: ids.thread };
    await listContentAgentThreadsPage({ data: { cursor, limit: 50 } });
    expect(mocks.rpc).toHaveBeenCalledWith("list_content_agent_threads_page", {
      p_user_id: "owner",
      p_limit: 50,
      p_cursor: cursor,
    });
  });
  it.each([true, false])(
    "pins or unpins only the active workspace's requested thread: %s",
    async (pinned) => {
      mocks.rpc.mockResolvedValue({
        data: { id: ids.thread, pinned_at: pinned ? "timestamp" : null },
        error: null,
      });
      const result = await setContentAgentThreadPinned({ data: { threadId: ids.thread, pinned } });
      expect(result.pinned_at).toBe(pinned ? "timestamp" : null);
      expect(mocks.rpc).toHaveBeenCalledWith("set_content_agent_thread_state", {
        p_user_id: "owner",
        p_thread_id: ids.thread,
        p_pinned: pinned,
      });
    },
  );
  it("marks read using the database time without accepting a caller timestamp", async () => {
    await markContentAgentThreadRead({ data: { threadId: ids.thread } });
    expect(mocks.rpc).toHaveBeenCalledWith("set_content_agent_thread_state", {
      p_user_id: "owner",
      p_thread_id: ids.thread,
      p_mark_read: true,
    });
  });
  it("rejects state mutation when no owned thread is returned", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    await expect(
      setContentAgentThreadPinned({ data: { threadId: ids.thread, pinned: true } }),
    ).rejects.toThrow("unavailable");
  });
  it("loads the latest retained messages for a long running named agent", async () => {
    mocks.messageRows = [
      { id: "new", created_at: "2026-10-12" },
      { id: "old", created_at: "2026-10-11" },
    ];
    const result = await getContentAgentThread({ data: { threadId: ids.thread } });
    expect(result.messages.map((message: { id: string }) => message.id)).toEqual(["old", "new"]);
    expect(mocks.queries).toContainEqual({
      table: "content_agent_messages",
      method: "order",
      args: ["created_at", { ascending: false }],
    });
    expect(mocks.queries).toContainEqual({
      table: "content_agent_messages",
      method: "eq",
      args: ["user_id", "owner"],
    });
  });
});

it("marks only through the last displayed message when a message ID is supplied", async () => {
  await markContentAgentThreadRead({
    data: { threadId: ids.thread, throughMessageId: ids.message },
  });
  expect(mocks.rpc).toHaveBeenCalledWith("set_content_agent_thread_state", {
    p_user_id: "owner",
    p_thread_id: ids.thread,
    p_mark_read: true,
    p_through_message_id: ids.message,
  });
});

it("passes selected owned card identity into regeneration without accepting replacement draft text", async () => {
  await regenerateAgentDraft({
    data: {
      messageId: ids.message,
      cardId: "draft-1",
      reason: "Keep the hook; tighten the closing",
    },
  });
  expect(mocks.runTurn).toHaveBeenCalledWith({
    userId: "owner",
    threadId: ids.thread,
    revision: { messageId: ids.message, cardId: "draft-1" },
    text: expect.stringContaining("Keep the hook"),
  });
  expect(mocks.queries).toContainEqual({
    table: "content_agent_messages",
    method: "eq",
    args: ["user_id", "owner"],
  });
});
it("rejects a regeneration card absent from the owned persisted result", async () => {
  await expect(
    regenerateAgentDraft({ data: { messageId: ids.message, cardId: "not-owned", reason: "Edit" } }),
  ).rejects.toThrow("unavailable");
  expect(mocks.runTurn).not.toHaveBeenCalled();
});

it("scopes proactive feedback to the authenticated workspace and rejects unavailable messages", async () => {
  const { giveContentAgentFeedback } = await import("./content-agent.functions");
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  await giveContentAgentFeedback({ data: { messageId: ids.message, feedback: "not_relevant" } });
  expect(mocks.rpc).toHaveBeenCalledWith("feedback_content_agent_signal", {
    p_user_id: "owner",
    p_message_id: ids.message,
    p_feedback: "not_relevant",
  });
  expect(mocks.requireContentWorkspace).toHaveBeenCalledWith("owner", "contentAgent");
  mocks.rpc.mockResolvedValue({ data: false, error: null });
  await expect(
    giveContentAgentFeedback({ data: { messageId: ids.message, feedback: "useful" } }),
  ).rejects.toThrow("unavailable");
});
it("edits through the atomic draft RPC instead of replacing metadata", async () => {
  const { saveAgentDraft } = await import("./content-agent.functions");
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  await saveAgentDraft({
    data: { messageId: ids.message, cardId: "draft-1", body: "Creator edit", revision: 0 },
  });
  expect(mocks.rpc).toHaveBeenCalledWith("mutate_content_agent_draft", {
    p_user_id: "owner",
    p_message_id: ids.message,
    p_card_id: "draft-1",
    p_revision: 0,
    p_operation: "edit",
    p_patch: { body: "Creator edit" },
    p_media: [],
  });
  expect(mocks.recordEvent).toHaveBeenCalledExactlyOnceWith("owner", "content_agent_draft_review", {
    status: "edited",
    count: 1,
  });
});

it("records copy edits only after durable success and excludes failures and media-only changes", async () => {
  const { saveAgentDraft } = await import("./content-agent.functions");
  const { mutateAgentDraft } = await import("./content-agent.actions");
  let finish!: (value: unknown) => void;
  mocks.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const data = {
    messageId: ids.message,
    cardId: "draft-1",
    revision: 0,
    body: "Private draft https://private.test/source",
  };
  const saving = saveAgentDraft({ data });
  await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
  expect(mocks.recordEvent).not.toHaveBeenCalled();
  finish({ data: { revision: 1 }, error: null });
  await saving;
  expect(mocks.recordEvent).toHaveBeenCalledExactlyOnceWith("owner", "content_agent_draft_review", {
    status: "edited",
    count: 1,
  });
  mocks.recordEvent.mockClear();
  mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "Draft changed" } });
  await expect(saveAgentDraft({ data })).rejects.toThrow("Draft changed");
  expect(mocks.recordEvent).not.toHaveBeenCalled();
  // Internal image/background repair can use edit, but is not a creator copy-save endpoint.
  mocks.rpc.mockResolvedValue({ data: { revision: 2 }, error: null });
  await mutateAgentDraft("owner", data, "edit", { body: payload.cards[0].body, slides: undefined });
  expect(mocks.recordEvent).not.toHaveBeenCalled();
});

it("accepts Less like this through the owner-scoped feedback API", async () => {
  const { giveContentAgentFeedback } = await import("./content-agent.functions");
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  await giveContentAgentFeedback({ data: { messageId: ids.message, feedback: "less_like_this" } });
  expect(mocks.rpc).toHaveBeenCalledWith("feedback_content_agent_signal", {
    p_user_id: "owner",
    p_message_id: ids.message,
    p_feedback: "less_like_this",
  });
});
it("rejects a stale client edit without invoking the atomic writer", async () => {
  const { saveAgentDraft } = await import("./content-agent.functions");
  mocks.rpc.mockClear();
  await expect(
    saveAgentDraft({
      data: { messageId: ids.message, cardId: "draft-1", body: "Stale", revision: 3 },
    }),
  ).rejects.toThrow("Draft changed");
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.recordEvent).not.toHaveBeenCalled();
  expect(mocks.queries).toContainEqual(
    expect.objectContaining({
      table: "content_agent_messages",
      method: "gt",
      args: ["expires_at", expect.any(String)],
    }),
  );
});

it("checks the thread revision without rereading message payloads when unchanged", async () => {
  const result = await getContentAgentThread({ data: { threadId: ids.thread, knownRevision: 7 } });
  expect(result.unchanged).toBe(true);
  expect(mocks.queries.some((q) => q.table === "content_agent_messages")).toBe(false);
});
