import { beforeEach, describe, expect, it, vi } from "vitest";
import { studioSchedulerDraftSchema } from "./content-studio";
import { saveStudioSchedulerDraft } from "./content-studio-scheduler.server";

const mocks = vi.hoisted(() => {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    limit: vi.fn(),
  };
  return {
    query,
    from: vi.fn(() => query),
    requireStudioWorkspace: vi.fn(),
    saveSocialPostForUser: vi.fn(),
  };
});

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("./content-studio.server", () => ({
  requireStudioWorkspace: mocks.requireStudioWorkspace,
}));
vi.mock("./social-scheduler.functions", () => ({
  saveSocialPostForUser: mocks.saveSocialPostForUser,
}));

const workspaceId = "4084bddf-b1e4-4f3f-837c-8c0940ac542c";
const requestId = "608930a5-28a3-40bc-9c5f-3dd234e622bb";
const mediaIds = ["bef96574-6afc-47ee-8dd5-0f14493feefd", "5c866ad4-3637-4779-b3ca-38d8d264ce0c"];
const options = { workspaceId, requestId, title: "Exported carousel", mediaIds };
const assets = mediaIds.map((id, index) => ({
  id,
  caption: `slide-${index + 1}.jpg`,
  storage_key: `users/${workspaceId}/image/slide-${index + 1}.jpg`,
  mime_type: "image/jpeg",
  byte_size: 500,
}));

describe("Studio Scheduler handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.limit.mockResolvedValue({ data: [...assets].reverse(), error: null });
    mocks.saveSocialPostForUser.mockResolvedValue({ savedPostId: requestId });
  });

  it("passes ordered exports and a stable creation ID into the existing draft workflow", async () => {
    await expect(saveStudioSchedulerDraft(options)).resolves.toEqual({ postId: requestId });
    expect(mocks.requireStudioWorkspace).toHaveBeenCalledWith(workspaceId);
    expect(mocks.query.limit).toHaveBeenCalledWith(mediaIds.length);
    expect(mocks.query.eq.mock.calls).toEqual([
      ["user_id", workspaceId],
      ["status", "ready"],
      ["import_origin", "upload"],
    ]);
    expect(mocks.saveSocialPostForUser).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({
        asDraft: true,
        connectionIds: [],
        scheduledAt: null,
        publishNow: false,
        media: assets.map((asset) => expect.objectContaining({ key: asset.storage_key })),
      }),
      undefined,
      requestId,
    );
  });

  it("rejects missing assets, foreign storage paths, and duplicate export IDs", async () => {
    mocks.query.limit.mockResolvedValueOnce({ data: [assets[0]], error: null });
    await expect(saveStudioSchedulerDraft(options)).rejects.toThrow(
      "unavailable in this workspace",
    );
    mocks.query.limit.mockResolvedValueOnce({
      data: [assets[0], { ...assets[1], storage_key: "users/other-workspace/image/slide.jpg" }],
      error: null,
    });
    await expect(saveStudioSchedulerDraft(options)).rejects.toThrow(
      "unavailable in this workspace",
    );
    expect(mocks.saveSocialPostForUser).not.toHaveBeenCalled();
    expect(
      studioSchedulerDraftSchema.safeParse({ ...options, mediaIds: [mediaIds[0], mediaIds[0]] })
        .success,
    ).toBe(false);
  });
  it("preserves a production caption and schedule without submitting a publication", async () => {
    const proposal = {
      body: "Platform caption",
      connectionIds: [mediaIds[0]],
      scheduledAt: "2026-11-20T10:00:00+05:30",
      timezone: "Asia/Kolkata",
      connectionOverrides: { [mediaIds[0]]: { bodyOverride: "Instagram caption" } },
    };
    await saveStudioSchedulerDraft({ ...options, proposal });
    expect(mocks.saveSocialPostForUser).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({ ...proposal, asDraft: true, publishNow: false }),
      undefined,
      requestId,
    );
  });
});
