import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ContentAgentCard as Card } from "@/lib/content-agent";
import { ContentAgentCard } from "./ContentAgentCard";

const draft: Card = {
  type: "draft",
  cardId: "draft-1",
  platform: "linkedin",
  format: "post",
  title: "",
  body: "A reviewed LinkedIn post.",
  visualBrief: null,
  sourceUrls: [],
  rationale: "Uses confirmed context.",
};

const schedule: Card = {
  type: "schedule_proposal",
  cardId: "schedule-1",
  draftCardId: "draft-1",
  connectionId: "33333333-3333-4333-8333-333333333333",
  scheduledAt: "2026-09-19T03:30:00.000Z",
  timezone: "Asia/Kolkata",
};

describe("ContentAgentCard", () => {
  it("saves the edited draft before it can be reviewed for scheduling", async () => {
    const onSaveDraft = vi.fn().mockResolvedValue(undefined);
    render(
      <ContentAgentCard
        messageId="message"
        card={draft}
        allCards={[draft]}
        onApproveBrain={vi.fn()}
        onRejectDraft={vi.fn()}
        onRegenerateDraft={vi.fn()}
        onApproveSchedule={vi.fn()}
        onSaveDraft={onSaveDraft}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
    fireEvent.change(screen.getByLabelText("Edit draft"), { target: { value: "Corrected post." } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledWith("draft-1", "Corrected post."));
  });
  it("requires review before scheduling a proposed post", () => {
    const onApproveSchedule = vi.fn();
    render(
      <ContentAgentCard
        messageId="22222222-2222-4222-8222-222222222222"
        card={schedule}
        allCards={[draft, schedule]}
        onApproveBrain={vi.fn()}
        onRejectDraft={vi.fn()}
        onRegenerateDraft={vi.fn()}
        onApproveSchedule={onApproveSchedule}
      />,
    );
    expect(onApproveSchedule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Review and schedule"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText("A reviewed LinkedIn post.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Approve schedule" }));
    expect(onApproveSchedule).toHaveBeenCalledWith("draft-1", "schedule-1");
  });

  it("records a bounded reason before rejecting or regenerating a draft", () => {
    const onRejectDraft = vi.fn();
    const onRegenerateDraft = vi.fn();
    render(
      <ContentAgentCard
        messageId="message"
        card={draft}
        allCards={[draft]}
        onApproveBrain={vi.fn()}
        onRejectDraft={onRejectDraft}
        onRegenerateDraft={onRegenerateDraft}
        onApproveSchedule={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Draft feedback"), { target: { value: "Too generic" } });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate draft" }));
    expect(onRegenerateDraft).toHaveBeenCalledWith("draft-1", "Too generic");
    fireEvent.click(screen.getByRole("button", { name: "Reject draft" }));
    expect(onRejectDraft).toHaveBeenCalledWith("draft-1", "Too generic");
  });
});
