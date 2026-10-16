// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getContentAgentPreferences,
  getContentPublishingAccounts,
  updateContentAgentPreferences,
} from "./content-agent-preferences.functions";
import {
  deleteContentAgentChat,
  listContentAgentThreads,
  markContentAgentThreadRead,
  prepareContentAgentDraft,
  renameContentAgentChat,
  setContentAgentThreadPinned,
} from "./content-agent.functions";
import {
  attachAgentDraftImage,
  clearAgentDraftBackgrounds,
  getAgentDraftImages,
} from "./content-agent-images.functions";
import { createContentAgentWebMcpTools } from "./content-agent-webmcp";

vi.mock("./content-agent-preferences.functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./content-agent-preferences.functions")>()),
  getContentAgentPreferences: vi.fn(),
  getContentPublishingAccounts: vi.fn(),
  updateContentAgentPreferences: vi.fn(),
}));
vi.mock("./content-agent.functions", () => ({
  prepareContentAgentDraft: vi.fn(),
  listContentAgentThreads: vi.fn(),
  setContentAgentThreadPinned: vi.fn(),
  markContentAgentThreadRead: vi.fn(),
  renameContentAgentChat: vi.fn(),
  deleteContentAgentChat: vi.fn(),
}));
vi.mock("./content-agent-images.functions", () => ({
  getAgentDraftImages: vi.fn(),
  attachAgentDraftImage: vi.fn(),
  clearAgentDraftBackgrounds: vi.fn(),
}));

const signal = new AbortController().signal;
const draftRef = {
  messageId: "11111111-1111-4111-8111-111111111111",
  cardId: "draft-1",
  revision: 2,
};

function tools(refresh = vi.fn().mockResolvedValue(undefined), openTab = vi.fn()) {
  return createContentAgentWebMcpTools({ refresh, openTab });
}

