import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
vi.mock("@/lib/content-studio.functions", () => ({
  getContentStudioHistory: vi.fn().mockResolvedValue({
    brief: "Make a practical editing Reel",
    conversationPath: "/content?tab=agent&thread=44444444-4444-4444-8444-444444444444",
    actions: [
      {
        id: "one",
        tool: "create_content_from_reference",
        status: "completed",
        createdAt: "2026-11-22T00:00:00Z",
      },
    ],
  }),
}));
import { StudioCreationHistory } from "./studio-creation-history";
import { studioStarter } from "@/lib/content-studio";
import { DEFAULT_AGENT_BRANDING } from "@/lib/content-agent-branding";
it("links the saved project's original conversation and shows its editing plan", async () => {
  const entry = { ...studioStarter("reel", "kinetic", DEFAULT_AGENT_BRANDING), revision: 1 };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StudioCreationHistory workspaceId="workspace" entry={entry} />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("link", { name: "Open Benny conversation" })).toHaveAttribute(
    "href",
    expect.stringContaining("thread=44444444"),
  );
  expect(screen.getByText("Make a practical editing Reel")).toBeInTheDocument();
  expect(screen.getByText("Editing plan & history")).toBeInTheDocument();
});
