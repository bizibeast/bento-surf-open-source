import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NewsletterPostsTable, type NewsletterPostTableRecord } from "./NewsletterPostsTable";

const posts: NewsletterPostTableRecord[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    publication_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    list_id: null,
    name: "September draft",
    subject: "September draft",
    preview_text: "Still writing",
    public_slug: "september-draft",
    web_visibility: "public",
    status: "draft",
    delivery_status: "draft",
    content: [{ id: "draft-body", type: "paragraph", text: "Draft body" }],
    updated_at: "2026-09-02T08:30:00.000Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    publication_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    list_id: null,
    name: "Launch recap",
    subject: "Launch recap",
    preview_text: "Sent recap",
    public_slug: "launch-recap",
    web_visibility: "public",
    status: "published",
    delivery_status: "sent",
    content: [{ id: "sent-body", type: "paragraph", text: "Sent body" }],
    scheduled_at: "2026-09-01T10:00:00.000Z",
    published_at: "2026-09-01T10:05:00.000Z",
    updated_at: "2026-09-01T10:05:00.000Z",
    opens: 43,
    clicks: 11,
  },
];

describe("NewsletterPostsTable", () => {
  it("searches and filters the post library and exposes one start-writing action", async () => {
    const user = userEvent.setup();
    const onStartPost = vi.fn();
    render(
      <NewsletterPostsTable
        posts={posts}
        creatorUsername="ari"
        publicationSlug="studio-notes"
        publicOrigin="https://bento.surf"
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        onPreview={vi.fn()}
        onSchedule={vi.fn()}
        onDeleteDraft={vi.fn()}
        onStartPost={onStartPost}
      />,
    );

    await user.type(screen.getByRole("searchbox", { name: "Search posts" }), "launch");
    expect(screen.getByText("Launch recap")).toBeVisible();
    expect(screen.queryByText("September draft")).not.toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "Search posts" }));
    await user.selectOptions(screen.getByLabelText("Filter posts"), "draft");
    expect(screen.getByText("September draft")).toBeVisible();
    expect(screen.queryByText("Launch recap")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start writing" }));
    expect(onStartPost).toHaveBeenCalledOnce();
  });

  it("renders posts as one semantic table with status chips", () => {
    render(
      <NewsletterPostsTable
        posts={posts}
        creatorUsername="ari"
        publicationSlug="studio-notes"
        publicOrigin="https://bento.surf"
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        onPreview={vi.fn()}
        onSchedule={vi.fn()}
        onDeleteDraft={vi.fn()}
      />,
    );

    const table = screen.getByRole("table", { name: "Posts" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Post", "Status", "Web page", "Schedule", "Updated", "Opens", "Clicks", "Actions"]);
    expect(screen.getByText("Draft")).toHaveAttribute("data-status", "draft");
    expect(screen.getByText("Sent", { selector: "span" })).toHaveAttribute("data-status", "sent");
    expect(screen.getByRole("link", { name: "View live post Launch recap" })).toHaveAttribute(
      "href",
      "https://bento.surf/@ari/newsletters/studio-notes/launch-recap",
    );
    expect(screen.queryByRole("link", { name: "View live post September draft" })).toBeNull();
    expect(document.body).not.toHaveTextContent(/issue/i);
  });

  it("runs the draft actions from an accessible overflow menu", async () => {
    const user = userEvent.setup();
    const actions = {
      onEdit: vi.fn(),
      onDuplicate: vi.fn(),
      onPreview: vi.fn(),
      onSchedule: vi.fn(),
      onDeleteDraft: vi.fn(),
    };
    render(<NewsletterPostsTable posts={posts} {...actions} />);

    const openDraftMenu = () =>
      user.click(screen.getByRole("button", { name: "Actions for September draft" }));

    await openDraftMenu();
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    await openDraftMenu();
    await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    await openDraftMenu();
    await user.click(screen.getByRole("menuitem", { name: "Preview" }));
    await openDraftMenu();
    await user.click(screen.getByRole("menuitem", { name: "Schedule" }));
    await openDraftMenu();
    await user.click(screen.getByRole("menuitem", { name: "Delete draft" }));

    expect(actions.onEdit).toHaveBeenCalledWith(posts[0]);
    expect(actions.onDuplicate).toHaveBeenCalledWith(posts[0]);
    expect(actions.onPreview).toHaveBeenCalledWith(posts[0]);
    expect(actions.onSchedule).toHaveBeenCalledWith(posts[0]);
    expect(actions.onDeleteDraft).toHaveBeenCalledWith(posts[0]);

    await user.click(screen.getByRole("button", { name: "Actions for Launch recap" }));
    expect(screen.queryByRole("menuitem", { name: "Delete draft" })).toBeNull();
  });

  it("surfaces a failed post action without removing the table", async () => {
    const user = userEvent.setup();
    render(
      <NewsletterPostsTable
        posts={posts}
        onEdit={vi.fn()}
        onDuplicate={vi.fn().mockRejectedValue(new Error("Could not duplicate post."))}
        onPreview={vi.fn()}
        onSchedule={vi.fn()}
        onDeleteDraft={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Actions for September draft" }));
    await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not duplicate post.");
    expect(screen.getByRole("table", { name: "Posts" })).toBeVisible();
  });
});
