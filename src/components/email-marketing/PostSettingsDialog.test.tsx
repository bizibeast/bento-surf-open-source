import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PostSettingsDialog, type PostSettingsValue } from "./PostSettingsDialog";

const value: PostSettingsValue = {
  subject: "Launch day",
  previewText: "A first look",
  listId: "list-1",
  webVisibility: "public",
  publicSlug: "launch-day",
  scheduledAt: "",
};

describe("PostSettingsDialog", () => {
  it("produces focused post metadata changes from one dialog", () => {
    const onChange = vi.fn();
    render(
      <PostSettingsDialog
        value={value}
        onChange={onChange}
        scheduleEnabled
        audiences={[
          { id: "list-1", name: "Members" },
          { id: "list-2", name: "Customers" },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Post settings" }));
    expect(screen.getByRole("dialog", { name: "Post settings" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Fresh subject" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, subject: "Fresh subject" });
    fireEvent.change(screen.getByLabelText("Preview text"), {
      target: { value: "Fresh preview" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, previewText: "Fresh preview" });
    fireEvent.change(screen.getByLabelText("Audience"), { target: { value: "list-2" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, listId: "list-2" });
    fireEvent.change(screen.getByLabelText("Web visibility"), { target: { value: "paid" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, webVisibility: "paid" });
    fireEvent.change(screen.getByLabelText("Post slug"), { target: { value: "fresh-post" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, publicSlug: "fresh-post" });
    fireEvent.change(screen.getByLabelText("Schedule"), {
      target: { value: "2030-01-02T03:04" },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      ...value,
      scheduledAt: "2030-01-02T03:04",
    });
  });

  it("keeps web-only controls out of broadcast settings", () => {
    render(<PostSettingsDialog mode="broadcast" value={value} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Post settings" }));

    expect(screen.queryByLabelText("Audience")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Schedule")).toBeVisible();
    expect(screen.queryByLabelText("Web visibility")).toBeNull();
    expect(screen.queryByLabelText("Post slug")).toBeNull();
  });

  it("disables scheduling with an accessible explanation until delivery is wired", () => {
    render(<PostSettingsDialog value={value} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Post settings" }));

    expect(screen.getByLabelText("Schedule")).toBeDisabled();
    expect(screen.getByLabelText("Schedule")).toHaveAccessibleDescription(
      "Connect delivery before scheduling this post.",
    );
  });

  it("explains paid access without adding another settings surface", async () => {
    render(<PostSettingsDialog value={value} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Post settings" }));
    fireEvent.focus(screen.getByRole("button", { name: "About paid access" }));

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Paid web previews hide the post body",
    );
  });
});
