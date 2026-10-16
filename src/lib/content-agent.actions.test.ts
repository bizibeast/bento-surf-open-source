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
  rpc: vi.fn(),
  resolve: vi.fn(),
  savePost: vi.fn(),
  recordEvent: vi.fn(),
  payload: null as unknown,
}));

function queryFor(table: string) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "gt"]) query[method] = vi.fn(() => query);
  query.insert = vi.fn((value: unknown) => {
    mocks.inserted(table, value);
    return query;
  });
  query.maybeSingle = vi.fn(async () => ({
    data: {
      id: ids.message,
      thread_id: "thread",
      role: "assistant",
      payload: mocks.payload || result,
    },
    error: null,
  }));
  query.single = vi.fn(async () => ({ data: { id: "brain-id" }, error: null }));
  return query;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => queryFor(table), rpc: mocks.rpc },
}));
vi.mock("./social-scheduler.functions", () => ({
  saveSocialPostForUser: mocks.savePost,
}));
vi.mock("./content-workspace-analytics.server", () => ({
  recordContentEvent: mocks.recordEvent,
}));

vi.mock("./content-agent-media.server", () => ({ resolveOwnedAgentMedia: mocks.resolve }));
vi.mock("./content-agent-preparation.server", () => ({
  prepareAgentMessage: async () => ({ draftStates: {} }),
}));
beforeEach(() => {
  mocks.resolve.mockResolvedValue([]);
  mocks.rpc.mockResolvedValue({ data: { revision: 1 }, error: null });
});
import {
  mutateAgentDraft,
  approveAgentBrainProposalForUser,
  approveAgentScheduleProposalForUser,
} from "./content-agent.actions";

describe("Content Agent shared actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.savePost.mockResolvedValue({ postId: "post" });
  });

  it("schedules the exact persisted proposal for the requested creator", async () => {
    mocks.resolve.mockResolvedValue([
      { key: "users/creator-a/photo.jpg", mimeType: "image/jpeg", size: 100 },
    ]);
    await approveAgentScheduleProposalForUser("creator-a", {
      messageId: ids.message,
      draftCardId: "draft-1",
      scheduleCardId: "schedule-1",
      revision: 0,
    });
    expect(mocks.savePost).toHaveBeenCalledWith(
      "creator-a",
      expect.objectContaining({
        body: "Reviewed post",
        connectionIds: [ids.connection],
        publishNow: false,
        asDraft: false,
      }),
      { messageId: ids.message, cardId: "draft-1", revision: 0 },
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

it("blocks old Instagram proposals and stale revisions before scheduler writes", async () => {
  const { resolveAgentDraftMedia } = await import("./content-agent.actions");
  const { storedContentAgentResultSchema } = await import("./content-agent-proactive");
  const instagram = storedContentAgentResultSchema.parse({
    ...result,
    cards: [
      {
        ...result.cards[0],
        platform: "instagram",
        format: "carousel",
        slides: [
          { heading: "Cover", body: "Promise" },
          { heading: "Action", body: "Takeaway" },
        ],
      },
    ],
  });
  await expect(resolveAgentDraftMedia("creator-a", instagram, "draft-1", 0)).rejects.toThrow(
    "visuals needed",
  );
  await expect(
    resolveAgentDraftMedia(
      "creator-a",
      { ...instagram, draftStates: { "draft-1": { revision: 2 } } },
      "draft-1",
      1,
    ),
  ).rejects.toThrow("Draft changed");
});

describe("account-aware X schedule approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.payload = {
      ...result,
      cards: result.cards.map((card) =>
        card.type === "draft" ? { ...card, platform: "twitter", body: "a".repeat(500) } : card,
      ),
    };
  });
  it.each(["Premium", "None"] as const)(
    "delegates a long %s proposal to the account-aware scheduler",
    async (tier) => {
      const { validatePostForProviders } = await import("./social-scheduler");
      const { xAccountCapabilities } = await import("./x-account");
      const capabilities = xAccountCapabilities(tier, null);
      mocks.savePost.mockImplementationOnce(
        async (
          _userId: string,
          input: {
            body: string;
            media: import("./social-scheduler").SchedulerMedia[];
            title: string;
          },
        ) => {
          const errors = validatePostForProviders(
            input.body,
            input.media,
            ["twitter"],
            input.title,
            {},
            capabilities,
          );
          if (errors.twitter) throw new Error(errors.twitter);
          return { postId: "post" };
        },
      );
      const approval = approveAgentScheduleProposalForUser("creator-a", {
        messageId: ids.message,
        draftCardId: "draft-1",
        scheduleCardId: "schedule-1",
        revision: 0,
      });
      if (tier === "Premium") await expect(approval).resolves.toEqual({ postId: "post" });
      else await expect(approval).rejects.toThrow("280");
      expect(mocks.savePost).toHaveBeenCalledWith(
        "creator-a",
        expect.objectContaining({
          body: "a".repeat(500),
          connectionIds: [ids.connection],
          publishNow: false,
          asDraft: false,
        }),
        { messageId: ids.message, cardId: "draft-1", revision: 0 },
      );
    },
  );
});

