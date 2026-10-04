import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramIntegrationCard } from "./TelegramIntegrationCard";

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  disconnect: vi.fn(),
  changed: vi.fn(),
}));

vi.mock("@/lib/telegram.functions", () => ({
  beginTelegramConnection: mocks.begin,
  disconnectTelegramConnection: mocks.disconnect,
}));

function renderCard(
  connection: Parameters<typeof TelegramIntegrationCard>[0]["connection"] = null,
  ready = true,
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TelegramIntegrationCard
        connection={connection}
        ready={ready}
        botUsername="BentoAgentBot"
        onChanged={mocks.changed}
      />
    </QueryClientProvider>,
  );
}

describe("Telegram integration card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, "open").mockImplementation(() => null);
  });

  it("opens the official deep link and exposes a status refresh", async () => {
    mocks.begin.mockResolvedValue({ url: "https://t.me/BentoAgentBot?start=state" });
    renderCard();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Manage Telegram integration/i }));
    await user.click(screen.getByRole("button", { name: "Connect Telegram" }));
    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        "https://t.me/BentoAgentBot?start=state",
        "_blank",
        "noopener,noreferrer",
      ),
    );
    expect(screen.getByRole("button", { name: "Check connection" })).toBeInTheDocument();
  });

  it("shows configuration pending without starting a connection", async () => {
    renderCard(null, false);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Manage Telegram integration/i }));
    expect(screen.getByText("Awaiting Bento bot configuration.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Telegram" })).toBeDisabled();
  });

  it("disconnects the connected creator chat", async () => {
    mocks.disconnect.mockResolvedValue({ disconnected: true });
    renderCard({
      id: "33333333-3333-4333-8333-333333333333",
      displayName: "@creator",
      status: "active",
      lastSuccessAt: null,
      lastError: null,
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Manage Telegram integration/i }));
    await user.click(screen.getByRole("button", { name: "Disconnect Telegram" }));
    await waitFor(() =>
      expect(mocks.disconnect).toHaveBeenCalledWith({
        data: { id: "33333333-3333-4333-8333-333333333333" },
      }),
    );
  });
});
