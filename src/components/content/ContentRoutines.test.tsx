import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContentRoutines, type ContentRoutineView } from "./ContentRoutines";

const routines: ContentRoutineView[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    template: "fill_schedule",
    enabled: true,
    schedule: { intervalMinutes: 1_440, time: "03:00" },
    timezone: "Asia/Kolkata",
    platforms: ["linkedin"],
    next_run_at: "2026-09-19T21:30:00.000Z",
    last_run_at: "2026-09-18T21:30:00.000Z",
  },
];

describe("ContentRoutines", () => {
  it("creates a custom routine inline and retains instructions after a failed save", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Offline"));
    render(
      <ContentRoutines
        routines={[]}
        timezone="Asia/Kolkata"
        onSave={onSave}
        onPause={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New Routine" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Weekly plan" } });
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "Draft three sourced LinkedIn posts." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enable routine" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Offline"));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        template: expect.stringMatching(/^custom:/),
        name: "Weekly plan",
        timezone: "Asia/Kolkata",
      }),
    );
    expect(screen.getByLabelText("Instructions")).toHaveValue(
      "Draft three sourced LinkedIn posts.",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("keeps routines inside Agent and exposes status, pause, and schedule controls", () => {
    const onPause = vi.fn();
    render(
      <ContentRoutines
        routines={routines}
        timezone="Asia/Kolkata"
        onSave={vi.fn()}
        onPause={onPause}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Fill my schedule Drafts/ }));
    expect(screen.getByText("Next run")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "All routines" }));
    fireEvent.click(screen.getByRole("switch", { name: "Pause Fill my schedule" }));
    expect(onPause).toHaveBeenCalledWith(routines[0].id, true);
  });

  it("keeps the existing four templates in the grouped catalog and no cron field", () => {
    render(
      <ContentRoutines
        routines={[]}
        timezone="UTC"
        onSave={vi.fn()}
        onPause={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    for (const label of [
      "Nightly niche brief",
      "Fill my schedule",
      "Morning ready email",
      "Weekly performance review",
    ]) {
      expect(screen.getByRole("heading", { name: label })).toBeVisible();
    }
    expect(screen.queryByLabelText(/cron/i)).not.toBeInTheDocument();
  });
});