describe("direct draft handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.payload = {
      ...result,
      cards: [{ ...result.cards[0], platform: "twitter", body: "a".repeat(500) }],
    };
  });
  it("opens long X copy without choosing or scheduling an account, then enforces its capabilities", async () => {
    const { validatePostForProviders } = await import("./social-scheduler");
    const { xAccountCapabilities } = await import("./x-account");
    await mutateAgentDraft(
      "creator-a",
      { messageId: ids.message, cardId: "draft-1", revision: 0 },
      "handoff",
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "mutate_content_agent_draft",
      expect.objectContaining({
        p_user_id: "creator-a",
        p_operation: "handoff",
        p_revision: 0,
        p_patch: {},
        p_media: [],
      }),
    );
    expect(mocks.savePost).not.toHaveBeenCalled();
    expect(
      validatePostForProviders(
        "a".repeat(500),
        [],
        ["twitter"],
        "",
        {},
        xAccountCapabilities("Premium", null),
      ),
    ).toEqual({});
    expect(
      validatePostForProviders(
        "a".repeat(500),
        [],
        ["twitter"],
        "",
        {},
        xAccountCapabilities("None", null),
      ).twitter,
    ).toContain("280");
  });
  it("still rejects stale revisions and incompatible owned media before handoff", async () => {
    const ref = { messageId: ids.message, cardId: "draft-1", revision: 0 };
    await expect(mutateAgentDraft("creator-a", { ...ref, revision: 1 }, "handoff")).rejects.toThrow(
      "Draft changed",
    );
    mocks.resolve.mockResolvedValue([
      { key: "users/creator-a/image", mimeType: "image/jpeg", size: 10 },
      { key: "users/creator-a/video", mimeType: "video/mp4", size: 10 },
    ]);
    await expect(mutateAgentDraft("creator-a", ref, "handoff")).rejects.toThrow(
      "cannot mix images and video",
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("keeps account-independent copy limits and complete carousel readiness", async () => {
    mocks.resolve.mockResolvedValue([
      { key: "users/creator-a/photo.jpg", mimeType: "image/jpeg", size: 100 },
    ]);
    const ref = { messageId: ids.message, cardId: "draft-1", revision: 0 };
    mocks.payload = { ...result, cards: [{ ...result.cards[0], body: "a".repeat(4000) }] };
    await expect(mutateAgentDraft("creator-a", ref, "handoff")).rejects.toThrow("3,000");
    mocks.payload = {
      ...result,
      cards: [
        {
          ...result.cards[0],
          platform: "instagram",
          format: "carousel",
          slides: [
            { heading: "Cover", body: "Promise" },
            { heading: "Next", body: "Try this" },
          ],
        },
      ],
    };
    await expect(mutateAgentDraft("creator-a", ref, "handoff")).rejects.toThrow(
      "Export every slide",
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not count successful export attachments as copy edits", async () => {
    mocks.payload = {
      ...result,
      cards: [
        {
          ...result.cards[0],
          platform: "instagram",
          format: "carousel",
          slides: [
            { heading: "Cover", body: "Promise" },
            { heading: "Next", body: "Try this" },
          ],
        },
      ],
    };
    mocks.resolve.mockResolvedValue([
      { key: "users/creator-a/cover", mimeType: "image/jpeg", size: 10 },
      { key: "users/creator-a/next", mimeType: "image/jpeg", size: 10 },
    ]);
    await mutateAgentDraft(
      "creator-a",
      { messageId: ids.message, cardId: "draft-1", revision: 0 },
      "attach",
      { mediaIds: ["cover", "next"] },
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "mutate_content_agent_draft",
      expect.objectContaining({ p_operation: "attach" }),
    );
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });
});

describe("repairing missing carousel backgrounds", () => {
  const old = "70000000-0000-4000-8000-000000000001",
    next = "70000000-0000-4000-8000-000000000002",
    other = "70000000-0000-4000-8000-000000000003";
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.payload = {
      ...result,
      cards: [
        {
          ...result.cards[0],
          platform: "instagram",
          format: "carousel",
          slides: [
            { heading: "Cover", body: "Promise", mediaId: old },
            { heading: "Try", body: "Next step", mediaId: other },
          ],
        },
      ],
    };
    mocks.resolve.mockImplementation(async (_owner: string, ids: string[]) => {
      if (ids.includes(old)) throw new Error("Missing old image");
      return [];
    });
  });
  it("replaces a deleted target while validating new and remaining references", async () => {
    await mutateAgentDraft(
      "owner",
      { messageId: ids.message, cardId: "draft-1", revision: 0 },
      "background",
      { mediaIds: [next], slideIndex: 0 },
    );
    expect(mocks.resolve).toHaveBeenCalledWith("owner", [next, other]);
    expect(mocks.resolve.mock.calls.some((call) => call[1].includes(old))).toBe(false);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "mutate_content_agent_draft",
      expect.objectContaining({ p_revision: 0, p_operation: "background" }),
    );
  });
  it("does not ignore another missing background, but permits explicit removal of all backgrounds", async () => {
    mocks.resolve.mockRejectedValue(new Error("Remaining image missing"));
    await expect(
      mutateAgentDraft(
        "owner",
        { messageId: ids.message, cardId: "draft-1", revision: 0 },
        "background",
        { mediaIds: [next], slideIndex: 0 },
      ),
    ).rejects.toThrow("Remaining image missing");
    expect(mocks.rpc).not.toHaveBeenCalled();
    await mutateAgentDraft(
      "owner",
      { messageId: ids.message, cardId: "draft-1", revision: 0 },
      "edit",
      {
        body: "Reviewed post",
        slides: [
          { heading: "Cover", body: "Promise" },
          { heading: "Try", body: "Next step" },
        ],
      },
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "mutate_content_agent_draft",
      expect.objectContaining({
        p_operation: "edit",
        p_revision: 0,
        p_patch: {
          body: "Reviewed post",
          slides: [
            { heading: "Cover", body: "Promise" },
            { heading: "Try", body: "Next step" },
          ],
        },
      }),
    );
  });
  it("keeps the revision guard when repairing a missing target", async () => {
    await expect(
      mutateAgentDraft(
        "owner",
        { messageId: ids.message, cardId: "draft-1", revision: 1 },
        "background",
        { mediaIds: [next], slideIndex: 0 },
      ),
    ).rejects.toThrow("Draft changed");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
