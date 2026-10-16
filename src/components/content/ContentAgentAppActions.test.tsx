import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { SchedulerConnection } from "@/lib/social-scheduler";
const mocks = vi.hoisted(() => ({ states: vi.fn(), review: vi.fn() }));
vi.mock("@/lib/content-agent.functions", () => ({
  getContentAgentActionStates: mocks.states,
  reviewContentAgentAction: mocks.review,
}));
import { ContentAgentAppActions } from "./ContentAgentAppActions";
const id = "00000000-0000-4000-8000-000000000001";
const account = {
  id,
  provider: "linkedin",
  displayName: "Taylor",
  handle: "taylor",
  avatarUrl: null,
} as SchedulerConnection;
const action = {
  id,
  tool: "create_social_post",
  title: "Create post",
  arguments: {
    body: "Shared caption",
    connectionIds: [id],
    mode: "schedule",
    timezone: "UTC",
    scheduledAt: "2026-12-20T12:00:00Z",
    media: [],
    providerSettings: { linkedin: { bodyOverride: "LinkedIn-specific caption" } },
  },
};
function view() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ContentAgentAppActions messageId={id} actions={[action]} accounts={[account]} />
    </QueryClientProvider>,
  );
}
describe("Agent action review", () => {
  it("shows the actual destination copy and approves only the saved action ID", async () => {
    mocks.states.mockResolvedValue([{ id, status: "pending" }]);
    mocks.review.mockResolvedValue({
      id,
      status: "completed",
      message: "Scheduled the social post.",
    });
    view();
    const approve = await screen.findByRole("button", { name: "Approve & schedule" });
    expect(screen.getAllByText("LinkedIn-specific caption")[0]).toBeVisible();
    expect(screen.queryByText("Shared caption")).not.toBeVisible();
    fireEvent.click(approve);
    await screen.findByText("Scheduled the social post.");
    expect(mocks.review).toHaveBeenCalledWith({ data: { id, dismiss: false } });
    expect(screen.queryByRole("button", { name: "Approve & schedule" })).not.toBeInTheDocument();
  });
  it("keeps approval unavailable when its durable state cannot be loaded", async () => {
    mocks.states.mockRejectedValue(new Error("Unavailable"));
    view();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded"));
    expect(screen.queryByRole("button", { name: "Approve & schedule" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeVisible();
  });
});
