import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { AgentPostReview } from "./AgentPostReview";
import type { SchedulerConnection } from "@/lib/social-scheduler";
const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
const accounts = ids.map((id, i) => ({
  id,
  provider: i ? "twitter" : "linkedin",
  displayName: "Taylor",
  handle: "taylor",
  avatarUrl: null,
  status: "active",
  canPublish: true,
  publishBlockReason: null,
  connectedAt: "",
})) as SchedulerConnection[];
const post = {
  body: "Fallback",
  connectionIds: ids,
  mode: "schedule",
  scheduledAt: "2099-10-22T12:30:00Z",
  timezone: "Asia/Kolkata",
  connectionOverrides: {
    [ids[0]]: { bodyOverride: "LinkedIn story" },
    [ids[1]]: { bodyOverride: "Short X update" },
  },
};
describe("shared Agent and landing post review", () => {
  it("switches exact account captions and saves in the shown timezone before approval", async () => {
    const edit = vi.fn().mockResolvedValue(undefined),
      approve = vi.fn();
    render(<AgentPostReview post={post} accounts={accounts} onEdit={edit} onApprove={approve} />);
    expect(screen.getByText("LinkedIn story")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Preview X: Taylor" }));
    expect(screen.getByText("Short X update")).toBeVisible();
    expect(screen.queryByText("LinkedIn story")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Approve & schedule" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Edit X caption"), {
      target: { value: "Revised X copy" },
    });
    const time = screen.getByLabelText("Schedule for all destinations (Asia/Kolkata)");
    expect(time).toHaveValue("2099-10-22T18:00");
    fireEvent.change(time, { target: { value: "2099-10-23T19:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(edit).toHaveBeenCalledWith({
        connectionId: ids[1],
        body: "Revised X copy",
        scheduledAt: "2099-10-23T13:30:00.000Z",
      }),
    );
    expect(approve).not.toHaveBeenCalled();
  });
  it("keeps edits visible on errors and does not show a false completed state", async () => {
    render(
      <AgentPostReview
        post={post}
        accounts={accounts}
        onApprove={vi.fn()}
        onEdit={vi.fn().mockRejectedValue(new Error("Review changed"))}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Review changed");
    expect(screen.getByLabelText("Edit LinkedIn caption")).toBeVisible();
    expect(screen.queryByText("Scheduled")).not.toBeInTheDocument();
  });
  it("explains an unavailable connection without enabling scheduling", () => {
    render(<AgentPostReview post={post} accounts={[accounts[0]]} onApprove={vi.fn()} />);
    expect(screen.getByText(/no longer connected/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve & schedule" })).toBeDisabled();
  });
});
