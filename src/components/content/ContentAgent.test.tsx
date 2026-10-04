import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { ContentAgent } from "./ContentAgent";

function props(): ComponentProps<typeof ContentAgent> {
  return {
    threads: [],
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
    expect(screen.getByPlaceholderText("What are we creating today?")).toBeVisible();
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
    expect(screen.getByLabelText("Search conversations")).toHaveClass("pl-12");
    expect(screen.getByText("Conversations").closest("aside")).toHaveClass(
      "max-h-32",
      "md:max-h-none",
    );
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
    fireEvent.click(screen.getByRole("button", { name: /LinkedIn plan/i }));
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
