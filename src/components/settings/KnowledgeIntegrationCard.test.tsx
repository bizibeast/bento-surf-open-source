import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeIntegrationCard } from "./KnowledgeIntegrationCard";

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  list: vi.fn(),
  select: vi.fn(),
  sync: vi.fn(),
  disconnect: vi.fn(),
  deleteData: vi.fn(),
  changed: vi.fn(),
}));

vi.mock("@/lib/content-connections.functions", () => ({
  beginContentKnowledgeConnection: mocks.begin,
  getContentKnowledgeResources: mocks.list,
  updateContentKnowledgeResources: mocks.select,
  syncContentKnowledgeConnection: mocks.sync,
  disconnectContentKnowledgeConnection: mocks.disconnect,
  deleteContentKnowledgeData: mocks.deleteData,
}));

function renderCard(
  connection: Parameters<typeof KnowledgeIntegrationCard>[0]["connection"] = null,
  provider: Parameters<typeof KnowledgeIntegrationCard>[0]["provider"] = "notion",
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <KnowledgeIntegrationCard
        provider={provider}
        connection={connection}
        ready
        onChanged={mocks.changed}
      />
    </QueryClientProvider>,
  );
}

describe("Knowledge integration card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, "open").mockImplementation(() => null);
  });

  it("starts the provider's official connection flow", async () => {
    mocks.begin.mockResolvedValue({ url: "https://api.notion.com/v1/oauth/authorize" });
    renderCard();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Manage Notion integration/i }));
    await user.click(screen.getByRole("button", { name: "Connect Notion" }));
    expect(window.open).toHaveBeenCalledWith(
      "https://api.notion.com/v1/oauth/authorize",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("uses the supplied Granola and Slack logo assets", () => {
    const granola = renderCard(null, "granola");
    expect(document.querySelector('img[src="/brands/granola.png"]')).toBeInTheDocument();
    granola.unmount();

    renderCard(null, "slack");
    expect(document.querySelector('img[src="/brands/slack.png"]')).toBeInTheDocument();
  });

  it("offers to replace the single active provider connection", async () => {
    renderCard({
      id: "11111111-1111-4111-8111-111111111111",
      provider: "notion",
      displayName: "Creator HQ",
      status: "active",
      selectedResources: { ids: [] },
      lastSuccessAt: null,
      lastError: null,
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Manage Notion integration/i }));

    expect(screen.getByRole("button", { name: "Replace connection" })).toBeEnabled();
  });

  it("selects provider-visible resources and syncs the connection", async () => {
    mocks.list.mockResolvedValue({
      resources: [{ id: "page-1", name: "Launch plan", type: "page" }],
      selectedIds: [],
    });
    mocks.select.mockResolvedValue({ selected: 1 });
    mocks.sync.mockResolvedValue({ imported: 1, warnings: [] });
    renderCard({
      id: "11111111-1111-4111-8111-111111111111",
      provider: "notion",
      displayName: "Creator HQ",
      status: "active",
      selectedResources: { ids: [] },
      lastSuccessAt: null,
      lastError: null,
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Manage Notion integration/i }));
    expect(await screen.findByRole("checkbox", { name: "Launch plan" })).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: "Launch plan" }));
    await user.click(screen.getByRole("button", { name: "Save sources" }));
    await waitFor(() =>
      expect(mocks.select).toHaveBeenCalledWith({
        data: {
          id: "11111111-1111-4111-8111-111111111111",
          resourceIds: ["page-1"],
        },
      }),
    );
    await user.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalled());
  });
});
