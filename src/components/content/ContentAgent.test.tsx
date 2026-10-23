import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { ContentAgent } from "./ContentAgent";
const attachmentMocks = vi.hoisted(() => ({ upload: vi.fn(), prepare: vi.fn() }));
vi.mock("@/lib/upload", () => ({ uploadFileResult: attachmentMocks.upload }));
vi.mock("@/lib/content-agent.functions", () => ({
  prepareContentAgentAttachment: attachmentMocks.prepare,
}));

function props(): ComponentProps<typeof ContentAgent> {
  return {
    threads: [],
    agentName: "Benny",
    agentThreadId: "named-agent",
    onPinThread: vi.fn(),
    onRenameThread: vi.fn().mockResolvedValue(undefined),
    onDeleteThread: vi.fn().mockResolvedValue(undefined),
    onMarkRead: vi.fn(),
    onOpenSettings: vi.fn(),
    activeThreadId: null,
    messages: [],
    seed: "",
    brainEmpty: false,
    sending: false,
    onNewThread: vi.fn(),
    onSelectThread: vi.fn(),
    onSend: vi.fn(),
    onBuildBrain: vi.fn(),
    onApproveBrain: vi.fn(),
    onRejectDraft: vi.fn(),
    onRegenerateDraft: vi.fn(),
    onApproveSchedule: vi.fn(),
  };
}

