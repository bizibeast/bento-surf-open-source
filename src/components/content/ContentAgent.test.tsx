import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { ContentAgent } from "./ContentAgent";

function props(): ComponentProps<typeof ContentAgent> {
  return {
    threads: [],
    agentName: "Bento",
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
    expect(screen.getByRole("status")).toHaveTextContent("Bento is preparing your response");
    expect(screen.queryByRole("heading", { name: "Ask Bento" })).not.toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Bento" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(screen.getByRole("button", { name: "My plan" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(first).toHaveFocus();
    fireEvent.change(screen.getByLabelText("Search conversations"), {
      target: { value: "absent" },
    });
    expect(screen.getByRole("button", { name: "Bento" })).toBeVisible();
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
      screen.queryByRole("button", { name: "More options for Bento" }),
    ).not.toBeInTheDocument();
  });

  it("opens a mobile conversation drawer and closes it after selection", async () => {
    const values = props();
    render(<ContentAgent {...values} />);
    fireEvent.click(screen.getByRole("button", { name: "Open conversations" }));
    const drawer = screen.getByRole("dialog", { name: "Conversations" });
    fireEvent.click(within(drawer).getByRole("button", { name: "Bento" }));
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
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Bento" }));
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
    await waitFor(() => expect(values.onSend).toHaveBeenCalledWith("A request"));
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
    expect(screen.getByPlaceholderText("What are we building today?")).toBeVisible();
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

    expect(screen.getByRole("heading", { name: "Ask Bento" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New chat" })).toBeVisible();
    expect(screen.getByLabelText("Search conversations")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Analyze my recent posts" }));
    expect(values.onSend).toHaveBeenCalledWith(
      "Analyze my recent posts and tell me what to repeat next.",
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
