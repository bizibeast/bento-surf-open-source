import { beforeEach, describe, expect, it, vi } from "vitest";

const ids = {
  message: "22222222-2222-4222-8222-222222222222",
  connection: "33333333-3333-4333-8333-333333333333",
};

const result = {
  action: "schedule_proposal",
  message: "Ready",
  cards: [
    {
      type: "draft",
      cardId: "draft-1",
      platform: "linkedin",
      format: "post",
      title: "",
      body: "Reviewed post",
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
    {
      type: "brain_proposal",
      cardId: "brain-1",
      kind: "story",
      title: "Launch lesson",
      content: "Ship narrow versions first.",
      sourceUrl: null,
      sourceRef: null,
    },
  ],
};

const mocks = vi.hoisted(() => ({
  inserted: vi.fn(),
  savePost: vi.fn(),
  recordEvent: vi.fn(),
}));

function queryFor(table: string) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq"]) query[method] = vi.fn(() => query);
  query.insert = vi.fn((value: unknown) => {
    mocks.inserted(table, value);
    return query;
  });
  query.maybeSingle = vi.fn(async () => ({
    data: { id: ids.message, thread_id: "thread", role: "assistant", payload: result },
    error: null,
  }));
  query.single = vi.fn(async () => ({ data: { id: "brain-id" }, error: null }));
  return query;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => queryFor(table) },
}));
vi.mock("./social-scheduler.functions", () => ({
  saveSocialPostForUser: mocks.savePost,
}));
vi.mock("./content-workspace-analytics.server", () => ({
  recordContentEvent: mocks.recordEvent,
}));

import {
  approveAgentBrainProposalForUser,
  approveAgentScheduleProposalForUser,
} from "./content-agent.actions";

describe("Content Agent shared actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.savePost.mockResolvedValue({ postId: "post" });
  });

  it("schedules the exact persisted proposal for the requested creator", async () => {
    await approveAgentScheduleProposalForUser("creator-a", {
      messageId: ids.message,
      draftCardId: "draft-1",
      scheduleCardId: "schedule-1",
    });
    expect(mocks.savePost).toHaveBeenCalledWith(
      "creator-a",
      expect.objectContaining({
        body: "Reviewed post",
        connectionIds: [ids.connection],
        publishNow: false,
        asDraft: false,
      }),
    );
  });

  it("confirms only the persisted Brain proposal", async () => {
    await approveAgentBrainProposalForUser("creator-a", {
      messageId: ids.message,
      cardId: "brain-1",
    });
    expect(mocks.inserted).toHaveBeenCalledWith(
      "creator_brain_items",
      expect.objectContaining({
        user_id: "creator-a",
        status: "confirmed",
        provenance: "agent_chat",
      }),
    );
  });
});
