import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NewsletterPostDetail } from "./NewsletterPostDetail";

const post = {
  id: "11111111-1111-4111-8111-111111111111",
  publication_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  list_id: null,
  name: "A better launch",
  subject: "The launch is here",
  preview_text: "What changed and why",
  public_slug: "a-better-launch",
  web_visibility: "public" as const,
  status: "draft",
  delivery_status: "draft" as const,
  content: [{ id: "body", type: "paragraph" as const, text: "The full story." }],
  template_id: "editorial" as const,
};

describe("NewsletterPostDetail", () => {
  it("shows post metadata and the rendered post without entering edit mode", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onBack = vi.fn();
    render(
      <NewsletterPostDetail
        post={post}
        publicationName="Studio Notes"
        onEdit={onEdit}
        onBack={onBack}
      />,
    );

    expect(screen.getByRole("heading", { name: "A better launch" })).toBeVisible();
    expect(screen.getAllByText("The launch is here")).toHaveLength(2);
    expect(screen.getByText("The full story.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Edit post" }));
    await user.click(screen.getByRole("button", { name: "Back to Posts" }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onBack).toHaveBeenCalledOnce();
  });
});