describe("ContentAgent", () => {
  it("labels speakers and keeps rejected drafts collapsed after reloading", () => {
    const values = props();
    values.messages = [
      { id: "user", role: "user", content: "Write a post" },
      {
        id: "reply",
        role: "assistant",
        content: "A long explanation that repeats the entire draft",
        payload: {
          action: "draft",
          message: "Ready",
          memories: [],
          rejectedDraftIds: ["draft-1"],
          cards: [
            {
              type: "draft",
              cardId: "draft-1",
              platform: "twitter",
              format: "post",
              title: "Rejected idea",
              body: "A rejected post",
              visualBrief: null,
              sourceUrls: [],
              rationale: "An angle",
            },
          ],
        },
      },
    ];
    render(<ContentAgent {...values} />);
    expect(screen.getByLabelText("Message from You")).toBeVisible();
    expect(screen.getByLabelText("Message from Benny")).toBeVisible();
    expect(screen.getByText("Draft rejected")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open in scheduler" })).not.toBeInTheDocument();
    expect(screen.queryByText(values.messages[1].content)).not.toBeInTheDocument();
  });

  it("collapses long manual text without changing its sender, complete content, or attachments", async () => {
    const values = props();
    const fullText =
      "My manually written request.\n" +
      "Keep these exact details and line breaks.\n".repeat(40) +
      "Final detail: preserve this verbatim.";
    values.messages = [
      {
        id: "manual-long",
        role: "user",
        content: fullText,
        payload: {
          attachments: [
            {
              id: "00000000-0000-4000-8000-000000000001",
              name: "brief.txt",
              key: "private/users/me/agent/brief.txt",
              mimeType: "text/plain",
              size: 5,
              url: null,
              mediaId: null,
            },
          ],
        },
      },
    ];
    render(<ContentAgent {...values} />);
    const message = screen.getByLabelText("Message from You");
    expect(within(message).getByText("You")).toBeVisible();
    expect(within(message).getByText("brief.txt")).toBeVisible();
    const expand = within(message).getByRole("button", { name: "Show full message" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    const content = document.getElementById(expand.getAttribute("aria-controls")!);
    expect(content?.textContent).not.toBe(fullText);
    expect(content?.textContent).toContain("My manually written request.");
    await userEvent.click(expand);
    expect(content?.textContent).toBe(fullText);
    expect(within(message).getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(within(message).getByText("brief.txt")).toBeVisible();
    await userEvent.click(within(message).getByRole("button", { name: "Show less" }));
    expect(content?.textContent).not.toBe(fullText);
    expect(within(message).getByText("brief.txt")).toBeVisible();
    expect(screen.queryByText("Routine request")).not.toBeInTheDocument();
  });

  it("keeps short manual messages intact without guessing routine origin", () => {
    const values = props();
    const text = "Prepare exactly 7 platform-native drafts; this is my manual request.";
    values.messages = [{ id: "manual-short", role: "user", content: text }];
    render(<ContentAgent {...values} />);
    expect(screen.getByText(text)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Show full message" })).not.toBeInTheDocument();
    expect(screen.queryByText("Routine request")).not.toBeInTheDocument();
  });

  it("collapses a legacy routine-shaped message with no trusted origin metadata", async () => {
    const values = props();
    const slots = Array.from({ length: 7 }, (_, day) => ({
      day,
      time: "18:30",
      scheduledAt: `2026-11-${String(day + 1).padStart(2, "0")}T13:00:00.000Z`,
    }));
    const fullText =
      "Prepare exactly 7 platform-native drafts for youtube, threads, instagram, tiktok, facebook, linkedin, twitter. " +
      `Target these reviewed schedule slots: ${JSON.stringify(slots)}. ` +
      "Use the reviewed Brain profile and source links. Keep each draft specific to its platform. " +
      "Return draft cards only, without schedule_proposal cards; do not publish. " +
      "The routine saves drafts and handles any opted-in scheduling separately.";
    expect(fullText.length).toBeGreaterThanOrEqual(800);
    expect(fullText.length).toBeLessThanOrEqual(900);
    values.messages = [{ id: "legacy-request", role: "user", content: fullText, payload: {} }];
    render(<ContentAgent {...values} />);
    const message = screen.getByLabelText("Message from You");
    const expand = within(message).getByRole("button", { name: "Show full message" });
    const content = document.getElementById(expand.getAttribute("aria-controls")!);
    expect(content?.textContent).toBe(`${Array.from(fullText).slice(0, 320).join("").trimEnd()}…`);
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(within(message).getByText("You")).toBeVisible();
    expect(screen.queryByText("Routine request")).not.toBeInTheDocument();
    await userEvent.click(expand);
    expect(content?.textContent).toBe(fullText);
    await userEvent.click(within(message).getByRole("button", { name: "Show less" }));
    expect(content?.textContent).not.toBe(fullText);
  });

  it("uploads a private reference, retains it after failed send, and clears it on chat switch", async () => {
    const values = props();
    values.onSend = vi.fn().mockRejectedValue(new Error("Temporary failure"));
    const attachment = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "brief.txt",
      key: "private/users/me/agent/brief.txt",
      mimeType: "text/plain",
      size: 5,
      url: null,
      mediaId: null,
    };
    attachmentMocks.upload.mockResolvedValue({ key: attachment.key, publicUrl: null });
    attachmentMocks.prepare.mockResolvedValue(attachment);
    const view = render(<ContentAgent {...values} />);
    fireEvent.change(screen.getByLabelText("Attach files"), {
      target: { files: [new File(["brief"], "brief.txt", { type: "text/plain" })] },
    });
    await screen.findByRole("button", { name: "Remove brief.txt" });
    fireEvent.change(screen.getByLabelText("Message Agent"), {
      target: { value: "Schedule from this brief" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Temporary failure");
    expect(values.onSend).toHaveBeenCalledWith("Schedule from this brief", [attachment]);
    expect(screen.getByRole("button", { name: "Remove brief.txt" })).toBeVisible();
    view.rerender(<ContentAgent {...values} activeThreadId="another-chat" />);
    expect(screen.queryByRole("button", { name: "Remove brief.txt" })).not.toBeInTheDocument();
  });
  it("blocks send during file preparation and ignores an upload completed after switching chats", async () => {
    const values = props();
    let resolve!: (value: unknown) => void;
    attachmentMocks.upload.mockReturnValue(new Promise((r) => (resolve = r)));
    const view = render(<ContentAgent {...values} />);
    fireEvent.change(screen.getByLabelText("Message Agent"), { target: { value: "Use this" } });
    fireEvent.change(screen.getByLabelText("Attach files"), {
      target: { files: [new File(["brief"], "brief.txt", { type: "text/plain" })] },
    });
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    view.rerender(<ContentAgent {...values} activeThreadId="another-chat" />);
    resolve({ key: "private/users/me/agent/brief.txt" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Remove brief.txt" })).not.toBeInTheDocument();
  });

  it("shows the submitted first message and progress while New chat is waiting", async () => {
    const values = props();
    let finish!: () => void;
    values.onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<ContentAgent {...values} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message Agent" }), {
      target: { value: "Write a LinkedIn post" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    view.rerender(<ContentAgent {...values} sending />);
    expect(screen.getByRole("status")).toHaveTextContent("Benny is preparing your response");
    expect(screen.queryByRole("heading", { name: "Ask Benny" })).not.toBeInTheDocument();
    finish();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Message Agent" })).toHaveValue(""),
    );
  });
  it("keeps the named agent after New chat and before Pinned and Recents, with unread state", () => {
    const values = props();
    values.agentName = "Milo";
    values.threads = [
      {
        id: "named-agent",
        title: "Milo",
        kind: "agent",
        unread_count: 3,
        last_message_at: "",
        created_at: "",
      },
      { id: "recent", title: "Recent idea", last_message_at: "", created_at: "" },
      {
        id: "pinned",
        title: "Pinned idea",
        pinned_at: "2026-10-01",
        last_message_at: "",
        created_at: "",
      },
    ];
    values.messages = [{ id: "reply", role: "assistant", content: "Let's make something." }];
    render(<ContentAgent {...values} />);
    const nav = screen.getByRole("navigation", { name: "Conversations" });
    const rows = within(nav)
      .getAllByRole("button")
      .filter((button) => button.hasAttribute("data-conversation"));
    expect(rows.map((row) => row.textContent)).toEqual([
      "New chat",
      "Milo3",
      "Pinned idea",
      "Recent idea",
    ]);
    expect(rows[1].querySelector("img")).toHaveAttribute("src", "/mascot/benny-avatar.webp");
    expect(screen.getByLabelText("3 unread messages")).toBeVisible();
    expect(screen.queryByText("Bento Agent")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Grounded in your Brain and connected sources"),
    ).not.toBeInTheDocument();
    fireEvent.click(rows[1]);
    expect(values.onSelectThread).toHaveBeenCalledWith("named-agent");
    fireEvent.click(screen.getByRole("button", { name: "Pin Recent idea" }));
    expect(values.onPinThread).toHaveBeenCalledWith("recent", true);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings" }));
    expect(values.onOpenSettings).toHaveBeenCalled();
  });

  it("navigates conversation rows with arrows, Home and End and keeps agent visible while searching", () => {
    const values = props();
    values.threads = [{ id: "chat", title: "My plan", last_message_at: "", created_at: "" }];
    render(<ContentAgent {...values} />);
    const first = screen.getByRole("button", { name: "New chat" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "Benny" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(screen.getByRole("button", { name: "My plan" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(first).toHaveFocus();
    fireEvent.change(screen.getByLabelText("Search conversations"), {
      target: { value: "absent" },
    });
    expect(screen.getByRole("button", { name: "Benny" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "My plan" })).not.toBeInTheDocument();
  });

  it("renames and confirms deletion for ordinary chats", async () => {
    const values = props();
    const user = userEvent.setup();
    values.threads = [
      { id: "chat", title: "Old name", kind: "chat", last_message_at: "", created_at: "" },
    ];
    render(<ContentAgent {...values} />);
    await user.click(screen.getByRole("button", { name: "More options for Old name" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename chat" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Chat name" }), {
      target: { value: "New name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(values.onRenameThread).toHaveBeenCalledWith("chat", "New name"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Rename chat" })).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "More options for Old name" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete chat" }));
    expect(screen.getByText(/Posts already saved to the scheduler stay there/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));
    await waitFor(() => expect(values.onDeleteThread).toHaveBeenCalledWith("chat"));
    expect(
      screen.queryByRole("button", { name: "More options for Benny" }),
    ).not.toBeInTheDocument();
  });

  it("opens a mobile conversation drawer and closes it after selection", async () => {
    const values = props();
    render(<ContentAgent {...values} />);
    fireEvent.click(screen.getByRole("button", { name: "Open conversations" }));
    const drawer = screen.getByRole("dialog", { name: "Conversations" });
    fireEvent.click(within(drawer).getByRole("button", { name: "Benny" }));
    expect(values.onSelectThread).toHaveBeenCalledWith("named-agent");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Open conversations" })).toHaveFocus();
  });

  it("marks only the displayed message watermark and does not repeat it on unrelated renders", () => {
    const values = props();
    values.activeThreadId = "named-agent";
    values.messages = [{ id: "displayed", role: "assistant", content: "Hello" }];
    const view = render(<ContentAgent {...values} />);
    expect(values.onMarkRead).toHaveBeenCalledWith("named-agent", "displayed");
    view.rerender(<ContentAgent {...values} agentName="Milo" />);
    expect(values.onMarkRead).toHaveBeenCalledTimes(1);
    view.rerender(
      <ContentAgent
        {...values}
        messages={[...values.messages, { id: "newer", role: "assistant", content: "New idea" }]}
      />,
    );
    expect(values.onMarkRead).toHaveBeenLastCalledWith("named-agent", "newer");
  });

  it("defers unread acknowledgements in a background tab and catches up on visibility return", () => {
    const values = props();
    values.activeThreadId = "named-agent";
    values.messages = [{ id: "first", role: "assistant", content: "Hello" }];
    const view = render(<ContentAgent {...values} />);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    view.rerender(
      <ContentAgent
        {...values}
        messages={[...values.messages, { id: "unseen", role: "assistant", content: "New idea" }]}
      />,
    );
    expect(values.onMarkRead).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    expect(values.onMarkRead).toHaveBeenLastCalledWith("named-agent", "unseen");
    visibility.mockRestore();
  });

  it("defers acknowledgements while an overlay covers the conversation", () => {
    const values = props();
    values.activeThreadId = "named-agent";
    values.messages = [{ id: "first", role: "assistant", content: "Hello" }];
    const view = render(<ContentAgent {...values} readEnabled={false} />);
    expect(values.onMarkRead).not.toHaveBeenCalled();
    view.rerender(<ContentAgent {...values} readEnabled />);
    expect(values.onMarkRead).toHaveBeenLastCalledWith("named-agent", "first");
    fireEvent.click(screen.getByRole("button", { name: "Open conversations" }));
    view.rerender(
      <ContentAgent
        {...values}
        messages={[...values.messages, { id: "covered", role: "assistant", content: "New idea" }]}
      />,
    );
    expect(values.onMarkRead).toHaveBeenCalledTimes(1);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Benny" }));
    expect(values.onMarkRead).toHaveBeenLastCalledWith("named-agent", "covered");
  });

  it("keeps the conversation available when chat pagination fails and exposes retry", () => {
    const values = props();
    values.messages = [
      { id: "reply", role: "assistant", content: "Your conversation stays here." },
    ];
    const onRetryThreads = vi.fn();
    render(
      <ContentAgent
        {...values}
        threadListError="Chats could not load."
        onRetryThreads={onRetryThreads}
        hasMoreThreads
      />,
    );
    expect(screen.getByText("Your conversation stays here.")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Chats could not load.");
    expect(screen.queryByRole("button", { name: "Load more chats" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry chats" }));
    expect(onRetryThreads).toHaveBeenCalled();
  });

  it("loads more chats and preserves Enter / Shift+Enter composer behavior", async () => {
    const values = props();
    const onLoadMore = vi.fn();
    render(<ContentAgent {...values} hasMoreThreads onLoadMore={onLoadMore} />);
    fireEvent.click(screen.getByRole("button", { name: "Load more chats" }));
    expect(onLoadMore).toHaveBeenCalled();
    const composer = screen.getByLabelText("Message Agent");
    fireEvent.change(composer, { target: { value: "A request" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    expect(values.onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(values.onSend).toHaveBeenCalledWith("A request", []));
    expect(composer).toHaveValue("");
  });

  it("keeps a single composer visible with long responses and retains a failed send", async () => {
    const values = props();
    values.messages = [
      {
        id: "reply",
        role: "assistant",
        content: "## A useful response\n\n" + "A long paragraph.\n\n".repeat(80),
      },
    ];
    values.onSend = vi.fn().mockRejectedValue(new Error("Offline"));
    render(<ContentAgent {...values} />);
    expect(screen.getAllByLabelText("Message Agent")).toHaveLength(1);
    expect(screen.getByPlaceholderText("Message Benny, or tell me what to change…")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Message Agent"), {
      target: { value: "My next request" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Offline"));
    expect(screen.getByLabelText("Message Agent")).toHaveValue("My next request");
  });
  it("uses the chat-first empty state and sends a selected starter", () => {
    const values = props();
    render(<ContentAgent {...values} />);

    expect(screen.getByRole("heading", { name: "Ask Benny" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New chat" })).toBeVisible();
    expect(screen.getByLabelText("Search conversations")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Analyze my recent posts" }));
    expect(values.onSend).toHaveBeenCalledWith(
      "Analyze my recent posts and tell me what to repeat next.",
      [],
    );
  });

  it("searches and selects existing conversations", () => {
    const values = props();
    values.threads = [
      {
        id: "thread-1",
        title: "Launch week ideas",
        last_message_at: "2026-09-20T00:00:00.000Z",
        created_at: "2026-09-20T00:00:00.000Z",
      },
      {
        id: "thread-2",
        title: "LinkedIn plan",
        last_message_at: "2026-09-19T00:00:00.000Z",
        created_at: "2026-09-19T00:00:00.000Z",
      },
    ];
    render(<ContentAgent {...values} />);

    fireEvent.change(screen.getByLabelText("Search conversations"), {
      target: { value: "LinkedIn" },
    });
    expect(screen.queryByText("Launch week ideas")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "LinkedIn plan" }));
    expect(values.onSelectThread).toHaveBeenCalledWith("thread-2");
  });

  it("collapses and expands the conversation rail", () => {
    render(<ContentAgent {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse conversations" }));
    expect(screen.queryByLabelText("Search conversations")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand conversations" }));
    expect(screen.getByLabelText("Search conversations")).toBeVisible();
  });

  it("seeds the composer from Discover without auto-sending", () => {
    const values = { ...props(), seed: "Create a draft from this source" };
    render(<ContentAgent {...values} />);
    expect(screen.getByLabelText("Message Agent")).toHaveValue("Create a draft from this source");
    expect(values.onSend).not.toHaveBeenCalled();
  });

  it("offers initial Brain analysis when no knowledge exists", () => {
    const values = { ...props(), brainEmpty: true };
    render(<ContentAgent {...values} />);
    fireEvent.click(screen.getByRole("button", { name: "Build my Brain from my posts" }));
    expect(values.onBuildBrain).toHaveBeenCalled();
  });
});