function tool(name: string) {
  const found = tools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing Content WebMCP tool ${name}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("Content Agent WebMCP tools", () => {
  it("registers route-local navigation, settings, and visual controls", () => {
    expect(tools().map(({ name }) => name)).toEqual([
      "open_content_tab",
      "get_content_agent_settings",
      "manage_content_agent_chat",
      "update_content_agent_settings",
      "get_content_agent_draft_visuals",
      "manage_content_agent_visuals",
    ]);
    expect(tool("get_content_agent_settings").annotations?.readOnlyHint).toBe(true);
    expect(tool("manage_content_agent_visuals").inputSchema).toMatchObject({
      oneOf: expect.any(Array),
    });
  });

  it("manages exact Agent chat IDs with approval and a refreshed bounded list", async () => {
    const threadId = "22222222-2222-4222-8222-222222222222";
    const messageId = "33333333-3333-4333-8333-333333333333";
    const refresh = vi.fn().mockResolvedValue(undefined);
    const openTab = vi.fn();
    const found = tools(refresh, openTab).find(
      (candidate) => candidate.name === "manage_content_agent_chat",
    )!;
    vi.mocked(listContentAgentThreads).mockResolvedValue(
      Array.from({ length: 51 }, (_, index) => ({
        id: index === 0 ? threadId : `thread-${index}`,
        title: `Chat ${index}`,
        kind: "chat",
        pinned_at: null,
        unread_count: 0,
        last_message_at: "2026-10-15T00:00:00Z",
        private_note: "secret",
      })) as never,
    );
    vi.mocked(setContentAgentThreadPinned).mockResolvedValue({} as never);
    vi.mocked(markContentAgentThreadRead).mockResolvedValue({} as never);
    vi.mocked(renameContentAgentChat).mockResolvedValue({
      id: threadId,
      title: "New name",
    } as never);
    vi.mocked(deleteContentAgentChat).mockResolvedValue({ id: threadId });

    await found.execute({ action: "set_pinned", threadId, pinned: true }, { signal });
    expect(setContentAgentThreadPinned).toHaveBeenCalledWith({ data: { threadId, pinned: true } });
    await found.execute({ action: "mark_read", threadId, throughMessageId: messageId }, { signal });
    expect(markContentAgentThreadRead).toHaveBeenCalledWith({
      data: { threadId, throughMessageId: messageId },
    });
    await found.execute({ action: "rename", threadId, title: " New name " }, { signal });
    expect(renameContentAgentChat).toHaveBeenCalledWith({
      data: { threadId, title: "New name" },
    });
    vi.mocked(listContentAgentThreads).mockResolvedValueOnce(
      Array.from({ length: 51 }, (_, index) => ({
        id: `thread-${index + 1}`,
        title: `Chat ${index + 1}`,
        kind: "chat",
        pinned_at: null,
        unread_count: 0,
        last_message_at: "2026-10-15T00:00:00Z",
      })) as never,
    );
    const deleted = await found.execute({ action: "delete", threadId }, { signal });
    expect(deleteContentAgentChat).toHaveBeenCalledWith({ data: { threadId } });
    expect(openTab).toHaveBeenCalledWith("agent");
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(listContentAgentThreads).toHaveBeenCalledTimes(4);
    expect(deleted).toMatchObject({ structuredContent: { action: "delete", threadId } });
    const remaining = (deleted as { structuredContent: { threads: Array<{ id: string }> } })
      .structuredContent.threads;
    expect(remaining).toHaveLength(50);
    expect(remaining.some((thread) => thread.id === threadId)).toBe(false);
    expect(JSON.stringify(deleted)).not.toContain("private_note");
    expect(window.confirm).toHaveBeenCalledTimes(4);
  });

  it("rejects unapproved, invalid, and unavailable Agent chat changes", async () => {
    const found = tool("manage_content_agent_chat");
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await expect(
      found.execute({ action: "delete", threadId: "not-a-uuid" }, { signal }),
    ).rejects.toThrow();
    await expect(
      found.execute({ action: "delete", threadId: draftRef.messageId }, { signal }),
    ).rejects.toThrow("did not approve");
    expect(deleteContentAgentChat).not.toHaveBeenCalled();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(deleteContentAgentChat).mockRejectedValue(new Error("This chat is unavailable."));
    await expect(
      found.execute({ action: "delete", threadId: draftRef.messageId }, { signal }),
    ).rejects.toThrow("This chat is unavailable.");
    expect(listContentAgentThreads).not.toHaveBeenCalled();
  });

  it("returns bounded publishing settings without private connection or photo URLs", async () => {
    vi.mocked(getContentAgentPreferences).mockResolvedValue({
      user_id: "private-user-id",
      display_name: "Bento Agent",
      proactive_paused: true,
      generate_images: false,
      use_face_references: true,
      reference_photo_ids: ["private-photo-id"],
      destination_accounts: { linkedin: "22222222-2222-4222-8222-222222222222" },
      platforms: ["linkedin"],
    });
    vi.mocked(getContentPublishingAccounts).mockResolvedValue(
      Array.from({ length: 21 }, (_, index) => ({
        id: `account-${index}`,
        provider: "linkedin" as const,
        provider_handle: index === 0 ? "owner@example.com" : `creator-${index}`,
        private_email: "owner@example.com",
      })) as never,
    );

    const result = await tool("get_content_agent_settings").execute({}, { signal });
    expect(result).toMatchObject({
      structuredContent: {
        preferences: {
          displayName: "Bento Agent",
          selectedReferencePhotoCount: 1,
          destinationAccounts: { linkedin: "22222222-2222-4222-8222-222222222222" },
        },
      },
    });
    const data = (result as { structuredContent: { publishingAccounts: unknown[] } })
      .structuredContent;
    expect(data.publishingAccounts).toHaveLength(20);
    expect(JSON.stringify(result)).not.toMatch(
      /owner@example|private-user-id|private-photo-id|private_email/,
    );
  });

  it("requires approval and server validation for Agent preference changes", async () => {
    const found = tool("update_content_agent_settings");
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await expect(found.execute({ displayName: "Bento Studio" }, { signal })).rejects.toThrow(
      "did not approve",
    );
    expect(updateContentAgentPreferences).not.toHaveBeenCalled();
    await expect(
      found.execute({ referencePhotoIds: ["private-photo-id"] }, { signal }),
    ).rejects.toThrow();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(updateContentAgentPreferences).mockResolvedValue({} as never);
    await expect(
      found.execute({ displayName: "Bento Studio", platforms: ["linkedin"] }, { signal }),
    ).resolves.toMatchObject({ structuredContent: { saved: true } });
    expect(updateContentAgentPreferences).toHaveBeenCalledWith({
      data: { displayName: "Bento Studio", platforms: ["linkedin"] },
    });
  });

  it("projects draft visual status and never returns private image URLs", async () => {
    vi.mocked(getAgentDraftImages).mockResolvedValue({
      assets: { "media-1": "https://private.example/photo" },
      missingMediaIds: ["media-2"],
      parentPending: false,
      jobs: [
        {
          id: "job-1",
          status: "ready",
          mediaId: "media-1",
          url: "https://private.example/generated",
          detail: "provider-secret",
        },
      ],
    } as never);
    const result = await tool("get_content_agent_draft_visuals").execute(draftRef, { signal });
    expect(result).toMatchObject({
      structuredContent: {
        attachedMediaIds: ["media-1"],
        missingMediaIds: ["media-2"],
        jobs: [{ id: "job-1", status: "ready", mediaId: "media-1" }],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/private\.example|provider-secret|detail/);
  });

  it("executes only validated visual actions after browser approval", async () => {
    const found = tool("manage_content_agent_visuals");
    vi.mocked(attachAgentDraftImage).mockResolvedValue({} as never);
    await found.execute(
      {
        action: "attach_existing",
        draftRef,
        mediaId: "33333333-3333-4333-8333-333333333333",
        slideIndex: 1,
      },
      { signal },
    );
    expect(attachAgentDraftImage).toHaveBeenCalledWith({
      data: {
        draftRef,
        mediaId: "33333333-3333-4333-8333-333333333333",
        slideIndex: 1,
      },
    });
    await expect(
      found.execute({ action: "attach_existing", draftRef, mediaId: "not-a-uuid" }, { signal }),
    ).rejects.toThrow();
    expect(clearAgentDraftBackgrounds).not.toHaveBeenCalled();
    expect(prepareContentAgentDraft).not.toHaveBeenCalled();
  });

  it("opens a named Content tab after confirmation", async () => {
    const openTab = vi.fn();
    const found = tools(undefined, openTab).find(
      (candidate) => candidate.name === "open_content_tab",
    )!;
    await expect(found.execute({ tab: "agent" }, { signal })).resolves.toMatchObject({
      structuredContent: { path: "/content?tab=agent" },
    });
    expect(openTab).toHaveBeenCalledWith("agent");
  });
});
