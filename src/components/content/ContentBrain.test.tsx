import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BrainItem, ContentProfile } from "@/lib/content-brain";
import { ContentBrain } from "./ContentBrain";

const profile: ContentProfile = {
  goal: "consistent_publishing",
  nicheKeywords: ["creator economy"],
  language: "en",
  region: "global",
  timezone: "UTC",
  platformFrequencies: { linkedin: 3 },
};

const suggestedStory: BrainItem = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "story",
  title: "The first launch",
  content: "What went wrong and what changed.",
  provenance: "social_post",
  sourceUrl: "https://linkedin.com/posts/example",
  sourceRef: "linkedin:post-1",
  status: "suggested",
  locked: false,
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
};

const handlers = () => ({
  onSaveProfile: vi.fn(),
  onSaveItem: vi.fn(),
  onConfirm: vi.fn(),
  onLock: vi.fn(),
  onDelete: vi.fn(),
  onUpload: vi.fn(),
});

describe("ContentBrain", () => {
  it("uploads every selected photo instead of dropping all but the first", async () => {
    const actions = handlers();
    render(<ContentBrain profile={profile} items={[]} sources={[]} {...actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Photos" }));
    const files = [
      new File(["one"], "one.webp", { type: "image/webp" }),
      new File(["two"], "two.webp", { type: "image/webp" }),
    ];
    const input = screen.getByLabelText("Upload photos");
    expect(input).toHaveAttribute("multiple");
    fireEvent.change(input, { target: { files } });
    await waitFor(() => expect(actions.onUpload).toHaveBeenCalledTimes(2));
    expect(actions.onUpload).toHaveBeenNthCalledWith(1, files[0], "photo");
    expect(actions.onUpload).toHaveBeenNthCalledWith(2, files[1], "photo");
  });
  it("keeps inferred stories visibly suggested until the creator confirms them", () => {
    const actions = handlers();
    render(<ContentBrain profile={profile} items={[suggestedStory]} sources={[]} {...actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Stories" }));
    expect(screen.getByText("Suggested from LinkedIn post")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Confirm story" }));
    expect(actions.onConfirm).toHaveBeenCalledWith(suggestedStory.id);
  });

  it("edits profile strategy without exposing Routines as a Brain category", () => {
    const actions = handlers();
    render(<ContentBrain profile={profile} items={[]} sources={[]} {...actions} />);
    expect(screen.getByRole("navigation", { name: "Brain sections" })).toHaveClass(
      "overflow-x-auto",
      "md:grid",
    );
    expect(screen.queryByRole("button", { name: "Routines" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Publishing settings"));
    fireEvent.change(screen.getByLabelText("Niche topics"), {
      target: { value: "creator economy, AI agents" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(actions.onSaveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ nicheKeywords: ["creator economy", "ai agents"] }),
    );
  });

  it("automatically creates editable X and LinkedIn strategy documents", () => {
    const actions = handlers();
    render(<ContentBrain profile={profile} items={[]} sources={[]} {...actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Strategy" }));

    expect(
      screen.getByRole("heading", { name: "Creator Content Strategy - One-Pager" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Edit X Strategy" }));
    expect(
      (screen.getByRole("textbox", { name: "X Strategy" }) as HTMLTextAreaElement).value,
    ).toContain("## Posting Rhythm");
    fireEvent.click(screen.getByRole("button", { name: "LinkedIn strategy" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit LinkedIn Strategy" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(actions.onSaveItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "strategy", title: "LinkedIn Strategy" }),
    );
  });

  it("locks knowledge and confirms deletion before removing it", () => {
    const actions = handlers();
    render(
      <ContentBrain
        profile={profile}
        items={[{ ...suggestedStory, status: "confirmed" }]}
        sources={[]}
        {...actions}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stories" }));
    fireEvent.click(screen.getAllByRole("button", { name: "The first launch" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Lock story" }));
    expect(actions.onLock).toHaveBeenCalledWith(suggestedStory.id, true);
    fireEvent.click(screen.getByRole("button", { name: "Delete story" }));
    expect(screen.getByRole("alertdialog", { name: "Delete this Brain item?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    expect(actions.onDelete).toHaveBeenCalledWith(suggestedStory.id);
  });

  it("shows safe connected account summaries in Sources", () => {
    render(
      <ContentBrain
        profile={profile}
        items={[]}
        sources={[
          {
            id: "source",
            provider: "linkedin",
            handle: "creator",
            displayName: "Creator",
            status: "active",
          },
          {
            id: "knowledge-source",
            provider: "notion",
            handle: "",
            displayName: "Creator HQ",
            status: "active",
          },
        ]}
        {...handlers()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    expect(screen.getByText("Creator")).toBeVisible();
    expect(screen.getByText(/@creator/)).toBeVisible();
    expect(screen.getByText("Creator HQ")).toBeVisible();
    expect(screen.getByText(/^Notion/)).toBeVisible();
    expect(document.body).not.toHaveTextContent("access_token");
  });
});
