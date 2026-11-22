import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_BRANDING } from "@/lib/content-agent-branding";
import { studioStarter } from "@/lib/content-studio";
import { BENNY_EDITING_MODELS } from "@/lib/benny-models";
import { getBennyAiSettings } from "@/lib/benny-byok.functions";
import { generateContentStudioDraft } from "@/lib/content-studio-generation.functions";
import { StudioGeneration } from "./studio-generation";

vi.mock("@/lib/benny-byok.functions", () => ({ getBennyAiSettings: vi.fn() }));
vi.mock("@/lib/content-studio-generation.functions", () => ({
  generateContentStudioDraft: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/settings?section=ai-providers">{children}</a>
  ),
}));

const { document } = studioStarter("reel", "captions", DEFAULT_AGENT_BRANDING);
const fixture = {
  connectAvailable: true,
  managedAvailable: true,
  providers: [],
  defaultProviderId: null,
  searchConnected: false,
  compatibleAvailable: false,
  managedSearch: false,
  managedUsage: null,
  bentoModels: BENNY_EDITING_MODELS.map(({ id, name }) => ({ id, name })),
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBennyAiSettings).mockResolvedValue(fixture);
  vi.mocked(generateContentStudioDraft).mockResolvedValue({ title: "A draft", document });
});
function mount(onApply = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StudioGeneration
        workspaceId="workspace"
        title="A draft"
        document={document}
        onApply={onApply}
      />
    </QueryClientProvider>,
  );
}

it.each(BENNY_EDITING_MODELS)(
  "sends the selected $name route and removes inline provider setup",
  async (model) => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    mount(onApply);
    await user.click(screen.getByRole("button", { name: "Generate draft" }));
    await screen.findByRole("option", { name: model.name });
    expect(screen.queryByRole("option", { name: "Default model" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Connect a model|Manage AI providers/ }),
    ).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Studio generation model"), `bento|${model.id}`);
    await user.type(screen.getByLabelText("What are you creating?"), "Edit my reel");
    await user.click(screen.getByRole("button", { name: "Replace draft copy" }));
    expect(generateContentStudioDraft).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace",
        title: "A draft",
        document,
        prompt: "Edit my reel",
        aiModel: model.id,
      },
    });
    expect(onApply).toHaveBeenCalledWith({ title: "A draft", document });
  },
);

it("retains BYOK setup in Settings and prevents generation when no model is available", async () => {
  vi.mocked(getBennyAiSettings).mockResolvedValue({
    ...fixture,
    managedAvailable: false,
    bentoModels: [],
  });
  const user = userEvent.setup();
  mount();
  await user.click(screen.getByRole("button", { name: "Generate draft" }));
  await user.type(screen.getByLabelText("What are you creating?"), "Edit my reel");
  expect(screen.getByRole("button", { name: "Replace draft copy" })).toBeDisabled();
  expect(await screen.findByRole("link", { name: "View AI provider settings" })).toHaveAttribute(
    "href",
    "/settings?section=ai-providers",
  );
  expect(generateContentStudioDraft).not.toHaveBeenCalled();
});
