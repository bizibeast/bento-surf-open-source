import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PostingTimesDialog } from "./PostingTimesDialog";

describe("PostingTimesDialog", () => {
  it("keeps mobile posting controls compact and saves their interactions", async () => {
    const onSave = vi.fn();
    render(
      <PostingTimesDialog
        open
        schedule={{
          timezone: "Asia/Calcutta",
          slots: [
            { day: 1, time: "12:00" },
            { day: 2, time: "12:00" },
          ],
          naturalOffset: false,
        }}
        saving={false}
        onOpenChange={vi.fn()}
        onSave={onSave}
      />,
    );

    await screen.findByText("2 weekly slots · Asia/Calcutta");
    const dialog = screen.getByRole("dialog", { name: "Posting times" });
    const mobile = dialog.querySelector<HTMLElement>("[data-posting-times-mobile]");
    const desktop = dialog.querySelector<HTMLElement>("[data-posting-times-desktop]");

    expect(dialog).toHaveClass("overflow-x-hidden", "overflow-y-auto");
    expect(mobile).toHaveClass("space-y-3", "sm:hidden");
    expect(desktop).toHaveClass("hidden", "overflow-x-auto", "sm:block");

    const mobileControls = within(mobile!);
    const monday = mobileControls.getByRole("button", { name: "Mon at 12:00" });
    expect(monday).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(monday);
    expect(monday).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(mobileControls.getByRole("button", { name: "Add time" }));
    expect(mobileControls.getByText("Time 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Save posting times" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0]![0];
    expect(saved.timezone).toBe("Asia/Calcutta");
    expect(saved.naturalOffset).toBe(true);
    expect(saved.slots).toContainEqual({ day: 2, time: "12:00" });
    expect(saved.slots).not.toContainEqual({ day: 1, time: "12:00" });
    expect(saved.slots).toContainEqual({ day: 1, time: "17:00" });
  });
});
