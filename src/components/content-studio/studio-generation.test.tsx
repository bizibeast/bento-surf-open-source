import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { DEFAULT_AGENT_BRANDING } from "@/lib/content-agent-branding";
import { studioStarter } from "@/lib/content-studio";
import { StudioGeneration } from "./studio-generation";

vi.mock("@/lib/benny-byok.functions", () => ({
  getBennyAiSettings: vi.fn().mockResolvedValue({
    connectAvailable: true,
    managedAvailable: false,
    providers: [],
    defaultProviderId: null,
    searchConnected: false,
  }),
  getBennyAiModels: vi.fn(),
  saveBennyAiProvider: vi.fn(),
  updateBennyAiDefault: vi.fn(),
  removeBennyAiProvider: vi.fn(),
  updateBennySearchKey: vi.fn(),
}));

vi.mock("@/lib/content-studio-generation.functions", () => ({
  getStudioBentoModelAccess: vi.fn().mockResolvedValue(false),
  generateContentStudioDraft: vi.fn(),
}));

it("opens API key setup from the editor and keeps the generation prompt after closing", async () => {
  const user = userEvent.setup();
  const { document } = studioStarter("carousel", "editorial", DEFAULT_AGENT_BRANDING);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StudioGeneration
        workspaceId="workspace"
        title="A draft"
        document={document}
        onApply={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Generate draft" }));
  await user.type(screen.getByLabelText("What are you creating?"), "How to plan a carousel");
  await user.click(await screen.findByRole("button", { name: "Connect a model" }));

  const dialog = screen.getByRole("dialog", { name: "Benny AI providers" });
  expect(within(dialog).getByLabelText("OpenRouter API key")).toHaveAttribute("type", "password");
  await user.click(within(dialog).getByRole("button", { name: "Close" }));

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByLabelText("What are you creating?")).toHaveValue("How to plan a carousel");
  expect(screen.getByRole("button", { name: "Replace draft copy" })).toBeDisabled();
});
