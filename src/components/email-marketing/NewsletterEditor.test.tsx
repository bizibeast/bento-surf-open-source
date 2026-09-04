import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveNewsletterIssue } from "@/lib/newsletter.functions";
import { NewsletterEditor } from "./NewsletterEditor";

vi.mock("@/lib/newsletter.functions", () => ({
  saveNewsletterIssue: vi.fn(),
}));

const issue = {
  id: "22222222-2222-4222-8222-222222222222",
  publication_id: "11111111-1111-4111-8111-111111111111",
  list_id: null,
  name: "Launch post",
  subject: "Launch day",
  preview_text: "A first look",
  public_slug: "launch-day",
  web_visibility: "public" as const,
  status: "draft",
  template_id: "personal-note" as const,
  content: [
    { id: "1", type: "heading" as const, text: "Launch day" },
    { id: "2", type: "paragraph" as const, text: "We are live." },
  ],
};

const products = [
  {
    id: "33333333-3333-4333-8333-333333333333",
    title: "Creator Kit",
    description: "Published kit",
    url: "/@ari/products/creator-kit",
  },
];

function renderEditor(props: Partial<React.ComponentProps<typeof NewsletterEditor>> = {}) {
  return render(
    <NewsletterEditor
      publicationId="11111111-1111-4111-8111-111111111111"
      issue={issue}
      publicationName="Studio Notes"
      recipientCount={42}
      onSaved={vi.fn()}
      products={products}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.mocked(saveNewsletterIssue).mockResolvedValue(issue as never);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("NewsletterEditor", () => {
  it("keeps the title fixed on canvas and settings inside the publishing flow", () => {
    renderEditor();

    expect(screen.getByLabelText("Post name")).toHaveValue("Launch post");
    expect(screen.getByLabelText("Heading text 1")).toHaveValue("Launch day");
    expect(screen.getByLabelText("Paragraph text 2")).toHaveValue("We are live.");
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send test" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Post settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.getByRole("tab", { name: "email post" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "web post" })).toBeVisible();
    expect(screen.getByTestId("post-surface-switch-slot")).toHaveClass(
      "lg:grid-cols-[minmax(0,1fr)_260px]",
    );
    expect(screen.getByRole("tablist", { name: "Post surface" })).toHaveClass("rounded-md");
    expect(screen.getByRole("tab", { name: "email post" })).toHaveClass("rounded-sm");
    expect(screen.getByText("audience", { selector: "span" })).toHaveClass("hidden", "sm:inline");

    fireEvent.click(screen.getByRole("tab", { name: /email$/i }));
    expect(screen.getByLabelText("Subject")).toHaveValue("Launch day");
    expect(screen.getByLabelText("Preview text")).toHaveValue("A first look");
    fireEvent.click(screen.getByRole("tab", { name: /audience$/i }));
    expect(screen.getByLabelText("Audience")).toHaveValue("");
    fireEvent.click(screen.getByRole("tab", { name: /web$/i }));
    expect(screen.getByLabelText("Web visibility")).toHaveValue("public");
    expect(screen.getByLabelText("Post slug")).toHaveValue("launch-day");
    fireEvent.click(screen.getByRole("tab", { name: /review$/i }));
    expect(screen.getByLabelText("Schedule")).toBeDisabled();
    expect(document.body).not.toHaveTextContent(/issue/i);
  });

  it("opens a slash menu inside a block and inserts the selected block after it", () => {
    renderEditor();
    const paragraph = screen.getByLabelText("Paragraph text 2");
    fireEvent.change(paragraph, { target: { value: "" } });
    fireEvent.keyDown(paragraph, { key: "/" });

    const menu = screen.getByRole("menu", { name: "Add block after 2" });
    expect(menu).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "Add image" }));

    expect(screen.getByLabelText("Image URL")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(3);
  });

  it.each(["newsletter", "broadcast"] as const)(
    "reloads an empty %s with an editable insertion point",
    (mode) => {
      renderEditor({
        mode,
        issue: {
          ...issue,
          web_visibility: mode === "broadcast" ? "private" : "public",
          content: [],
        },
      });

      expect(screen.getByLabelText("Paragraph text 1")).toHaveValue("");
      expect(screen.getByRole("button", { name: "Add block after 1" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Remove paragraph 1" })).toBeDisabled();
    },
  );

  it("shows Saving then Saved and exposes a failed autosave retry", async () => {
    vi.useFakeTimers();
    renderEditor();

    fireEvent.change(screen.getByLabelText("Paragraph text 2"), {
      target: { value: "Updated body" },
    });
    expect(screen.getByText("Saving")).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(screen.getByText("Saved")).toBeVisible();
    expect(saveNewsletterIssue).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        templateId: "personal-note",
        content: expect.arrayContaining([
          expect.objectContaining({ type: "paragraph", text: "Updated body" }),
        ]),
        status: "draft",
      }),
    });

    vi.mocked(saveNewsletterIssue).mockRejectedValueOnce(new Error("Network unavailable"));
    fireEvent.change(screen.getByLabelText("Paragraph text 2"), {
      target: { value: "Retry this body" },
    });
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(screen.getByText("Failed")).toBeVisible();
    expect(screen.getByText("Network unavailable")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await act(async () => Promise.resolve());
    expect(screen.getByText("Saved")).toBeVisible();
  });

  it("undoes and redoes edits and warns before closing with local changes", () => {
    renderEditor();
    const name = screen.getByLabelText("Post name");

    fireEvent.change(name, { target: { value: "Renamed post" } });
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(name).toHaveValue("Launch post");
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(name).toHaveValue("Renamed post");

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("shows Needs details instead of Saving while required post settings are invalid", async () => {
    vi.useFakeTimers();
    renderEditor();

    fireEvent.click(screen.getByRole("tab", { name: /email$/i }));
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "" } });
    expect(screen.getByText("Needs details")).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(saveNewsletterIssue).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: /email$/i }));
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Restored" } });
    fireEvent.click(screen.getByRole("tab", { name: /web$/i }));
    fireEvent.change(screen.getByLabelText("Post slug"), { target: { value: "" } });
    expect(screen.getByText("Needs details")).toBeVisible();

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps a pending schedule unsaved and out of draft autosave", async () => {
    vi.useFakeTimers();
    renderEditor({ onPublish: vi.fn() });

    fireEvent.click(screen.getByRole("tab", { name: /review$/i }));
    fireEvent.change(screen.getByLabelText("Schedule"), {
      target: { value: "2030-01-02T03:04" },
    });

    expect(screen.getByText("Unsaved")).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(saveNewsletterIssue).not.toHaveBeenCalled();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("saves a pending draft before delegating scheduling without publishing locally", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const onPublish = vi.fn().mockResolvedValue(undefined);
    renderEditor({ onPublish });

    fireEvent.change(screen.getByLabelText("Paragraph text 2"), {
      target: { value: "Pending schedule body" },
    });
    fireEvent.click(screen.getByRole("tab", { name: /review$/i }));
    fireEvent.change(screen.getByLabelText("Schedule"), {
      target: { value: "2030-01-02T03:04" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await act(async () => Promise.resolve());

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('"Launch post"'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Studio Notes"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("42 recipients"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Public access"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("2030"));
    expect(saveNewsletterIssue).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "draft" }),
    });
    expect(saveNewsletterIssue).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "published" }),
    });
    expect(onPublish).toHaveBeenCalledWith({
      id: issue.id,
      scheduledAt: new Date("2030-01-02T03:04").toISOString(),
    });
    expect(vi.mocked(saveNewsletterIssue).mock.invocationCallOrder[0]).toBeLessThan(
      onPublish.mock.invocationCallOrder[0],
    );
  });

  it("saves an immediate publish as a draft before queueing the exact post", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onPublish = vi.fn().mockResolvedValue(undefined);
    renderEditor({ onPublish });

    fireEvent.click(screen.getByRole("tab", { name: /review$/i }));
    fireEvent.click(screen.getByRole("button", { name: "Publish post" }));
    await act(async () => Promise.resolve());

    expect(saveNewsletterIssue).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: issue.id, status: "draft" }),
    });
    expect(onPublish).toHaveBeenCalledWith({ id: issue.id, scheduledAt: null });
  });

  it("leaves the post unpublished when the scheduling callback fails", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onPublish = vi.fn().mockRejectedValue(new Error("Scheduler unavailable"));
    renderEditor({ onPublish });

    fireEvent.click(screen.getByRole("tab", { name: /review$/i }));
    fireEvent.change(screen.getByLabelText("Schedule"), {
      target: { value: "2030-01-02T03:04" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await act(async () => Promise.resolve());

    expect(await screen.findByText("Scheduler unavailable")).toBeVisible();
    expect(saveNewsletterIssue).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "published" }),
    });
  });

  it("round-trips an existing UTC schedule through browser-local time", async () => {
    vi.stubEnv("TZ", "Asia/Kolkata");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onPublish = vi.fn().mockResolvedValue(undefined);
    renderEditor({
      issue: { ...issue, scheduled_at: "2030-01-02T03:04:00.000Z" },
      onPublish,
    });

    fireEvent.click(screen.getByRole("tab", { name: /review$/i }));
    expect(screen.getByLabelText("Schedule")).toHaveValue("2030-01-02T08:34");
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await act(async () => Promise.resolve());

    expect(onPublish).toHaveBeenCalledWith({
      id: issue.id,
      scheduledAt: "2030-01-02T03:04:00.000Z",
    });
  });

  it("disables a loaded schedule until a delivery callback is wired", () => {
    renderEditor({ issue: { ...issue, scheduled_at: "2030-01-02T03:04:00.000Z" } });

    fireEvent.click(screen.getByRole("tab", { name: /review$/i }));
    expect(screen.queryByRole("button", { name: "Schedule" })).toBeNull();
  });

  it("saves a draft before test-send without publishing", async () => {
    const onTestSend = vi.fn().mockResolvedValue(undefined);
    renderEditor({ onTestSend });

    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await act(async () => Promise.resolve());

    expect(onTestSend).toHaveBeenCalledWith(issue.id);
    expect(saveNewsletterIssue).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: issue.id, status: "draft" }),
    });
    expect(saveNewsletterIssue).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "published" }),
    });
  });
});
