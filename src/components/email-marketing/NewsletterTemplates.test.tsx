import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NewsletterTemplates } from "./NewsletterTemplates";

describe("NewsletterTemplates", () => {
  it("shows 28 long-form templates and searches the library", async () => {
    const user = userEvent.setup();
    render(
      <NewsletterTemplates
        defaultTemplateId="editorial"
        onSetDefault={vi.fn()}
        onStartPost={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("button", { name: /^Preview / })).toHaveLength(28);
    expect(screen.getByRole("button", { name: "Preview Classic Editorial" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Preview Product Drop" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Preview Creator Notes" })).toBeVisible();
    expect(screen.queryByTitle("Desktop email preview")).not.toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Search templates" }), "event");
    expect(screen.getByRole("button", { name: "Preview Event Brief" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Preview Product Drop" })).not.toBeInTheDocument();
  });

  it("puts recently used templates first in the new-post chooser and offers a way back", () => {
    render(
      <NewsletterTemplates
        selectionMode
        recentTemplateIds={["weekly-roundup", "editorial"]}
        defaultTemplateId="editorial"
        onBack={vi.fn()}
        onSetDefault={vi.fn()}
        onStartPost={vi.fn()}
      />,
    );
    expect(screen.getByText("Recently used")).toBeVisible();
    expect(screen.getByText("All templates")).toBeVisible();
    expect(screen.getByRole("button", { name: "Back to posts" })).toBeVisible();
  });

  it("opens one accurate preview and starts a post from the selected template", async () => {
    const user = userEvent.setup();
    const onSetDefault = vi.fn().mockResolvedValue(undefined);
    const onStartPost = vi.fn().mockResolvedValue(undefined);
    render(
      <NewsletterTemplates
        defaultTemplateId="editorial"
        onSetDefault={onSetDefault}
        onStartPost={onStartPost}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Preview Community Pulse" }));
    expect(screen.getByRole("dialog", { name: "Community Pulse" })).toBeVisible();
    expect(screen.getByTitle("Email desktop preview").getAttribute("srcdoc")).toContain(
      "What is happening in the community",
    );
    expect(screen.queryByTitle("Email mobile preview")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Email mobile" }));
    expect(screen.getByTitle("Email mobile preview")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Set as default" }));
    await user.click(screen.getByRole("button", { name: "Start writing" }));

    expect(onSetDefault).toHaveBeenCalledWith("weekly-roundup");
    expect(onStartPost).toHaveBeenCalledWith("weekly-roundup");
  });
});
